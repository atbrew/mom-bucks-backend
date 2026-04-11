import { describe, expect, it } from "vitest";
import {
  BackfillError,
  buildFcmTokensByUid,
  buildUserIdToUidMap,
  computeParentUidsByChild,
  pickVaultBalanceCents,
  toCents,
  transformActivity,
  transformAllowanceConfig,
  transformChild,
  transformInvite,
  transformTransaction,
  transformUser,
  transformVaultTransaction,
  type PgActivity,
  type PgAllowanceConfig,
  type PgChild,
  type PgDeviceToken,
  type PgFamilyInvite,
  type PgFamilyMember,
  type PgTransaction,
  type PgUser,
  type PgVault,
  type PgVaultTransaction,
} from "../../src/backfill/transform";

// ─── toCents rounding ───────────────────────────────────────────────

describe("toCents", () => {
  it("converts integer euros to cents", () => {
    expect(toCents(12)).toBe(1200);
    expect(toCents(0)).toBe(0);
  });

  it('converts Postgres-style string "12.50" to 1250 cents', () => {
    expect(toCents("12.50")).toBe(1250);
  });

  it("rounds floating-point noise (12.499999... → 1250)", () => {
    expect(toCents(12.499_999_999_999_998)).toBe(1250);
  });

  it("handles negatives (for refunds)", () => {
    expect(toCents("-5.25")).toBe(-525);
  });

  it("throws BackfillError on NaN", () => {
    expect(() => toCents("not a number")).toThrow(BackfillError);
  });

  it("throws BackfillError on Infinity", () => {
    expect(() => toCents(Infinity)).toThrow(BackfillError);
  });
});

// ─── buildUserIdToUidMap ────────────────────────────────────────────

describe("buildUserIdToUidMap", () => {
  it("maps users with firebase_uid and skips those without", () => {
    const alice: PgUser = {
      id: "u-alice",
      email: "alice@test.com",
      name: "Alice",
      timezone: "Europe/Dublin",
      firebase_uid: "fb-alice",
      created_at: new Date("2024-01-01T00:00:00Z"),
    };
    const bob: PgUser = {
      id: "u-bob",
      email: "bob@test.com",
      name: "Bob",
      timezone: null,
      firebase_uid: "fb-bob",
      created_at: new Date("2024-02-01T00:00:00Z"),
    };
    const unmigrated: PgUser = {
      id: "u-charlie",
      email: "charlie@test.com",
      name: "Charlie",
      timezone: null,
      firebase_uid: null,
      created_at: new Date("2024-03-01T00:00:00Z"),
    };

    const m = buildUserIdToUidMap([alice, bob, unmigrated]);
    expect(m.get("u-alice")).toBe("fb-alice");
    expect(m.get("u-bob")).toBe("fb-bob");
    expect(m.has("u-charlie")).toBe(false);
    expect(m.size).toBe(2);
  });
});

// ─── computeParentUidsByChild — the canonical co-parenting test ────

