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
  vaultTransactions: number;
  activities: number;
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
   * How long a newly-created invite should live once backfilled.
   * Default: 14 days from now.
   */
  inviteExpiryDays?: number;
}

const DEFAULT_INVITE_EXPIRY_DAYS = 14;

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
export async function runBackfill(deps: BackfillDeps): Promise<BackfillSummary> {
  const log = deps.logger ?? ((msg) => console.log(msg));
  const summary: BackfillSummary = {
    users: 0,
    usersSkipped: 0,
    children: 0,
    childrenSkipped: 0,
    transactions: 0,
    vaultTransactions: 0,
    activities: 0,
    allowanceConfigs: 0,
    invites: 0,
    invitesSkipped: 0,
    warnings: [],
  };

  log("[backfill] reading source tables from Postgres…");

  const users = await readUsers(deps.pg);
  const children = await readChildren(deps.pg);
  const familyMembers = await readFamilyMembers(deps.pg);
  const transactions = await readTransactions(deps.pg);
  const vaults = await readVaults(deps.pg);
  const vaultTxns = await readVaultTransactions(deps.pg);
  const activities = await readActivities(deps.pg);
  const allowanceConfigs = await readAllowanceConfigs(deps.pg);
  const deviceTokens = await readDeviceTokens(deps.pg);
  const invites = await readFamilyInvites(deps.pg);

  log(
    `[backfill] read: users=${users.length} children=${children.length} ` +
      `family_members=${familyMembers.length} transactions=${transactions.length} ` +
      `vaults=${vaults.length} vault_transactions=${vaultTxns.length} ` +
      `activities=${activities.length} allowance_configs=${allowanceConfigs.length} ` +
      `device_tokens=${deviceTokens.length} invites=${invites.length}`,
  );

  const userIdToUid = buildUserIdToUidMap(users);
  const fcmTokensByUid = buildFcmTokensByUid(deviceTokens, userIdToUid);
  const parentUidsByChild = computeParentUidsByChild(
    children,
    familyMembers,
    userIdToUid,
  );

  // Group by child for efficient subcollection writes.
  const vaultsByChild = groupBy(vaults, (v) => v.child_id);
  const vaultTxnsByVault = groupBy(vaultTxns, (vt) => vt.vault_id);
  const transactionsByChild = groupBy(transactions, (t) => t.child_id);
  const activitiesByChild = groupBy(activities, (a) => a.child_id);
  const allowanceConfigByChild = new Map<string, PgAllowanceConfig>();
  for (const cfg of allowanceConfigs) {
    allowanceConfigByChild.set(cfg.child_id, cfg);
  }

  // ── users ──────────────────────────────────────────────────────
  log("[backfill] writing users/…");
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

  // ── children (+ allowanceConfig inline) ───────────────────────
  log("[backfill] writing children/…");
  batch = deps.firestore.batch();
  inBatch = 0;
  const writtenChildIds = new Set<string>();
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

  // ── transactions ──────────────────────────────────────────────
  log("[backfill] writing children/*/transactions/…");
  await writeInBatches(
    deps.firestore,
    transactions,
    (batch, row) => {
      if (!writtenChildIds.has(row.child_id)) return false;
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
          return false;
        }
        throw err;
      }
    },
  );

  // ── vault transactions (scoped to child via vault → child_id) ─
  log("[backfill] writing children/*/vaultTransactions/…");
  const vaultIdToChildId = new Map<string, string>();
  for (const v of vaults) vaultIdToChildId.set(v.id, v.child_id);

  const vaultTxnsFlat: Array<{ childId: string; row: PgVaultTransaction }> = [];
  for (const vt of vaultTxns) {
    const childId = vaultIdToChildId.get(vt.vault_id);
    if (!childId) {
      summary.warnings.push(
        `vault_transaction ${vt.id} references unknown vault ${vt.vault_id}`,
      );
      continue;
    }
    if (!writtenChildIds.has(childId)) continue;
    vaultTxnsFlat.push({ childId, row: vt });
  }
  // Silence the unused-variable warning while keeping the grouping map
  // around for potential future use (per-vault cursors, etc.).
  void vaultTxnsByVault;

  await writeInBatches(deps.firestore, vaultTxnsFlat, (batch, item) => {
    const doc = transformVaultTransaction(item.row);
    batch.set(
      deps.firestore.doc(
        `children/${item.childId}/vaultTransactions/${item.row.id}`,
      ),
      doc,
    );
    summary.vaultTransactions += 1;
    return true;
  });

  // ── activities ───────────────────────────────────────────────
  log("[backfill] writing children/*/activities/…");
  await writeInBatches(deps.firestore, activities, (batch, row) => {
    if (!writtenChildIds.has(row.child_id)) return false;
    const doc = transformActivity(row);
    batch.set(
      deps.firestore.doc(`children/${row.child_id}/activities/${row.id}`),
      doc,
    );
    summary.activities += 1;
    return true;
  });

  // Keep groupBy'd activity map around for callers who may want
  // per-child iteration later — not used here.
  void activitiesByChild;
  // Same for transactionsByChild.
  void transactionsByChild;

  // ── invites ──────────────────────────────────────────────────
  log("[backfill] writing invites/…");
  const now = Date.now();
  const expiryMs =
    (deps.inviteExpiryDays ?? DEFAULT_INVITE_EXPIRY_DAYS) * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(now + expiryMs);

  await writeInBatches(deps.firestore, invites, (batch, row) => {
    const invitedByUid = userIdToUid.get(row.invited_by);
    const doc = transformInvite(row, invitedByUid, expiresAt);
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
 * Walk a list in Firestore-safe batches, calling `fn(batch, item)`
 * for each. The callback should push set()/delete() calls onto the
 * batch and return true if the item was added (so we can count it
 * against the batch size). A return of false means the item was
 * skipped and the batch counter is not incremented.
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

// ─── Postgres readers ───────────────────────────────────────────────

async function readUsers(pg: PgClient): Promise<PgUser[]> {
  const res = await pg.query(
    `SELECT id, email, name, timezone, firebase_uid FROM users`,
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

async function readTransactions(pg: PgClient): Promise<PgTransaction[]> {
  const res = await pg.query(
    `SELECT id, child_id, parent_id, type, amount, description,
            created_at, version
       FROM transactions`,
  );
  return res.rows as PgTransaction[];
}

async function readVaults(pg: PgClient): Promise<PgVault[]> {
  const res = await pg.query(
    `SELECT id, child_id, goal_name, target_amount, current_balance,
            status, unlocked_at
       FROM vaults`,
  );
  return res.rows as PgVault[];
}

async function readVaultTransactions(
  pg: PgClient,
): Promise<PgVaultTransaction[]> {
  const res = await pg.query(
    `SELECT id, vault_id, amount, type, description, created_at
       FROM vault_transactions`,
  );
  return res.rows as PgVaultTransaction[];
}

async function readActivities(pg: PgClient): Promise<PgActivity[]> {
  const res = await pg.query(
    `SELECT id, child_id, card_type, status, amount, description,
            due_date, claimed_at, created_at, version
       FROM activities`,
  );
  return res.rows as PgActivity[];
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
