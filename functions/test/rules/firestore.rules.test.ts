/**
 * Firestore rules unit tests — Phase 2, issue #11.
 *
 * Locks down the security model defined in `firestore.rules` (issue #10)
 * with executable scenarios so future rule changes can't silently widen
 * access. Runs against the Firestore emulator; booted via
 * `npm run test:rules` which wraps this file in `firebase emulators:exec`.
 *
 * The tests cover:
 *
 *   - users/{uid}         — self-only access
 *   - children/{childId}  — parentUids membership gates read/update/delete,
 *                           create requires the caller's own uid in the
 *                           array, and parentUids itself cannot be
 *                           mutated directly by clients
 *   - subcollections      — transactions / vaultTransactions / activities
 *                           inherit the parent child's parentUids via
 *                           get() lookups
 *   - co-parenting        — the canonical isolation test: Bob is in
 *                           sam.parentUids but not jamie.parentUids, so
 *                           Bob reads Sam's data but is blocked from
 *                           Jamie's
 *   - invites/{token}     — unauthenticated read, authenticated create
 *                           with strict shape constraints, update
 *                           denied (acceptance goes through the #13
 *                           callable), creator can delete
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
} from "firebase/firestore";

// Resolve the rules file from the repo root. Test file lives at
// functions/test/rules/firestore.rules.test.ts; firestore.rules is at
// the repo root.
const RULES_PATH = resolve(__dirname, "../../../firestore.rules");

// Use a demo- prefixed project id so this can NEVER collide with the
// real Firebase projects from .firebaserc, even if someone
// accidentally points the test at a non-emulator endpoint.
const PROJECT_ID = "demo-mom-bucks-test";

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(RULES_PATH, "utf8"),
    },
  });
});

afterAll(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

// ─── Seeding helpers ─────────────────────────────────────────────────
//
// Seeding bypasses security rules via `withSecurityRulesDisabled` so
// we can set up arbitrary initial state (including parentUids arrays
// that legitimate clients could never write directly).

// Default DOB for seeded children. Real children always have one
// (enforced at create-time by rules), so every realistic fixture
// should carry one too — otherwise the update-time DOB guards below
// can't be exercised. Tests that need a specific DOB override via
// the `extra` argument.
const DEFAULT_SEED_DOB = new Date("2018-05-01T00:00:00Z");

// Default createdAt for seeded children. Mirrors DEFAULT_SEED_DOB:
// real children always carry a `createdAt` (enforced at create-time
// by rules, which pin it to `request.time`), so seeding must supply
// one too — otherwise the update-time `createdAtUnchanged()` guards
// below have nothing to compare against and the rule becomes
// inadvertently lax.
const DEFAULT_SEED_CREATED_AT = new Date("2025-01-01T09:30:00Z");

async function seedChild(
  childId: string,
  parentUids: string[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "children", childId), {
      name: childId,
      dateOfBirth: DEFAULT_SEED_DOB,
      createdAt: DEFAULT_SEED_CREATED_AT,
      balance: 0,
      vaultBalance: 0,
      parentUids,
      createdByUid: parentUids[0] ?? "system",
      version: 1,
      ...extra,
    });
  });
}

async function seedInvite(
  token: string,
  invitedByUid: string,
  childId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "invites", token), {
      childId,
      invitedByUid,
      invitedEmail: null,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      acceptedByUid: null,
      acceptedAt: null,
      ...extra,
    });
  });
}

// ─── users/{uid} ────────────────────────────────────────────────────

describe("users/{uid}", () => {
  it("allows a user to read their own doc", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertSucceeds(
      setDoc(doc(alice, "users/alice"), { displayName: "Alice" }),
    );
    await assertSucceeds(getDoc(doc(alice, "users/alice")));
  });

  it("denies another signed-in user from reading it", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await setDoc(doc(alice, "users/alice"), { displayName: "Alice" });

    const bob = env.authenticatedContext("bob").firestore();
    await assertFails(getDoc(doc(bob, "users/alice")));
  });

  it("denies unauthenticated access", async () => {
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, "users/alice")));
  });

  it("denies a user from writing someone else's doc", async () => {
    const bob = env.authenticatedContext("bob").firestore();
    await assertFails(
      setDoc(doc(bob, "users/alice"), { displayName: "impostor" }),
    );
  });
});

// ─── children/{childId} ─────────────────────────────────────────────

describe("children/{childId}", () => {
  describe("read", () => {
    it("allows a parent listed in parentUids to read", async () => {
      await seedChild("sam", ["alice"]);
      const alice = env.authenticatedContext("alice").firestore();
      await assertSucceeds(getDoc(doc(alice, "children/sam")));
    });

    it("denies a signed-in user not in parentUids", async () => {
      await seedChild("sam", ["alice"]);
      const bob = env.authenticatedContext("bob").firestore();
      await assertFails(getDoc(doc(bob, "children/sam")));
    });

    it("denies unauthenticated reads", async () => {
      await seedChild("sam", ["alice"]);
      const anon = env.unauthenticatedContext().firestore();
      await assertFails(getDoc(doc(anon, "children/sam")));
    });
  });

  describe("create", () => {
    // Fixed DOB used by the happy-path create tests. A calendar date
    // (no time-of-day) mirroring the Flask `Child.date_of_birth` column
    // semantics — Firestore stores it as a `timestamp` but callers
    // should treat it as a day.
    const SAM_DOB = new Date("2018-05-01T00:00:00Z");

    it("allows creating a child with the caller's own uid in parentUids", async () => {
      const alice = env.authenticatedContext("alice").firestore();
      await assertSucceeds(
        setDoc(doc(alice, "children/sam"), {
          name: "Sam",
          dateOfBirth: SAM_DOB,
          createdAt: serverTimestamp(),
          balance: 0,
          vaultBalance: 0,
          parentUids: ["alice"],
          createdByUid: "alice",
          version: 1,
        }),
      );
    });

    it("denies creating a child without the caller in parentUids", async () => {
      const alice = env.authenticatedContext("alice").firestore();
      await assertFails(
        setDoc(doc(alice, "children/sam"), {
          name: "Sam",
          dateOfBirth: SAM_DOB,
          createdAt: serverTimestamp(),
          balance: 0,
          vaultBalance: 0,
          parentUids: ["bob"],
          createdByUid: "alice",
          version: 1,
        }),
      );
    });

    it("denies creating a child with an empty parentUids array", async () => {
      const alice = env.authenticatedContext("alice").firestore();
      await assertFails(
        setDoc(doc(alice, "children/sam"), {
          name: "Sam",
          dateOfBirth: SAM_DOB,
          createdAt: serverTimestamp(),
          balance: 0,
          vaultBalance: 0,
          parentUids: [],
          createdByUid: "alice",
          version: 1,
        }),
      );
    });

    it("denies creating a child with MULTIPLE parentUids (must go through acceptInvite)", async () => {
      // Closes the loophole where a client could seed
      // parentUids: [me, victim] at create time and grant access to
      // an unrelated user without going through the invite flow.
      const alice = env.authenticatedContext("alice").firestore();
      await assertFails(
        setDoc(doc(alice, "children/sam"), {
          name: "Sam",
          dateOfBirth: SAM_DOB,
          createdAt: serverTimestamp(),
          balance: 0,
          vaultBalance: 0,
          parentUids: ["alice", "bob"],
          createdByUid: "alice",
          version: 1,
        }),
      );
    });

    it("denies unauthenticated creates", async () => {
      const anon = env.unauthenticatedContext().firestore();
      await assertFails(
        setDoc(doc(anon, "children/sam"), {
          name: "Sam",
          dateOfBirth: SAM_DOB,
          createdAt: serverTimestamp(),
          balance: 0,
          vaultBalance: 0,
          parentUids: ["alice"],
          createdByUid: "alice",
          version: 1,
        }),
      );
    });

    // ─── dateOfBirth required field ──────────────────────────────
    //
    // Mirrors the Flask `Child.date_of_birth` column
    // (`db.Date, nullable=False`). A child cannot be created without
    // it. These tests pin the shape check at the rules layer so the
    // Phase 2 backfill and any future client writers cannot silently
    // drop the field.
    describe("dateOfBirth required field", () => {
      it("denies creating a child with no dateOfBirth field at all", async () => {
        const alice = env.authenticatedContext("alice").firestore();
        await assertFails(
          setDoc(doc(alice, "children/sam"), {
            name: "Sam",
            createdAt: serverTimestamp(),
            balance: 0,
            vaultBalance: 0,
            parentUids: ["alice"],
            createdByUid: "alice",
            version: 1,
          }),
        );
      });

      it("denies creating a child whose dateOfBirth is not a timestamp (e.g. a string)", async () => {
        // A string like "2018-05-01" sneaking through would defeat the
        // point of storing a real timestamp. Rules must reject it.
        const alice = env.authenticatedContext("alice").firestore();
        await assertFails(
          setDoc(doc(alice, "children/sam"), {
            name: "Sam",
            dateOfBirth: "2018-05-01",
            createdAt: serverTimestamp(),
            balance: 0,
            vaultBalance: 0,
            parentUids: ["alice"],
            createdByUid: "alice",
            version: 1,
          }),
        );
      });

      it("allows creating a child with a valid dateOfBirth timestamp", async () => {
        const alice = env.authenticatedContext("alice").firestore();
        await assertSucceeds(
          setDoc(doc(alice, "children/sam"), {
            name: "Sam",
            dateOfBirth: SAM_DOB,
            createdAt: serverTimestamp(),
            balance: 0,
            vaultBalance: 0,
            parentUids: ["alice"],
            createdByUid: "alice",
            version: 1,
          }),
        );
      });
    });

    // ─── createdAt required + bound to request.time ───────────────
    //
    // Reversing PR #32's pushback on Gemini's `createdAt` comments.
    // A required, server-timestamped, immutable createdAt is the
    // strongest data model at this stage. Rules must:
    //
    //   1. Reject creates with no `createdAt` at all.
    //   2. Reject creates whose `createdAt` is a string or other
    //      non-timestamp.
    //   3. Reject creates whose `createdAt` is a client-chosen
    //      timestamp (e.g. `new Date()` from a drifting clock or a
    //      deliberately-backdated "imported" record). The only way
    //      to pass the create rule is to write `request.time` via
    //      `serverTimestamp()`, which the emulator binds to
    //      `request.time` during rule evaluation.
    //
    // Immutability on update is covered in the "createdAt immutability
    // on update" describe block below.
    describe("createdAt required and bound to request.time on create", () => {
      it("denies creating a child with no createdAt field at all", async () => {
        const alice = env.authenticatedContext("alice").firestore();
        await assertFails(
          setDoc(doc(alice, "children/sam"), {
            name: "Sam",
            dateOfBirth: SAM_DOB,
            balance: 0,
            vaultBalance: 0,
            parentUids: ["alice"],
            createdByUid: "alice",
            version: 1,
          }),
        );
      });

      it("denies creating a child whose createdAt is not a timestamp (e.g. a string)", async () => {
        const alice = env.authenticatedContext("alice").firestore();
        await assertFails(
          setDoc(doc(alice, "children/sam"), {
            name: "Sam",
            dateOfBirth: SAM_DOB,
            createdAt: "2025-01-01T09:30:00Z",
            balance: 0,
            vaultBalance: 0,
            parentUids: ["alice"],
            createdByUid: "alice",
            version: 1,
          }),
        );
      });

      it("denies creating a child whose createdAt is a client-chosen Date (not serverTimestamp)", async () => {
        // A client-chosen `new Date()` will not equal `request.time`
        // during rule evaluation (different instant, different drift).
        // This test pins the "server time only" invariant: the only
        // way to pass is via `serverTimestamp()`.
        const alice = env.authenticatedContext("alice").firestore();
        await assertFails(
          setDoc(doc(alice, "children/sam"), {
            name: "Sam",
            dateOfBirth: SAM_DOB,
            createdAt: new Date("2020-01-01T00:00:00Z"),
            balance: 0,
            vaultBalance: 0,
            parentUids: ["alice"],
            createdByUid: "alice",
            version: 1,
          }),
        );
      });

      it("allows creating a child with createdAt = serverTimestamp() (which rules see as request.time)", async () => {
        const alice = env.authenticatedContext("alice").firestore();
        await assertSucceeds(
          setDoc(doc(alice, "children/sam"), {
            name: "Sam",
            dateOfBirth: SAM_DOB,
            createdAt: serverTimestamp(),
            balance: 0,
            vaultBalance: 0,
            parentUids: ["alice"],
            createdByUid: "alice",
            version: 1,
          }),
        );
      });
    });
  });

  describe("update", () => {
    it("allows a parent to update non-membership fields", async () => {
      await seedChild("sam", ["alice"]);
      const alice = env.authenticatedContext("alice").firestore();
      await assertSucceeds(
        updateDoc(doc(alice, "children/sam"), { name: "Samuel" }),
      );
    });

    it("denies a non-parent from updating", async () => {
      await seedChild("sam", ["alice"]);
      const bob = env.authenticatedContext("bob").firestore();
      await assertFails(
        updateDoc(doc(bob, "children/sam"), { name: "Hacked" }),
      );
    });

    it("denies a parent from directly mutating parentUids (add)", async () => {
      await seedChild("sam", ["alice"]);
      const alice = env.authenticatedContext("alice").firestore();
      await assertFails(
        updateDoc(doc(alice, "children/sam"), {
          parentUids: ["alice", "bob"],
        }),
      );
    });

    it("denies a parent from directly mutating parentUids (remove)", async () => {
      await seedChild("sam", ["alice", "bob"]);
      const alice = env.authenticatedContext("alice").firestore();
      await assertFails(
        updateDoc(doc(alice, "children/sam"), { parentUids: ["alice"] }),
      );
    });

    // ─── dateOfBirth is immutable after create ───────────────────
    //
    // The reviewers on PR #32 flagged that enforcing `dateOfBirth`
    // only on create is a hollow guarantee: a signed-in parent could
    // then update the child doc, strip the field, or change it to a
    // different value, and the "required" invariant would silently
    // rot. Biologically DOB doesn't change, so the simplest fix is
    // to pin it as immutable at the rules layer. These tests lock in
    // that behaviour.
    describe("dateOfBirth immutability on update", () => {
      it("denies an update that sets dateOfBirth to a different timestamp", async () => {
        await seedChild("sam", ["alice"]);
        const alice = env.authenticatedContext("alice").firestore();
        await assertFails(
          updateDoc(doc(alice, "children/sam"), {
            dateOfBirth: new Date("2019-06-01T00:00:00Z"),
          }),
        );
      });

      it("denies an update that removes dateOfBirth (FieldValue.delete equivalent)", async () => {
        // The Firestore web SDK uses `deleteField()` from
        // firebase/firestore, but re-exporting it would widen the
        // test's import surface. A `null` write is functionally the
        // same shape-check failure path — not a timestamp — so this
        // covers the "delete" case at the rules layer even without
        // pulling in the deleteField sentinel.
        await seedChild("sam", ["alice"]);
        const alice = env.authenticatedContext("alice").firestore();
        await assertFails(
          updateDoc(doc(alice, "children/sam"), {
            dateOfBirth: null,
          }),
        );
      });

      it("denies an update that sets dateOfBirth to a non-timestamp (e.g. a string)", async () => {
        await seedChild("sam", ["alice"]);
        const alice = env.authenticatedContext("alice").firestore();
        await assertFails(
          updateDoc(doc(alice, "children/sam"), {
            dateOfBirth: "2019-06-01",
          }),
        );
      });

      it("allows a name update that does not touch dateOfBirth", async () => {
        // Regression guard: the update rule must not become so strict
        // that ordinary field updates (rename, balance bumps, etc.)
        // get denied just because DOB is in the doc.
        await seedChild("sam", ["alice"]);
        const alice = env.authenticatedContext("alice").firestore();
        await assertSucceeds(
          updateDoc(doc(alice, "children/sam"), { name: "Samuel" }),
        );
      });
    });

    // ─── createdAt is immutable after create ─────────────────────
    //
    // Mirrors the dateOfBirth immutability block above. A child's
    // creation instant is historical — it cannot legitimately change
    // post-create, so any update that touches `createdAt` (to
    // overwrite, null out, or retype it) must be refused.
    describe("createdAt immutability on update", () => {
      it("denies an update that sets createdAt to a different timestamp", async () => {
        await seedChild("sam", ["alice"]);
        const alice = env.authenticatedContext("alice").firestore();
        await assertFails(
          updateDoc(doc(alice, "children/sam"), {
            createdAt: new Date("2025-02-02T10:00:00Z"),
          }),
        );
      });

      it("denies an update that sets createdAt to serverTimestamp() (re-stamping)", async () => {
        // Even serverTimestamp() — which is the only legitimate way to
        // write `createdAt` on CREATE — must be refused on UPDATE.
        // Otherwise a parent could silently bump an old child's
        // "createdAt" to today and corrupt the historical ordering.
        await seedChild("sam", ["alice"]);
        const alice = env.authenticatedContext("alice").firestore();
        await assertFails(
          updateDoc(doc(alice, "children/sam"), {
            createdAt: serverTimestamp(),
          }),
        );
      });

      it("denies an update that removes createdAt (null write)", async () => {
        await seedChild("sam", ["alice"]);
        const alice = env.authenticatedContext("alice").firestore();
        await assertFails(
          updateDoc(doc(alice, "children/sam"), {
            createdAt: null,
          }),
        );
      });

      it("denies an update that sets createdAt to a non-timestamp (e.g. a string)", async () => {
        await seedChild("sam", ["alice"]);
        const alice = env.authenticatedContext("alice").firestore();
        await assertFails(
          updateDoc(doc(alice, "children/sam"), {
            createdAt: "2025-02-02T10:00:00Z",
          }),
        );
      });

      it("allows a name update that does not touch createdAt", async () => {
        // Regression guard: ordinary field updates must still go
        // through even though createdAt is now pinned.
        await seedChild("sam", ["alice"]);
        const alice = env.authenticatedContext("alice").firestore();
        await assertSucceeds(
          updateDoc(doc(alice, "children/sam"), { name: "Samuel" }),
        );
      });
    });
  });

  describe("delete", () => {
    it("allows a parent to delete the child", async () => {
      await seedChild("sam", ["alice"]);
      const alice = env.authenticatedContext("alice").firestore();
      await assertSucceeds(deleteDoc(doc(alice, "children/sam")));
    });

    it("denies a non-parent from deleting", async () => {
      await seedChild("sam", ["alice"]);
      const bob = env.authenticatedContext("bob").firestore();
      await assertFails(deleteDoc(doc(bob, "children/sam")));
    });
  });
});

// ─── children/{childId}/transactions/{txnId} ────────────────────────

describe("children/{childId}/transactions/{txnId}", () => {
  it("allows a parent to read transactions", async () => {
    await seedChild("sam", ["alice"]);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "children/sam/transactions/t1"), {
        amount: 500,
        type: "LODGE",
        description: "chore",
        createdByUid: "alice",
      });
    });
    const alice = env.authenticatedContext("alice").firestore();
    await assertSucceeds(getDoc(doc(alice, "children/sam/transactions/t1")));
  });

  it("allows a parent to create transactions", async () => {
    await seedChild("sam", ["alice"]);
    const alice = env.authenticatedContext("alice").firestore();
    await assertSucceeds(
      setDoc(doc(alice, "children/sam/transactions/t1"), {
        amount: 500,
        type: "LODGE",
        description: "chore",
        createdByUid: "alice",
      }),
    );
  });

  it("denies a non-parent from reading transactions", async () => {
    await seedChild("sam", ["alice"]);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "children/sam/transactions/t1"), {
        amount: 500,
        type: "LODGE",
      });
    });
    const bob = env.authenticatedContext("bob").firestore();
    await assertFails(getDoc(doc(bob, "children/sam/transactions/t1")));
  });

  it("denies a non-parent from writing transactions", async () => {
    await seedChild("sam", ["alice"]);
    const bob = env.authenticatedContext("bob").firestore();
    await assertFails(
      setDoc(doc(bob, "children/sam/transactions/t1"), {
        amount: 500,
        type: "LODGE",
      }),
    );
  });

  // ─── WITHDRAW overspend guard ─────────────────────────────────────
  //
  // Synchronous rejection of WITHDRAWs that would drive the balance
  // negative. The trigger (`onTransactionCreate` #15) fires AFTER the
  // doc write, so the only place we can refuse synchronously is here
  // in the rules layer. The trigger's clamp-at-zero path remains as
  // defense-in-depth for Admin-SDK writers and concurrent-write races.
  describe("WITHDRAW overspend guard", () => {
    it("allows a WITHDRAW when amount is less than balance", async () => {
      await seedChild("sam", ["alice"], { balance: 1000 });
      const alice = env.authenticatedContext("alice").firestore();
      await assertSucceeds(
        setDoc(doc(alice, "children/sam/transactions/t1"), {
          amount: 400,
          type: "WITHDRAW",
          description: "treat",
          createdByUid: "alice",
        }),
      );
    });

    it("allows a WITHDRAW that exactly drains the balance to zero", async () => {
      await seedChild("sam", ["alice"], { balance: 1000 });
      const alice = env.authenticatedContext("alice").firestore();
      await assertSucceeds(
        setDoc(doc(alice, "children/sam/transactions/t1"), {
          amount: 1000,
          type: "WITHDRAW",
          description: "payout",
          createdByUid: "alice",
        }),
      );
    });

    it("denies a WITHDRAW when amount exceeds balance", async () => {
      await seedChild("sam", ["alice"], { balance: 500 });
      const alice = env.authenticatedContext("alice").firestore();
      await assertFails(
        setDoc(doc(alice, "children/sam/transactions/t1"), {
          amount: 501,
          type: "WITHDRAW",
          description: "overspend by one cent",
          createdByUid: "alice",
        }),
      );
    });

    it("denies a WITHDRAW from a child with zero balance", async () => {
      await seedChild("sam", ["alice"]); // default balance: 0
      const alice = env.authenticatedContext("alice").firestore();
      await assertFails(
        setDoc(doc(alice, "children/sam/transactions/t1"), {
          amount: 100,
          type: "WITHDRAW",
          description: "cold wallet",
          createdByUid: "alice",
        }),
      );
    });

    it("allows a LODGE even when the current balance is zero", async () => {
      // The overspend check must only apply to WITHDRAWs. A LODGE of
      // any amount against a fresh child must continue to work.
      await seedChild("sam", ["alice"]);
      const alice = env.authenticatedContext("alice").firestore();
      await assertSucceeds(
        setDoc(doc(alice, "children/sam/transactions/t1"), {
          amount: 99999,
          type: "LODGE",
          description: "seed",
          createdByUid: "alice",
        }),
      );
    });

    // The overspend guard's correctness depends on `amount` being a
    // non-negative number. Without the shape check, a client could
    // send `{amount: -100, type: 'WITHDRAW'}` and the `amount <=
    // balance` test is trivially true for any non-negative balance —
    // the doc lands, the trigger's defensive negative-amount check
    // fires and returns without updating the balance, and we're left
    // with an orphan transaction record. These two cases lock the
    // shape check in at the rules layer.
    it("denies creating a WITHDRAW with a negative amount", async () => {
      await seedChild("sam", ["alice"], { balance: 1000 });
      const alice = env.authenticatedContext("alice").firestore();
      await assertFails(
        setDoc(doc(alice, "children/sam/transactions/t1"), {
          amount: -100,
          type: "WITHDRAW",
          description: "negative withdraw",
          createdByUid: "alice",
        }),
      );
    });

    it("denies creating a LODGE with a negative amount", async () => {
      await seedChild("sam", ["alice"], { balance: 1000 });
      const alice = env.authenticatedContext("alice").firestore();
      await assertFails(
        setDoc(doc(alice, "children/sam/transactions/t1"), {
          amount: -100,
          type: "LODGE",
          description: "negative lodge",
          createdByUid: "alice",
        }),
      );
    });
  });
});

// ─── children/{childId}/activities/{activityId} ─────────────────────

describe("children/{childId}/activities/{activityId}", () => {
  it("allows a parent to create an activity", async () => {
    await seedChild("sam", ["alice"]);
    const alice = env.authenticatedContext("alice").firestore();
    await assertSucceeds(
      setDoc(doc(alice, "children/sam/activities/a1"), {
        title: "Take out the bins",
        reward: 200,
        status: "OPEN",
      }),
    );
  });

  it("denies a non-parent from reading an activity", async () => {
    await seedChild("sam", ["alice"]);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "children/sam/activities/a1"), {
        title: "Homework",
        reward: 100,
        status: "OPEN",
      });
    });
    const bob = env.authenticatedContext("bob").firestore();
    await assertFails(getDoc(doc(bob, "children/sam/activities/a1")));
  });
});

// ─── children/{childId}/vaultTransactions/{id} ──────────────────────

describe("children/{childId}/vaultTransactions/{id}", () => {
  it("allows a parent to write vault transactions", async () => {
    await seedChild("sam", ["alice"]);
    const alice = env.authenticatedContext("alice").firestore();
    await assertSucceeds(
      setDoc(doc(alice, "children/sam/vaultTransactions/v1"), {
        amount: 1000,
        type: "DEPOSIT",
      }),
    );
  });

  it("denies a non-parent from writing vault transactions", async () => {
    await seedChild("sam", ["alice"]);
    const bob = env.authenticatedContext("bob").firestore();
    await assertFails(
      setDoc(doc(bob, "children/sam/vaultTransactions/v1"), {
        amount: 1000,
        type: "DEPOSIT",
      }),
    );
  });
});

// ─── co-parenting isolation (the canonical Phase 2 scenario) ────────

describe("co-parenting isolation", () => {
  beforeEach(async () => {
    // Alice is in both; Bob only co-parents Sam; Carol only co-parents Jamie.
    await seedChild("sam", ["alice", "bob"]);
    await seedChild("jamie", ["alice", "carol"]);

    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "children/sam/transactions/t1"), {
        amount: 500,
        type: "LODGE",
      });
      await setDoc(doc(db, "children/jamie/transactions/t1"), {
        amount: 750,
        type: "LODGE",
      });
    });
  });

  it("Bob reads Sam (his co-parented child)", async () => {
    const bob = env.authenticatedContext("bob").firestore();
    await assertSucceeds(getDoc(doc(bob, "children/sam")));
  });

  it("Bob cannot read Jamie (Alice's other child, not his)", async () => {
    const bob = env.authenticatedContext("bob").firestore();
    await assertFails(getDoc(doc(bob, "children/jamie")));
  });

  it("Bob can read Sam's transactions", async () => {
    const bob = env.authenticatedContext("bob").firestore();
    await assertSucceeds(getDoc(doc(bob, "children/sam/transactions/t1")));
  });

  it("Bob cannot read Jamie's transactions (subcollection isolation)", async () => {
    const bob = env.authenticatedContext("bob").firestore();
    await assertFails(getDoc(doc(bob, "children/jamie/transactions/t1")));
  });

  it("Alice sees both children (she's in both parentUids arrays)", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertSucceeds(getDoc(doc(alice, "children/sam")));
    await assertSucceeds(getDoc(doc(alice, "children/jamie")));
  });

  it("Carol sees Jamie but not Sam", async () => {
    const carol = env.authenticatedContext("carol").firestore();
    await assertSucceeds(getDoc(doc(carol, "children/jamie")));
    await assertFails(getDoc(doc(carol, "children/sam")));
  });
});

// ─── invites/{token} ────────────────────────────────────────────────

describe("invites/{token}", () => {
  describe("read", () => {
    it("allows unauthenticated reads by token (URL is the secret)", async () => {
      await seedInvite("tok1", "alice", "sam");
      const anon = env.unauthenticatedContext().firestore();
      await assertSucceeds(getDoc(doc(anon, "invites/tok1")));
    });

    it("allows authenticated reads by token", async () => {
      await seedInvite("tok1", "alice", "sam");
      const bob = env.authenticatedContext("bob").firestore();
      await assertSucceeds(getDoc(doc(bob, "invites/tok1")));
    });
  });

  describe("create", () => {
    const futureDate = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

    it("allows a signed-in user to create an invite with their own uid as invitedByUid", async () => {
      const alice = env.authenticatedContext("alice").firestore();
      await assertSucceeds(
        setDoc(doc(alice, "invites/tok1"), {
          childId: "sam",
          invitedByUid: "alice",
          invitedEmail: null,
          expiresAt: futureDate(),
          acceptedByUid: null,
          acceptedAt: null,
        }),
      );
    });

    it("denies creating an invite stamped with someone else's uid", async () => {
      const alice = env.authenticatedContext("alice").firestore();
      await assertFails(
        setDoc(doc(alice, "invites/tok1"), {
          childId: "sam",
          invitedByUid: "bob",
          expiresAt: futureDate(),
          acceptedByUid: null,
        }),
      );
    });

    it("denies creating an invite with an empty childId", async () => {
      const alice = env.authenticatedContext("alice").firestore();
      await assertFails(
        setDoc(doc(alice, "invites/tok1"), {
          childId: "",
          invitedByUid: "alice",
          expiresAt: futureDate(),
          acceptedByUid: null,
        }),
      );
    });

    it("denies creating an invite with childId as a non-string (e.g. an array, guarding the old multi-child shape)", async () => {
      // Invites are issued one child at a time. If a client still sends
      // the legacy `childIds: [...]` shape (or any non-string), rules
      // must reject it so the stored data stays consistent with what
      // acceptInvite (#13) expects.
      const alice = env.authenticatedContext("alice").firestore();
      await assertFails(
        setDoc(doc(alice, "invites/tok1"), {
          childId: ["sam"],
          invitedByUid: "alice",
          expiresAt: futureDate(),
          acceptedByUid: null,
        }),
      );
    });

    it("denies creating an invite with expiresAt in the past", async () => {
      const alice = env.authenticatedContext("alice").firestore();
      await assertFails(
        setDoc(doc(alice, "invites/tok1"), {
          childId: "sam",
          invitedByUid: "alice",
          expiresAt: new Date(Date.now() - 1000),
          acceptedByUid: null,
        }),
      );
    });

    it("denies creating an invite with acceptedByUid already set", async () => {
      const alice = env.authenticatedContext("alice").firestore();
      await assertFails(
        setDoc(doc(alice, "invites/tok1"), {
          childId: "sam",
          invitedByUid: "alice",
          expiresAt: futureDate(),
          acceptedByUid: "bob",
        }),
      );
    });

    it("denies unauthenticated creates", async () => {
      const anon = env.unauthenticatedContext().firestore();
      await assertFails(
        setDoc(doc(anon, "invites/tok1"), {
          childId: "sam",
          invitedByUid: "alice",
          expiresAt: futureDate(),
          acceptedByUid: null,
        }),
      );
    });
  });

  describe("update", () => {
    it("denies direct updates even by the creator (acceptance must go through #13)", async () => {
      await seedInvite("tok1", "alice", "sam");
      const alice = env.authenticatedContext("alice").firestore();
      await assertFails(
        updateDoc(doc(alice, "invites/tok1"), { acceptedByUid: "bob" }),
      );
    });
  });

  describe("delete", () => {
    it("allows the inviter to revoke an unclaimed invite", async () => {
      await seedInvite("tok1", "alice", "sam");
      const alice = env.authenticatedContext("alice").firestore();
      await assertSucceeds(deleteDoc(doc(alice, "invites/tok1")));
    });

    it("denies another user from deleting someone else's invite", async () => {
      await seedInvite("tok1", "alice", "sam");
      const bob = env.authenticatedContext("bob").firestore();
      await assertFails(deleteDoc(doc(bob, "invites/tok1")));
    });
  });
});

// ─── default deny (nothing else is reachable) ───────────────────────

describe("default deny", () => {
  it("denies reads/writes to an unknown top-level collection", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(getDoc(doc(alice, "notARealCollection/anything")));
    await assertFails(
      setDoc(doc(alice, "notARealCollection/anything"), { x: 1 }),
    );
  });

  it("denies writes to the Phase 0 smoke-test path (hello/)", async () => {
    // helloWorld writes via Admin SDK and bypasses these rules; clients
    // should not be able to touch hello/ directly.
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(setDoc(doc(alice, "hello/probe"), { foo: "bar" }));
  });
});