describe("computeParentUidsByChild", () => {
  // Fixture mirrors the Alice/Bob/Carol scenario from docs/schema.md.
  //
  // Alice created both children (she's the original parent_id on both).
  // Bob is invited into Sam's Circle of Care. Carol is invited into
  // Jamie's. Bob and Carol don't know each other.
  //
  // Expected outcome after flattening:
  //   children/sam.parentUids   = ['fb-alice', 'fb-bob']
  //   children/jamie.parentUids = ['fb-alice', 'fb-carol']

  const users: PgUser[] = [
    {
      id: "u-alice",
      email: "alice@test.com",
      name: "Alice",
      timezone: null,
      firebase_uid: "fb-alice",
      created_at: new Date("2024-01-01T00:00:00Z"),
    },
    {
      id: "u-bob",
      email: "bob@test.com",
      name: "Bob",
      timezone: null,
      firebase_uid: "fb-bob",
      created_at: new Date("2024-02-01T00:00:00Z"),
    },
    {
      id: "u-carol",
      email: "carol@test.com",
      name: "Carol",
      timezone: null,
      firebase_uid: "fb-carol",
      created_at: new Date("2024-03-01T00:00:00Z"),
    },
  ];

  const children: PgChild[] = [
    {
      id: "c-sam",
      parent_id: "u-alice",
      name: "Sam",
      date_of_birth: new Date("2018-05-01"),
      balance: "12.50",
      profile_image_key: null,
      version: 3,
      created_at: new Date("2025-01-01"),
      updated_at: new Date("2025-06-01"),
    },
    {
      id: "c-jamie",
      parent_id: "u-alice",
      name: "Jamie",
      date_of_birth: new Date("2020-02-14"),
      balance: "7.25",
      profile_image_key: null,
      version: 1,
      created_at: new Date("2025-03-15"),
      updated_at: new Date("2025-06-01"),
    },
  ];

  const familyMembers: PgFamilyMember[] = [
    {
      id: "fm-1",
      child_id: "c-sam",
      user_id: "u-bob",
      role: "ADMIN",
      invited_by: "u-alice",
    },
    {
      id: "fm-2",
      child_id: "c-jamie",
      user_id: "u-carol",
      role: "ADMIN",
      invited_by: "u-alice",
    },
  ];

  const userIdToUid = buildUserIdToUidMap(users);

  it("flattens the creating parent plus family_members into parentUids", () => {
    const map = computeParentUidsByChild(
      children,
      familyMembers,
      userIdToUid,
    );

    expect(map.get("c-sam")).toEqual(["fb-alice", "fb-bob"]);
    expect(map.get("c-jamie")).toEqual(["fb-alice", "fb-carol"]);
  });

  it("isolates Bob from Jamie (the Phase 2 co-parenting requirement)", () => {
    const map = computeParentUidsByChild(
      children,
      familyMembers,
      userIdToUid,
    );

    expect(map.get("c-sam")).toContain("fb-bob");
    expect(map.get("c-jamie")).not.toContain("fb-bob");
    expect(map.get("c-jamie")).toContain("fb-carol");
    expect(map.get("c-sam")).not.toContain("fb-carol");
  });

  it("deduplicates if a user is both the creating parent AND a family_member", () => {
    const weirdFm: PgFamilyMember = {
      id: "fm-weird",
      child_id: "c-sam",
      user_id: "u-alice",
      role: "ADMIN",
      invited_by: "u-alice",
    };
    const map = computeParentUidsByChild(
      children,
      [...familyMembers, weirdFm],
      userIdToUid,
    );

    expect(map.get("c-sam")).toEqual(["fb-alice", "fb-bob"]);
  });

  it("returns a sorted parentUids array for deterministic backfills", () => {
    const map = computeParentUidsByChild(
      children,
      familyMembers,
      userIdToUid,
    );
    const sam = map.get("c-sam")!;
    const sorted = [...sam].sort();
    expect(sam).toEqual(sorted);
  });

  it("silently skips family_members whose user has no firebase_uid", () => {
    const unmigratedUser: PgUser = {
      id: "u-dave",
      email: "dave@test.com",
      name: "Dave",
      timezone: null,
      firebase_uid: null,
      created_at: new Date("2024-04-01T00:00:00Z"),
    };
    const fmDave: PgFamilyMember = {
      id: "fm-dave",
      child_id: "c-sam",
      user_id: "u-dave",
      role: "ADMIN",
      invited_by: "u-alice",
    };
    const uidMap = buildUserIdToUidMap([...users, unmigratedUser]);
    const map = computeParentUidsByChild(
      children,
      [...familyMembers, fmDave],
      uidMap,
    );
    // Sam still has alice + bob; dave is dropped because he has no uid.
    expect(map.get("c-sam")).toEqual(["fb-alice", "fb-bob"]);
  });

  it("handles children with no family_members (single-parent case)", () => {
    const soloChild: PgChild = {
      id: "c-solo",
      parent_id: "u-alice",
      name: "Solo",
      date_of_birth: new Date("2022-01-01"),
      balance: "0.00",
      profile_image_key: null,
      version: 1,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const map = computeParentUidsByChild([soloChild], [], userIdToUid);
    expect(map.get("c-solo")).toEqual(["fb-alice"]);
  });

  it("skips family_member rows pointing at unknown children", () => {
    const orphanFm: PgFamilyMember = {
      id: "fm-orphan",
      child_id: "c-ghost",
      user_id: "u-bob",
      role: "ADMIN",
      invited_by: "u-alice",
    };
    // Should not throw and should not affect known children.
    const map = computeParentUidsByChild(
      children,
      [...familyMembers, orphanFm],
      userIdToUid,
    );
    expect(map.get("c-sam")).toEqual(["fb-alice", "fb-bob"]);
    expect(map.has("c-ghost")).toBe(false);
  });
});

// ─── transformUser ──────────────────────────────────────────────────

describe("transformUser", () => {
  it("shapes a valid user row into FirestoreUser", () => {
    const u: PgUser = {
      id: "u-alice",
      email: "alice@test.com",
      name: "Alice",
      timezone: "Europe/Dublin",
      firebase_uid: "fb-alice",
      created_at: new Date("2024-01-15T12:34:56Z"),
    };
    const out = transformUser(u);
    expect(out.displayName).toBe("Alice");
    expect(out.email).toBe("alice@test.com");
    expect(out.timezone).toBe("Europe/Dublin");
    expect(out.photoUrl).toBeNull();
    expect(out.fcmTokens).toEqual([]);
  });

  it("preserves the source created_at (does not reset to now)", () => {
    // Gemini's #5 finding — historical signup time must survive the
    // migration so analytics derived from it don't collapse.
    const original = new Date("2023-06-01T09:00:00Z");
    const u: PgUser = {
      id: "u-alice",
      email: "alice@test.com",
      name: "Alice",
      timezone: null,
      firebase_uid: "fb-alice",
      created_at: original,
    };
    const out = transformUser(u);
    expect(out.createdAt).toEqual(original);
  });

  it("throws MISSING_FIREBASE_UID when firebase_uid is null", () => {
    const u: PgUser = {
      id: "u-charlie",
      email: "charlie@test.com",
      name: "Charlie",
      timezone: null,
      firebase_uid: null,
      created_at: new Date(),
    };
    expect(() => transformUser(u)).toThrowError(BackfillError);
    try {
      transformUser(u);
    } catch (err) {
      expect(err).toBeInstanceOf(BackfillError);
      expect((err as BackfillError).code).toBe("MISSING_FIREBASE_UID");
    }
  });
});

// ─── transformChild ─────────────────────────────────────────────────

describe("transformChild", () => {
  const CHILD_CREATED_AT = new Date("2025-01-01T09:30:00Z");

  const childRow: PgChild = {
    id: "c-sam",
    parent_id: "u-alice",
    name: "Sam",
    date_of_birth: new Date("2018-05-01"),
    balance: "12.50",
    profile_image_key: null,
    version: 3,
    created_at: CHILD_CREATED_AT,
    updated_at: new Date(),
  };

  it("converts balance to integer cents", () => {
    const out = transformChild(
      childRow,
      ["fb-alice", "fb-bob"],
      "fb-alice",
      null,
      0,
    );
    expect(out.balance).toBe(1250);
  });

  it("carries parentUids through unchanged", () => {
    const out = transformChild(
      childRow,
      ["fb-alice", "fb-bob"],
      "fb-alice",
      null,
      0,
    );
    expect(out.parentUids).toEqual(["fb-alice", "fb-bob"]);
  });

  it("preserves date_of_birth from PgChild as FirestoreChild.dateOfBirth", () => {
    // The Flask `Child.date_of_birth` column is `db.Date, nullable=False`
    // and must survive the backfill into Firestore as a required field.
    // Previously `transformChild` silently dropped it — this test pins
    // the contract so it can't regress.
    const out = transformChild(
      childRow,
      ["fb-alice"],
      "fb-alice",
      null,
      0,
    );
    expect(out.dateOfBirth).toEqual(new Date("2018-05-01"));
  });

  it("preserves the source version for optimistic-locking continuity", () => {
    const out = transformChild(childRow, ["fb-alice"], "fb-alice", null, 0);
    expect(out.version).toBe(3);
  });

  it("throws ORPHAN_CHILD if parentUids is empty", () => {
    try {
      transformChild(childRow, [], "fb-alice", null, 0);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BackfillError);
      expect((err as BackfillError).code).toBe("ORPHAN_CHILD");
    }
  });

  // ─── dateOfBirth runtime validation ──────────────────────────────
  //
  // Copilot flagged on PR #32 that `readChildren()` casts raw pg
  // rows to `PgChild[]` with no runtime validation. If a future
  // driver config (or a bad migration) ever returned `date_of_birth`
  // as a string or null, the cast would hide it and the Admin SDK
  // would write garbage into Firestore. Rather than add runtime type
  // validation at the I/O layer, we defend in the pure transform:
  // `transformChild` refuses to build a doc if the incoming
  // `date_of_birth` isn't a real `Date`. That keeps the check
  // unit-testable without spinning up Postgres.
  it("throws INVALID_CHILD_DOB when date_of_birth is a string instead of a Date", () => {
    const bad = { ...childRow, date_of_birth: "2018-05-01" as unknown as Date };
    try {
      transformChild(bad, ["fb-alice"], "fb-alice", null, 0);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BackfillError);
      expect((err as BackfillError).code).toBe("INVALID_CHILD_DOB");
    }
  });

  it("throws INVALID_CHILD_DOB when date_of_birth is null", () => {
    const bad = { ...childRow, date_of_birth: null as unknown as Date };
    try {
      transformChild(bad, ["fb-alice"], "fb-alice", null, 0);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BackfillError);
      expect((err as BackfillError).code).toBe("INVALID_CHILD_DOB");
    }
  });

  it("throws INVALID_CHILD_DOB when date_of_birth is an Invalid Date", () => {
    // `new Date("not a date")` constructs a Date whose .getTime() is
    // NaN. It's still `instanceof Date`, so a bare typeof check would
    // miss it — the validator has to inspect .getTime().
    const bad = { ...childRow, date_of_birth: new Date("not a date") };
    try {
      transformChild(bad, ["fb-alice"], "fb-alice", null, 0);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BackfillError);
      expect((err as BackfillError).code).toBe("INVALID_CHILD_DOB");
    }
  });

  // ─── createdAt carry-through + runtime validation ────────────────
  //
  // Reversing PR #32's pushback on Gemini's `createdAt` comments
  // (3-6). At this stage of the project there's no backfill cost and
  // the strongest data model is the one that enforces `createdAt`
  // server-side from day one: required on `FirestoreChild`, immutable
  // once set, validated at transform time the same way DOB is. The
  // Postgres source already carries `created_at` (it has since the
  // Flask days) so the historical creation-order survives the move.
  it("preserves created_at from PgChild as FirestoreChild.createdAt", () => {
    const out = transformChild(
      childRow,
      ["fb-alice"],
      "fb-alice",
      null,
      0,
    );
    expect(out.createdAt).toEqual(CHILD_CREATED_AT);
  });

  it("throws INVALID_CHILD_CREATED_AT when created_at is a string instead of a Date", () => {
    const bad = {
      ...childRow,
      created_at: "2025-01-01T09:30:00Z" as unknown as Date,
    };
    try {
      transformChild(bad, ["fb-alice"], "fb-alice", null, 0);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BackfillError);
      expect((err as BackfillError).code).toBe("INVALID_CHILD_CREATED_AT");
    }
  });

  it("throws INVALID_CHILD_CREATED_AT when created_at is null", () => {
    const bad = { ...childRow, created_at: null as unknown as Date };
    try {
      transformChild(bad, ["fb-alice"], "fb-alice", null, 0);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BackfillError);
      expect((err as BackfillError).code).toBe("INVALID_CHILD_CREATED_AT");
    }
  });

  it("throws INVALID_CHILD_CREATED_AT when created_at is an Invalid Date", () => {
    // Same `new Date("not a date")` trap as DOB — the validator has
    // to inspect .getTime() because Invalid Dates are still Dates.
    const bad = { ...childRow, created_at: new Date("not a date") };
    try {
      transformChild(bad, ["fb-alice"], "fb-alice", null, 0);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BackfillError);
      expect((err as BackfillError).code).toBe("INVALID_CHILD_CREATED_AT");
    }
  });
});

