/**
 * acceptInvite — Phase 4, issue #13.
 *
 * Callable that lets a freshly authenticated user redeem an invite
 * token, gaining access to the children listed on it. This is what
 * backs the "join my family" UX in the clients.
 *
 * Security contract (see firestore.rules):
 *   - Clients cannot directly mutate `children/{childId}.parentUids`.
 *   - The ONLY paths that can mutate it are this callable and
 *     removeParentFromChildren (#14), which use the Admin SDK to
 *     bypass the rules.
 *   - Rules cannot iterate an array of `get()` calls, so they can't
 *     verify "the inviter is still in parentUids of every listed
 *     child" at create time. This callable MUST re-verify that
 *     invariant at acceptance time, otherwise a revoked parent's
 *     stale invite could resurrect their access.
 *
 * Runtime behaviour, inside a Firestore transaction:
 *   1. Read `invites/{token}`. Reject if missing, expired, or
 *      already consumed by a different uid.
 *   2. If `invitedEmail` is set, verify the caller's email matches.
 *   3. For each childId in the invite's childIds[]:
 *        a. Read the child doc.
 *        b. Reject if the inviter is no longer in parentUids.
 *        c. arrayUnion the caller's uid into parentUids.
 *   4. Mark the invite consumed: set `acceptedByUid` and `acceptedAt`.
 *   5. Return the list of childIds the caller now has access to.
 *
 * Idempotency: if the invite was already consumed by the SAME uid
 * (e.g. a client retry after a network hiccup), we return success
 * with the same childIds rather than failing. Accepted by a
 * DIFFERENT uid is a hard error.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { getFirestore, FieldValue, Timestamp } from "../admin";

// ─── Types ──────────────────────────────────────────────────────────

interface InviteDoc {
  childIds: string[];
  invitedByUid: string;
  invitedEmail: string | null;
  expiresAt: Timestamp;
  acceptedByUid: string | null;
  acceptedAt: Timestamp | null;
}

interface ChildDoc {
  parentUids: string[];
  name?: string;
}

export interface AcceptInviteRequest {
  token: string;
}

export interface AcceptInviteResponse {
  childIds: string[];
}

export type AcceptInviteDecision =
  | { kind: "accept"; childIds: string[] }
  | { kind: "idempotent-replay"; childIds: string[] }
  | { kind: "reject"; code: HttpsError["code"]; message: string };

// ─── Pure decision logic ────────────────────────────────────────────

/**
 * Given an invite doc, the set of child docs the invite references,
 * and the caller's identity, decide what the callable should do.
 *
 * This is the interesting part of acceptInvite — rejecting expired /
 * stale / impersonated invites, allowing idempotent retries, and
 * enforcing that the inviter is STILL a parent of every listed child
 * at acceptance time. Extracted from the transactional wrapper so it
 * can be unit-tested without mocking Firestore.
 */
export function decideInviteAcceptance(params: {
  callerUid: string;
  callerEmail: string | null;
  invite: InviteDoc | null | undefined;
  children: Map<string, ChildDoc | null>;
  nowMs: number;
}): AcceptInviteDecision {
  const { callerUid, callerEmail, invite, children, nowMs } = params;

  if (!invite) {
    return {
      kind: "reject",
      code: "not-found",
      message: "invite does not exist",
    };
  }

  const expiresAtMs = invite.expiresAt?.toMillis?.() ?? 0;
  if (expiresAtMs <= nowMs) {
    return {
      kind: "reject",
      code: "deadline-exceeded",
      message: "invite has expired",
    };
  }

  if (invite.acceptedByUid) {
    if (invite.acceptedByUid === callerUid) {
      return { kind: "idempotent-replay", childIds: invite.childIds };
    }
    return {
      kind: "reject",
      code: "already-exists",
      message: "invite has already been accepted by another user",
    };
  }

  if (
    invite.invitedEmail &&
    callerEmail &&
    invite.invitedEmail.toLowerCase() !== callerEmail.toLowerCase()
  ) {
    return {
      kind: "reject",
      code: "permission-denied",
      message: "invite was issued to a different email address",
    };
  }

  if (!Array.isArray(invite.childIds) || invite.childIds.length === 0) {
    return {
      kind: "reject",
      code: "failed-precondition",
      message: "invite has no childIds",
    };
  }

  // Re-verify the inviter is still a parent of every listed child.
  // This is the invariant that rules cannot enforce at create time.
  for (const childId of invite.childIds) {
    const child = children.get(childId);
    if (!child) {
      return {
        kind: "reject",
        code: "not-found",
        message: `child ${childId} no longer exists`,
      };
    }
    if (!child.parentUids?.includes(invite.invitedByUid)) {
      return {
        kind: "reject",
        code: "permission-denied",
        message: `inviter is no longer authorised to grant access to child ${childId}`,
      };
    }
  }

  return { kind: "accept", childIds: invite.childIds };
}

// ─── Handler ────────────────────────────────────────────────────────

export const acceptInvite = onCall<
  AcceptInviteRequest,
  Promise<AcceptInviteResponse>
>({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError(
      "unauthenticated",
      "acceptInvite requires a signed-in caller",
    );
  }
  const callerUid = request.auth.uid;
  const callerEmail = (request.auth.token?.email as string | undefined) ?? null;

  const token = request.data?.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new HttpsError("invalid-argument", "token is required");
  }

  const db = getFirestore();
  const inviteRef = db.doc(`invites/${token}`);

  return db.runTransaction(async (tx) => {
    const inviteSnap = await tx.get(inviteRef);
    const invite = inviteSnap.exists
      ? (inviteSnap.data() as InviteDoc)
      : null;

    // Read the child docs up front so decideInviteAcceptance can be
    // a pure function. Skip if we already know we're going to reject.
    const childIds = invite?.childIds ?? [];
    const childRefs = childIds.map((id) => db.doc(`children/${id}`));
    const childSnaps = await Promise.all(childRefs.map((ref) => tx.get(ref)));
    const children = new Map<string, ChildDoc | null>();
    childIds.forEach((id, i) => {
      const snap = childSnaps[i];
      children.set(id, snap?.exists ? (snap.data() as ChildDoc) : null);
    });

    const decision = decideInviteAcceptance({
      callerUid,
      callerEmail,
      invite,
      children,
      nowMs: Date.now(),
    });

    if (decision.kind === "reject") {
      throw new HttpsError(decision.code, decision.message);
    }
    if (decision.kind === "idempotent-replay") {
      logger.info("[acceptInvite] idempotent replay", { token, callerUid });
      return { childIds: decision.childIds };
    }

    // kind === "accept" — mutate.
    for (const ref of childRefs) {
      tx.update(ref, {
        parentUids: FieldValue.arrayUnion(callerUid),
      });
    }
    tx.update(inviteRef, {
      acceptedByUid: callerUid,
      acceptedAt: FieldValue.serverTimestamp(),
    });

    logger.info("[acceptInvite] invite consumed", {
      token,
      callerUid,
      childIds: decision.childIds,
    });
    return { childIds: decision.childIds };
  });
});
