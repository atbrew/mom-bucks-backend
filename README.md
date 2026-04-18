# mom-bucks-backend

Firebase backend for [Mom Bucks](https://github.com/atbrew/mom-bucks): TypeScript
Cloud Functions, Firestore, Auth, Storage, and Hosting. Replaces the legacy
Flask + Postgres stack — see [`docs/firebase-migration-plan.md`](docs/firebase-migration-plan.md)
for the full migration plan.

## Layout

```
firebase.json              Firebase project + emulator config
.firebaserc                Project aliases (staging, prod)
firestore.rules            Firestore security rules
firestore.indexes.json     Composite index definitions
storage.rules              Cloud Storage security rules
functions/                 TypeScript Cloud Functions
  src/
  test/
scripts/
  start-emulators.sh       Boot the local emulator suite
docs/
  firebase-migration-plan.md   Source of truth for the migration
  schema.md                    Firestore collection layout
```

## Prerequisites

- Node.js 20+ (tested on 25)
- Firebase CLI: `npm install -g firebase-tools`
- A Firebase service-account JSON for staging if you need to deploy
  (never commit it — see `.gitignore`)

## Local development

All work happens against the Firebase emulator suite — never against
production from a workstation.

```bash
# One-time
cd functions && npm install && cd ..

# Boot emulators (Auth, Firestore, Functions, Storage, Hosting + UI)
./scripts/start-emulators.sh
```

The emulator UI will be available at <http://localhost:4000>.

| Emulator  | Port |
|-----------|------|
| Auth      | 9099 |
| Firestore | 8080 |
| Functions | 5005 |
| Storage   | 9199 |
| Hosting   | 5050 |
| UI        | 4000 |

Hosting runs on **5050** rather than the Firebase default 5000 because
macOS Sonoma+ binds port 5000 to AirPlay Receiver by default — booting
the suite with hosting on 5000 fails with "port taken" on any
out-of-the-box Mac.

State is persisted between runs in `.emulator-data/` (gitignored), via
`--import` / `--export-on-exit`.

## Tests

```bash
cd functions
npm run lint
npm run typecheck
npm run build
npm test
```

## Deploying

Two Firebase projects are aliased in `.firebaserc`:

```bash
firebase use dev    # mom-bucks-dev-b3772
firebase use prod   # mom-bucks-prod-81096
firebase deploy
```

Blaze upgrade, service enablement, and budget alerts are tracked in
[issue #2](https://github.com/atbrew/mom-bucks-backend/issues/2).

## Status

Migration is in progress. Open issues are grouped by phase label
(`phase-0`, `phase-2`, `phase-4`). See
[`docs/firebase-migration-plan.md`](docs/firebase-migration-plan.md) for the
phased rollout.
