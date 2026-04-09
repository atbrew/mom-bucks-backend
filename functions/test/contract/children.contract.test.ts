/**
 * Children parity — Phase 5 contract tests.
 *
 * Drives Flask and Firebase with identical inputs on child CRUD and
 * asserts the observable state matches. The transactions suite covers
 * balance math; this one covers the *child lifecycle*: create, rename,
 * delete (with cascade), and the negative-access path where a
 * non-parent tries to read a child they don't own.
 *
 * Scope (locked in during Phase 5 planning,
 * docs/firebase-migration-plan.md:394):
 *   - Create child
 *   - Rename child
 *   - Delete child (with cascade to transactions subcollection on
 *     Firebase / cascade-delete of transaction rows on Flask)
 *   - Non-parent read rejection (Flask 404 vs Firebase rule denial)
 *
 * ---
 *
 * Asymmetries worth calling out:
 *
 * - **Rename verbs.** Flask uses `PATCH /api/v1/children/:id`;
 *   Firebase uses `updateDoc` on the child doc. Both are gated on
 *   the caller being a current parent, and neither allows changing
 *   the security membership (`parent_id` on Flask, `parentUids` on
 *   Firebase) via this path — membership changes go through
 *   acceptInvite / removeParentFromChildren on the Firebase side
 *   and separate co-parenting endpoints on Flask.
 *
 * - **Delete cascades.** Flask uses an explicit handler-side cascade
 *   (`web-app/src/mombucks/api/children.py` deletes VaultTransaction
 *   → Activity → Transaction → … → Child in order inside a single
 *   request). Firebase uses the `onChildDelete` trigger (#16) which
 *   pages the subcollections via `BulkWriter` *after* the child doc
 *   has been deleted. That makes the Firebase cascade asynchronous,
 *   so the test polls `awaitFirebaseChildSubcollectionEmpty` to
 *   give the trigger time to land before asserting.
 *
 * - **Post-delete subcollection verification.** Once
 *   `children/{id}` is gone, the Firebase client SDK cannot read
 *   `children/{id}/transactions` — the read rule evaluates
 *   `get(children/{id}).data.parentUids` and returns null on the
 *   missing doc, so the rule fails. The contract test uses the
 *   admin SDK (via `adminClient.ts`) for this one assertion only.
 *   See the `adminClient.ts` module comment for why we make that
 *   exception.
 *
 * - **Cross-parent read status codes.** Flask collapses "not found"
 *   and "not your child" into a single 404 (intentional — it avoids
 *   leaking the existence of a child to a non-parent). Firebase
 *   surfaces `permission-denied` from the read rule because the
 *   rule explicitly requires `request.auth.uid in parentUids`. The
 *   parity assertion is structural: *both* backends reject the read,
 *   but the error shapes are deliberately different.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFlaskTransaction,
  deleteFlaskChild,
  getFlaskChild,
  renameFlaskChild,
  tryGetFlaskChild,
} from "./harness/flaskClient";
import {
  awaitFirebaseBalance,
  createFirebaseTransaction,
  deleteFirebaseChild,
  getFirebaseChild,
  renameFirebaseChild,
  tryGetFirebaseChild,
} from "./harness/firebaseClient";
import {
  awaitFirebaseChildDocAbsent,
  awaitFirebaseChildSubcollectionEmpty,
} from "./harness/adminClient";
import {
  createParityPair,
  createParityUser,
  type ParityPair,
  type ParityUser,
} from "./harness/testUser";

describe("children parity — Flask vs Firebase", () => {
  // Definite assignment assertion — see the mirror comment in
  // transactions.contract.test.ts. `pair` is always reassigned in
  // `beforeEach` before any test body reads it.
  let pair!: ParityPair;

  beforeEach(async () => {
    pair = await createParityPair({
      slug: "children",
      childName: "Parity Child",
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
  // 1. Create lands with the same name + zero balance on both sides.
  // ────────────────────────────────────────────────────────────────
  it("a newly created child has the same name and zero balance on both backends", async () => {
    const flaskChild = await getFlaskChild(pair.user.email, pair.flaskChildId);
    const firebaseChild = await getFirebaseChild({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
    });
    expect(flaskChild.name).toBe(pair.childName);
    expect(firebaseChild.name).toBe(pair.childName);
    expect(flaskChild.balanceCents).toBe(0);
    expect(firebaseChild.balanceCents).toBe(0);
    expect(flaskChild).toEqual(firebaseChild);
  });

  // ────────────────────────────────────────────────────────────────
  // 2. Rename reflects on both sides.
  // ────────────────────────────────────────────────────────────────
  it("renaming a child updates the name on both backends", async () => {
    const renamedTo = "Parity Child (renamed)";

    await renameFlaskChild({
      impersonateEmail: pair.user.email,
      childId: pair.flaskChildId,
      name: renamedTo,
    });
    await renameFirebaseChild({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
      name: renamedTo,
    });

    const flaskChild = await getFlaskChild(pair.user.email, pair.flaskChildId);
    const firebaseChild = await getFirebaseChild({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
    });
    expect(flaskChild.name).toBe(renamedTo);
    expect(firebaseChild.name).toBe(renamedTo);
    // Balance should still be zero — a rename must not touch money.
    expect(flaskChild.balanceCents).toBe(0);
    expect(firebaseChild.balanceCents).toBe(0);
    expect(flaskChild).toEqual(firebaseChild);
  });

  // ────────────────────────────────────────────────────────────────
  // 3. Delete cascades — child + transactions gone on both sides.
  // ────────────────────────────────────────────────────────────────
  //
  // Seed two LODGE transactions first so the cascade has something
  // to actually clean up. On Firebase we have to wait for
  // `onTransactionCreate` to land the balance before the next step
  // (otherwise the second LODGE races the first one's rule check
  // via the same pattern the transactions suite hit).
  it("deleting a child cascades: both backends drop the child and its transactions", async () => {
    const lodgeSteps = [
      { amountCents: 1000, runningCents: 1000 },
      { amountCents: 500, runningCents: 1500 },
    ];
    for (const { amountCents, runningCents } of lodgeSteps) {
      const flaskWrite = await createFlaskTransaction({
        impersonateEmail: pair.user.email,
        childId: pair.flaskChildId,
        type: "LODGE",
        amountCents,
        description: `seed ${amountCents}`,
      });
      expect(flaskWrite.ok).toBe(true);

      const firebaseWrite = await createFirebaseTransaction({
        user: pair.user.firebase,
        childId: pair.firebaseChildId,
        type: "LODGE",
        amountCents,
        description: `seed ${amountCents}`,
      });
      expect(firebaseWrite.ok).toBe(true);

      await awaitFirebaseBalance({
        user: pair.user.firebase,
        childId: pair.firebaseChildId,
        expectedCents: runningCents,
      });
    }

    // Delete on both sides.
    await deleteFlaskChild({
      impersonateEmail: pair.user.email,
      childId: pair.flaskChildId,
    });
    await deleteFirebaseChild({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
    });

    // Child doc gone on Firebase + transactions subcollection cleaned
    // up by `onChildDelete`. Both checks go through the admin SDK:
    // the subcollection check because the children rule can't read a
    // subcollection whose parent child doc no longer exists, and the
    // doc-absent check because the children READ rule dereferences
    // `resource.data.parentUids` without a null guard so a client-SDK
    // `getDoc` on a missing child surfaces as `permission-denied`.
    // See `adminClient.ts` for the full rationale.
    await awaitFirebaseChildDocAbsent({
      childId: pair.firebaseChildId,
    });
    await awaitFirebaseChildSubcollectionEmpty({
      childId: pair.firebaseChildId,
      subcollection: "transactions",
    });

    // Flask: both the child and any follow-up read on its
    // subresources return 404. The handler deletes in one DB
    // transaction so there's no "half cascaded" window to poll
    // through — a single check is enough.
    const flaskCheck = await tryGetFlaskChild({
      impersonateEmail: pair.user.email,
      childId: pair.flaskChildId,
    });
    expect(flaskCheck.ok).toBe(false);
    expect(flaskCheck.status).toBe(404);
  });

  // ────────────────────────────────────────────────────────────────
  // 4. Non-parent read rejection.
  // ────────────────────────────────────────────────────────────────
  //
  // A fresh user (no children, not co-parenting anything) tries to
  // read the pair's child on both backends. The semantic parity
  // claim is "both backends refuse to disclose the child"; the test
  // also pins the exact backend-specific rejection shapes so a
  // future change — say, Flask switching to 403 or Firebase growing
  // a null guard on the read rule — surfaces here immediately
  // instead of silently drifting:
  //
  //   - Flask returns 404 (collapsed "not found" / "not yours").
  //   - Firebase raises `permission-denied` because the read rule
  //     requires `request.auth.uid in parentUids`.
  it("a non-parent cannot read another parent's child on either backend", async () => {
    const stranger: ParityUser = await createParityUser({
      slug: "children-stranger",
    });
    try {
      const flaskResult = await tryGetFlaskChild({
        impersonateEmail: stranger.email,
        childId: pair.flaskChildId,
      });
      expect(flaskResult.ok, "Flask must refuse to disclose").toBe(false);
      expect(flaskResult.status).toBe(404);

      const firebaseResult = await tryGetFirebaseChild({
        user: stranger.firebase,
        childId: pair.firebaseChildId,
      });
      expect(firebaseResult.ok, "Firebase must refuse to disclose").toBe(false);
      expect(firebaseResult.errorCode).toBe("permission-denied");
    } finally {
      await stranger.firebase.cleanup();
    }
  });
});
