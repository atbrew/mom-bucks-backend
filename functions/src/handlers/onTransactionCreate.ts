/**
 * onTransactionCreate — Phase 4, issue #15.
 *
 * Firestore trigger: `children/{childId}/transactions/{txnId}` onCreate.
 *
 * When a new transaction row lands, update the parent child's
 * running `balance` atomically. Replaces the Flask-side balance
 * recompute path. Runs in a Firestore transaction so concurrent
 * writes retry on contention — this is our replacement for Postgres
 * optimistic locking.
 *
 * Behaviour:
 *   - `type === 'LODGE'`   → balance += amount
 *   - `type === 'WITHDRAW'` → balance -= amount (clamped at 0)
 *   - `lastTxnAt` is set to the server timestamp
 *   - `version` is bumped so clients can detect stale reads
 *
 * Clamping on would-go-negative is defense-in-depth. The primary
 * guard against overspend lives in `firestore.rules`, which denies
 * WITHDRAW creates where `amount > child.balance` synchronously at
 * write time. This trigger fires AFTER the doc has landed, so a
 * refusal here can't un-do the write — the rules layer is the only
 * place the transaction can actually be rejected.
 *
 * That said, two paths can still deliver a negative-yielding write
 * to this trigger:
 *   1. Admin SDK writers (backfill, callables) bypass security rules.
 *   2. Concurrent WITHDRAWs issued against the same child can both
 *      read a sufficient balance, both pass the rule check, and then
 *      land in sequence — the second one now overspends.
 *
 * When either happens, we clamp the resulting balance at 0 and log a
 * structured warning so operations can investigate out-of-band.
 */

import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions";
import { getFirestore, FieldValue } from "../admin";

export interface TransactionDoc {
  amount: number; // integer cents
  type: "LODGE" | "WITHDRAW" | "EARN";
  description?: string;
  createdByUid?: string;
}

export interface ChildBalanceUpdate {
  newBalance: number;
  clamped: boolean;
  previousBalance: number;
}

/**
 * Pure balance-recompute helper. Exposed for unit testing so the
 * logic can be exercised without mocking the whole trigger
 * infrastructure.
 */
export function computeNewBalance(
  previousBalance: number,
  txn: Pick<TransactionDoc, "amount" | "type">,
): ChildBalanceUpdate {
  const delta = txn.type === "LODGE" ? txn.amount : -txn.amount;
  const raw = previousBalance + delta;
  if (raw < 0) {
    return { newBalance: 0, clamped: true, previousBalance };
  }
  return { newBalance: raw, clamped: false, previousBalance };
}

export const onTransactionCreate = onDocumentCreated(
  {
    document: "children/{childId}/transactions/{txnId}",
    region: "us-central1",
  },
  async (event) => {
    const childId = event.params.childId;
    const txnId = event.params.txnId;
    const txn = event.data?.data() as TransactionDoc | undefined;

    if (!txn) {
      logger.warn("[onTransactionCreate] empty snapshot", { childId, txnId });
      return;
    }

    if (typeof txn.amount !== "number" || txn.amount < 0) {
      logger.warn("[onTransactionCreate] invalid amount; skipping", {
        childId,
        txnId,
        amount: txn.amount,
      });
      return;
    }

    if (txn.type === "EARN") {
      // claimActivity and vault callables apply the balance + version
      // bump atomically in the same transaction that writes the EARN
      // row, so the trigger has nothing left to do.
      return;
    }

    if (txn.type !== "LODGE" && txn.type !== "WITHDRAW") {
      logger.warn("[onTransactionCreate] invalid type; skipping", {
        childId,
        txnId,
        type: txn.type,
      });
      return;
    }

    const db = getFirestore();
    const childRef = db.doc(`children/${childId}`);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(childRef);
      if (!snap.exists) {
        logger.error(
          "[onTransactionCreate] parent child doc missing; skipping recompute",
          { childId, txnId },
        );
        return;
      }
      const previousBalance = Number(snap.get("balance") ?? 0);
      const update = computeNewBalance(previousBalance, txn);
      tx.update(childRef, {
        balance: update.newBalance,
        lastTxnAt: FieldValue.serverTimestamp(),
        version: FieldValue.increment(1),
      });
      if (update.clamped) {
        logger.warn("[onTransactionCreate] balance clamped at zero", {
          childId,
          txnId,
          previousBalance: update.previousBalance,
          requested: txn.type === "WITHDRAW" ? -txn.amount : txn.amount,
        });
      }
    });

    logger.info("[onTransactionCreate] balance updated", {
      childId,
      txnId,
      type: txn.type,
      amount: txn.amount,
    });
  },
);