// ─── transformTransaction ───────────────────────────────────────────

describe("transformTransaction", () => {
  const txn: PgTransaction = {
    id: "t-1",
    child_id: "c-sam",
    parent_id: "u-alice",
    type: "LODGE",
    amount: "5.00",
    description: "chore bonus",
    created_at: new Date("2025-06-01"),
    version: 1,
  };

  it("maps a LODGE transaction in cents", () => {
    const out = transformTransaction(txn, "fb-alice");
    expect(out.amount).toBe(500);
    expect(out.type).toBe("LODGE");
    expect(out.createdByUid).toBe("fb-alice");
    expect(out.description).toBe("chore bonus");
  });

  it("throws ORPHAN_TRANSACTION when createdByUid is undefined", () => {
    try {
      transformTransaction(txn, undefined);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BackfillError);
      expect((err as BackfillError).code).toBe("ORPHAN_TRANSACTION");
    }
  });
});

// ─── transformVaultTransaction ──────────────────────────────────────

describe("transformVaultTransaction", () => {
  it("maps a vault DEPOSIT", () => {
    const row: PgVaultTransaction = {
      id: "vt-1",
      vault_id: "v-1",
      amount: "10.00",
      type: "DEPOSIT",
      description: "initial deposit",
      created_at: new Date(),
    };
    const out = transformVaultTransaction(row);
    expect(out.amount).toBe(1000);
    expect(out.type).toBe("DEPOSIT");
  });

  it("preserves source-specific INTEREST_CLAIM / MATCH types", () => {
    const row: PgVaultTransaction = {
      id: "vt-2",
      vault_id: "v-1",
      amount: "0.37",
      type: "INTEREST_CLAIM",
      description: "weekly interest",
      created_at: new Date(),
    };
    expect(transformVaultTransaction(row).type).toBe("INTEREST_CLAIM");
  });
});

