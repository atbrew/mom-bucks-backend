# Migration Runbook — Postgres → Firestore

This runbook covers the one-shot backfill that copies the live
Mom Bucks Postgres database into the Firestore collections defined in
[`docs/schema.md`](schema.md). It's the first half of the Phase 2
work (issue #12); the dual-write layer in the Flask API
(`atbrew/mom-bucks`) is the second half and is tracked separately.

The backfill is intended to run **once** at cutover time. Re-running
it is safe — it uses deterministic document IDs (the Postgres row
UUIDs) and `set()` semantics, so a second run exactly rewrites the
last transformed state.

## Source of truth

- Pure transform logic — [`functions/src/backfill/transform.ts`](../functions/src/backfill/transform.ts)
- Orchestration (pg reads, batched Firestore writes) — [`functions/src/backfill/runBackfill.ts`](../functions/src/backfill/runBackfill.ts)
- CLI entry point — [`functions/src/backfill/cli.ts`](../functions/src/backfill/cli.ts)
- Unit tests (fixtures + co-parenting scenario) — [`functions/test/backfill/transform.test.ts`](../functions/test/backfill/transform.test.ts)

## Prerequisites

Before you run the backfill:

1. **Phase 1 (`atbrew/mom-bucks` #1) must be done.** The backfill
   reads `users.firebase_uid` and uses it as the Firestore document
   ID for every user doc. If that column isn't populated, every
   active user gets skipped and their children are orphaned.
2. **Read-only Postgres DSN.** Provision a replica (or create a
   read-only role on the primary and connect via a pgbouncer / RDS
   proxy that forces read-only mode). Never point this script at a
   writable DSN. The CLI refuses to run unless the DSN string
   contains `read-only` or `replica` in the host, user, or
   application_name — override with `--allow-writable-dsn` only if
   you're absolutely certain.
3. **Firebase service account.** Download a service-account JSON
   for the target Firebase project from the Firebase console
   → Project settings → Service accounts. Keep it out of git.
4. **Target Firebase project.** Confirm which project you're
   writing to — staging for dry runs, prod only at final cutover.
   Double-check `FIREBASE_PROJECT_ID` in the environment matches.

## Dry run against dev

```bash
cd functions

# Point at the dev (staging) Firebase project and the read-only
# replica. The DSN below is illustrative — use your actual host.
export READ_ONLY_POSTGRES_DSN='postgres://mom_bucks_ro:<password>@mom-bucks-ro.internal:5432/mombucks?application_name=read-only-backfill'
export GOOGLE_APPLICATION_CREDENTIALS=/tmp/mom-bucks-dev-sa.json
export FIREBASE_PROJECT_ID=mom-bucks-dev-b3772

npm run backfill
```

The script logs:
- row counts read from each Postgres table,
- per-collection write progress,
- a final JSON summary with counts + any skip warnings.

Expected end-state in Firestore (check in the Firebase console):
- `users/{firebase_uid}` — one per migrated parent
- `children/{childId}` — one per child, `parentUids[]` populated
- `children/{childId}/transactions/{id}` — full transaction history
- `children/{childId}/vaultTransactions/{id}` — vault deposits/claims
- `children/{childId}/activities/{id}` — allowance + bounty cards
- `invites/{id}` — only `PENDING` invites are ported

## Verifying a dry run

Spot-check a co-parented child in the Firebase console:

1. Pick a child that has two parents in Postgres:
   ```sql
   SELECT c.id, c.name, u.email, u.firebase_uid
     FROM children c
     LEFT JOIN family_members fm ON fm.child_id = c.id
     JOIN users u ON u.id = fm.user_id OR u.id = c.parent_id
    WHERE c.id = '<child-id>';
   ```
2. Open `children/{child-id}` in the Firestore console.
3. Confirm `parentUids` contains the `firebase_uid`s of BOTH parents.
4. Spot-check balance: Postgres `Numeric(10,2)` × 100 should match
   Firestore integer cents exactly (e.g. `12.50` → `1250`).

## Rollback

Firestore has no transactional rollback for bulk writes. If a dry
run goes wrong, the recovery path is:

1. **If the target is staging**, just wipe the entire Firestore
   database via the Firebase console and re-run the backfill after
   fixing whatever broke. No user harm.
2. **If the target is prod**, do NOT wipe. Instead:
   - Stop clients from reading Firestore (the `USE_FIREBASE_BACKEND`
     flag in `atbrew/mom-bucks` clients — Phase 3).
   - Investigate which docs are wrong.
   - Either run a targeted fix script or restore from the nightly
     Firestore backup (enable this on prod before cutover — GCP
     Firestore backups are a Blaze-only feature).

The Postgres backup in GCS (90-day retention per Phase 5 plan) is
the ultimate rollback: wipe Firestore, restore Postgres, flip clients
back to the Flask API. This is the reason Phase 5 is a hard cutover
rather than a progressive migration.

## Known limitations / follow-ups

Tracked against the schema doc in [`docs/schema.md`](schema.md):

- **Vault fidelity.** The source has a `vaults` table that supports
  multiple states (ACTIVE/COMPLETED/unlocked). The backfill collapses
  this to a single `children.vaultBalance` integer-cents scalar
  matching the Firestore schema. Interest rate, matching multiplier,
  goal name, and claimed interest total are NOT currently ported. If
  we need richer vaults in Firestore post-migration, that's a
  follow-up issue.
- **Profile images.** The source stores `profile_image_key` (a GCS
  key). The backfill currently sets `photoUrl: null` because the
  image copy is a separate operation (GCS → Firebase Storage). This
  is a Phase 3 concern — clients re-upload on first login under the
  new storage rules.
- **Historical invites.** Only `PENDING` invites are ported. Accepted,
  declined, and revoked invites are dropped as historical noise.
- **Timezones.** `users.timezone` is carried across as a string.
  Scheduled functions (`sendHabitNotifications` #17) need to respect
  this per-user rather than using a project-wide default.

## Schema finding during Phase 2

The plan originally described the source schema as having a
`families` table with a `family_members` join. That's wrong —
there is no `families` table. The Postgres schema is already
child-scoped: `family_members` is a direct `child_id ↔ user_id`
join representing the "Circle of Care" for a specific child. This
actually makes the flattening simpler than plan.md predicted. See
`transform.ts` → `computeParentUidsByChild` for the implementation
and `test/backfill/transform.test.ts` for the canonical
Alice/Bob/Carol co-parenting isolation test.

## CLI flags

| Flag | Purpose |
|---|---|
| `--dry-run` | Log everything that would be written but don't commit to Firestore *(not yet implemented — placeholder)*. |
| `--allow-writable-dsn` | Override the read-only DSN safety check. Requires explicit intent. |

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `READ_ONLY_POSTGRES_DSN` | yes | Must contain `read-only` or `replica` substring, or `--allow-writable-dsn` is required. |
| `FIREBASE_PROJECT_ID` | yes | Must match the target Firebase project. No default — set it explicitly to avoid writing to the wrong project. |
| `GOOGLE_APPLICATION_CREDENTIALS` | recommended | Path to a service-account JSON. Falls back to Application Default Credentials if unset. |
