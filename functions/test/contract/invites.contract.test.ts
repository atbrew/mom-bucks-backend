/**
 * Invites parity — Phase 5 contract tests.
 *
 * Drives Flask and Firebase with identical co-parenting invite flows
 * and asserts the observable state matches. Follows the transactions
 * (#25), children (#26), and activities (#27) suites.
 *
 * Scope (docs/firebase-migration-plan.md:397):
 *   - Issue + accept (single-child shape)
 *   - Already-consumed rejection
 *   - Expired/revoked stale-invite rejection
 *   - Revoked-parent loophole (divergence test)
 *
 * ---
 *
 * Asymmetries worth calling out:
 *
 * - **Invite identity.** Flask uses a server-assigned UUID (`id`);
 *   Firebase uses the Firestore doc ID (`token`) as the sharing
 *   secret. Both are opaque strings used for acceptance — the parity
 *   test never compares them.
 *
 * - **Acceptance mechanism.** Flask is a REST endpoint
 *   (`POST /family/invites/:id/accept`); Firebase is the
 *   `acceptInvite` callable (#13) running inside a Firestore
 *   transaction. Both require the acceptor's email to match the
 *   invite's `invitee_email` / `invitedEmail`.
 *
 * - **Post-accept observable.** Flask creates a `FamilyMember` row,
 *   making the child listable by the invitee. Firebase
 *   `arrayUnion`s the invitee's uid into `parentUids`, making the
 *   child readable via security rules. The parity assertion is: the
 *   invitee can now read the child on both backends.
 *
 * - **Staleness mechanism.** Flask has no time-based expiry —
 *   invites stay PENDING forever until accepted or revoked. Firebase
 *   has `expiresAt` on every invite; `acceptInvite` rejects after
 *   that timestamp. The parity claim for "stale invite rejection"
 *   exercises each backend's staleness mechanism (Flask: revoke then
 *   accept → 404; Firebase: past expiresAt → deadline-exceeded) and
 *   asserts both refuse the invite.
 *
 * - **Revoked-parent loophole.** Firebase's `acceptInvite`
 *   re-verifies that the inviter is still in `parentUids` at
 *   acceptance time — if the inviter lost access, the invite is
 *   rejected. Flask has no such guard: an invite stays valid even if
 *   the inviter is removed from the child's Circle of Care. The
 *   contract test documents this deliberate divergence: Firebase
 *   rejects, Flask allows.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acceptFlaskInvite,
  createFlaskInvite,
  listFlaskFamilyMembers,
  removeFlaskFamilyMember,
  revokeFlaskInvite,
  tryGetFlaskChild,
} from "./harness/flaskClient";
import {
  callAcceptInvite,
  callRemoveParentFromChildren,
  createFirebaseInvite,
  tryGetFirebaseChild,
} from "./harness/firebaseClient";
import {
  createParityPair,
  createParityUser,
  type ParityPair,
  type ParityUser,
} from "./harness/testUser";
import { getAdminDb } from "./harness/adminClient";
import { Timestamp as AdminTimestamp } from "firebase-admin/firestore";

/** 14 days from now — a generous non-expired window for test invites. */
function futureExpiry(): Date {
  return new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
}

/** 1 second in the past — guaranteed expired. */
function pastExpiry(): Date {
  return new Date(Date.now() - 1000);
}

