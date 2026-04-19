/**
 * unlockVault — mutating callable, slice 5.
 *
 * Per design §4.7. Releases a filled vault: appends a vault `UNLOCK`
 * row, appends a main-ledger `LODGE` row tagged `source:
 * 'VAULT_UNLOCK'`, bumps `child.balance` by the released amount, zeros
 * `vault.balance`, clears `vault.unlockedAt`, and resets
 * `vault.interest.lastAccrualWrite` to `now` (fresh cycle) when
 * interest is configured. Config (`target`, `interest`, `matching`) is
 * preserved across the unlock. `onTransactionCreate` sees the `source`
 * tag on the LODGE row and skips recompute — the balance bump is
 * already applied by this transaction.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { getFirestore, FieldValue, Timestamp } from "../admin";
import type { Vault } from "../lib/vault";

export interface UnlockVaultRequest {
  childId: string;
}

export interface UnlockVaultResponse {
  released: number;
}

interface ChildDoc {
  parentUids: string[];
  balance?: number;
  vault?: Vault | null;
}

export type UnlockVaultDecision =
  | { kind: "accept"; released: number; hasInterest: boolean }
  | { kind: "reject"; code: HttpsError["code"]; message: string };

export function decideUnlockVault(params: {
  callerUid: string;
  child: ChildDoc | null | undefined;
}): UnlockVaultDecision {
  const { callerUid, child } = params;
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
  if (vault.unlockedAt == null) {
    return {
      kind: "reject",
      code: "failed-precondition",
      message: "vault is not unlocked; nothing to release",
    };
  }
  const released = Number(vault.balance ?? 0);
  return {
    kind: "accept",
    released,
    hasInterest: vault.interest != null,
  };
}

export const unlockVault = onCall<
  UnlockVaultRequest,
  Promise<UnlockVaultResponse>
>({ region: "us-central1", invoker: "public" }, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError(
      "unauthenticated",
      "unlockVault requires a signed-in caller",
    );
  }
  const callerUid = request.auth.uid;
  const childId = request.data?.childId;
  if (typeof childId !== "string" || childId.length === 0) {
    throw new HttpsError("invalid-argument", "childId is required");
  }

  const db = getFirestore();
  const childRef = db.doc(`children/${childId}`);
  const mainTxnRef = db.collection(`children/${childId}/transactions`).doc();
  const vaultTxnRef = db
    .collection(`children/${childId}/vaultTransactions`)
    .doc();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(childRef);
    const child = snap.exists ? (snap.data() as ChildDoc) : null;
    const decision = decideUnlockVault({ callerUid, child });

    if (decision.kind === "reject") {
      throw new HttpsError(decision.code, decision.message);
    }

    const now = Timestamp.now();
    const { released, hasInterest } = decision;

    tx.create(vaultTxnRef, {
      type: "UNLOCK",
      amount: released,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.create(mainTxnRef, {
      type: "LODGE",
      source: "VAULT_UNLOCK",
      amount: released,
      description: "Vault unlocked",
      createdByUid: callerUid,
      createdAt: FieldValue.serverTimestamp(),
    });

    const childUpdate: Record<string, unknown> = {
      balance: FieldValue.increment(released),
      lastTxnAt: FieldValue.serverTimestamp(),
      version: FieldValue.increment(1),
      "vault.balance": 0,
      "vault.unlockedAt": null,
    };
    if (hasInterest) {
      childUpdate["vault.interest.lastAccrualWrite"] = now;
    }
    tx.update(childRef, childUpdate);

    logger.info("[unlockVault] released", {
      childId,
      callerUid,
      released,
    });
    return { released };
  });
});
