/**
 * revokeInvite — inviter cancels an unaccepted invite.
 *
 * Replaces client-side `deleteDoc(invites/{token})`. Moving this
 * path through a callable is what lets us:
 *
 *   1. Enforce a server-trusted "only the sender can revoke" check
 *      (the old client-side rule did the same, but bundling all
 *      invite mutations behind callables lets rules deny direct
 *      writes entirely).
 *   2. Refuse to revoke an already-accepted invite. Once accepted,
 *      the invite doc is historical — removing it would erase the
 *      audit trail without reversing the access grant. Use
 *      `removeParentFromChildren` to reverse an accepted invite.
 *
 * Accepted invites are left to expire and sit in the collection
 * until Firestore TTL (or a future scheduled cleanup) removes them.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { getFirestore } from "../admin";

interface InviteDoc {
  invitedByUid: string;
  acceptedByUid: string | null;
}

export interface RevokeInviteRequest {
  token: string;
}

export interface RevokeInviteResponse {
  revoked: boolean;
}

export type RevokeInviteDecision =
  | { kind: "revoke" }
  | { kind: "reject"; code: HttpsError["code"]; message: string };

// ─── Pure decision logic ────────────────────────────────────────────

export function decideRevokeInvite(params: {
  callerUid: string;
  invite: InviteDoc | null;
}): RevokeInviteDecision {
  const { callerUid, invite } = params;

  if (!invite) {
    return {
      kind: "reject",
      code: "not-found",
      message: "invite does not exist",
    };
  }
  if (invite.invitedByUid !== callerUid) {
    return {
      kind: "reject",
      code: "permission-denied",
      message: "only the inviter can revoke this invite",
    };
  }
  if (invite.acceptedByUid !== null) {
    return {
      kind: "reject",
      code: "failed-precondition",
      message:
        "invite has already been accepted — the invitee is now a co-parent. "
        + "Remove their access from the child instead of revoking the invite.",
    };
  }

  return { kind: "revoke" };
}

// ─── Handler ────────────────────────────────────────────────────────

export const revokeInvite = onCall<
  RevokeInviteRequest,
  Promise<RevokeInviteResponse>
>({ region: "us-central1", invoker: "public" }, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError(
      "unauthenticated",
      "revokeInvite requires a signed-in caller",
    );
  }
  const callerUid = request.auth.uid;

  const token = request.data?.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new HttpsError("invalid-argument", "token is required");
  }

  const db = getFirestore();
  const inviteRef = db.doc(`invites/${token}`);
  const snap = await inviteRef.get();
  const invite = snap.exists ? (snap.data() as InviteDoc) : null;

  const decision = decideRevokeInvite({ callerUid, invite });
  if (decision.kind === "reject") {
    throw new HttpsError(decision.code, decision.message);
  }

  await inviteRef.delete();

  logger.info("[revokeInvite] invite revoked", { token, callerUid });
  return { revoked: true };
});
