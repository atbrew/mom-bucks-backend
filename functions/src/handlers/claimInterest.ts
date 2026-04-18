/**
 * claimInterest — mutating callable, slice 5.
 *
 * Per design §4.4. Computes the interest payout server-side, writes
 * an INTEREST_CLAIM row, bumps the vault balance, advances the
 * accrual clock, and atomically sets `unlockedAt` if the payout
 * fills the vault to target.
 *
 * Never writes a MATCH row (design §4.4: interest claims are not
 * matched). No-op and no write when the computed payout is zero.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { getFirestore, FieldValue, Timestamp } from "../admin";
import { computeInterestPayout } from "../lib/vault";

export interface ClaimInterestRequest {
  childId: string;
}

export interface ClaimInterestResponse {
  paid: number;
  unlocked: boolean;
}

interface VaultInterest {
  weeklyRate: number;
  lastAccrualWrite: Timestamp;
}

interface Vault {
  balance: number;
  target: number;
  unlockedAt: Timestamp | null;
  interest: VaultInterest | null;
  matching: { rate: number } | null;
}

interface ChildDoc {
  parentUids: string[];
  vault?: Vault | null;
}

export type ClaimInterestDecision =
  | { kind: "pay"; payout: number; unlocks: boolean }
  | { kind: "noop" }
  | { kind: "reject"; code: HttpsError["code"]; message: string };

export function decideClaimInterest(params: {
  callerUid: string;
  child: ChildDoc | null | undefined;
  nowMs: number;
}): ClaimInterestDecision {
  const { callerUid, child, nowMs } = params;
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
  if (vault.interest == null) {
    return {
      kind: "reject",
      code: "failed-precondition",
      message: "interest is disabled on this vault",
    };
  }
  if (vault.unlockedAt != null) {
    return {
      kind: "reject",
      code: "failed-precondition",
      message: "vault is unlocked; call unlockVault before claiming interest",
    };
  }

  const lastAccrualMs = vault.interest.lastAccrualWrite?.toMillis?.();
  if (typeof lastAccrualMs !== "number") {
    return {
      kind: "reject",
      code: "failed-precondition",
      message: "vault.interest.lastAccrualWrite is missing",
    };
  }

  const balance = Number(vault.balance ?? 0);
  const target = Number(vault.target ?? 0);
  const payout = computeInterestPayout({
    balance,
    weeklyRate: Number(vault.interest.weeklyRate ?? 0),
    lastAccrualMs,
    nowMs,
    target,
  });
  if (payout === 0) return { kind: "noop" };

  const unlocks = balance + payout >= target;
  return { kind: "pay", payout, unlocks };
}

export const claimInterest = onCall<
  ClaimInterestRequest,
  Promise<ClaimInterestResponse>
>({ region: "us-central1", invoker: "public" }, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError(
      "unauthenticated",
      "claimInterest requires a signed-in caller",
    );
  }
  const callerUid = request.auth.uid;
  const childId = request.data?.childId;
  if (typeof childId !== "string" || childId.length === 0) {
    throw new HttpsError("invalid-argument", "childId is required");
  }

  const db = getFirestore();
  const childRef = db.doc(`children/${childId}`);
  const vaultTxnRef = db
    .collection(`children/${childId}/vaultTransactions`)
    .doc();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(childRef);
    const child = snap.exists ? (snap.data() as ChildDoc) : null;
    const now = Timestamp.now();
    const decision = decideClaimInterest({
      callerUid,
      child,
      nowMs: now.toMillis(),
    });

    if (decision.kind === "reject") {
      throw new HttpsError(decision.code, decision.message);
    }
    if (decision.kind === "noop") {
      logger.info("[claimInterest] noop (nothing accrued)", {
        childId,
        callerUid,
      });
      return { paid: 0, unlocked: false };
    }

    tx.create(vaultTxnRef, {
      type: "INTEREST_CLAIM",
      amount: decision.payout,
      createdAt: FieldValue.serverTimestamp(),
    });

    const childUpdate: Record<string, unknown> = {
      "vault.balance": FieldValue.increment(decision.payout),
      "vault.interest.lastAccrualWrite": now,
    };
    if (decision.unlocks) {
      childUpdate["vault.unlockedAt"] = now;
    }
    tx.update(childRef, childUpdate);

    logger.info("[claimInterest] paid", {
      childId,
      payout: decision.payout,
      unlocked: decision.unlocks,
      callerUid,
    });
    return { paid: decision.payout, unlocked: decision.unlocks };
  });
});
