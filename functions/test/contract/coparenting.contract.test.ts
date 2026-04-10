/**
 * Co-parenting parity — Phase 5 contract tests.
 *
 * Drives Flask and Firebase with identical co-parent removal flows
 * and asserts the observable state matches. Follows the children
 * (#24), transactions (#25), activities (#27), and invites (#28)
 * suites.
 *
 * Scope (docs/firebase-migration-plan.md:398):
 *   - Remove one of two parents from a child (positive case)
 *   - Refuse to remove the last parent (last-parent guard)
 *
 * ---
 *
 * Asymmetries worth calling out:
 *
 * - **Removal API.** Flask removes a `FamilyMember` row by its
 *   membership ID (`DELETE /family/children/:cid/members/:mid`).
 *   Firebase removes a UID directly via the `removeParentFromChildren`
 *   callable, specifying `{ targetUid, childIds }`.
 *
 * - **Last-parent guard.** Flask has a **primary-parent** guard:
 *   the child's creator (`child.parent_id`) can never be removed
 *   regardless of how many co-parents exist (→ 403). Firebase has
 *   a **last-parent** guard: removal is blocked only when
 *   `parentUids` would become empty (→ skipped with
 *   `WOULD_ORPHAN_CHILD`). Both prevent orphaning a child, but
 *   the mechanism differs: Flask protects a specific role,
 *   Firebase protects a count invariant.
 *
 * - **Post-removal observable.** Flask: the removed member no
 *   longer appears in `listFlaskFamilyMembers` and can't read the
 *   child via `GET /children/:id`. Firebase: the removed UID is
 *   no longer in `parentUids`, and a `getDoc` on the child is
 *   denied by security rules.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acceptFlaskInvite,
  createFlaskInvite,
  listFlaskFamilyMembers,
  tryGetFlaskChild,
  tryRemoveFlaskFamilyMember,
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

/** 14 days from now — a generous non-expired window for test invites. */
function futureExpiry(): Date {
  return new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
}

