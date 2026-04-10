/**
 * Activities parity — Phase 5 contract tests.
 *
 * Drives Flask and Firebase with identical bounty-activity inputs
 * and asserts the observable state matches on both sides. This
 * follows the transactions + children suites landed in PRs #25 / #26.
 *
 * Scope (docs/firebase-migration-plan.md:396):
 *   - Create a BOUNTY_RECURRING activity
 *   - Claim a READY bounty (balance bumps + LODGE txn + recycle)
 *   - Delete a bounty
 *   - Non-parent cannot list the activities subcollection
 *
 * Out of scope on purpose:
 *
 * - **ALLOWANCE / INTEREST activities.** Both sides generate these
 *   server-side (Flask via `generate_activities_for_child`, Firebase
 *   via a hypothetical future scheduled function). The contract-test
 *   interface can't meaningfully parity-test generated state yet.
 *
 * - **LOCKED → READY push fan-out.** The migration plan mentions
 *   this as a parity item but there's no Flask equivalent of
 *   Firebase's `onActivityPush` FCM trigger; the parity claim would
 *   collapse to "the Firebase trigger fires", which is a unit-test
 *   concern (`sendChildPush.test.ts` already covers it). Revisit if
 *   Flask grows an equivalent fan-out.
 *
 * ---
 *
 * Asymmetries worth calling out:
 *
 * - **Claim is server-side on Flask, client-orchestrated on
 *   Firebase.** Flask bundles (create LODGE txn + bump balance +
 *   recycle activity to LOCKED + next due_date) into one atomic
 *   request. Firebase has no equivalent callable — the client issues
 *   the same writes as two operations (`addDoc` the transaction,
 *   then `updateDoc` the activity). The contract's
 *   `claimFirebaseActivity` helper reproduces that client protocol
 *   faithfully so the test can drive both sides with symmetric
 *   arguments.
 *
 * - **Next due date.** Flask computes the recycled `due_date`
 *   server-side from the bounty's recurrence. Firebase has no
 *   server-side logic, so the test computes the expected next due
 *   date once and passes it to *both* claim helpers. On the Flask
 *   side the passed value is ignored (the server recomputes), so
 *   parity is maintained by construction: we always create the
 *   bounty with a due_date that's 30 days in the future, so a
 *   WEEKLY recurrence advances cleanly to day 37 without Flask's
 *   "skip missed cycles" loop kicking in.
 *
 * - **Balance propagation.** Flask's claim returns `new_balance`
 *   inline; Firebase's client-orchestrated claim has to wait for
 *   `onTransactionCreate` (#15) to land the bump before the child
 *   doc reads through. The test uses `awaitFirebaseBalance` after
 *   each claim to sync.
 *
 * - **Non-parent rejection shape.** Flask returns 404 from
 *   `require_child_for_parent`; Firebase returns `permission-denied`
 *   from the activities rule's `isChildParent` check. The parity
 *   claim is semantic ("both backends refuse to disclose"), but the
 *   test pins the exact shapes so a future drift surfaces here.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimFlaskActivity,
  createFlaskActivity,
  deleteFlaskActivity,
  getFlaskChild,
  listFlaskActivities,
  tryListFlaskActivities,
} from "./harness/flaskClient";
import {
  awaitFirebaseBalance,
  claimFirebaseActivity,
  createFirebaseActivity,
  deleteFirebaseActivity,
  listFirebaseActivities,
  tryListFirebaseActivities,
} from "./harness/firebaseClient";
import {
  createParityPair,
  createParityUser,
  type ParityPair,
  type ParityUser,
} from "./harness/testUser";

/**
 * Format a Date as YYYY-MM-DD in UTC. We use UTC-slice for
 * determinism: the contract test has no opinion on the host
 * timezone, and Flask's docker-compose container runs in UTC by
 * default (the Postgres image's TZ), so UTC strings are what both
 * sides end up storing anyway.
 */
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Add `days` full days to a Date, UTC-anchored. */
function addUtcDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

