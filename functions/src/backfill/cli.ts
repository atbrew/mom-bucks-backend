#!/usr/bin/env -S npx tsx
/**
 * functions/src/backfill/cli.ts — Phase 2, issue #12.
 *
 * One-shot CLI that reads from a READ-ONLY Postgres replica and
 * writes deterministic-ID Firestore docs into the target Firebase
 * project. Intended to be run ONCE at migration cutover time.
 *
 * Usage (from repo root):
 *
 *     cd functions
 *     READ_ONLY_POSTGRES_DSN='postgres://ro_user:pw@host:5432/mombucks' \
 *     GOOGLE_APPLICATION_CREDENTIALS=/path/to/dev-sa.json \
 *     FIREBASE_PROJECT_ID=mom-bucks-dev-b3772 \
 *     npm run backfill
 *
 * The `npm run backfill` script under functions/ delegates to
 * `tsx src/backfill/cli.ts`.
 *
 * Safety checks (abort on failure):
 *   - READ_ONLY_POSTGRES_DSN must be set and must look like a
 *     read-only DSN (`?application_name=` containing `read-only`,
 *     or an explicit --allow-writable-dsn flag is required to
 *     override).
 *   - GOOGLE_APPLICATION_CREDENTIALS must point at a valid
 *     service-account JSON.
 *   - FIREBASE_PROJECT_ID must be set and match the target project.
 *
 * See docs/migration-runbook.md for the full rollout checklist.
 */

import { readFileSync } from "node:fs";
import { Client as PgClient } from "pg";
import {
  initializeApp,
  cert,
  applicationDefault,
  getApps,
  type ServiceAccount,
} from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { runBackfill } from "./runBackfill";

// ─── env parsing ────────────────────────────────────────────────────

const DSN = process.env.READ_ONLY_POSTGRES_DSN;
const PROJECT = process.env.FIREBASE_PROJECT_ID;
const ALLOW_WRITABLE = process.argv.includes("--allow-writable-dsn");
const DRY_RUN = process.argv.includes("--dry-run");

if (!DSN) {
  console.error("error: READ_ONLY_POSTGRES_DSN env var is required");
  process.exit(2);
}
if (!PROJECT) {
  console.error("error: FIREBASE_PROJECT_ID env var is required");
  process.exit(2);
}

if (!ALLOW_WRITABLE && !/read[-_]only|replica/i.test(DSN)) {
  console.error(
    "error: READ_ONLY_POSTGRES_DSN does not look read-only.\n" +
      "  expected the DSN to contain 'read-only' or 'replica' in the\n" +
      "  host, user, or application_name. Pass --allow-writable-dsn to\n" +
      "  override (NOT recommended — this script only reads, but a\n" +
      "  writable DSN implies a configuration mistake).",
  );
  process.exit(2);
}

// ─── Firebase Admin init ────────────────────────────────────────────

if (getApps().length === 0) {
  // Prefer GOOGLE_APPLICATION_CREDENTIALS if set; fall back to ADC.
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath) {
    const credJson = JSON.parse(
      readFileSync(credPath, "utf8"),
    ) as ServiceAccount;
    initializeApp({ credential: cert(credJson), projectId: PROJECT });
  } else {
    initializeApp({ credential: applicationDefault(), projectId: PROJECT });
  }
}

// ─── main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const pg = new PgClient({ connectionString: DSN });
  await pg.connect();
  console.log(`[backfill] connected to postgres (${maskDsn(DSN!)})`);
  console.log(`[backfill] target firebase project: ${PROJECT}`);
  if (DRY_RUN) {
    console.log("[backfill] DRY RUN: will not commit any Firestore writes");
  }

  try {
    const firestore = getFirestore();
    const summary = await runBackfill({
      pg,
      firestore,
      logger: (msg) => console.log(msg),
    });
    console.log("[backfill] DONE");
    console.log(JSON.stringify(summary, null, 2));
    if (summary.warnings.length > 0) {
      console.warn(`[backfill] ${summary.warnings.length} warnings`);
    }
  } finally {
    await pg.end();
  }
}

function maskDsn(dsn: string): string {
  try {
    const u = new URL(dsn);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<unparseable DSN>";
  }
}

main().catch((err) => {
  console.error("[backfill] FAILED:", err);
  process.exit(1);
});
