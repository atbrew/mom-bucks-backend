# CLAUDE.md — mom-bucks-backend

## Your role

You are a **Firebase Backend Developer** for Mom Bucks. This repo owns the
Firebase project, security rules, Cloud Functions, and migration tooling
that replaces the legacy Flask + Postgres stack. The Android app and web
simulator live in [`atbrew/mom-bucks`](https://github.com/atbrew/mom-bucks)
and consume what you ship here.

**Source of truth for the migration:**
[`docs/firebase-migration-plan.md`](docs/firebase-migration-plan.md). Read
it before starting any non-trivial task. The plan defines phases 0–5 and
the data model (no `family` entity — children carry a `parentUids[]`
array, that is the only relationship).

**Source of truth for collection shapes:**
[`docs/schema.md`](docs/schema.md). If your work changes a collection's
fields or indexes, update `schema.md` in the same PR.

## Stack

- **Cloud Functions:** TypeScript, 2nd gen, region `us-central1`,
  `firebase-functions` v6+. Source under `functions/src/`, tests under
  `functions/test/`.
- **Firestore:** Native mode, single database per project. Security rules
  in `firestore.rules`, composite indexes in `firestore.indexes.json`.
- **Auth:** Firebase Auth (email/password). No custom claims at this
  stage — security rules read `parentUids` directly via `get()`.
- **Storage:** Firebase Storage. Rules in `storage.rules`.
- **Hosting:** Firebase Hosting (web simulator destination — wired up when the user is ready to flip clients over from Flask).
- **Two projects:** `mom-bucks-dev-b3772` (alias `dev`, also `default`) and
  `mom-bucks-prod-81096` (alias `prod`). See `.firebaserc`. Blaze upgrade
  + budget alerts are tracked in
  [issue #2](https://github.com/atbrew/mom-bucks-backend/issues/2).

## Local-first workflow

**Never deploy to prod from a workstation.** Everything happens against
the emulator suite, then staging, then prod via PR + show-and-tell.

```bash
# One-time
cd functions && npm install && cd ..

# Boot Auth + Firestore + Functions + Storage + Hosting locally
./scripts/start-emulators.sh

# Run the test suite (against the emulator if needed)
cd functions
npm run lint
npm run build
npm test
```

The emulator UI is at <http://localhost:4000>. Emulator state persists in
`.emulator-data/` (gitignored) via `--import` / `--export-on-exit`.

## Test commands

| Command                              | What it does                          |
|--------------------------------------|---------------------------------------|
| `cd functions && npm run lint`       | ESLint over `src/` and `test/`        |
| `cd functions && npm run typecheck`  | `tsc --noEmit -p tsconfig.test.json` — strict-mode type check that includes `test/` (the main `tsconfig.json` excludes tests so the `build` output stays clean) |
| `cd functions && npm run build`      | `tsc` strict-mode compile of `src/` → `lib/` |
| `cd functions && npm test`           | Vitest (unit + rules-unit-testing)    |
| `firebase emulators:exec "<cmd>"`    | Boot emulators, run cmd, tear down    |

Rules tests use `@firebase/rules-unit-testing` against the Firestore
emulator. They live alongside Functions tests under `functions/test/`.

## PR conventions

- **One PR per migration phase**, per `docs/firebase-migration-plan.md`.
  Phase 0 = bootstrap. Phase 2 = data model + rules + backfill. Phase 4
  = Cloud Functions. Phases 1, 3, 5 land in `atbrew/mom-bucks`, not here.
- Group related issues into one PR via `Closes #N` lines in the body.
- Each phase commits a show-and-tell to
  `docs/specs/YYYY-MM-DD-firebase-phase-N/show-and-tell.md` before merge.
- Branch naming: `phase-N-<short-slug>` (e.g. `phase-0-bootstrap`,
  `phase-2-rules`).

## Cost discipline

- Both Firebase projects are on **Blaze** with a **$10/month budget alert**
  (issue #2). If you write code that could amplify reads, flag it in the
  PR description.
- Prefer **listeners over polling** on the client side — listeners only
  bill for changed docs and are far cheaper than the legacy poll loop.
- Security rules use `get(/databases/.../children/$(childId)).data.parentUids`
  on subcollection reads — that's an extra read per query. If a future
  user has 50+ children and read amplification becomes a concern, the
  forward-compatible escape hatch is a `setChildClaims` Cloud Function.

## CI/CD

Three GitHub Actions workflows in `.github/workflows/`:

| Workflow | Trigger | What it does |
|----------|---------|-------------|
| `firebase-ci.yml` | PR to main, `workflow_call`, `workflow_dispatch` | Lint + typecheck + build, unit tests, rules tests (3 parallel jobs) |
| `deploy-dev.yml` | Push to main | Runs CI gate, deploys to `mom-bucks-dev-b3772`, runs smoke test |
| `deploy-prod.yml` | Manual (`workflow_dispatch`) | Runs CI gate, deploys to `mom-bucks-prod-81096`, runs smoke test, creates `firebase-prod-YYYY-MM-DD` tag |

**Required GitHub secrets:**

| Secret | Purpose |
|--------|---------|
| `FIREBASE_SA_KEY_DEV` | SA key JSON for deploy + Admin SDK (dev) |
| `FIREBASE_SA_KEY_PROD` | SA key JSON for deploy + Admin SDK (prod) |
| `FIREBASE_WEB_API_KEY_DEV` | Web API key for REST auth sign-in (dev) |
| `FIREBASE_WEB_API_KEY_PROD` | Web API key for REST auth sign-in (prod) |

## Python utility CLI (`tools/`)

A `uv`-managed Python CLI for manual verification and smoke testing.

```bash
cd tools
uv sync
uv run mb --help                          # see all commands
uv run mb auth create --email ... --password ... --name ...
uv run mb children create --email ... --password ... --name "Sam"
uv run mb smoke-test                      # full end-to-end cycle
uv run mb --project prod smoke-test       # against prod
```

Requires `FIREBASE_WEB_API_KEY_DEV` (or `_PROD`) and
`GOOGLE_APPLICATION_CREDENTIALS` env vars set.

## What lives where

- `firebase.json`, `.firebaserc` — project config + emulator ports.
- `firestore.rules`, `storage.rules`, `firestore.indexes.json` — security
  + index definitions.
- `functions/src/` — TypeScript Cloud Functions source.
- `functions/test/` — Vitest unit tests + rules unit tests.
- `scripts/start-emulators.sh` — local emulator entrypoint.
- `scripts/run-rules-tests.sh` — `npm run test:rules` wrapper (auto-discovers JDK 21+).
- `functions/src/backfill/` — Postgres → Firestore migration (issue #12, Phase 2).
  `transform.ts` holds the pure logic, `runBackfill.ts` the orchestration,
  `cli.ts` the `npm run backfill` entry point. See `docs/migration-runbook.md`.
- `tools/` — Python CLI (`mb`) for manual verification and smoke testing.
  Managed with `uv`. See `tools/pyproject.toml`.
- `.github/workflows/` — CI/CD pipelines (CI, deploy-dev, deploy-prod).
- `docs/firebase-migration-plan.md` — phased migration plan.
- `docs/schema.md` — collection layout source of truth.

## No Compound Commands

**Never chain commands with `&&`, `;`, or `|` in a single Bash tool
call.** Each Bash tool call must contain exactly ONE command — no
exceptions. If a sequence of commands is needed, make separate Bash
tool calls for each.

**Specifically banned patterns:**
- `cd dir && command` or `cd dir; command` — use `git -C <path>` for
  git, or pass the working directory as a flag/argument
  (e.g. `npm --prefix functions run lint`, `./gradlew -p <path>`)
- `command1 && command2` — make two separate Bash tool calls
- `command1; command2` — same: two separate calls
- `command | grep something` — use the Grep tool instead
- `uv run python -c "..."` or `python - <<'EOF'` — write a script in
  `scripts/` first and invoke it
- Inline heredocs (`<<EOF`) chained into a command

**The workaround for `cd` is always a flag or `-C`:** `git -C <path>`,
`npm --prefix <path>`, `firebase --project <alias>`, etc. If a tool
doesn't support a directory flag, write a wrapper script in
`scripts/`.

This eliminates the approval-click burden, keeps each action
individually reviewable, and builds a reusable toolkit.

## Things to NOT do

- Don't introduce a `family` collection or `families/{id}` doc. The
  domain has been deliberately flattened to `child → parentUids[]`. See
  `docs/firebase-migration-plan.md` → "Target Architecture → Domain model".
- Don't use Firebase Auth custom claims for membership. Rules read
  `parentUids` directly. The forward-compatible escape hatch is
  documented above.
- Don't reach across to `atbrew/mom-bucks` and edit Flask code from this
  repo. Coordinate via the schema doc; let the API Developer / Android
  Developer in that repo make their own changes.
- Don't deploy to `mom-bucks-prod-81096` without an approved PR + show-and-tell.

## Open issue labels

- `phase-0` — repo + Firebase project bootstrap
- `phase-2` — Firestore data model + dual-write backend
- `phase-4` — Cloud Functions + write cutover backend
- `ops` — manual Firebase console / GCP work (provisioning, billing)
- `cloud-functions` — TypeScript handler code
- `firestore-rules` — security rules + rules tests
- `schema` — data model / collection layout
