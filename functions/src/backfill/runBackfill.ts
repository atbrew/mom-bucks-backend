/**
 * Orchestration layer for the Postgres → Firestore backfill.
 *
 * Issue #12 — Phase 2.
 *
 * Reads every relevant table from a READ-ONLY Postgres replica,
 * transforms rows via the pure functions in `transform.ts`, and
 * writes deterministic-ID documents into Firestore via the Admin
 * SDK.
 *
 * Memory strategy:
 *   - **Small tables** (users, children, family_members, vaults,
 *     allowance_configs, device_tokens, invites) are loaded into
 *     memory up front. They're bounded by the number of families
 *     and parents, which stays small even as the app grows.
 *   - **Large tables** (transactions, vault_transactions, activities)
 *     are streamed via `pg-query-stream` one row at a time. A
 *     single `SELECT *` on `transactions` could easily be
 *     millions of rows in production, and loading that into a
 *     Node array is an OOM waiting to happen.
 *
 * Idempotency: Postgres row IDs (UUIDs) are reused as Firestore
 * document IDs, so re-running the script is safe. Writes use
 * `set()` (merge: false) so a re-run exactly rewrites the last
 * transformed state.
 *
 * This module is intentionally thin and I/O-shaped — the business
 * logic lives in `transform.ts` and is unit-tested there. The test
 * harness for THIS file would require a real Postgres + Firestore
 * emulator. Deferring that until we have live staging data to
 * validate against (see docs/migration-runbook.md).
 */

import type { Firestore, WriteBatch } from "firebase-admin/firestore";
import type { Client as PgClient } from "pg";
import QueryStream from "pg-query-stream";
import {
  BackfillError,
  buildFcmTokensByUid,
  buildUserIdToUidMap,
  computeParentUidsByChild,
  pickVaultBalanceCents,
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
} from "./transform";

export interface BackfillSummary {
  users: number;
  usersSkipped: number;
  children: number;
  childrenSkipped: number;
  transactions: number;
  transactionsSkipped: number;
  vaultTransactions: number;
  vaultTransactionsSkipped: number;
  activities: number;
  activitiesSkipped: number;
  allowanceConfigs: number;
  invites: number;
  invitesSkipped: number;
  warnings: string[];
}

export interface BackfillDeps {
  pg: PgClient;
  firestore: Firestore;
  logger?: (msg: string) => void;
  /**
   * How long a newly-created invite should live, measured from its
   * ORIGINAL `created_at` in Postgres (not from `now`). An invite
   * whose derived expiresAt is already in the past is skipped.
   * Default: 14 days.
   */
  inviteLifetimeDays?: number;
  /** Override "now" for tests. */
  now?: Date;
}

const DEFAULT_INVITE_LIFETIME_DAYS = 14;

// Firestore batches are capped at 500 operations. We use 400 to leave
// headroom for transactional reads / compound writes.
const BATCH_SIZE = 400;

/**
 * Main entry point. Runs the full backfill and returns a summary.
 *
 * The caller is responsible for connecting/disconnecting the pg
 * client. This function assumes a live connection and pg.query()
 * reachability.
 */
