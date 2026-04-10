# CI/CD and Tooling Proposal

## Context

The `atbrew/mom-bucks` repo has a mature GitHub Actions pipeline: PR
checks, auto-deploy to dev on merge, and manual release to prod. This
repo (`mom-bucks-backend`) has none of that yet — everything is manual
(`npm run lint`, `npm test`, `firebase deploy`). This proposal adds
CI/CD workflows modelled on the mom-bucks patterns, plus a Python
utility script for manual backend verification.

## Decisions

These questions were resolved during review. Captured here so the
implementation doesn't revisit them.

| Question | Decision |
|----------|----------|
| Hosting deploy | Include it; env-specific `index.html` ("Mom Bucks Dev" vs "Mom Bucks") written by the workflow before `firebase deploy` |
| Branch protection | Yes — require all CI status checks to pass before merge |
| Contract tests in CI | No — Flask parity is complete (PRs #24–#30). Firebase is the source of truth. Contract test files will be removed in a cleanup PR. |
| Budget alerts in CI | No — use existing Firebase Console budget alerts (issue #2) |
| Utility script default project | Default to dev (`mom-bucks-dev-b3772`); require explicit `--project prod` for production |

## 1. GitHub Actions Workflows

### 1a. PR Check (`firebase-ci.yml`)

**Trigger:** Pull request to `main` (paths: `functions/**`,
`firestore.rules`, `storage.rules`, `firestore.indexes.json`,
workflow file itself).

**Jobs:**

1. **Lint + Typecheck + Build** (ubuntu-latest, Node 22)
   - `npm ci` in `functions/`
   - `npm run lint`
   - `npm run typecheck` (strict, includes test files)
   - `npm run build` (compile `src/` to `lib/`)

2. **Unit Tests** (ubuntu-latest, Node 22)
   - `npm run test:unit` (vitest, no emulator needed)

3. **Rules Tests** (ubuntu-latest, Node 22, Java 21)
   - Install Firebase CLI
   - `npm run test:rules` (boots Firestore emulator, runs rules
     unit tests, tears down)

**Why three jobs instead of one:** Lint/typecheck failures are fast
(< 30s); unit tests take ~10s; rules tests need Java + emulator (~30s
startup). Running them in parallel surfaces failures faster than a
single serial job.

### 1b. Deploy to Dev (`deploy-dev.yml`)

**Trigger:** Push to `main` (same path filter as PR check).

**Prerequisite:** All three PR-check jobs pass (duplicated as a gate,
or extracted as a reusable workflow).

**Jobs:**

1. **Gate: lint + typecheck + build + unit tests + rules tests**
2. **Deploy** (ubuntu-latest, Node 22)

   a. Authenticate to Firebase using a service account key
      (`FIREBASE_SA_KEY_DEV` secret).

   b. Write the dev hosting page:
      ```html
      <title>Mom Bucks Dev</title>
      ```

   c. Deploy with `--skip-predeploy` (CI already validated the
      build in the gate jobs — no reason to lint+typecheck+build
      a second time inside the Firebase CLI's predeploy hooks):
      ```bash
      firebase deploy --project mom-bucks-dev-b3772 \
        --only functions,firestore:rules,firestore:indexes,storage,hosting \
        --skip-predeploy
      ```

   d. **Post-deploy smoke test** — run `mb smoke-test` against the
      live dev project. This is **mandatory**, not optional. Firebase
      functions can report ACTIVE even if they crash on boot (missing
      env var, runtime error). The smoke test exercises auth + rules
      + callables through the client SDK path, catching failures that
      `firebase functions:list` would miss. If the smoke test fails,
      the workflow fails.

**What `firebase deploy` does under the hood:**

| Component | What ships | Mechanism |
|-----------|-----------|-----------|
| Functions | `functions/lib/` (compiled JS) | Uploaded to Cloud Functions; cold starts pick up new code |
| Firestore rules | `firestore.rules` | Uploaded and applied atomically; takes effect within seconds |
| Firestore indexes | `firestore.indexes.json` | Creates/updates composite indexes; long-running but non-blocking |
| Storage rules | `storage.rules` | Uploaded and applied atomically |
| Hosting | `public/index.html` | Uploaded to Firebase CDN; live within seconds |

There is no Docker image, no SSH, no rollback script. Firebase
handles versioning internally — every deploy creates a new
immutable release. If a bad deploy ships, the fix is another deploy
(or `firebase functions:delete <name>` in an emergency).

### 1c. Deploy to Prod (`deploy-prod.yml`)

**Trigger:** Manual only (`workflow_dispatch`), matching the
mom-bucks pattern.

**Jobs:**

1. **Gate: Full test suite** (lint + typecheck + build + unit + rules)
2. **Deploy** (same as dev, but `--project mom-bucks-prod-81096`)
   - Uses `FIREBASE_SA_KEY_PROD` secret
   - Writes production hosting page (`<title>Mom Bucks</title>`)
   - Runs `mb smoke-test --project prod` as mandatory verification
3. **Tag release** — creates a lightweight git tag
   `firebase-prod-YYYY-MM-DD` on the deployed commit. Useful for
   debugging "when did this break?" without digging through the
   Firebase Console deploy history.

### 1d. Summary: What triggers what

```
Pull Request to main
  └─ firebase-ci.yml
       ├─ lint-typecheck-build
       ├─ unit-tests
       └─ rules-tests

Push to main (merge)
  └─ deploy-dev.yml
       ├─ lint-typecheck-build (gate)
       ├─ unit-tests (gate)
       ├─ rules-tests (gate)
       ├─ deploy → mom-bucks-dev-b3772 (--skip-predeploy)
       └─ smoke-test → mb smoke-test (mandatory)

Manual trigger
  └─ deploy-prod.yml
       ├─ lint-typecheck-build (gate)
       ├─ unit-tests (gate)
       ├─ rules-tests (gate)
       ├─ deploy → mom-bucks-prod-81096 (--skip-predeploy)
       ├─ smoke-test → mb smoke-test --project prod (mandatory)
       └─ tag → firebase-prod-YYYY-MM-DD
```

### 1e. Secrets Required

| Secret | Used by | Source |
|--------|---------|--------|
| `FIREBASE_SA_KEY_DEV` | deploy-dev | Firebase Console > Project Settings > Service Accounts (dev project) |
| `FIREBASE_SA_KEY_PROD` | deploy-prod | Same, from the prod project |

Both are JSON service account keys. The Firebase CLI accepts them
via the `GOOGLE_APPLICATION_CREDENTIALS` env var. The recommended
approach for larger teams is Workload Identity Federation, but a
service account key is simpler for a personal project and matches
the mom-bucks pattern.

### 1f. Branch Protection

Once CI is live, enable "Require status checks to pass before
merging" on `main` with these required checks:

- `lint-typecheck-build`
- `unit-tests`
- `rules-tests`

## 2. Python Utility Script (`tools/`)

### Purpose

A CLI tool for verifying the backend works end-to-end against a
live Firebase project (dev or prod). Replaces the "open the emulator
UI and click around" workflow with repeatable, scriptable operations.

Use cases:
- **Post-deploy smoke test** (mandatory CI step — see 1b above)
- Manual QA during development
- Seeding test data for the Android app or web simulator

### Tooling: `uv` for Python

We use [`uv`](https://docs.astral.sh/uv/) as the Python package
manager, matching the mom-bucks repo's pattern. `uv` handles
virtualenv creation, dependency resolution, and lockfile management
in a single fast tool.

```
tools/
  pyproject.toml      # Python project config (uv-managed)
  uv.lock             # Lockfile (committed)
  src/
    mb/               # Package: "mom bucks" CLI
      __init__.py
      cli.py          # Click/Typer CLI entrypoint
      client.py       # Firebase client (REST + client auth)
      admin.py        # Admin SDK (cleanup only)
      commands/
        auth.py       # create-account, login
        children.py   # create-child, list-children
        transactions.py  # add-transaction, get-balance
        activities.py    # create-activity, claim-activity
        invites.py       # send-invite, accept-invite
```

### Dependencies

- `firebase-admin` — Admin SDK for user creation and cleanup only
- `requests` — HTTP client for Firebase REST API + callable
  invocation
- `click` or `typer` — CLI framework
- `rich` — formatted terminal output (tables, status)

### How it talks to Firebase

**Client auth (REST API), not Admin SDK.**

The Admin SDK bypasses security rules, which makes it useless as a
smoke test — you could deploy a broken `firestore.rules` change
that locks out the Android app, and the Admin SDK script would pass
perfectly.

Instead, the script authenticates as a real user via the Firebase
Auth REST API (email/password sign-in), gets an ID token, and uses
that token for all Firestore reads/writes and callable invocations.
This exercises the full auth + rules + functions stack, exactly as
the Android app would.

**Admin SDK is used only for:**
- Creating test users (Firebase Auth `createUser` — can't self-
  register via REST without the client SDK)
- Cleanup (deleting test users and documents after `smoke-test`)

This split means a successful smoke test proves that auth, rules,
and callables are all working in harmony — not just that the
database is reachable.

### CLI Interface

```bash
# Default: targets dev project (mom-bucks-dev-b3772)
# Override: mb --project prod <command>

# Auth
mb create-account --email alice@test.dev --password test123 --name Alice
mb login --email alice@test.dev --password test123

# Children
mb create-child --name Sam
mb list-children

# Transactions
mb add-transaction --child Sam --amount 5.00 --type LODGE --description "Pocket money"
mb add-transaction --child Sam --amount 2.50 --type WITHDRAW --description "Sweets"
mb get-balance --child Sam

# Activities
mb create-activity --child Sam --title "Clean room" --reward 3.00 --type BOUNTY_RECURRING
mb list-activities --child Sam
mb claim-activity --child Sam --activity "Clean room"

# Invites
mb send-invite --child Sam --email bob@test.dev
mb accept-invite --token <token>

# Quick smoke test (runs a full create→transact→verify→cleanup cycle)
mb smoke-test
```

### Running

```bash
cd tools
uv sync            # Install dependencies from lockfile
uv run mb --help   # Run the CLI
```

Or install as a tool:

```bash
uv tool install -e .
mb --help
```

## 3. Implementation Plan

### Phase 1: PR checks (firebase-ci.yml)

1. Create `.github/workflows/firebase-ci.yml`
2. Wire up lint + typecheck + build + unit tests + rules tests
3. Verify on a test PR
4. Enable branch protection on `main`

### Phase 2: Python utility script (tools/)

1. Scaffold `tools/` with `uv init`
2. Implement client auth + REST API layer
3. Implement core commands (create-account, create-child,
   add-transaction, get-balance)
4. Implement `smoke-test` command
5. Verify against live dev project

### Phase 3: Deploy to dev (deploy-dev.yml)

1. Generate a Firebase service account key for the dev project
2. Store as `FIREBASE_SA_KEY_DEV` GitHub secret
3. Create `.github/workflows/deploy-dev.yml` with mandatory
   `mb smoke-test` post-deploy step
4. Merge a test PR and verify auto-deploy + smoke test

### Phase 4: Deploy to prod (deploy-prod.yml)

1. Generate a Firebase service account key for the prod project
2. Store as `FIREBASE_SA_KEY_PROD` GitHub secret
3. Create `.github/workflows/deploy-prod.yml` with smoke test +
   release tagging
4. Test with a manual dispatch

### Phase 5: Cleanup

1. Remove Flask contract test files (`functions/test/contract/`)
2. Remove contract test harness, docker-compose, vitest contract
   config
3. Remove `npm run test:contract` script
4. Update CLAUDE.md to reflect the new CI/CD workflow