describe("activities parity — Flask vs Firebase", () => {
  // Definite-assignment assertion — see the mirror comment in
  // transactions.contract.test.ts.
  let pair!: ParityPair;

  beforeEach(async () => {
    pair = await createParityPair({
      slug: "activities",
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
  // 1. Create a bounty activity — both backends list it with the
  // same normalized shape.
  // ────────────────────────────────────────────────────────────────
  it("a newly created bounty activity has matching fields on both backends", async () => {
    const title = "Take out the bins";
    const rewardCents = 250; // $2.50
    // 30 days out so WEEKLY recycle lands cleanly on day 37 without
    // Flask's "skip missed cycles" loop kicking in.
    const dueDate = toIsoDate(addUtcDays(new Date(), 30));

    await createFlaskActivity({
      impersonateEmail: pair.user.email,
      childId: pair.flaskChildId,
      description: title,
      amountCents: rewardCents,
      recurrence: "WEEKLY",
      dueDate,
    });

    await createFirebaseActivity({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
      title,
      rewardCents,
      type: "BOUNTY_RECURRING",
      status: "READY",
      dueDate,
    });

    const flaskActivities = await listFlaskActivities({
      impersonateEmail: pair.user.email,
      childId: pair.flaskChildId,
    });
    const firebaseActivities = await listFirebaseActivities({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
    });

    expect(flaskActivities).toHaveLength(1);
    expect(firebaseActivities).toHaveLength(1);

    const [flaskAct] = flaskActivities;
    const [firebaseAct] = firebaseActivities;
    expect(flaskAct.title).toBe(title);
    expect(firebaseAct.title).toBe(title);
    expect(flaskAct.rewardCents).toBe(rewardCents);
    expect(firebaseAct.rewardCents).toBe(rewardCents);
    expect(flaskAct.type).toBe("BOUNTY_RECURRING");
    expect(firebaseAct.type).toBe("BOUNTY_RECURRING");
    expect(flaskAct.status).toBe("READY");
    expect(firebaseAct.status).toBe("READY");
    expect(flaskAct.dueDate).toBe(dueDate);
    expect(firebaseAct.dueDate).toBe(dueDate);
    // Tight equality as a belt-and-braces parity assertion.
    expect(flaskAct).toEqual(firebaseAct);
  });

  // ────────────────────────────────────────────────────────────────
  // 2. Claim a READY bounty — balance bumps by the reward, a LODGE
  // transaction exists, and the activity recycles to LOCKED at the
  // next due date.
  // ────────────────────────────────────────────────────────────────
  it("claiming a bounty bumps balance, recycles the activity, and matches on both backends", async () => {
    const title = "Feed the cat";
    const rewardCents = 400;
    const now = new Date();
    const dueDate = toIsoDate(addUtcDays(now, 30));
    const nextDueDate = toIsoDate(addUtcDays(now, 37));

    const flaskCreated = await createFlaskActivity({
      impersonateEmail: pair.user.email,
      childId: pair.flaskChildId,
      description: title,
      amountCents: rewardCents,
      recurrence: "WEEKLY",
      dueDate,
    });
    const firebaseActivityId = await createFirebaseActivity({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
      title,
      rewardCents,
      type: "BOUNTY_RECURRING",
      status: "READY",
      dueDate,
    });

    // Flask claim — server-side atomic: txn + balance + recycle.
    const flaskClaim = await claimFlaskActivity({
      impersonateEmail: pair.user.email,
      childId: pair.flaskChildId,
      activityId: flaskCreated.id,
    });
    expect(flaskClaim.newBalanceCents).toBe(rewardCents);
    expect(flaskClaim.transaction.type).toBe("LODGE");
    expect(flaskClaim.transaction.amountCents).toBe(rewardCents);

    // Firebase claim — client orchestrated: txn + activity recycle.
    // Description mirrors Flask's "<desc> - claimed" pattern so the
    // txn records look alike on both sides.
    await claimFirebaseActivity({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
      activityId: firebaseActivityId,
      rewardCents,
      description: `${title} - claimed`,
      nextDueDate,
    });

    // Balance parity: Flask is already updated (returned inline);
    // Firebase needs to wait for onTransactionCreate to fire.
    await awaitFirebaseBalance({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
      expectedCents: rewardCents,
    });
    const flaskChild = await getFlaskChild(pair.user.email, pair.flaskChildId);
    expect(flaskChild.balanceCents).toBe(rewardCents);

    // Both activities recycled to LOCKED at the next due date. Flask
    // computed it server-side, Firebase was handed the same value —
    // convergence is by construction.
    const flaskActivities = await listFlaskActivities({
      impersonateEmail: pair.user.email,
      childId: pair.flaskChildId,
    });
    const firebaseActivities = await listFirebaseActivities({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
    });
    expect(flaskActivities).toHaveLength(1);
    expect(firebaseActivities).toHaveLength(1);
    const [flaskAct] = flaskActivities;
    const [firebaseAct] = firebaseActivities;
    expect(flaskAct.status).toBe("LOCKED");
    expect(firebaseAct.status).toBe("LOCKED");
    expect(flaskAct.dueDate).toBe(nextDueDate);
    expect(firebaseAct.dueDate).toBe(nextDueDate);
    expect(flaskAct).toEqual(firebaseAct);
  });

  // ────────────────────────────────────────────────────────────────
  // 3. Delete a bounty — both backends stop listing it.
  // ────────────────────────────────────────────────────────────────
  it("deleting a bounty removes it from both backends", async () => {
    const title = "Tidy room";
    const rewardCents = 150;
    const dueDate = toIsoDate(addUtcDays(new Date(), 30));

    const flaskCreated = await createFlaskActivity({
      impersonateEmail: pair.user.email,
      childId: pair.flaskChildId,
      description: title,
      amountCents: rewardCents,
      recurrence: "WEEKLY",
      dueDate,
    });
    const firebaseActivityId = await createFirebaseActivity({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
      title,
      rewardCents,
      type: "BOUNTY_RECURRING",
      status: "READY",
      dueDate,
    });

    await deleteFlaskActivity({
      impersonateEmail: pair.user.email,
      childId: pair.flaskChildId,
      activityId: flaskCreated.id,
    });
    await deleteFirebaseActivity({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
      activityId: firebaseActivityId,
    });

    const flaskActivities = await listFlaskActivities({
      impersonateEmail: pair.user.email,
      childId: pair.flaskChildId,
    });
    const firebaseActivities = await listFirebaseActivities({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
    });
    expect(flaskActivities).toHaveLength(0);
    expect(firebaseActivities).toHaveLength(0);
  });

  // ────────────────────────────────────────────────────────────────
  // 4. Non-parent cannot list another parent's activities.
  // ────────────────────────────────────────────────────────────────
  //
  // A fresh user with no children (and not co-parenting anything)
  // tries to list the pair's activities on both backends. Flask
  // refuses with 404 via `require_child_for_parent`; Firebase
  // refuses with `permission-denied` via the activities rule's
  // `isChildParent(childId)` check.
  it("a non-parent cannot list another parent's activities on either backend", async () => {
    // Seed a bounty so there's something to try to read — an empty
    // list isn't a useful assertion target if the access check is
    // broken.
    const dueDate = toIsoDate(addUtcDays(new Date(), 30));
    await createFlaskActivity({
      impersonateEmail: pair.user.email,
      childId: pair.flaskChildId,
      description: "Secret bounty",
      amountCents: 100,
      recurrence: "WEEKLY",
      dueDate,
    });
    await createFirebaseActivity({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
      title: "Secret bounty",
      rewardCents: 100,
      type: "BOUNTY_RECURRING",
      status: "READY",
      dueDate,
    });

    const stranger: ParityUser = await createParityUser({
      slug: "activities-stranger",
    });
    try {
      const flaskResult = await tryListFlaskActivities({
        impersonateEmail: stranger.email,
        childId: pair.flaskChildId,
      });
      expect(flaskResult.ok, "Flask must refuse to disclose").toBe(false);
      expect(flaskResult.status).toBe(404);

      const firebaseResult = await tryListFirebaseActivities({
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