export async function runBackfill(
  deps: BackfillDeps,
): Promise<BackfillSummary> {
  const log = deps.logger ?? ((msg) => console.log(msg));
  const now = deps.now ?? new Date();
  const inviteLifetimeDays =
    deps.inviteLifetimeDays ?? DEFAULT_INVITE_LIFETIME_DAYS;

  const summary: BackfillSummary = {
    users: 0,
    usersSkipped: 0,
    children: 0,
    childrenSkipped: 0,
    transactions: 0,
    transactionsSkipped: 0,
    vaultTransactions: 0,
    vaultTransactionsSkipped: 0,
    activities: 0,
    activitiesSkipped: 0,
    allowanceConfigs: 0,
    invites: 0,
    invitesSkipped: 0,
    warnings: [],
  };

  // ── Load small tables into memory for cross-reference lookups ─
  log("[backfill] reading small source tables (users, children, etc)…");

  const users = await readUsers(deps.pg);
  const children = await readChildren(deps.pg);
  const familyMembers = await readFamilyMembers(deps.pg);
  const vaults = await readVaults(deps.pg);
  const allowanceConfigs = await readAllowanceConfigs(deps.pg);
  const deviceTokens = await readDeviceTokens(deps.pg);
  const invites = await readFamilyInvites(deps.pg);

  log(
    `[backfill] small tables read: users=${users.length} children=${children.length} ` +
      `family_members=${familyMembers.length} vaults=${vaults.length} ` +
      `allowance_configs=${allowanceConfigs.length} device_tokens=${deviceTokens.length} ` +
      `invites=${invites.length}`,
  );

  const userIdToUid = buildUserIdToUidMap(users);
  const fcmTokensByUid = buildFcmTokensByUid(deviceTokens, userIdToUid);
  const parentUidsByChild = computeParentUidsByChild(
    children,
    familyMembers,
    userIdToUid,
  );

  const vaultsByChild = groupBy(vaults, (v) => v.child_id);
  const vaultIdToChildId = new Map<string, string>();
  for (const v of vaults) vaultIdToChildId.set(v.id, v.child_id);

  const allowanceConfigByChild = new Map<string, PgAllowanceConfig>();
  for (const cfg of allowanceConfigs) {
    allowanceConfigByChild.set(cfg.child_id, cfg);
  }

  // ── users ──────────────────────────────────────────────────────
  log("[backfill] writing users/…");
  {
    let batch = deps.firestore.batch();
    let inBatch = 0;
    for (const row of users) {
      if (!row.firebase_uid) {
        summary.usersSkipped += 1;
        summary.warnings.push(
          `user ${row.id} (${row.email}) has no firebase_uid; skipped`,
        );
        continue;
      }
      const uid = row.firebase_uid;
      try {
        const doc = transformUser(row);
        doc.fcmTokens = fcmTokensByUid.get(uid) ?? [];
        batch.set(deps.firestore.doc(`users/${uid}`), doc);
        summary.users += 1;
        inBatch += 1;
        if (inBatch >= BATCH_SIZE) {
          await batch.commit();
          batch = deps.firestore.batch();
          inBatch = 0;
        }
      } catch (err) {
        if (err instanceof BackfillError) {
          summary.warnings.push(err.message);
          summary.usersSkipped += 1;
        } else {
          throw err;
        }
      }
    }
    if (inBatch > 0) {
      await batch.commit();
    }
  }

  // ── children (+ allowanceConfig inline) ───────────────────────
  log("[backfill] writing children/…");
  const writtenChildIds = new Set<string>();
  {
    let batch = deps.firestore.batch();
    let inBatch = 0;
    for (const row of children) {
      const parentUids = parentUidsByChild.get(row.id) ?? [];
      const creatorUid = userIdToUid.get(row.parent_id);
      if (!creatorUid) {
        summary.childrenSkipped += 1;
        summary.warnings.push(
          `child ${row.id} (${row.name}) parent ${row.parent_id} has no firebase_uid; skipped`,
        );
        continue;
      }
      try {
        const cfg = allowanceConfigByChild.get(row.id);
        const fsCfg = cfg ? transformAllowanceConfig(cfg) : null;
        const vaultBalanceCents = pickVaultBalanceCents(
          vaultsByChild.get(row.id) ?? [],
        );
        const doc = transformChild(
          row,
          parentUids,
          creatorUid,
          fsCfg,
          vaultBalanceCents,
        );
        batch.set(deps.firestore.doc(`children/${row.id}`), doc);
        writtenChildIds.add(row.id);
        if (fsCfg) summary.allowanceConfigs += 1;
        summary.children += 1;
        inBatch += 1;
        if (inBatch >= BATCH_SIZE) {
          await batch.commit();
          batch = deps.firestore.batch();
          inBatch = 0;
        }
      } catch (err) {
        if (err instanceof BackfillError) {
          summary.warnings.push(err.message);
          summary.childrenSkipped += 1;
        } else {
          throw err;
        }
      }
    }
    if (inBatch > 0) {
      await batch.commit();
    }
  }

  // ── transactions (STREAMED — potentially millions of rows) ────
  log("[backfill] streaming children/*/transactions/…");
  await streamAndWrite<PgTransaction>(
    deps.pg,
    deps.firestore,
    `SELECT id, child_id, parent_id, type, amount, description,
            created_at, version
       FROM transactions`,
    (batch, row) => {
      if (!writtenChildIds.has(row.child_id)) {
        summary.transactionsSkipped += 1;
        return false;
      }
      try {
        const createdByUid = userIdToUid.get(row.parent_id);
        const doc = transformTransaction(row, createdByUid);
        batch.set(
          deps.firestore.doc(
            `children/${row.child_id}/transactions/${row.id}`,
          ),
          doc,
        );
        summary.transactions += 1;
        return true;
      } catch (err) {
        if (err instanceof BackfillError) {
          summary.warnings.push(err.message);
          summary.transactionsSkipped += 1;
          return false;
        }
        throw err;
      }
    },
  );

  // ── vault transactions (STREAMED — vault-scoped, many per vault) ─
  log("[backfill] streaming children/*/vaultTransactions/…");
  await streamAndWrite<PgVaultTransaction>(
    deps.pg,
    deps.firestore,
    `SELECT id, vault_id, amount, type, description, created_at
       FROM vault_transactions`,
    (batch, row) => {
      const childId = vaultIdToChildId.get(row.vault_id);
      if (!childId) {
        summary.warnings.push(
          `vault_transaction ${row.id} references unknown vault ${row.vault_id}`,
        );
        summary.vaultTransactionsSkipped += 1;
        return false;
      }
      if (!writtenChildIds.has(childId)) {
        summary.vaultTransactionsSkipped += 1;
        return false;
      }
      const doc = transformVaultTransaction(row);
      batch.set(
        deps.firestore.doc(
          `children/${childId}/vaultTransactions/${row.id}`,
        ),
        doc,
      );
      summary.vaultTransactions += 1;
      return true;
    },
  );

  // ── activities (STREAMED — many per child, long-lived history) ─
  log("[backfill] streaming children/*/activities/…");
  await streamAndWrite<PgActivity>(
    deps.pg,
    deps.firestore,
    `SELECT id, child_id, card_type, status, amount, description,
            due_date, claimed_at, created_at, version
       FROM activities`,
    (batch, row) => {
      if (!writtenChildIds.has(row.child_id)) {
        summary.activitiesSkipped += 1;
        return false;
      }
      const doc = transformActivity(row);
      batch.set(
        deps.firestore.doc(
          `children/${row.child_id}/activities/${row.id}`,
        ),
        doc,
      );
      summary.activities += 1;
      return true;
    },
  );

  // ── invites (small, in-memory is fine) ────────────────────────
  log("[backfill] writing invites/…");
  await writeInBatches(deps.firestore, invites, (batch, row) => {
    const invitedByUid = userIdToUid.get(row.invited_by);
    const doc = transformInvite(row, invitedByUid, inviteLifetimeDays, now);
    if (!doc) {
      summary.invitesSkipped += 1;
      return false;
    }
    batch.set(deps.firestore.doc(`invites/${row.id}`), doc);
    summary.invites += 1;
    return true;
  });

  log("[backfill] summary: " + JSON.stringify(summary, null, 2));
  return summary;
}

