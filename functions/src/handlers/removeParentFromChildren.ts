/**
 * removeParentFromChildren — Phase 4, issue #14.
 *
 * Callable that removes a uid from one or more children's
 * parentUids[]. Handles the "we split up; remove Bob from Sam and
 * Jamie but leave him on his own kids" case.
 *
 * Security contract (see firestore.rules):
 *   - Clients cannot directly mutate `children/{childId}.parentUids`.
 *   - This callable is the ONLY path for removing a uid from
 *     parentUids (acceptInvite #13 is the only path for adding).
 *
 * Guardrails:
 *   - **Last-parent standing.** The function MUST refuse to remove
 *     the last uid from `parentUids`. Orphaning a child leaves it
 *     accessible to nobody and there is no recovery path short of
 *     direct Firestore console intervention.
 *   - **Authorization.** The caller must currently be in
 *     `parentUids` of every child in the request. You cannot strip
 *     access to a child you don't co-parent.
 *   - **Self-removal is allowed.** A parent wanting to leave a
 *     co-parenting arrangement passes `targetUid === request.auth.uid`.
 *     Same guardrails apply.
 *
 * The function is per-child best-effort: if the caller asks to
 * remove targetUid from [sam, jamie] and the check fails for jamie
 * (e.g. caller isn't a parent of jamie), sam is still updated and
 * jamie comes back as a `skipped` entry. This matches the client UX
 * where a single call can span multiple children but each is
 * independent.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { getFirestore, FieldValue } from "../admin";

interface ChildDoc {
  parentUids: string[];
  name?: string;
}

export interface RemoveParentRequest {
  targetUid: string;
  childIds: string[];
}

export interface RemoveParentResponse {
  removedFrom: string[];
  skipped: Array<{ childId: string; reason: RemoveParentSkipReason }>;
}

export type RemoveParentSkipReason =
  | "CHILD_NOT_FOUND"
  | "CALLER_NOT_PARENT"
  | "TARGET_NOT_PARENT"
  | "WOULD_ORPHAN_CHILD";

export type RemoveParentDecision =
  | { kind: "apply"; removeUid: string }
  | { kind: "skip"; reason: RemoveParentSkipReason };

// ─── Pure decision logic ────────────────────────────────────────────

/**
 * Given a child doc (possibly null) and the caller + target uids,
 * decide whether this particular child's `parentUids` should be
 * mutated. Pure so we can unit-test the last-parent guard and the
 * authorization checks without mocking Firestore.
 */
export function decideRemoval(params: {
  callerUid: string;
  targetUid: string;
  child: ChildDoc | null;
}): RemoveParentDecision {
  const { callerUid, targetUid, child } = params;

  if (!child) {
    return { kind: "skip", reason: "CHILD_NOT_FOUND" };
  }

  const parentUids = child.parentUids ?? [];

  if (!parentUids.includes(callerUid)) {
    return { kind: "skip", reason: "CALLER_NOT_PARENT" };
  }

  if (!parentUids.includes(targetUid)) {
    // Target is already not a parent — treat as a successful no-op
    // is tempting, but we report TARGET_NOT_PARENT so the client
    // knows there was nothing to do (clearer than "success, nothing
    // changed"). Idempotent either way.
    return { kind: "skip", reason: "TARGET_NOT_PARENT" };
  }

  // The critical guardrail — don't let the array become empty.
  // This catches: single-parent child removing themselves, or a
  // two-parent child where the second parent was already removed
  // but the client doesn't know yet.
  if (parentUids.length === 1 && parentUids[0] === targetUid) {
    return { kind: "skip", reason: "WOULD_ORPHAN_CHILD" };
  }

  return { kind: "apply", removeUid: targetUid };
}

// ─── Handler ────────────────────────────────────────────────────────

export const removeParentFromChildren = onCall<
  RemoveParentRequest,
  Promise<RemoveParentResponse>
>({ region: "us-central1", invoker: "public" }, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError(
      "unauthenticated",
      "removeParentFromChildren requires a signed-in caller",
    );
  }
  const callerUid = request.auth.uid;

  const { targetUid, childIds } = request.data ?? {};
  if (typeof targetUid !== "string" || targetUid.length === 0) {
    throw new HttpsError("invalid-argument", "targetUid is required");
  }
  if (!Array.isArray(childIds) || childIds.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "childIds must be a non-empty array",
    );
  }
  if (childIds.length > 20) {
    throw new HttpsError(
      "invalid-argument",
      "childIds is limited to 20 entries per call",
    );
  }

  const db = getFirestore();
  const removedFrom: string[] = [];
  const skipped: RemoveParentResponse["skipped"] = [];

  // Run the whole thing in a single transaction so the last-parent
  // check can't race with a concurrent remove. Worst case the
  // transaction retries, but each per-child decision is still pure
  // and deterministic given its current parentUids.
  await db.runTransaction(async (tx) => {
    // Reset result arrays on retry so we don't double-count.
    removedFrom.length = 0;
    skipped.length = 0;

    const refs = childIds.map((id) => db.doc(`children/${id}`));
    const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));

    for (let i = 0; i < refs.length; i += 1) {
      const ref = refs[i];
      const snap = snaps[i];
      const childId = childIds[i];
      if (!ref || !snap || !childId) continue;

      const child = snap.exists ? (snap.data() as ChildDoc) : null;
      const decision = decideRemoval({ callerUid, targetUid, child });

      if (decision.kind === "skip") {
        skipped.push({ childId, reason: decision.reason });
        continue;
      }

      tx.update(ref, {
        parentUids: FieldValue.arrayRemove(targetUid),
      });
      removedFrom.push(childId);
    }
  });

  logger.info("[removeParentFromChildren] complete", {
    callerUid,
    targetUid,
    removedFromCount: removedFrom.length,
    skippedCount: skipped.length,
  });

  return { removedFrom, skipped };
});
