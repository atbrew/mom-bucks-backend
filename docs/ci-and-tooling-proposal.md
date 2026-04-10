# CI/CD and Tooling Proposal

## Context

The `atbrew/mom-bucks` repo has a mature GitHub Actions pipeline: PR
checks, auto-deploy to dev on merge, and manual release to prod. This
repo (`mom-bucks-backend`) has none of that yet — everything is manual
(`npm run lint`, `npm test`, `firebase deploy`). This proposal adds
CI/CD workflows modelled on the mom-bucks patterns, plus a Python
utility script for manual backend verification.

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

**Not included in PR checks:** contract tests. They need Docker
Compose for the Flask stack and are heavyweight (~15s just to boot
Flask + Postgres). They run locally via `npm run test:contract` and
can be added to CI later if drift becomes a concern.

### 1b. Deploy to Dev (`deploy-dev.yml`)

**Trigger:** Push to `main` (same path filter as PR check).

**Prerequisite:** All three PR-check jobs pass (duplicated as a gate,
or extracted as a reusable workflow).

**Job: Deploy** (ubuntu-latest, Node 22)

1. Authenticate to Firebase using a service account key
   (`FIREBASE_SA_KEY_DEV` secret, same key the mom-bucks repo
   already stores).
2. Deploy everything that changed:
   ```bash
   firebase deploy --project mom-bucks-dev-b3772 \
     --only functions,firestore:rules,firestore:indexes,storage
   ```
   The `--only` flag is safe to use unconditionally — Firebase
   skips components whose source hasn't changed (functions are
   diffed by hash, rules by content). No need for path-based
   conditional logic.
3. `firebase.json` predeploy hooks handle lint + typecheck + build
   automatically before the functions upload, so the deploy command
   is the only step needed.

**What `firebase deploy` does under the hood:**

| Component | What ships | Mechanism |
|-----------|-----------|-----------|
| Functions | `functions/lib/` (compiled JS) | Uploaded to Cloud Functions; cold starts pick up new code |
| Firestore rules | `firestore.rules` | Uploaded and applied atomically; takes effect within seconds |
| Firestore indexes | `firestore.indexes.json` | Creates/updates composite indexes; long-running but non-blocking |
| Storage rules | `storage.rules` | Uploaded and applied atomically |

There is no Docker image, no SSH, no rollback script. Firebase
handles versioning internally — every deploy creates a new
immutable release. If a bad deploy ships, the fix is another deploy
(or `firebase functions:delete <name>` in an emergency).

**Health check:** Unlike the Flask deploy (which curls `/health`),
Firebase functions don't have a single health endpoint. The
verification step is:

```bash
firebase functions:list --project mom-bucks-dev-b3772
```

This confirms the functions are deployed and their status is ACTIVE.
For deeper verification, the Python utility script (section 2) can
run a quick smoke test against the live dev project.

### 1c. Deploy to Prod (`deploy-prod.yml`)

**Trigger:** Manual only (`workflow_dispatch`), matching the
mom-bucks pattern.

**Jobs:**

1. **Gate: Full test suite** (lint + typecheck + build + unit + rules)
2. **Deploy** (same as dev, but `--project mom-bucks-prod-81096`)
   - Uses `FIREBASE_SA_KEY_PROD` secret

**No release tagging (yet):** The mom-bucks repo creates GitHub
Releases with version tags. This repo doesn't produce downloadable
artifacts (no APK, no Docker image), so a GitHub Release would be
empty. Instead, the deploy commit SHA is the version identifier —
visible in the Firebase Console under each function's "Source" tab.
If we want release tags later, we can add a step that creates a
lightweight git tag (`firebase-prod-YYYY-MM-DD`).

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
       └─ deploy → mom-bucks-dev-b3772

Manual trigger
  └─ deploy-prod.yml
       ├─ lint-typecheck-build (gate)
       ├─ unit-tests (gate)
       ├─ rules-tests (gate)
       └─ deploy → mom-bucks-prod-81096
