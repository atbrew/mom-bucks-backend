/**
 * acceptInvite — Phase 4, issue #13.
 *
 * Callable that lets a freshly authenticated user redeem an invite
 * token, gaining access to the single child listed on it. This is
 * what backs the "join my family" UX in the clients.
 *
 * Invites are issued one child at a time. If a parent wants to share
 * two children they send two invite links — the extra round trip is
 * cheap and it keeps the security boundary simple: one invite, one
 * child, one `arrayUnion` at acceptance time.
 *
 * Security contract (see firestore.rules):
 *   - Clients cannot directly mutate `children/{childId}.parentUids`.
 *   - The ONLY paths that can mutate it are this callable and
 *     removeParentFromChildren (#14), which use the Admin SDK to
 *     bypass the rules.
 *   - Rules cannot follow a `get()` chain from the invite doc to the
 *     referenced child and cross-check membership at create time. This
 *     callable MUST re-verify the invariant ("the inviter is still in
 *     parentUids of the child") at acceptance time, otherwise a
 *     revoked parent's stale invite could resurrect their access.
 *
 * Runtime behaviour, inside a Firestore transaction:
 *   1. Read `invites/{token}`. Reject if missing, expired, or
 *      already consumed by a different uid.
 *   2. If `invitedEmail` is set, verify the caller's email matches.
 *   3. Read the child doc. Reject if it's gone or if the inviter is
 *      no longer in parentUids.
 *   4. arrayUnion the caller's uid into the child's parentUids.
 *   5. Mark the invite consumed: set `acceptedByUid` and `acceptedAt`.
 *   6. Return the childId the caller now has access to.
 *
 * Idempotency: if the invite was already consumed by the SAME uid
 * (e.g. a client retry after a network hiccup), we return success
 * with the same childId rather than failing. Accepted by a
 * DIFFERENT uid is a hard error.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { getFirestore, FieldValue, Timestamp } from "../admin";

// ─── Types ──────────────────────────────────────────────────────────

interface InviteDoc {
  childId: string;
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
  childId: string;
}

export type AcceptInviteDecision =
  | { kind: "accept"; childId: string }
  | { kind: "idempotent-replay"; childId: string }
  | { kind: "reject"; code: HttpsError["code"]; message: string };

// ─── Pure decision logic ────────────────────────────────────────────

/**
 * Given an invite doc, the referenced child doc, and the caller's
 * identity, decide what the callable should do.
 *
 * This is the interesting part of acceptInvite — rejecting expired /
 * stale / impersonated invites, allowing idempotent retries, and
 * enforcing that the inviter is STILL a parent of the child at
 * acceptance time. Extracted from the transactional wrapper so it
 * can be unit-tested without mocking Firestore.
 */
export function decideInviteAcceptance(params: {
  callerUid: string;
  callerEmail: string | null;
  invite: InviteDoc | null | undefined;
  child: ChildDoc | null | undefined;
  nowMs: number;
}): AcceptInviteDecision {
  const { callerUid, callerEmail, invite, child, nowMs } = params;

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
      return { kind: "idempotent-replay", childId: invite.childId };
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

  if (typeof invite.childId !== "string" || invite.childId.length === 0) {
    return {
      kind: "reject",
      code: "failed-precondition",
      message: "invite has no childId",
    };
  }

  if (!child) {
    return {
      kind: "reject",
      code: "not-found",
      message: `child ${invite.childId} no longer exists`,
    };
  }
  if (!child.parentUids?.includes(invite.invitedByUid)) {
    return {
      kind: "reject",
      code: "permission-denied",
      message: `inviter is no longer authorised to grant access to child ${invite.childId}`,
    };
  }

  return { kind: "accept", childId: invite.childId };
}

// ─── Handler ────────────────────────────────────────────────────────

export const acceptInvite = onCall<
  AcceptInviteRequest,
  Promise<AcceptInviteResponse>
>({ region: "us-central1", invoker: "public" }, async (request) => {
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

    // Read the child doc up front so decideInviteAcceptance can be a
    // pure function. Skip if the invite is missing (no childId to look
    // up) — decideInviteAcceptance will reject on that branch.
    let child: ChildDoc | null = null;
    let childRef: FirebaseFirestore.DocumentReference | null = null;
    if (invite?.childId) {
      childRef = db.doc(`children/${invite.childId}`);
      const childSnap = await tx.get(childRef);
      child = childSnap.exists ? (childSnap.data() as ChildDoc) : null;
    }

    const decision = decideInviteAcceptance({
      callerUid,
      callerEmail,
      invite,
      child,
      nowMs: Date.now(),
    });

    if (decision.kind === "reject") {
      throw new HttpsError(decision.code, decision.message);
    }
    if (decision.kind === "idempotent-replay") {
      logger.info("[acceptInvite] idempotent replay", { token, callerUid });
      return { childId: decision.childId };
    }

    // kind === "accept" — mutate.
    if (!childRef) {
      // Unreachable: we only reach "accept" when invite.childId is set,
      // which means childRef was populated above. Guard for the type
      // checker.
      throw new HttpsError("internal", "childRef missing on accept branch");
    }
    tx.update(childRef, {
      parentUids: FieldValue.arrayUnion(callerUid),
    });
    tx.update(inviteRef, {
      acceptedByUid: callerUid,
      acceptedAt: FieldValue.serverTimestamp(),
    });

    logger.info("[acceptInvite] invite consumed", {
      token,
      callerUid,
      childId: decision.childId,
    });
    return { childId: decision.childId };
  });
});
