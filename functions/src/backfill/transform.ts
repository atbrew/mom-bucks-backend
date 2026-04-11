/**
 * Pure transform functions for the Postgres → Firestore backfill.
 *
 * Issue #12 — Phase 2.
 *
 * Every function in this file is side-effect-free: rows in, Firestore
 * docs out. The I/O wrapper in `runBackfill.ts` handles actually
 * reading from pg and writing via the Admin SDK. This split lets us
 * unit-test the hard parts (family flattening, cents conversion,
 * co-parenting) with fixture data instead of spinning up a real
 * Postgres.
 *
 * Source schema reference: see `mom-bucks/web-app/src/mombucks/models/`.
 *
 * IMPORTANT: the source has NO `families` table. The "family" concept
 * in the original plan was a misreading of the Postgres schema — the
 * actual data model is already child-scoped via the `family_members`
 * table, which is a direct child ↔ user join. This simplifies the
 * flattening: for each child, `parentUids` is
 *
 *     union(
 *       [users.firebase_uid where users.id == child.parent_id],
 *       [users.firebase_uid where users.id in (
 *         family_members.user_id where child_id == thisChild.id
 *       )]
 *     )
 *
 * i.e. the creating parent plus every "Circle of Care" member.
 */

// ─── Source row types (mirror the live Postgres schema) ─────────────

export interface PgUser {
  id: string;
  email: string;
  name: string;
  timezone: string | null;
  /**
   * Firebase Auth uid, populated in Phase 1 (#1 in atbrew/mom-bucks)
   * via the Flask-side auth migration. At cutover time every active
   * user MUST have this set — if a user row is missing it, the
   * backfill refuses to proceed for that user (and anything that
   * references them as a parent).
   */
  firebase_uid: string | null;
  /**
   * Original signup timestamp. Carried through verbatim to
   * `users/{uid}.createdAt` so the historical signup order survives
   * the migration.
   */
  created_at: Date;
}

