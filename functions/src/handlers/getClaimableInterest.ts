/**
 * getClaimableInterest — read-only callable, slice 5.
 *
 * Returns the integer cents of interest claimable on the child's
 * vault right now. No writes; safe to call on every UI render.
 *
 * Mirrors design §4.3. Returns 0 when:
 *   - vault is null (unconfigured),
 *   - vault.interest is null (interest disabled),
 *   - vault.unlockedAt is not null (vault cycle already hit target).
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, Timestamp } from "../admin";
import { computeInterestPayout } from "../lib/vault";

export interface GetClaimableInterestRequest {
  childId: string;
}

export interface GetClaimableInterestResponse {
  claimable: number;
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

export function decideClaimableInterest(params: {
  callerUid: string;
  child: ChildDoc | null | undefined;
  nowMs: number;
}): { claimable: number } | { reject: { code: HttpsError["code"]; message: string } } {
  const { callerUid, child, nowMs } = params;
  if (!child) {
    return { reject: { code: "not-found", message: "child does not exist" } };
  }
  if (!child.parentUids?.includes(callerUid)) {
    return {
      reject: {
        code: "permission-denied",
        message: "caller is not a parent of this child",
      },
    };
  }
  const vault = child.vault ?? null;
  if (!vault) return { claimable: 0 };
  if (vault.interest == null) return { claimable: 0 };
  if (vault.unlockedAt != null) return { claimable: 0 };

  const lastAccrualMs = vault.interest.lastAccrualWrite?.toMillis?.();
  if (typeof lastAccrualMs !== "number") return { claimable: 0 };

  return {
    claimable: computeInterestPayout({
      balance: Number(vault.balance ?? 0),
      weeklyRate: Number(vault.interest.weeklyRate ?? 0),
      lastAccrualMs,
      nowMs,
      target: Number(vault.target ?? 0),
    }),
  };
}

export const getClaimableInterest = onCall<
  GetClaimableInterestRequest,
  Promise<GetClaimableInterestResponse>
>({ region: "us-central1", invoker: "public" }, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError(
      "unauthenticated",
      "getClaimableInterest requires a signed-in caller",
    );
  }
  const callerUid = request.auth.uid;
  const childId = request.data?.childId;
  if (typeof childId !== "string" || childId.length === 0) {
    throw new HttpsError("invalid-argument", "childId is required");
  }

  const db = getFirestore();
  const snap = await db.doc(`children/${childId}`).get();
  const child = snap.exists ? (snap.data() as ChildDoc) : null;
  const result = decideClaimableInterest({
    callerUid,
    child,
    nowMs: Date.now(),
  });
  if ("reject" in result) {
    throw new HttpsError(result.reject.code, result.reject.message);
  }
  return { claimable: result.claimable };
});