// ─── transformActivity ──────────────────────────────────────────────

describe("transformActivity", () => {
  it("maps a READY activity", () => {
    const row: PgActivity = {
      id: "a-1",
      child_id: "c-sam",
      card_type: "BOUNTY_RECURRING",
      status: "READY",
      amount: "2.00",
      description: "Take out the bins",
      due_date: new Date("2025-06-05"),
      claimed_at: null,
      created_at: new Date(),
      version: 1,
    };
    const out = transformActivity(row);
    expect(out.title).toBe("Take out the bins");
    expect(out.reward).toBe(200);
    expect(out.type).toBe("BOUNTY_RECURRING");
    expect(out.status).toBe("READY");
  });
});

// ─── transformAllowanceConfig ───────────────────────────────────────

describe("transformAllowanceConfig", () => {
  it("maps a weekly allowance config", () => {
    const row: PgAllowanceConfig = {
      id: "ac-1",
      child_id: "c-sam",
      allowance_amount: "5.00",
      allowance_frequency: "WEEKLY",
      allowance_day: 6,
      last_generated_at: null,
    };
    const out = transformAllowanceConfig(row);
    expect(out.amount).toBe(500);
    expect(out.frequency).toBe("WEEKLY");
    expect(out.dayOfWeek).toBe(6);
  });
});