describe("co-parenting parity — Flask vs Firebase", () => {
  let pair!: ParityPair;

  beforeEach(async () => {
    pair = await createParityPair({
      slug: "coparenting",
      childName: "CoParent Child",
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
  // 1. Positive case — remove a co-parent. The removed parent
  // loses access, the remaining parent keeps access.
  // ────────────────────────────────────────────────────────────────
  it("removing a co-parent revokes their access on both backends", async () => {
    const coParent: ParityUser = await createParityUser({
      slug: "coparenting-removee",
    });
    try {
      // Step 1: Add co-parent via invite + accept on both backends.
      const flaskInvite = await createFlaskInvite({
        impersonateEmail: pair.user.email,
        childId: pair.flaskChildId,
        inviteeEmail: coParent.email,
      });
      const firebaseToken = await createFirebaseInvite({
        user: pair.user.firebase,
        childId: pair.firebaseChildId,
        invitedEmail: coParent.email,
        expiresAt: futureExpiry(),
      });

      await acceptFlaskInvite({
        impersonateEmail: coParent.email,
        inviteId: flaskInvite.id,
      });
      await callAcceptInvite({
        user: coParent.firebase,
        token: firebaseToken,
      });

      // Sanity check: co-parent can read the child on both.
      const flaskPreRead = await tryGetFlaskChild({
        impersonateEmail: coParent.email,
        childId: pair.flaskChildId,
      });
      expect(flaskPreRead.ok, "Flask: co-parent should read child before removal").toBe(true);

      const firebasePreRead = await tryGetFirebaseChild({
        user: coParent.firebase,
        childId: pair.firebaseChildId,
      });
      expect(firebasePreRead.ok, "Firebase: co-parent should read child before removal").toBe(true);

      // Step 2: Remove co-parent on both backends.

      // Flask: find co-parent's membership ID, then DELETE it.
      const members = await listFlaskFamilyMembers({
        impersonateEmail: pair.user.email,
        childId: pair.flaskChildId,
      });
      expect(members, "Flask should have exactly 2 members").toHaveLength(2);
      const creatorMember = members[0];
      const coParentMember = members.find(
        (m) => m.userId !== creatorMember.userId,
      );
      expect(coParentMember, "co-parent member should exist on Flask").toBeTruthy();

      const flaskRemove = await tryRemoveFlaskFamilyMember({
        impersonateEmail: pair.user.email,
        childId: pair.flaskChildId,
        memberId: coParentMember!.id,
      });
      expect(flaskRemove.ok, "Flask: removal should succeed").toBe(true);

      // Firebase: removeParentFromChildren callable.
      const firebaseRemove = await callRemoveParentFromChildren({
        user: pair.user.firebase,
        targetUid: coParent.firebase.uid,
        childIds: [pair.firebaseChildId],
      });
      expect(firebaseRemove.removedFrom).toContain(pair.firebaseChildId);
      expect(firebaseRemove.skipped).toHaveLength(0);

      // Step 3: Parity assertion — co-parent can no longer read
      // the child on either backend.
      const flaskPostRead = await tryGetFlaskChild({
        impersonateEmail: coParent.email,
        childId: pair.flaskChildId,
      });
      expect(flaskPostRead.ok, "Flask: co-parent must lose access after removal").toBe(false);

      const firebasePostRead = await tryGetFirebaseChild({
        user: coParent.firebase,
        childId: pair.firebaseChildId,
      });
      expect(firebasePostRead.ok, "Firebase: co-parent must lose access after removal").toBe(false);

      // Step 4: The remaining parent (pair.user) still has access.
      const flaskOwnerRead = await tryGetFlaskChild({
        impersonateEmail: pair.user.email,
        childId: pair.flaskChildId,
      });
      expect(flaskOwnerRead.ok, "Flask: owner still has access after co-parent removal").toBe(true);

      const firebaseOwnerRead = await tryGetFirebaseChild({
        user: pair.user.firebase,
        childId: pair.firebaseChildId,
      });
      expect(firebaseOwnerRead.ok, "Firebase: owner still has access after co-parent removal").toBe(true);
    } finally {
      await coParent.firebase.cleanup();
    }
  });

  // ────────────────────────────────────────────────────────────────
  // 2. Last-parent guard — both backends refuse to orphan a child.
  //
  // The mechanism differs:
  //   - Flask: the creator is the "primary parent"
  //     (`child.parent_id`). Removing them always returns 403,
  //     regardless of how many other co-parents exist.
  //   - Firebase: `removeParentFromChildren` checks whether the
  //     removal would empty `parentUids`. If so, the child is
  //     skipped with reason `WOULD_ORPHAN_CHILD`.
  //
  // Both produce the same user-visible outcome: the child is not
  // orphaned.
  // ────────────────────────────────────────────────────────────────
  it("both backends refuse to remove the last parent from a child", async () => {
    // Flask: find the creator's membership ID, then try to DELETE.
    const members = await listFlaskFamilyMembers({
      impersonateEmail: pair.user.email,
      childId: pair.flaskChildId,
    });
    expect(members.length, "Flask should have exactly 1 member (creator)").toBe(1);

    const flaskRemove = await tryRemoveFlaskFamilyMember({
      impersonateEmail: pair.user.email,
      childId: pair.flaskChildId,
      memberId: members[0].id,
    });
    expect(flaskRemove.ok, "Flask must reject removal of the primary parent").toBe(false);
    expect(flaskRemove.status).toBe(403);

    // Firebase: try to remove the only parent (self-removal).
    const firebaseRemove = await callRemoveParentFromChildren({
      user: pair.user.firebase,
      targetUid: pair.user.firebase.uid,
      childIds: [pair.firebaseChildId],
    });
    expect(firebaseRemove.removedFrom, "Firebase must not remove the last parent").toHaveLength(0);
    expect(firebaseRemove.skipped).toHaveLength(1);
    const skip = firebaseRemove.skipped[0] as {
      childId: string;
      reason: string;
    };
    expect(skip.childId).toBe(pair.firebaseChildId);
    expect(skip.reason).toBe("WOULD_ORPHAN_CHILD");

    // Both backends still allow the parent to read the child.
    const flaskRead = await tryGetFlaskChild({
      impersonateEmail: pair.user.email,
      childId: pair.flaskChildId,
    });
    expect(flaskRead.ok, "Flask: parent should still have access after rejected removal").toBe(true);

    const firebaseRead = await tryGetFirebaseChild({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
    });
    expect(firebaseRead.ok, "Firebase: parent should still have access after rejected removal").toBe(true);
  });
});