// ─── Helpers ────────────────────────────────────────────────────────

function groupBy<T, K>(xs: T[], keyFn: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = keyFn(x);
    const existing = m.get(k);
    if (existing) {
      existing.push(x);
    } else {
      m.set(k, [x]);
    }
  }
  return m;
}

/**
 * Walk an in-memory list in Firestore-safe batches, calling
 * `fn(batch, item)` for each. The callback should push set()/delete()
 * calls onto the batch and return true if the item was added (so we
 * can count it against the batch size). A return of false means the
 * item was skipped and the batch counter is not incremented.
 */
async function writeInBatches<T>(
  firestore: Firestore,
  items: T[],
  fn: (batch: WriteBatch, item: T) => boolean,
): Promise<void> {
  let batch = firestore.batch();
  let inBatch = 0;
  for (const item of items) {
    const added = fn(batch, item);
    if (added) {
      inBatch += 1;
      if (inBatch >= BATCH_SIZE) {
        await batch.commit();
        batch = firestore.batch();
        inBatch = 0;
      }
    }
  }
  if (inBatch > 0) {
    await batch.commit();
  }
}

/**
 * Stream a large pg table and write the rows into Firestore in
 * Firestore-safe batches. The `sql` should produce rows that match
 * type `T`; the callback handles per-row transformation and batch
 * mutation, returning true if the row was added.
 *
 * Uses `pg-query-stream` (backed by pg's cursor protocol) so memory
 * stays bounded regardless of result-set size.
 */
