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
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";

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

async function seedChild(
  childId: string,
  parentUids: string[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "children", childId), {
      name: childId,
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
  childIds: string[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "invites", token), {
      childIds,
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
    it("allows creating a child with the caller's own uid in parentUids", async () => {
      const alice = env.authenticatedContext("alice").firestore();
      await assertSucceeds(
        setDoc(doc(alice, "children/sam"), {
          name: "Sam",
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
          balance: 0,
          vaultBalance: 0,
          parentUids: [],
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
          balance: 0,
          vaultBalance: 0,
          parentUids: ["alice"],
          createdByUid: "alice",
          version: 1,
        }),
      );
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
      await seedInvite("tok1", "alice", ["sam"]);
      const anon = env.unauthenticatedContext().firestore();
      await assertSucceeds(getDoc(doc(anon, "invites/tok1")));
    });

    it("allows authenticated reads by token", async () => {
      await seedInvite("tok1", "alice", ["sam"]);
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
          childIds: ["sam"],
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
          childIds: ["sam"],
          invitedByUid: "bob",
          expiresAt: futureDate(),
          acceptedByUid: null,
        }),
      );
    });

    it("denies creating an invite with an empty childIds", async () => {
      const alice = env.authenticatedContext("alice").firestore();
      await assertFails(
        setDoc(doc(alice, "invites/tok1"), {
          childIds: [],
          invitedByUid: "alice",
          expiresAt: futureDate(),
          acceptedByUid: null,
        }),
      );
    });

    it("denies creating an invite with more than 10 childIds (fan-out cap)", async () => {
      const alice = env.authenticatedContext("alice").firestore();
      const elevenIds = Array.from({ length: 11 }, (_, i) => `c${i}`);
      await assertFails(
        setDoc(doc(alice, "invites/tok1"), {
          childIds: elevenIds,
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
          childIds: ["sam"],
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
          childIds: ["sam"],
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
          childIds: ["sam"],
          invitedByUid: "alice",
          expiresAt: futureDate(),
          acceptedByUid: null,
        }),
      );
    });
  });

  describe("update", () => {
    it("denies direct updates even by the creator (acceptance must go through #13)", async () => {
      await seedInvite("tok1", "alice", ["sam"]);
      const alice = env.authenticatedContext("alice").firestore();
      await assertFails(
        updateDoc(doc(alice, "invites/tok1"), { acceptedByUid: "bob" }),
      );
    });
  });

  describe("delete", () => {
    it("allows the inviter to revoke an unclaimed invite", async () => {
      await seedInvite("tok1", "alice", ["sam"]);
      const alice = env.authenticatedContext("alice").firestore();
      await assertSucceeds(deleteDoc(doc(alice, "invites/tok1")));
    });

    it("denies another user from deleting someone else's invite", async () => {
      await seedInvite("tok1", "alice", ["sam"]);
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

