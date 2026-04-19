/**
 * depositToVault — mutating callable, slice 5.
 *
 * Per design §4.6. Moves money from the child's main balance into the
 * vault. Interest-first ordering: claims interest first, then sizes
 * the deposit against the post-interest room, then sizes the optional
 * match against the remaining room, then atomically unlocks the vault
 * if `balance >= target` afterwards. All state — main balance, vault
 * balance, ledger rows — lands in a single Firestore transaction. The
 * main-ledger WITHDRAW row is tagged `source: 'VAULT_DEPOSIT'` so
 * `onTransactionCreate` skips re-applying the balance delta (the
 * transaction here already did it).
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { getFirestore, FieldValue, Timestamp } from "../admin";
import {
  computeInterestPayout,
  computeMatchAmount,
  computeMaxDeposit,
  type Vault,
} from "../lib/vault";

export interface DepositToVaultRequest {
  childId: string;
  amount: number;
}

export interface DepositToVaultResponse {
  interestClaimed: number;
  deposited: number;
  matched: number;
  remainedInMain: number;
  unlocked: boolean;
}

interface ChildDoc {
  parentUids: string[];
  balance?: number;
  vault?: Vault | null;
}

export type DepositToVaultDecision =
  | {
      kind: "accept";
      interestClaimed: number;
      actualDeposit: number;
      matchAmount: number;
      remainedInMain: number;
      unlocks: boolean;
      advanceInterestClock: boolean;
    }
  | { kind: "reject"; code: HttpsError["code"]; message: string };

export function decideDepositToVault(params: {
  callerUid: string;
  child: ChildDoc | null | undefined;
  amount: number;
  nowMs: number;
}): DepositToVaultDecision {
  const { callerUid, child, amount, nowMs } = params;

  if (!child) {
    return { kind: "reject", code: "not-found", message: "child does not exist" };
  }
  if (!child.parentUids?.includes(callerUid)) {
    return {
      kind: "reject",
      code: "permission-denied",
      message: "caller is not a parent of this child",
    };
  }
  const vault = child.vault ?? null;
  if (!vault) {
    return {
      kind: "reject",
      code: "failed-precondition",
      message: "vault is not configured for this child",
    };
  }
  if (vault.unlockedAt != null) {
    return {
      kind: "reject",
      code: "failed-precondition",
      message: "vault is unlocked; call unlockVault before depositing",
    };
  }

  if (!Number.isInteger(amount) || amount <= 0) {
    return {
      kind: "reject",
      code: "invalid-argument",
      message: "amount must be a positive integer number of cents",
    };
  }

  const childBalance = Number(child.balance ?? 0);
  if (amount > childBalance) {
    return {
      kind: "reject",
      code: "failed-precondition",
      message: `amount exceeds main balance (${amount} > ${childBalance})`,
    };
  }

  const target = Number(vault.target ?? 0);
  let vaultBalance = Number(vault.balance ?? 0);

  // Step A — claim interest first.
  let interestClaimed = 0;
  if (vault.interest != null) {
    const lastMs = vault.interest.lastAccrualWrite?.toMillis?.();
    if (typeof lastMs !== "number") {
      return {
        kind: "reject",
        code: "failed-precondition",
        message: "vault.interest.lastAccrualWrite is missing",
      };
    }
    interestClaimed = computeInterestPayout({
      balance: vaultBalance,
      weeklyRate: Number(vault.interest.weeklyRate ?? 0),
      lastAccrualMs: lastMs,
      nowMs,
      target,
    });
    if (interestClaimed > 0) {
      vaultBalance += interestClaimed;
    }
  }

  // Step B — compute deposit sizing against the post-interest room.
  const matchingRate = vault.matching?.rate ?? null;
  let actualDeposit = 0;
  let matchAmount = 0;
  const roomAfterInterest = target - vaultBalance;
  if (roomAfterInterest > 0) {
    const maxDeposit = computeMaxDeposit({
      roomAfterInterest,
      matchingRate,
    });
    actualDeposit = Math.min(amount, maxDeposit);
    if (actualDeposit > 0) {
      vaultBalance += actualDeposit;
      matchAmount = computeMatchAmount({
        deposit: actualDeposit,
        matchingRate,
        room: target - vaultBalance,
      });
      if (matchAmount > 0) {
        vaultBalance += matchAmount;
      }
    }
  }

  // Step D — unlock check.
  const unlocks = vaultBalance >= target;

  // Interest clock advances whenever any vault-mutating event fires,
  // but only when interest is configured (no field to advance otherwise).
  const advanceInterestClock =
    vault.interest != null &&
    (interestClaimed > 0 || actualDeposit > 0 || matchAmount > 0);

  return {
    kind: "accept",
    interestClaimed,
    actualDeposit,
    matchAmount,
    remainedInMain: amount - actualDeposit,
    unlocks,
    advanceInterestClock,
  };
}

export const depositToVault = onCall<
  DepositToVaultRequest,
  Promise<DepositToVaultResponse>
>({ region: "us-central1", invoker: "public" }, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError(
      "unauthenticated",
      "depositToVault requires a signed-in caller",
    );
  }
  const callerUid = request.auth.uid;
  const data = request.data ?? ({} as Partial<DepositToVaultRequest>);
  const childId = data.childId;
  const amount = data.amount;
  if (typeof childId !== "string" || childId.length === 0) {
    throw new HttpsError("invalid-argument", "childId is required");
  }
  if (typeof amount !== "number") {
    throw new HttpsError("invalid-argument", "amount must be a number");
  }

  const db = getFirestore();
  const childRef = db.doc(`children/${childId}`);
  const mainTxnsRef = db.collection(`children/${childId}/transactions`);
  const vaultTxnsRef = db.collection(
    `children/${childId}/vaultTransactions`,
  );

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(childRef);
    const child = snap.exists ? (snap.data() as ChildDoc) : null;
    const now = Timestamp.now();
    const decision = decideDepositToVault({
      callerUid,
      child,
      amount,
      nowMs: now.toMillis(),
    });

    if (decision.kind === "reject") {
      throw new HttpsError(decision.code, decision.message);
    }

    // Step A — INTEREST_CLAIM row.
    if (decision.interestClaimed > 0) {
      tx.create(vaultTxnsRef.doc(), {
        type: "INTEREST_CLAIM",
        amount: decision.interestClaimed,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    // Step C — main WITHDRAW + vault DEPOSIT + optional MATCH.
    if (decision.actualDeposit > 0) {
      tx.create(mainTxnsRef.doc(), {
        type: "WITHDRAW",
        source: "VAULT_DEPOSIT",
        amount: decision.actualDeposit,
        description: "Vault deposit",
        createdByUid: callerUid,
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.create(vaultTxnsRef.doc(), {
        type: "DEPOSIT",
        amount: decision.actualDeposit,
        createdAt: FieldValue.serverTimestamp(),
      });
      if (decision.matchAmount > 0) {
        tx.create(vaultTxnsRef.doc(), {
          type: "MATCH",
          amount: decision.matchAmount,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
    }

    // Main `child.balance` is decremented inline in this same
    // transaction. `onTransactionCreate` sees the WITHDRAW row's
    // `source: 'VAULT_DEPOSIT'` tag and skips — otherwise the amount
    // would be double-debited.
    const childUpdate: Record<string, unknown> = {};
    const vaultBalanceDelta =
      decision.interestClaimed + decision.actualDeposit + decision.matchAmount;
    if (vaultBalanceDelta > 0) {
      childUpdate["vault.balance"] = FieldValue.increment(vaultBalanceDelta);
    }
    if (decision.actualDeposit > 0) {
      childUpdate.balance = FieldValue.increment(-decision.actualDeposit);
    }
    if (decision.advanceInterestClock) {
      childUpdate["vault.interest.lastAccrualWrite"] = now;
    }
    if (decision.unlocks) {
      childUpdate["vault.unlockedAt"] = now;
    }
    if (Object.keys(childUpdate).length > 0) {
      childUpdate.lastTxnAt = FieldValue.serverTimestamp();
      childUpdate.version = FieldValue.increment(1);
      tx.update(childRef, childUpdate);
    }

    logger.info("[depositToVault] applied", {
      childId,
      callerUid,
      interestClaimed: decision.interestClaimed,
      deposited: decision.actualDeposit,
      matched: decision.matchAmount,
      remainedInMain: decision.remainedInMain,
      unlocked: decision.unlocks,
    });

    return {
      interestClaimed: decision.interestClaimed,
      deposited: decision.actualDeposit,
      matched: decision.matchAmount,
      remainedInMain: decision.remainedInMain,
      unlocked: decision.unlocks,
    };
  });
});