async function streamAndWrite<T>(
  pg: PgClient,
  firestore: Firestore,
  sql: string,
  fn: (batch: WriteBatch, row: T) => boolean,
): Promise<void> {
  const stream = pg.query(new QueryStream(sql, [], { batchSize: BATCH_SIZE }));

  let batch = firestore.batch();
  let inBatch = 0;

  try {
    for await (const row of stream as AsyncIterable<T>) {
      const added = fn(batch, row);
      if (added) {
        inBatch += 1;
        if (inBatch >= BATCH_SIZE) {
          await batch.commit();
          batch = firestore.batch();
          inBatch = 0;
        }
      }
    }
    if (inBatch > 0) {
      await batch.commit();
    }
  } finally {
    // pg-query-stream cleans up the underlying cursor on stream end,
    // but destroy() is idempotent and safe on an already-finished
    // stream. Defensive — if `fn` throws, make sure the cursor is
    // released.
    (stream as unknown as { destroy?: () => void }).destroy?.();
  }
}

// ─── Small-table readers (these still load fully into memory) ──────

async function readUsers(pg: PgClient): Promise<PgUser[]> {
  const res = await pg.query(
    `SELECT id, email, name, timezone, firebase_uid, created_at
       FROM users`,
  );
  return res.rows as PgUser[];
}

async function readChildren(pg: PgClient): Promise<PgChild[]> {
  const res = await pg.query(
    `SELECT id, parent_id, name, date_of_birth, balance,
            profile_image_key, version, created_at, updated_at
       FROM children`,
  );
  return res.rows as PgChild[];
}

async function readFamilyMembers(pg: PgClient): Promise<PgFamilyMember[]> {
  const res = await pg.query(
    `SELECT id, child_id, user_id, role, invited_by FROM family_members`,
  );
  return res.rows as PgFamilyMember[];
}

async function readVaults(pg: PgClient): Promise<PgVault[]> {
  const res = await pg.query(
    `SELECT id, child_id, goal_name, target_amount, current_balance,
            status, unlocked_at
       FROM vaults`,
  );
  return res.rows as PgVault[];
}

async function readAllowanceConfigs(
  pg: PgClient,
): Promise<PgAllowanceConfig[]> {
  const res = await pg.query(
    `SELECT id, child_id, allowance_amount, allowance_frequency,
            allowance_day, last_generated_at
       FROM allowance_configs`,
  );
  return res.rows as PgAllowanceConfig[];
}

async function readDeviceTokens(pg: PgClient): Promise<PgDeviceToken[]> {
  const res = await pg.query(
    `SELECT id, user_id, token, platform FROM device_tokens`,
  );
  return res.rows as PgDeviceToken[];
}

async function readFamilyInvites(pg: PgClient): Promise<PgFamilyInvite[]> {
  const res = await pg.query(
    `SELECT id, child_id, invited_by, invitee_email, status, created_at
       FROM family_invites`,
  );
  return res.rows as PgFamilyInvite[];
}