describe("invites parity — Flask vs Firebase", () => {
  let pair!: ParityPair;

  beforeEach(async () => {
    pair = await createParityPair({
      slug: "invites",
      childName: "Invite Child",
    });
  });

  afterEach(async () => {
    const current: ParityPair | undefined = pair;
    pair = undefined as unknown as ParityPair;
    if (current) {
      await current.cleanup();
    }
  });

  // ────────────────────────────────────────────────────────────────
  // 1. Issue + accept — invitee gains access to the child on both
  // backends.
  // ────────────────────────────────────────────────────────────────
  it("issuing and accepting an invite grants the invitee child access on both backends", async () => {
    // Create the invitee (a second user) on both backends.
    const invitee: ParityUser = await createParityUser({
      slug: "invites-acceptor",
    });
    try {
      // Issue invites.
      const flaskInvite = await createFlaskInvite({
        impersonateEmail: pair.user.email,
        childId: pair.flaskChildId,
        inviteeEmail: invitee.email,
      });
      expect(flaskInvite.status).toBe("PENDING");

      const firebaseToken = await createFirebaseInvite({
        user: pair.user.firebase,
        childId: pair.firebaseChildId,
        invitedEmail: invitee.email,
        expiresAt: futureExpiry(),
      });

      // Accept invites.
      const flaskAccept = await acceptFlaskInvite({
        impersonateEmail: invitee.email,
        inviteId: flaskInvite.id,
      });
      expect(flaskAccept.ok).toBe(true);

      const firebaseAccept = await callAcceptInvite({
        user: invitee.firebase,
        token: firebaseToken,
      });
      expect(firebaseAccept.ok).toBe(true);
      expect(firebaseAccept.childId).toBe(pair.firebaseChildId);

      // Parity assertion: the invitee can now read the child.
      const flaskRead = await tryGetFlaskChild({
        impersonateEmail: invitee.email,
        childId: pair.flaskChildId,
      });
      expect(flaskRead.ok, "Flask: invitee should read child").toBe(true);

      const firebaseRead = await tryGetFirebaseChild({
        user: invitee.firebase,
        childId: pair.firebaseChildId,
      });
      expect(firebaseRead.ok, "Firebase: invitee should read child").toBe(true);

      // Both see the same child name.
      expect(flaskRead.child!.name).toBe(pair.childName);
      expect(firebaseRead.child!.name).toBe(pair.childName);
    } finally {
      await invitee.firebase.cleanup();
    }
  });

  // ────────────────────────────────────────────────────────────────
  // 2. Already-consumed rejection — a second user cannot re-use an
  // invite that has already been accepted.
  // ────────────────────────────────────────────────────────────────
  it("both backends reject a second accept of an already-consumed invite", async () => {
    const invitee: ParityUser = await createParityUser({
      slug: "invites-first",
    });
    const intruder: ParityUser = await createParityUser({
      slug: "invites-second",
    });
    try {
      // Issue + accept by invitee.
      const flaskInvite = await createFlaskInvite({
        impersonateEmail: pair.user.email,
        childId: pair.flaskChildId,
        inviteeEmail: invitee.email,
      });
      const firebaseToken = await createFirebaseInvite({
        user: pair.user.firebase,
        childId: pair.firebaseChildId,
        invitedEmail: invitee.email,
        expiresAt: futureExpiry(),
      });

      await acceptFlaskInvite({
        impersonateEmail: invitee.email,
        inviteId: flaskInvite.id,
      });
      await callAcceptInvite({
        user: invitee.firebase,
        token: firebaseToken,
      });

      // Intruder tries the same invites.
      // Flask: invite status is ACCEPTED, not PENDING → 404.
      const flaskRetry = await acceptFlaskInvite({
        impersonateEmail: intruder.email,
        inviteId: flaskInvite.id,
      });
      expect(flaskRetry.ok, "Flask must reject consumed invite").toBe(false);
      expect(flaskRetry.status).toBe(404);

      // Firebase: acceptInvite sees acceptedByUid !== callerUid →
      // "already-exists".
      const firebaseRetry = await callAcceptInvite({
        user: intruder.firebase,
        token: firebaseToken,
      });
      expect(firebaseRetry.ok, "Firebase must reject consumed invite").toBe(false);
      expect(firebaseRetry.errorCode).toBe("already-exists");
    } finally {
      await invitee.firebase.cleanup();
      await intruder.firebase.cleanup();
    }
  });

  // ────────────────────────────────────────────────────────────────
  // 3. Stale invite rejection — both backends refuse to honour an
  // invite that's no longer valid.
  //
  // The staleness mechanism differs:
  //   - Flask: revoke (DELETE) → status=REVOKED → accept returns 404.
  //   - Firebase: create with `expiresAt` in the past →
  //     acceptInvite returns "deadline-exceeded".
  //
  // Both mechanisms produce the same user-visible outcome: the
  // invite is un-usable. The test exercises each backend's native
  // staleness path and asserts both refuse.
  // ────────────────────────────────────────────────────────────────
  it("both backends reject a stale invite (Flask: revoked, Firebase: expired)", async () => {
    const invitee: ParityUser = await createParityUser({
      slug: "invites-stale",
    });
    try {
      // Flask: issue then revoke.
      const flaskInvite = await createFlaskInvite({
        impersonateEmail: pair.user.email,
        childId: pair.flaskChildId,
        inviteeEmail: invitee.email,
      });
      await revokeFlaskInvite({
        impersonateEmail: pair.user.email,
        inviteId: flaskInvite.id,
      });
      const flaskAccept = await acceptFlaskInvite({
        impersonateEmail: invitee.email,
        inviteId: flaskInvite.id,
      });
      expect(flaskAccept.ok, "Flask must reject revoked invite").toBe(false);
      expect(flaskAccept.status).toBe(404);

      // Firebase: create with past expiresAt. The create rule
      // requires expiresAt > request.time, so we use the admin SDK
      // (via adminClient) to write it directly, bypassing rules.
      const expiredToken = `expired-test-${Date.now()}`;
      const adminDb = getAdminDb();
      await adminDb.collection("invites").doc(expiredToken).set({
        childId: pair.firebaseChildId,
        invitedByUid: pair.user.firebase.uid,
        invitedEmail: invitee.email,
        expiresAt: AdminTimestamp.fromDate(pastExpiry()),
        acceptedByUid: null,
        acceptedAt: null,
      });
      const firebaseAccept = await callAcceptInvite({
        user: invitee.firebase,
        token: expiredToken,
      });
      expect(firebaseAccept.ok, "Firebase must reject expired invite").toBe(false);
      expect(firebaseAccept.errorCode).toBe("deadline-exceeded");
    } finally {
      await invitee.firebase.cleanup();
    }
  });

  // ────────────────────────────────────────────────────────────────
  // 4. Revoked-parent loophole — deliberate divergence.
  //
  // Setup: Parent A creates child. Parent A invites Co-Parent C.
  // C accepts and becomes a co-parent. C issues a second invite
  // for User B. Then A removes C from the child. User B tries to
  // accept C's invite.
  //
  // Firebase: `acceptInvite` checks that the inviter (C) is still
  // in `parentUids` → rejects with "permission-denied".
  //
  // Flask: the accept endpoint has no inviter-validity check →
  // succeeds, B gains access. This is a known security gap in
  // Flask that Firebase intentionally closes.
  //
  // The test documents this divergence so a future Flask fix can
  // flip the Flask assertion from "allows" to "rejects" without
  // rewriting the test structure.
  // ────────────────────────────────────────────────────────────────
  it("Firebase rejects an invite whose issuer lost access; Flask allows it (known divergence)", async () => {
    const coParent: ParityUser = await createParityUser({
      slug: "invites-coparent",
    });
    const invitee: ParityUser = await createParityUser({
      slug: "invites-loophole",
    });
    try {
      // Step 1: Parent A invites Co-Parent C on both backends.
      const flaskInviteForC = await createFlaskInvite({
        impersonateEmail: pair.user.email,
        childId: pair.flaskChildId,
        inviteeEmail: coParent.email,
      });
      const firebaseTokenForC = await createFirebaseInvite({
        user: pair.user.firebase,
        childId: pair.firebaseChildId,
        invitedEmail: coParent.email,
        expiresAt: futureExpiry(),
      });

      // Step 2: Co-Parent C accepts on both.
      const flaskCAccept = await acceptFlaskInvite({
        impersonateEmail: coParent.email,
        inviteId: flaskInviteForC.id,
      });
      expect(flaskCAccept.ok).toBe(true);

      const firebaseCAccept = await callAcceptInvite({
        user: coParent.firebase,
        token: firebaseTokenForC,
      });
      expect(firebaseCAccept.ok).toBe(true);

      // Step 3: Co-Parent C issues invite for User B on both.
      const flaskInviteForB = await createFlaskInvite({
        impersonateEmail: coParent.email,
        childId: pair.flaskChildId,
        inviteeEmail: invitee.email,
      });
      const firebaseTokenForB = await createFirebaseInvite({
        user: coParent.firebase,
        childId: pair.firebaseChildId,
        invitedEmail: invitee.email,
        expiresAt: futureExpiry(),
      });

      // Step 4: Parent A removes Co-Parent C from the child.

      // Flask: find C's membership ID, then DELETE it.
      const members = await listFlaskFamilyMembers({
        impersonateEmail: pair.user.email,
        childId: pair.flaskChildId,
      });
      // Find the Flask user_id for coParent. The test-auth shim
      // uses email → user lookup, so we find the member whose
      // email matches coParent. Unfortunately the members endpoint
      // doesn't return email directly on the member object in all
      // Flask versions, but it does return user_id. We need to
      // match by user_id. Since we don't have coParent's Flask
      // user_id, we find the member that ISN'T the pair's creator.
      // The pair has exactly one member (the creator via parent_id)
      // before invite acceptance; after C accepts there are two
      // members total — the one we want is the non-creator.
      //
      // Actually, the members response includes user_id and we
      // know the creator is pair.user. Since pair.user's Flask ID
      // isn't exposed by the harness, we look for the member whose
      // user_id differs from the first one (the creator is always
      // listed first per Flask's ORDER BY role, created_at).
      const creatorMember = members[0];
      const coParentMember = members.find(
        (m) => m.userId !== creatorMember.userId,
      );
      expect(coParentMember, "co-parent member should exist on Flask").toBeTruthy();

      await removeFlaskFamilyMember({
        impersonateEmail: pair.user.email,
        childId: pair.flaskChildId,
        memberId: coParentMember!.id,
      });

      // Firebase: use removeParentFromChildren callable.
      const removeResult = await callRemoveParentFromChildren({
        user: pair.user.firebase,
        targetUid: coParent.firebase.uid,
        childIds: [pair.firebaseChildId],
      });
      expect(removeResult.removedFrom).toContain(pair.firebaseChildId);

      // Step 5: User B tries to accept C's (now-revoked-issuer) invite.

      // Flask: no inviter-validity check → succeeds.
      const flaskBAccept = await acceptFlaskInvite({
        impersonateEmail: invitee.email,
        inviteId: flaskInviteForB.id,
      });
      expect(
        flaskBAccept.ok,
        "Flask allows accept from a revoked issuer (known gap)",
      ).toBe(true);

      // Firebase: acceptInvite checks inviter is still in parentUids
      // → rejects.
      const firebaseBAccept = await callAcceptInvite({
        user: invitee.firebase,
        token: firebaseTokenForB,
      });
      expect(
        firebaseBAccept.ok,
        "Firebase must reject invite from revoked issuer",
      ).toBe(false);
      expect(firebaseBAccept.errorCode).toBe("permission-denied");
    } finally {
      await coParent.firebase.cleanup();
      await invitee.firebase.cleanup();
    }
  });
});