// ─── pickVaultBalanceCents ──────────────────────────────────────────

describe("pickVaultBalanceCents", () => {
  it("returns 0 when there are no vaults", () => {
    expect(pickVaultBalanceCents([])).toBe(0);
  });

  it("prefers the ACTIVE vault over a COMPLETED one", () => {
    const vaults: PgVault[] = [
      {
        id: "v-done",
        child_id: "c-sam",
        goal_name: "Old goal",
        target_amount: "50.00",
        current_balance: "50.00",
        status: "COMPLETED",
        unlocked_at: null,
      },
      {
        id: "v-active",
        child_id: "c-sam",
        goal_name: "New goal",
        target_amount: "100.00",
        current_balance: "17.50",
        status: "ACTIVE",
        unlocked_at: null,
      },
    ];
    expect(pickVaultBalanceCents(vaults)).toBe(1750);
  });

  it("ignores unlocked vaults entirely", () => {
    const vaults: PgVault[] = [
      {
        id: "v-unlocked",
        child_id: "c-sam",
        goal_name: "Spent goal",
        target_amount: "20.00",
        current_balance: "20.00",
        status: "COMPLETED",
        unlocked_at: new Date(),
      },
    ];
    expect(pickVaultBalanceCents(vaults)).toBe(0);
  });

  it("falls back to COMPLETED when there is no ACTIVE vault", () => {
    const vaults: PgVault[] = [
      {
        id: "v-done",
        child_id: "c-sam",
        goal_name: "Old goal",
        target_amount: "50.00",
        current_balance: "42.00",
        status: "COMPLETED",
        unlocked_at: null,
      },
    ];
    expect(pickVaultBalanceCents(vaults)).toBe(4200);
  });
});