```

### 1e. Secrets Required

| Secret | Used by | Source |
|--------|---------|--------|
| `FIREBASE_SA_KEY_DEV` | deploy-dev | Already exists in mom-bucks repo; reuse or create a dedicated one via Firebase Console > Project Settings > Service Accounts |
| `FIREBASE_SA_KEY_PROD` | deploy-prod | Same; generate from the prod project |

Both are JSON service account keys. The Firebase CLI accepts them
via the `GOOGLE_APPLICATION_CREDENTIALS` env var or
`firebase --token` (deprecated) — the recommended approach is to
use `google-auth` with Workload Identity Federation, but a service
account key is simpler for a personal project and matches the
mom-bucks pattern.

## 2. Python Utility Script (`tools/`)

### Purpose

A CLI tool for manually verifying the backend works end-to-end
against a live Firebase project (dev or prod). Replaces the "open
the emulator UI and click around" workflow with repeatable,
scriptable operations.

Use cases:
- Post-deploy smoke test ("did the deploy break anything?")
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
      client.py       # Firebase client (Admin SDK or REST)
      commands/
        auth.py       # create-account, login
        children.py   # create-child, list-children
        transactions.py  # add-transaction, get-balance
        activities.py    # create-activity, claim-activity
        invites.py       # send-invite, accept-invite
```

### Dependencies

- `firebase-admin` — server-side SDK for creating users, reading/
  writing Firestore, calling callables
- `click` or `typer` — CLI framework
- `rich` — formatted terminal output (optional, nice for tables)

### CLI Interface

```bash
# Setup — point at a project
export GOOGLE_APPLICATION_CREDENTIALS=path/to/sa-key.json

# Or use a project flag
mb --project mom-bucks-dev-b3772 <command>

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

# Quick smoke test (runs all of the above in sequence)
mb smoke-test
```

### How it talks to Firebase

Two options, each with trade-offs:

**Option A: Firebase Admin SDK (server-side, bypasses rules)**

- Pro: Simple, no auth token management, can do everything
- Con: Bypasses security rules — doesn't verify that rules work
- Con: Can't test callables (acceptInvite, removeParentFromChildren)
  the way a real client would

**Option B: Firebase REST API + client auth**

- Pro: Exercises the same auth + rules path as the real app
- Pro: Can call callables via HTTP (the callable protocol is just
  a POST to a Cloud Functions URL)
- Con: More complex — needs to manage ID tokens, refresh tokens
- Con: REST API for Firestore is verbose

**Recommendation: Option A (Admin SDK) for writes, with a
`--verify-rules` flag that uses Option B for read assertions.**

The primary use case is seeding data and checking balances, not
testing rules (the rules tests already do that). Admin SDK keeps
the script simple. The `smoke-test` command can optionally verify
that a second user can't read another user's children (a quick
rules sanity check).

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

### Phase 2: Deploy to dev (deploy-dev.yml)

1. Generate a Firebase service account key for the dev project
2. Store as `FIREBASE_SA_KEY_DEV` GitHub secret
3. Create `.github/workflows/deploy-dev.yml`
4. Merge a test PR and verify auto-deploy

### Phase 3: Deploy to prod (deploy-prod.yml)

1. Generate a Firebase service account key for the prod project
2. Store as `FIREBASE_SA_KEY_PROD` GitHub secret
3. Create `.github/workflows/deploy-prod.yml`
4. Test with a manual dispatch

### Phase 4: Python utility script (tools/)

1. Scaffold `tools/` with `uv init`
2. Implement core commands (create-account, create-child, add-transaction)
3. Add smoke-test command
4. Document in `tools/README.md`

## 4. Open Questions

1. **Hosting deploy:** `firebase.json` has a hosting config pointing
   at `public/`. Should `deploy-dev` include `--only hosting`, or is
   hosting not in use yet? If not in use, we can skip it and save a
   deploy step.

2. **Branch protection:** Should we enable "Require status checks to
   pass before merging" on `main` once CI is live? The mom-bucks repo
   does this.

3. **Contract tests in CI:** Currently excluded from the PR check
   because they need Docker Compose + the Flask repo. If we want them
   in CI, we'd need to either (a) build the Flask image in CI from a
   published Docker image, or (b) use a `workflow_call` pattern like
   mom-bucks does. Worth deferring until the contract tests need to
   run automatically.

4. **Budget alerts in CI:** The deploy step could query the Firebase
   billing API and warn if the current month's spend is above a
   threshold. Is this worth the complexity?

5. **Utility script target:** Should the script default to the dev
   project or require an explicit `--project` flag? Defaulting to dev
   is safer (can't accidentally write to prod) but slightly more
   typing for the common case.