export interface PgChild {
  id: string;
  parent_id: string;
  name: string;
  date_of_birth: Date;
  balance: string | number;
  profile_image_key: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface PgFamilyMember {
  id: string;
  child_id: string;
  user_id: string;
  role: "ADMIN";
  invited_by: string;
}

export interface PgTransaction {
  id: string;
  child_id: string;
  parent_id: string;
  type: "LODGE" | "WITHDRAW";
  amount: string | number;
  description: string;
  created_at: Date;
  version: number;
}

export interface PgVault {
  id: string;
  child_id: string;
  goal_name: string;
  target_amount: string | number;
  current_balance: string | number;
  status: "ACTIVE" | "COMPLETED";
  unlocked_at: Date | null;
}

export interface PgVaultTransaction {
  id: string;
  vault_id: string;
  amount: string | number;
  type: "DEPOSIT" | "UNLOCK" | "INTEREST_CLAIM" | "MATCH";
  description: string;
  created_at: Date;
}

export interface PgActivity {
  id: string;
  child_id: string;
  card_type: "ALLOWANCE" | "BOUNTY_RECURRING" | "INTEREST";
  status: "LOCKED" | "READY";
  amount: string | number;
  description: string;
  due_date: Date;
  claimed_at: Date | null;
  created_at: Date;
  version: number;
}

export interface PgAllowanceConfig {
  id: string;
  child_id: string;
  allowance_amount: string | number;
  allowance_frequency: "DAILY" | "WEEKLY" | "FORTNIGHTLY" | "MONTHLY";
  allowance_day: number;
  last_generated_at: Date | null;
}

export interface PgFamilyInvite {
  id: string;
  child_id: string;
  invited_by: string;
  invitee_email: string;
  status: "PENDING" | "ACCEPTED" | "DECLINED" | "REVOKED";
  created_at: Date;
}

export interface PgDeviceToken {
  id: string;
  user_id: string;
  token: string;
  platform: string;
}

// ─── Firestore doc shapes (mirror docs/schema.md) ───────────────────

export interface FirestoreUser {
  displayName: string;
  email: string;
  photoUrl: string | null;
  fcmTokens: string[];
  timezone: string | null;
  createdAt: Date;
}

export interface FirestoreChild {
  name: string;
  /**
   * Child's calendar date of birth. Mirrors the Flask
   * `Child.date_of_birth` column (`db.Date, nullable=False`) — it is
   * required on every child and never null. Stored as a Firestore
   * `timestamp` (the Admin SDK converts the JS `Date` we hand it on
   * write), but semantically it's a day: callers should ignore the
   * time-of-day component.
   */
  dateOfBirth: Date;
  photoUrl: string | null;
  balance: number; // integer cents
  vaultBalance: number; // integer cents
  parentUids: string[];
  createdByUid: string;
  allowanceConfig: FirestoreAllowanceConfig | null;
  lastTxnAt: Date | null;
  deletedAt: Date | null;
  version: number;
}

export interface FirestoreAllowanceConfig {
  amount: number; // integer cents
  frequency: "DAILY" | "WEEKLY" | "FORTNIGHTLY" | "MONTHLY";
  dayOfWeek: number;
  lastGeneratedAt: Date | null;
}

export interface FirestoreTransaction {
  amount: number; // integer cents
  type: "LODGE" | "WITHDRAW";
  description: string;
  createdAt: Date;
  createdByUid: string;
}

export interface FirestoreVaultTransaction {
  amount: number; // integer cents
  type: "DEPOSIT" | "UNLOCK" | "INTEREST_CLAIM" | "MATCH";
  description: string;
  createdAt: Date;
}

export interface FirestoreActivity {
  title: string;
  reward: number; // integer cents
  type: "ALLOWANCE" | "BOUNTY_RECURRING" | "INTEREST";
  status: "LOCKED" | "READY";
  dueDate: Date;
  claimedAt: Date | null;
  createdAt: Date;
}

export interface FirestoreInvite {
  childId: string;
  invitedByUid: string;
  invitedEmail: string | null;
  expiresAt: Date;
  acceptedByUid: string | null;
  acceptedAt: Date | null;
}

// ─── Transform errors ───────────────────────────────────────────────

export class BackfillError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "MISSING_FIREBASE_UID"
      | "ORPHAN_CHILD"
      | "ORPHAN_TRANSACTION"
      | "ORPHAN_VAULT_TXN"
      | "INVALID_AMOUNT"
      | "INVALID_CHILD_DOB",
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "BackfillError";
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Convert a Postgres Numeric(10,2) value (which the `pg` driver
 * returns as a string to preserve precision) to an integer cents
 * value. Rounding is deliberate: pg sometimes returns "12.50" but
 * naive `Number()` coercion followed by multiplication can yield
 * 1249.999... due to floating-point, so we Math.round to snap.
 */
export function toCents(value: string | number): number {
  if (value === null || value === undefined) {
    throw new BackfillError(
      `cannot convert ${String(value)} to cents`,
      "INVALID_AMOUNT",
      { value },
    );
  }
  const asNumber = typeof value === "string" ? parseFloat(value) : value;
  if (!Number.isFinite(asNumber)) {
    throw new BackfillError(
      `value ${value} is not a finite number`,
      "INVALID_AMOUNT",
      { value },
    );
  }
  return Math.round(asNumber * 100);
}

/**
 * Build a lookup from Postgres user.id to Firebase Auth uid.
 * Users without a firebase_uid are EXCLUDED — the caller can then
 * detect orphans when walking children/transactions.
 */
export function buildUserIdToUidMap(users: PgUser[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const u of users) {
    if (u.firebase_uid) {
      m.set(u.id, u.firebase_uid);
    }
  }
  return m;
}

/**
 * Given all users and all family_members, compute every child's
 * parentUids array. This is the heart of the "flatten families into
 * children" logic.
 *
 * For each child:
 *   parentUids = {firebase_uid of child.parent_id}
 *             ∪ {firebase_uid of family_members.user_id
 *                where family_members.child_id == child.id}
 *
 * Users without a firebase_uid are silently skipped — the caller
 * should surface a warning if this happens.
 *
 * Returns a map from `child.id` → sorted array of unique uids. The
 * sort is for determinism so re-runs produce the same array and
 * Firestore doesn't flag the field as "changed" on a no-op backfill.
 */
export function computeParentUidsByChild(
  children: PgChild[],
  familyMembers: PgFamilyMember[],
  userIdToUid: Map<string, string>,
): Map<string, string[]> {
  const result = new Map<string, Set<string>>();

  for (const child of children) {
    const set = new Set<string>();
    const creatorUid = userIdToUid.get(child.parent_id);
    if (creatorUid) {
      set.add(creatorUid);
    }
    result.set(child.id, set);
  }

  for (const fm of familyMembers) {
    const set = result.get(fm.child_id);
    if (!set) {
      // family_member points at a child we don't know — skip, the
      // caller can detect this if they care.
      continue;
    }
    const uid = userIdToUid.get(fm.user_id);
    if (uid) {
      set.add(uid);
    }
  }

  // Materialise to sorted arrays for determinism.
  const finalMap = new Map<string, string[]>();
  for (const [childId, set] of result.entries()) {
    finalMap.set(childId, Array.from(set).sort());
  }
  return finalMap;
}

// ─── Per-collection transforms ──────────────────────────────────────

export function transformUser(row: PgUser): FirestoreUser {
  if (!row.firebase_uid) {
    throw new BackfillError(
      `user ${row.id} (${row.email}) has no firebase_uid — cannot backfill`,
      "MISSING_FIREBASE_UID",
      { userId: row.id, email: row.email },
    );
  }
  return {
    displayName: row.name,
    email: row.email,
    photoUrl: null,
    fcmTokens: [],
    timezone: row.timezone,
    // Preserve the original signup time from Postgres so the historical
    // ordering (and any analytics derived from it) survives the move.
    createdAt: row.created_at,
  };
}

export function transformChild(
  row: PgChild,
  parentUids: string[],
  createdByUid: string,
  allowanceConfig: FirestoreAllowanceConfig | null,
  vaultBalance: number,
): FirestoreChild {
  if (parentUids.length === 0) {
    throw new BackfillError(
      `child ${row.id} (${row.name}) has no resolvable parentUids`,
      "ORPHAN_CHILD",
      { childId: row.id, postgresParentId: row.parent_id },
    );
  }

  // Runtime validation of `date_of_birth`.
  //
  // The `pg` driver returns a Postgres `DATE` column as a JS `Date`
  // at midnight UTC of that calendar day by default, which is what
  // we want to hand to the Admin SDK — it will serialise to a
  // Firestore `timestamp`. `readChildren()` casts `res.rows` to
  // `PgChild[]` without runtime validation though, so if a future
  // driver config (or a bad migration) ever returned a string, a
  // null, or an Invalid Date, the cast would hide it and we'd
  // silently write garbage into Firestore. Catch that here instead
  // of relying on types.
  //
  // Note that `new Date("not a date")` is still `instanceof Date`,
  // so we explicitly check `isNaN(.getTime())` — a bare typeof
  // check would miss Invalid Dates. PR #32 review feedback.
  const dob = row.date_of_birth;
  if (!(dob instanceof Date) || Number.isNaN(dob.getTime())) {
    throw new BackfillError(
      `child ${row.id} (${row.name}) has invalid date_of_birth: ${String(dob)}`,
      "INVALID_CHILD_DOB",
      { childId: row.id, value: dob },
    );
  }

  return {
    name: row.name,
    dateOfBirth: dob,
    photoUrl: null,
    balance: toCents(row.balance),
    vaultBalance,
    parentUids,
    createdByUid,
    allowanceConfig,
    lastTxnAt: null,
    deletedAt: null,
    version: row.version,
  };
}

export function transformTransaction(
  row: PgTransaction,
  createdByUid: string | undefined,
): FirestoreTransaction {
  if (!createdByUid) {
    throw new BackfillError(
      `transaction ${row.id} references unknown parent ${row.parent_id}`,
      "ORPHAN_TRANSACTION",
      { txnId: row.id, parentId: row.parent_id },
    );
  }
  return {
    amount: toCents(row.amount),
    type: row.type,
    description: row.description,
    createdAt: row.created_at,
    createdByUid,
  };
}

export function transformVaultTransaction(
  row: PgVaultTransaction,
): FirestoreVaultTransaction {
  return {
    amount: toCents(row.amount),
    type: row.type,
    description: row.description,
    createdAt: row.created_at,
  };
}

export function transformActivity(row: PgActivity): FirestoreActivity {
  return {
    title: row.description,
    reward: toCents(row.amount),
    type: row.card_type,
    status: row.status,
    dueDate: row.due_date,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
  };
}

export function transformAllowanceConfig(
  row: PgAllowanceConfig,
): FirestoreAllowanceConfig {
  return {
    amount: toCents(row.allowance_amount),
    frequency: row.allowance_frequency,
    dayOfWeek: row.allowance_day,
    lastGeneratedAt: row.last_generated_at,
  };
}

/**
 * Pull the active (or most recently completed, not yet unlocked)
 * vault's current_balance in cents. If no such vault exists, returns 0.
 *
 * This collapses the source's potentially-multi-row vaults table into
 * a single `children.vaultBalance` scalar in Firestore, matching
 * docs/schema.md. A more faithful "vaults as subcollection" migration
 * is a follow-up (see `docs/migration-runbook.md`).
 */
export function pickVaultBalanceCents(vaults: PgVault[]): number {
  const visible = vaults.filter((v) => v.unlocked_at === null);
  if (visible.length === 0) return 0;
  // Prefer ACTIVE, fall back to COMPLETED.
  const active = visible.find((v) => v.status === "ACTIVE");
  const pick = active ?? visible[0];
  return pick ? toCents(pick.current_balance) : 0;
}

/**
 * Transform a single Postgres family_invite row into a Firestore
 * invite doc. Only PENDING invites are ported; accepted/declined/revoked
 * are historical.
 *
 * Both Postgres and Firestore store one child per invite. If a parent
 * wants to share two children they send two invite links — the extra
 * round trip is cheap and it keeps the acceptInvite security boundary
 * dead simple (one invite → one `arrayUnion`).
 *
 * Expiry is computed as `row.created_at + lifetimeDays`, NOT
 * `now + lifetimeDays` — an invite that was created six months ago
 * has earned its grave and should not be resurrected with a fresh
 * 14-day lease at backfill time. If the derived expiresAt is already
 * in the past, the invite is treated as stale and skipped (returns
 * null).
 */
export function transformInvite(
  row: PgFamilyInvite,
  invitedByUid: string | undefined,
  lifetimeDays: number,
  now: Date,
): FirestoreInvite | null {
  if (row.status !== "PENDING") return null;
  if (!invitedByUid) {
    // inviter has no firebase_uid — skip, we can't represent this
    // invite without a valid Firebase identity.
    return null;
  }
  const lifetimeMs = lifetimeDays * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(row.created_at.getTime() + lifetimeMs);
  if (expiresAt.getTime() <= now.getTime()) {
    // Original lifetime has already elapsed. Don't port it — the
    // inviter can re-invite if they still want to co-parent.
    return null;
  }
  return {
    childId: row.child_id,
    invitedByUid,
    invitedEmail: row.invitee_email,
    expiresAt,
    acceptedByUid: null,
    acceptedAt: null,
  };
}

/**
 * Collect every user's device tokens into a flat list keyed by
 * firebase_uid. Used to populate `users/{uid}.fcmTokens` at backfill
 * time.
 */
export function buildFcmTokensByUid(
  tokens: PgDeviceToken[],
  userIdToUid: Map<string, string>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const t of tokens) {
    const uid = userIdToUid.get(t.user_id);
    if (!uid) continue;
    const existing = result.get(uid) ?? [];
    existing.push(t.token);
    result.set(uid, existing);
  }
  return result;
}
