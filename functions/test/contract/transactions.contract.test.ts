/**
 * Transactions & balance-math parity — Phase 5 contract tests.
 *
 * Drives Flask and Firebase with identical inputs and asserts that
 * the observable state matches on both sides. This is the core of
 * the Phase 5 contract-test work: the goal is not to test either
 * backend in isolation (the unit tests do that), but to prove that
 * *migrating a client from Flask to Firebase will not change the
 * balance numbers a user sees*.
 *
 * Scope (locked in during Phase 5 planning):
 *   - Transactions (LODGE / WITHDRAW)
 *   - Balance math
 *   - Overspend rejection
 *   - Sequence arithmetic
 *   - Boundary cents values
 *   - Concurrent writes
 *
 * Explicitly out of scope for this pass: activities/bounty cards,
 * vault transactions, invites, habit notifications, profile images.
 * Those become contract tests in follow-up PRs if the transactions
 * suite shakes out cleanly.
 *
 * ---
 *
 * Key implementation notes for future readers:
 *
 * - Each test creates a **fresh parity pair** via `createParityPair`
 *   so there's no shared state between cases. This makes failures
 *   easy to reproduce (run a single test) and avoids whole-file
 *   cascading failures when one case leaves state behind.
 *
 * - After every Firebase transaction write we have to wait for
 *   `onTransactionCreate` (#15) to land the balance update —
 *   `awaitFirebaseBalance` polls the child doc until the expected
 *   value shows up. Flask recomputes the balance inline in the
 *   request handler so no polling is needed there.
 *
 * - Overspend assertions are asymmetric-looking but the intent is
 *   parity: both backends must reject. Flask returns a 4xx (exact
 *   code may vary by version — we just assert `!ok`), Firebase
 *   surfaces a `permission-denied` FirestoreError translated by
 *   `createFirebaseTransaction` into `{ ok: false, errorCode }`.
 *   The test asserts both shapes' rejection together.
 *
 * - The concurrent-writes case is the one real race test. It fires
 *   two LODGEs in parallel via `Promise.all` on each backend, then
 *   asserts the final balance equals the sum. Both backends
 *   serialize concurrent writes (Flask via optimistic locking on
 *   the child row, Firebase via the Firestore transaction inside
 *   `onTransactionCreate`), so parity is "both lands, sum is
 *   correct" — no ordering guarantees.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFlaskTransaction,
  getFlaskChild,
} from "./harness/flaskClient";
import {
  awaitFirebaseBalance,
  createFirebaseTransaction,
} from "./harness/firebaseClient";
import { createParityPair, type ParityPair } from "./harness/testUser";

describe("transactions parity — Flask vs Firebase", () => {
  // Definite assignment assertion — `pair` is always reassigned in
  // `beforeEach` before any test body reads it, so TypeScript can
  // safely treat it as non-null in the test bodies. The `afterEach`
  // below still has to handle the case where `beforeEach` threw and
  // `pair` is runtime-undefined, which it does by capturing a local
  // optional view before calling cleanup.
  let pair!: ParityPair;

  beforeEach(async () => {
    pair = await createParityPair({
      slug: "txn",
      childName: "Parity Child",
    });
  });

  afterEach(async () => {
    // Capture a view typed as optional so a `beforeEach` failure
    // surfaces as its original error instead of a secondary
    // "Cannot read properties of undefined" trace. The reassignment
    // to undefined makes sure a subsequent `beforeEach` failure
    // doesn't see a stale (already-torn-down) pair on the next run.
    const current: ParityPair | undefined = pair;
    pair = undefined as unknown as ParityPair;
    if (current) {
      await current.cleanup();
    }
  });

  // ────────────────────────────────────────────────────────────────
  // 1. LODGE
  // ────────────────────────────────────────────────────────────────
  it("a single LODGE lands with the same balance on both backends", async () => {
    const flaskWrite = await createFlaskTransaction({
      impersonateEmail: pair.user.email,
      childId: pair.flaskChildId,
      type: "LODGE",
      amountCents: 1000,
      description: "pocket money",
    });
    expect(flaskWrite.ok, "Flask LODGE should succeed").toBe(true);

    const firebaseWrite = await createFirebaseTransaction({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
      type: "LODGE",
      amountCents: 1000,
      description: "pocket money",
    });
    expect(firebaseWrite.ok, "Firebase LODGE should succeed").toBe(true);

    const flaskChild = await getFlaskChild(pair.user.email, pair.flaskChildId);
    const firebaseChild = await awaitFirebaseBalance({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
      expectedCents: 1000,
    });

    expect(flaskChild.balanceCents).toBe(1000);
    expect(firebaseChild.balanceCents).toBe(1000);
    expect(flaskChild).toEqual(firebaseChild);
  });

  // ────────────────────────────────────────────────────────────────
  // 2. WITHDRAW (within balance)
  // ────────────────────────────────────────────────────────────────
  //
  // The subtle bit here: on the Firebase side, the WITHDRAW rule
  // does a `get()` on `child.balance` to enforce the overspend
  // guard, but that balance is updated *asynchronously* by the
  // `onTransactionCreate` trigger. If we fire the WITHDRAW before
  // the trigger has landed the LODGE, the rule reads `balance=0`
  // and rejects with permission-denied. So between every step we
  // `awaitFirebaseBalance` to the new expected value before
  // continuing. Flask updates its balance synchronously in the
  // request handler so it doesn't need the wait.
  it("LODGE then WITHDRAW leaves the expected balance on both backends", async () => {
    const steps = [
      { type: "LODGE" as const, amountCents: 2000, runningCents: 2000 },
      { type: "WITHDRAW" as const, amountCents: 750, runningCents: 1250 },
    ];
    for (const { type, amountCents, runningCents } of steps) {
      const flaskWrite = await createFlaskTransaction({
        impersonateEmail: pair.user.email,
        childId: pair.flaskChildId,
        type,
        amountCents,
        description: `${type} ${amountCents}`,
      });
      expect(flaskWrite.ok, `Flask ${type} should succeed`).toBe(true);

      const firebaseWrite = await createFirebaseTransaction({
        user: pair.user.firebase,
        childId: pair.firebaseChildId,
        type,
        amountCents,
        description: `${type} ${amountCents}`,
      });
      expect(firebaseWrite.ok, `Firebase ${type} should succeed`).toBe(true);

      // Wait for the trigger to land the new balance on the
      // Firebase side before the next step's rule check fires.
      await awaitFirebaseBalance({
        user: pair.user.firebase,
        childId: pair.firebaseChildId,
        expectedCents: runningCents,
      });
    }

    const flaskChild = await getFlaskChild(pair.user.email, pair.flaskChildId);
    const firebaseChild = await awaitFirebaseBalance({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
      expectedCents: 1250,
    });

    expect(flaskChild.balanceCents).toBe(1250);
    expect(firebaseChild.balanceCents).toBe(1250);
    expect(flaskChild).toEqual(firebaseChild);
  });

  // ────────────────────────────────────────────────────────────────
  // 3. Overspend rejection (the most critical parity case)
  // ────────────────────────────────────────────────────────────────
  it("both backends reject a WITHDRAW that exceeds the current balance", async () => {
    // Seed both sides to exactly 500 cents so the overspend is
    // unambiguous.
    await createFlaskTransaction({
      impersonateEmail: pair.user.email,
      childId: pair.flaskChildId,
      type: "LODGE",
      amountCents: 500,
      description: "seed",
    });
    await createFirebaseTransaction({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
      type: "LODGE",
      amountCents: 500,
      description: "seed",
    });
    await awaitFirebaseBalance({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
      expectedCents: 500,
    });

    // Now try to WITHDRAW 501 — one cent over.
    const flaskOverspend = await createFlaskTransaction({
      impersonateEmail: pair.user.email,
      childId: pair.flaskChildId,
      type: "WITHDRAW",
      amountCents: 501,
      description: "overspend",
    });
    const firebaseOverspend = await createFirebaseTransaction({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
      type: "WITHDRAW",
      amountCents: 501,
      description: "overspend",
    });

    expect(flaskOverspend.ok, "Flask must reject overspend").toBe(false);
    expect(firebaseOverspend.ok, "Firebase must reject overspend").toBe(false);
    expect(firebaseOverspend.errorCode).toBe("permission-denied");

    // Final state: both sides still at 500.
    const flaskChild = await getFlaskChild(pair.user.email, pair.flaskChildId);
    const firebaseChild = await awaitFirebaseBalance({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
      expectedCents: 500,
    });
    expect(flaskChild.balanceCents).toBe(500);
    expect(firebaseChild.balanceCents).toBe(500);
  });

  // ────────────────────────────────────────────────────────────────
  // 4. Sequence: LODGE 1000 → WITHDRAW 400 → LODGE 250 = 850
  // ────────────────────────────────────────────────────────────────
  //
  // Same `awaitFirebaseBalance` between steps as test 2 — the
  // WITHDRAW's rule check must see the balance left behind by
  // the preceding LODGE.
  it("a LODGE/WITHDRAW/LODGE sequence produces the same final balance", async () => {
    const steps = [
      { type: "LODGE" as const, amountCents: 1000, runningCents: 1000 },
      { type: "WITHDRAW" as const, amountCents: 400, runningCents: 600 },
      { type: "LODGE" as const, amountCents: 250, runningCents: 850 },
    ];
    for (const step of steps) {
      const flaskWrite = await createFlaskTransaction({
        impersonateEmail: pair.user.email,
        childId: pair.flaskChildId,
        type: step.type,
        amountCents: step.amountCents,
        description: `step ${step.type} ${step.amountCents}`,
      });
      expect(flaskWrite.ok).toBe(true);

      const firebaseWrite = await createFirebaseTransaction({
        user: pair.user.firebase,
        childId: pair.firebaseChildId,
        type: step.type,
        amountCents: step.amountCents,
        description: `step ${step.type} ${step.amountCents}`,
      });
      expect(firebaseWrite.ok).toBe(true);

      await awaitFirebaseBalance({
        user: pair.user.firebase,
        childId: pair.firebaseChildId,
        expectedCents: step.runningCents,
      });
    }

    const flaskChild = await getFlaskChild(pair.user.email, pair.flaskChildId);
    const firebaseChild = await awaitFirebaseBalance({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
      expectedCents: 850,
    });

    expect(flaskChild.balanceCents).toBe(850);
    expect(firebaseChild.balanceCents).toBe(850);
    expect(flaskChild).toEqual(firebaseChild);
  });

  // ────────────────────────────────────────────────────────────────
  // 5. Boundary cents (1, 9999, 10000)
  // ────────────────────────────────────────────────────────────────
  //
  // Catches rounding bugs at the Flask wire format boundary.
  // 1 cent → 0.01 dollars, 9999 cents → 99.99 dollars, 10000 cents
  // → 100.00 dollars. Any off-by-one in `centsFromDollars` (or its
  // inverse on the Flask client path) would show up here.
  it("boundary cent values round-trip cleanly on both backends", async () => {
    const boundaryCents = [1, 9999, 10000];
    for (const amountCents of boundaryCents) {
      const flaskWrite = await createFlaskTransaction({
        impersonateEmail: pair.user.email,
        childId: pair.flaskChildId,
        type: "LODGE",
        amountCents,
        description: `boundary ${amountCents}`,
      });
      expect(flaskWrite.ok).toBe(true);

      const firebaseWrite = await createFirebaseTransaction({
        user: pair.user.firebase,
        childId: pair.firebaseChildId,
        type: "LODGE",
        amountCents,
        description: `boundary ${amountCents}`,
      });
      expect(firebaseWrite.ok).toBe(true);
    }

    const expectedSum = boundaryCents.reduce((a, b) => a + b, 0); // 20_000
    const flaskChild = await getFlaskChild(pair.user.email, pair.flaskChildId);
    const firebaseChild = await awaitFirebaseBalance({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
      expectedCents: expectedSum,
    });

    expect(flaskChild.balanceCents).toBe(expectedSum);
    expect(firebaseChild.balanceCents).toBe(expectedSum);
  });

  // ────────────────────────────────────────────────────────────────
  // 6. Concurrent LODGEs
  // ────────────────────────────────────────────────────────────────
  //
  // Fire two LODGEs in parallel on each backend and assert the
  // final balance equals the sum. This catches lost-update bugs —
  // if either backend reads the balance, adds a delta, and writes
  // it back without serialization, one of the two updates will be
  // lost and the final balance will be 500 instead of 1000.
  //
  // Both backends' correct behaviour:
  //   - Flask: optimistic locking on the child row inside a DB txn.
  //   - Firebase: `db.runTransaction` inside `onTransactionCreate`
  //     retries on contention.
  it("concurrent LODGEs are both applied without loss on either backend", async () => {
    const concurrentCount = 3;
    const perLodgeCents = 500;
    const expectedTotal = concurrentCount * perLodgeCents;

    const flaskWrites = Array.from({ length: concurrentCount }, (_, i) =>
      createFlaskTransaction({
        impersonateEmail: pair.user.email,
        childId: pair.flaskChildId,
        type: "LODGE",
        amountCents: perLodgeCents,
        description: `concurrent flask ${i}`,
      }),
    );
    const firebaseWrites = Array.from({ length: concurrentCount }, (_, i) =>
      createFirebaseTransaction({
        user: pair.user.firebase,
        childId: pair.firebaseChildId,
        type: "LODGE",
        amountCents: perLodgeCents,
        description: `concurrent firebase ${i}`,
      }),
    );

    const [flaskResults, firebaseResults] = await Promise.all([
      Promise.all(flaskWrites),
      Promise.all(firebaseWrites),
    ]);

    for (const r of flaskResults) {
      expect(r.ok, "every concurrent Flask write must succeed").toBe(true);
    }
    for (const r of firebaseResults) {
      expect(r.ok, "every concurrent Firebase write must succeed").toBe(true);
    }

    const flaskChild = await getFlaskChild(pair.user.email, pair.flaskChildId);
    const firebaseChild = await awaitFirebaseBalance({
      user: pair.user.firebase,
      childId: pair.firebaseChildId,
      expectedCents: expectedTotal,
      // Concurrent trigger execution serialises on Firestore
      // contention; give it a little more headroom than the
      // single-write path.
      timeoutMs: 10_000,
    });

    expect(flaskChild.balanceCents).toBe(expectedTotal);
    expect(firebaseChild.balanceCents).toBe(expectedTotal);
  });
});
