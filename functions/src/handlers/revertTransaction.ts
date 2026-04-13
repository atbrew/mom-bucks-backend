/**
 * revertTransaction — callable.
 *
 * Creates the inverse of an existing transaction (LODGE→WITHDRAW or
 * WITHDRAW→LODGE) and stamps the original as reverted, all inside a
 * Firestore transaction so the double-revert check is atomic.
 *
 * The caller must be a parent of the child (checked via parentUids).
 * The balance update is NOT done here — `onTransactionCreate` fires
 * on the new inverse doc and handles it the same way as any other
 * transaction.
 *
 * Idempotency: if the original was already reverted by the SAME
 * caller, we return the existing revert transaction ID rather than
 * failing. Reverted by a DIFFERENT caller is also fine (any parent
 * can revert).
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { getFirestore, FieldValue } from "../admin";

// ─── Types ──────────────────────────────────────────────────────────

interface TransactionDoc {
  amount: number;
  type: "LODGE" | "WITHDRAW";
  description?: string;
  createdByUid?: string;
  revertedByTxnId?: string;
}

interface ChildDoc {
  parentUids: string[];
}

export interface RevertTransactionRequest {
  childId: string;
  txnId: string;
}

export interface RevertTransactionResponse {
  revertTxnId: string;
}

export type RevertDecision =
  | { kind: "revert"; inverseType: "LODGE" | "WITHDRAW"; amount: number; description: string }
  | { kind: "idempotent-replay"; revertTxnId: string }
  | { kind: "reject"; code: HttpsError["code"]; message: string };

// ─── Pure decision logic ────────────────────────────────────────────

export function decideRevert(params: {
  callerUid: string;
  txn: TransactionDoc | null | undefined;
  child: ChildDoc | null | undefined;
}): RevertDecision {
  const { callerUid, txn, child } = params;

  if (!child) {
    return { kind: "reject", code: "not-found", message: "child does not exist" };
  }
  if (!child.parentUids?.includes(callerUid)) {
    return { kind: "reject", code: "permission-denied", message: "caller is not a parent of this child" };
  }
  if (!txn) {
    return { kind: "reject", code: "not-found", message: "transaction does not exist" };
  }
  if (txn.revertedByTxnId) {
    return { kind: "idempotent-replay", revertTxnId: txn.revertedByTxnId };
  }
  if (txn.type !== "LODGE" && txn.type !== "WITHDRAW") {
    return { kind: "reject", code: "failed-precondition", message: `unknown transaction type: ${txn.type}` };
  }

  const inverseType = txn.type === "LODGE" ? "WITHDRAW" : "LODGE";
  const originalDesc = txn.description ?? "";

  return {
    kind: "revert",
    inverseType,
    amount: txn.amount,
    description: `Revert of ${originalDesc}`,
  };
}

// ─── Handler ────────────────────────────────────────────────────────

export const revertTransaction = onCall<
  RevertTransactionRequest,
  Promise<RevertTransactionResponse>
>({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "revertTransaction requires a signed-in caller");
  }
  const callerUid = request.auth.uid;

  const { childId, txnId } = request.data ?? {};
  if (typeof childId !== "string" || childId.length === 0) {
    throw new HttpsError("invalid-argument", "childId is required");
  }
  if (typeof txnId !== "string" || txnId.length === 0) {
    throw new HttpsError("invalid-argument", "txnId is required");
  }

  const db = getFirestore();
  const childRef = db.doc(`children/${childId}`);
  const txnRef = db.doc(`children/${childId}/transactions/${txnId}`);

  return db.runTransaction(async (tx) => {
    const [childSnap, txnSnap] = await Promise.all([
      tx.get(childRef),
      tx.get(txnRef),
    ]);

    const child = childSnap.exists ? (childSnap.data() as ChildDoc) : null;
    const txn = txnSnap.exists ? (txnSnap.data() as TransactionDoc) : null;

    const decision = decideRevert({ callerUid, txn, child });

    if (decision.kind === "reject") {
      throw new HttpsError(decision.code, decision.message);
    }
    if (decision.kind === "idempotent-replay") {
      logger.info("[revertTransaction] idempotent replay", { childId, txnId, callerUid });
      return { revertTxnId: decision.revertTxnId };
    }

    const revertRef = db.collection(`children/${childId}/transactions`).doc();
    tx.create(revertRef, {
      amount: decision.amount,
      type: decision.inverseType,
      description: decision.description,
      createdByUid: callerUid,
      revertsTransactionId: txnId,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(txnRef, { revertedByTxnId: revertRef.id });

    logger.info("[revertTransaction] reverted", {
      childId,
      txnId,
      revertTxnId: revertRef.id,
      callerUid,
    });
    return { revertTxnId: revertRef.id };
  });
});
