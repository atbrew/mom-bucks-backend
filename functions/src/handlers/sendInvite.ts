/**
 * sendInvite — co-parenting invite creation callable.
 *
 * Replaces client-side Firestore writes to `invites/{token}`. Moving
 * this path through a callable is what lets us:
 *
 *   1. Denormalise `childName` and `invitedByDisplayName` onto the
 *      invite doc at creation time, so the inbox list view doesn't
 *      need N+1 reads to render human-readable names.
 *   2. Normalise `invitedEmail` to lowercase — the inbox rule
 *      (`invitedEmail == request.auth.token.email.lower()`) relies
 *      on the stored value being already lowercased. Enforcing that
 *      in a trusted code path is simpler than a rule-level check.
 *   3. Set `expiresAt` and `createdAt` server-side, so a bad clock on
 *      a client can't mint an invite that never expires.
 *
 * Resend semantics ("delete and recreate"):
 *   If an unaccepted invite already exists for the same
 *   `(childId, invitedEmail)` pair (whether still live or already
 *   expired), it is deleted in the same transaction that writes the
 *   new one. Effect: calling sendInvite twice for the same target
 *   yields a single fresh invite with a new token and a new 7-day
 *   TTL, not two competing docs in the invitee's inbox. Accepted
 *   invites are left alone as historical records.
 *
 * Security contract:
 *   - Clients cannot write to `invites/{token}` directly (rules deny
 *     all client writes on the collection).
 *   - The caller must be in `parentUids` of the target child. This
 *     is the same defence-in-depth check the old `allow create` rule
 *     used to perform — now enforced in trusted code.
 *
 * Invite expiry is a fixed 7 days from creation. Changing that window
 * requires a deploy, which is intentional: short-lived invites are a
 * security affordance.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { getFirestore, FieldValue, Timestamp } from "../admin";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface ChildDoc {
  parentUids: string[];
  name?: string;
}

export interface SendInviteRequest {
  childId: string;
  invitedEmail: string;
}

export interface SendInviteResponse {
  token: string;
}

export type SendInviteDecision =
  | { kind: "send"; normalizedEmail: string }
  | { kind: "reject"; code: HttpsError["code"]; message: string };

// ─── Pure decision logic ────────────────────────────────────────────

/**
 * Given the caller (uid + email), child doc, and raw invitedEmail,
 * decide whether the invite should be created. Pure so the
 * parent-membership check, self-invite guard, and email normalisation
 * can be unit-tested without the Firestore transaction machinery.
 * Pass ``callerEmail`` as null for phone/anonymous-auth callers; the
 * self-invite guard is skipped when no email is present.
 */
export function decideSendInvite(params: {
  callerUid: string;
  callerEmail: string | null | undefined;
  childId: string;
  invitedEmail: string;
  child: ChildDoc | null;
}): SendInviteDecision {
  const { callerUid, callerEmail, childId, invitedEmail, child } = params;

  if (typeof childId !== "string" || childId.length === 0) {
    return {
      kind: "reject",
      code: "invalid-argument",
      message: "childId is required",
    };
  }
  if (typeof invitedEmail !== "string" || invitedEmail.length === 0) {
    return {
      kind: "reject",
      code: "invalid-argument",
      message: "invitedEmail is required",
    };
  }
  if (!invitedEmail.includes("@")) {
    return {
      kind: "reject",
      code: "invalid-argument",
      message: "invitedEmail must be a valid email address",
    };
  }

  if (!child) {
    return {
      kind: "reject",
      code: "not-found",
      message: `child ${childId} not found`,
    };
  }
  if (!child.parentUids?.includes(callerUid)) {
    return {
      kind: "reject",
      code: "permission-denied",
      message: "caller is not a parent of this child",
    };
  }

  const normalizedEmail = invitedEmail.trim().toLowerCase();

  // Self-invite is never meaningful: the inviter is already a parent
  // (checked above), so accepting their own invite is a no-op at best
  // and clutters the inbox at worst. Reject before we mint a doc.
  // Only enforceable when the auth token carries an email; providers
  // without email (phone auth, anonymous) can't self-invite by email
  // anyway.
  if (
    callerEmail != null
    && callerEmail.trim().toLowerCase() === normalizedEmail
  ) {
    return {
      kind: "reject",
      code: "invalid-argument",
      message: "cannot invite yourself",
    };
  }

  return { kind: "send", normalizedEmail };
}

// ─── Handler ────────────────────────────────────────────────────────

export const sendInvite = onCall<
  SendInviteRequest,
  Promise<SendInviteResponse>
>({ region: "us-central1", invoker: "public" }, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError(
      "unauthenticated",
      "sendInvite requires a signed-in caller",
    );
  }
  const callerUid = request.auth.uid;
  const callerEmail =
    (request.auth.token?.email as string | undefined) ?? null;

  const { childId, invitedEmail } = request.data ?? ({} as SendInviteRequest);

  const db = getFirestore();
  const childRef = db.doc(`children/${childId}`);
  const userRef = db.doc(`users/${callerUid}`);

  return db.runTransaction(async (tx) => {
    const childSnap = await tx.get(childRef);
    const child = childSnap.exists ? (childSnap.data() as ChildDoc) : null;

    const decision = decideSendInvite({
      callerUid,
      callerEmail,
      childId,
      invitedEmail,
      child,
    });
    if (decision.kind === "reject") {
      throw new HttpsError(decision.code, decision.message);
    }

    // Find unaccepted invites for the same (childId, invitedEmail)
    // pair. These get superseded: a resend replaces the old invite
    // atomically rather than cluttering the inbox. The query
    // deliberately does NOT filter by expiresAt — expired-but-
    // unaccepted invites are also renewal candidates.
    const supersedeQuery = db
      .collection("invites")
      .where("childId", "==", childId)
      .where("invitedEmail", "==", decision.normalizedEmail)
      .where("acceptedByUid", "==", null);
    const supersedeSnap = await tx.get(supersedeQuery);

    // Denormalise display name from the users/{uid} doc. If it's
    // missing (edge case — trigger hasn't fired yet, or user doc was
    // deleted), fall back to empty string so the invite still sends.
    // displayName is cosmetic; the rule check uses invitedByUid.
    const userSnap = await tx.get(userRef);
    const invitedByDisplayName =
      (userSnap.exists ? (userSnap.get("displayName") as string) : "") ?? "";

    for (const doc of supersedeSnap.docs) {
      tx.delete(doc.ref);
    }

    // We use Firestore's auto-id as the token. It's 20 chars of secure
    // random alphabet — same property the old client path relied on.
    const inviteRef = db.collection("invites").doc();
    const token = inviteRef.id;
    const expiresAt = Timestamp.fromMillis(Date.now() + INVITE_TTL_MS);

    tx.set(inviteRef, {
      childId,
      childName: child?.name ?? "",
      invitedByUid: callerUid,
      invitedByDisplayName,
      invitedEmail: decision.normalizedEmail,
      expiresAt,
      createdAt: FieldValue.serverTimestamp(),
      acceptedByUid: null,
      acceptedAt: null,
    });

    logger.info("[sendInvite] invite created", {
      token,
      callerUid,
      childId,
      invitedEmail: decision.normalizedEmail,
      supersededCount: supersedeSnap.size,
    });

    return { token };
  });
});