// ─── transformInvite ────────────────────────────────────────────────

describe("transformInvite", () => {
  const LIFETIME_DAYS = 14;
  const NOW = new Date("2026-04-08T12:00:00Z");

  it("computes expiresAt as row.created_at + lifetimeDays (not now + lifetime)", () => {
    // Gemini's #4 finding — an invite created 6 days ago should have 8
    // days left, not a fresh 14-day lease.
    const createdAt = new Date("2026-04-02T12:00:00Z"); // 6 days before NOW
    const row: PgFamilyInvite = {
      id: "fi-recent",
      child_id: "c-sam",
      invited_by: "u-alice",
      invitee_email: "bob@test.com",
      status: "PENDING",
      created_at: createdAt,
    };
    const out = transformInvite(row, "fb-alice", LIFETIME_DAYS, NOW)!;
    const expected = new Date(
      createdAt.getTime() + LIFETIME_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(out.expiresAt).toEqual(expected);
    expect(out.childId).toBe("c-sam");
    expect(out.invitedByUid).toBe("fb-alice");
    expect(out.invitedEmail).toBe("bob@test.com");
    expect(out.acceptedByUid).toBeNull();
  });

  it("skips a PENDING invite whose derived expiresAt is already in the past", () => {
    // Gemini's #4 finding — an invite from 6 months ago has earned its
    // grave; the backfill shouldn't resurrect it with a fresh lease.
    const row: PgFamilyInvite = {
      id: "fi-stale",
      child_id: "c-sam",
      invited_by: "u-alice",
      invitee_email: "bob@test.com",
      status: "PENDING",
      created_at: new Date("2025-10-01T00:00:00Z"), // ~6 months before NOW
    };
    expect(transformInvite(row, "fb-alice", LIFETIME_DAYS, NOW)).toBeNull();
  });

  it("returns null for ACCEPTED invites (historical, not ported)", () => {
    const row: PgFamilyInvite = {
      id: "fi-2",
      child_id: "c-sam",
      invited_by: "u-alice",
      invitee_email: "bob@test.com",
      status: "ACCEPTED",
      created_at: NOW,
    };
    expect(transformInvite(row, "fb-alice", LIFETIME_DAYS, NOW)).toBeNull();
  });

  it("returns null when inviter has no firebase_uid", () => {
    const row: PgFamilyInvite = {
      id: "fi-3",
      child_id: "c-sam",
      invited_by: "u-ghost",
      invitee_email: "bob@test.com",
      status: "PENDING",
      created_at: NOW,
    };
    expect(transformInvite(row, undefined, LIFETIME_DAYS, NOW)).toBeNull();
  });
});

// ─── buildFcmTokensByUid ────────────────────────────────────────────

describe("buildFcmTokensByUid", () => {
  it("groups device tokens by firebase_uid", () => {
    const userIdToUid = new Map([
      ["u-alice", "fb-alice"],
      ["u-bob", "fb-bob"],
    ]);
    const tokens: PgDeviceToken[] = [
      {
        id: "dt-1",
        user_id: "u-alice",
        token: "tok-a1",
        platform: "android",
      },
      {
        id: "dt-2",
        user_id: "u-alice",
        token: "tok-a2",
        platform: "android",
      },
      { id: "dt-3", user_id: "u-bob", token: "tok-b1", platform: "android" },
    ];
    const out = buildFcmTokensByUid(tokens, userIdToUid);
    expect(out.get("fb-alice")).toEqual(["tok-a1", "tok-a2"]);
    expect(out.get("fb-bob")).toEqual(["tok-b1"]);
  });

  it("skips tokens for users with no firebase_uid", () => {
    const userIdToUid = new Map<string, string>();
    const tokens: PgDeviceToken[] = [
      { id: "dt-1", user_id: "u-ghost", token: "tok-x", platform: "android" },
    ];
    expect(buildFcmTokensByUid(tokens, userIdToUid).size).toBe(0);
  });
});
