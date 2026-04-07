# Mom Bucks → Firebase (Full Migration) Plan



## Context



Mom Bucks today is a Flask + Postgres backend (17 tables, JWT auth, APScheduler cron, polling-based sync) deployed in a Docker container on a GCP instance, with an Android app and a web simulator client. The user wants to migrate **the entire backend and user auth to Firebase**. After evaluating Spark vs. Blaze and the relational-vs-document fit, the chosen path is **Option 2: full Firestore migration on the Blaze plan** (which still costs ~$0–5/month at this workload but unlocks Cloud Functions). The data model collapses cleanly from 17 tables to ~5 collection types because almost every access pattern is family- or child-scoped.



The intended outcome: delete a large amount of bespoke infrastructure (JWT issuance, password reset, idempotency keys, alembic, polling sync, optimistic locking, scheduler boilerplate, GCP instance + Docker deploy) in exchange for Firebase SDK primitives, real-time listeners, and a much smaller surface area to maintain.



## Repository Strategy



The Firebase migration lives in a **new, separate repository: `atbrew/mom-bucks-backend`**. The existing `atbrew/mom-bucks` repo continues shipping unchanged Flask + Postgres releases until the cutover. This isolates the migration completely:



- No risk of half-finished Firebase code blocking ordinary bug fixes on the live backend.

- The new repo can adopt different conventions (TypeScript Functions, Firebase emulators, no Alembic, no Docker) without polluting the Android/web-app workflow.

- Clients (`app/`, `web-app/` simulator) stay in `atbrew/mom-bucks` and gain Firebase SDKs additively — they speak to **either** the old Flask API or the new Firebase project depending on a build flag (`USE_FIREBASE_BACKEND=true|false`).

- When ready, we flip the flag, ship a client release, and decommission Flask + Postgres in `atbrew/mom-bucks`.



**`mom-bucks-backend` repo layout:**

```

mom-bucks-backend/

  firebase.json

  .firebaserc

  firestore.rules

  firestore.indexes.json

  storage.rules

  functions/                    ← TypeScript Cloud Functions

    src/

      acceptInvite.ts

      removeParentFromChildren.ts

      onTransactionCreate.ts

      onChildDelete.ts

      sendHabitNotifications.ts

      sendChildPush.ts

      index.ts

    test/

    package.json

    tsconfig.json

  scripts/

    start-emulators.sh

    firestore-backfill.ts       ← reads from live Postgres (read-only DSN), writes to Firestore

    seed-staging.ts

  docs/

    schema.md                   ← collection layout, security model, cost model

    migration-runbook.md

  CLAUDE.md                     ← role: Firebase Backend Developer

  README.md

```



**Coordination across the two repos:**

- `atbrew/mom-bucks-backend` owns the Firebase project, rules, functions, and migration tooling.

- `atbrew/mom-bucks` owns the Android app, the web simulator, and (until Phase 5) the Flask API.

- Schema is the contract: `mom-bucks-backend/docs/schema.md` is the source of truth for collection shapes. The Architect mirrors any changes into `atbrew/mom-bucks/specs/` so both client teams see them.

- A third-party CI integration test repo isn't needed — the contract tests in `app/src/test/.../contract/` get a new variant that runs against the Firebase emulator booted from `mom-bucks-backend`.



## Target Architecture



**Auth:** Firebase Auth (email/password). Replaces `auth.py`, JWT, bcrypt, password reset tokens, and the Brevo email integration for resets.



**Data:** Cloud Firestore in Native mode, single database, region `us-central1` (matches existing GCP).



**Domain model: there is no "family".** The current Postgres schema has a `families` table with a `family_members` join, but in practice this misrepresents reality. The actual relationships are:



- A parent has 1+ children.

- A child has 1+ parents.

- Two parents can co-parent some children but not others (Alice + Bob share Sam; Alice + Carol share Jamie; Bob and Carol don't know each other).



A first-class `family` entity assumes a stable (parents × children) set, but that set is per-child, not global. So we drop the `family` concept entirely. **The child is the unit. The only relationship is `child → parents[]`.**



**Collection layout:**

```

users/{uid}                       ← matches Firebase Auth uid; one doc per parent

  displayName, email, photoUrl, fcmTokens[], createdAt



children/{childId}                ← top-level

  name, photoUrl, balance, vaultBalance, activeCardId,

  allowanceConfig: { amount, cadence, dayOfWeek, ... },

  parentUids: [uidA, uidB],       ← the ONLY relationship that matters

  createdByUid, lastTxnAt, deletedAt, version



  transactions/{txnId}

    amount, type (LODGE|WITHDRAW), description, createdAt, createdByUid



  vaultTransactions/{id}

    amount, type, createdAt, unlockAt



  activities/{activityId}

    title, reward, status, claimedAt, completedAt



invites/{token}                   ← top-level so an unauthenticated client can read by token

  childIds: [childA, childB],     ← which kids to grant the invitee access to

  invitedEmail, invitedByUid, expiresAt, acceptedByUid

```



**How co-parenting works:** When Alice invites Bob to co-parent Sam, the invite carries `childIds: [sam]`. On accept, Bob's uid is appended to `children/sam.parentUids[]`. If Alice later co-parents Jamie with Carol, the invite carries `childIds: [jamie]` and only Carol's uid lands in `children/jamie.parentUids[]`. Bob never sees Jamie; Carol never sees Sam. No "family" doc to coordinate.



**Home screen query:** `children where parentUids array-contains <myUid>`. One indexed query, real-time listener.



**Custom claims:** Not used. Security rules do a single `get(/databases/$(database)/documents/children/$(childId))` to check `request.auth.uid in resource.data.parentUids`. Cost is one extra read per query but listeners only re-fire on changes, so this stays cheap. If a future user has 50+ kids and read amplification becomes a concern, we can add a `setChildClaims` Cloud Function later — design is forward-compatible.



**Business logic:** Cloud Functions (2nd gen, TypeScript), region `us-central1`.

- `onTransactionCreate` → updates `child.balance` in a Firestore transaction

- `onChildDelete` → fans out cascade delete of subcollections

- `acceptInvite` (callable) → validates token, appends invitee uid to each `childIds` entry's `parentUids[]`, marks invite consumed

- `removeParentFromChildren` (callable) → removes a uid from one or more children's `parentUids[]` (handles "we split up; remove Bob from Sam and Jamie")

- `sendHabitNotifications` (scheduled, hourly) → replaces APScheduler cron

- `sendChildPush` (Firestore trigger on activity claim, transaction, etc.) → FCM fan-out to every uid in the affected child's `parentUids[]`



**Storage:** Firebase Storage for profile images. Path: `children/{childId}/profile.jpg` and `users/{uid}/profile.jpg`. Replaces `storage.py` GCS backend.



**Hosting:** Firebase Hosting for the web simulator frontend. Replaces whatever currently serves it (Flask static files today).



**Clients:**

- **Android (`app/`):** Firebase Auth SDK, Firestore SDK with real-time listeners, Firebase Storage SDK, FCM SDK (already partially wired). Repository layer rewritten to wrap Firestore queries instead of Retrofit calls.

- **Web simulator frontend** (the static HTML/JS app currently bundled inside `web-app/`, separate from the Flask API): Firebase Web SDK, same shape as Android.



**Security rules:**

- `users/{uid}` — read/write only when `request.auth.uid == uid`

- `children/{childId}` — `request.auth.uid in resource.data.parentUids` for read/update; create requires the caller to put their own uid in `parentUids`

- `children/{childId}/transactions/**`, `vaultTransactions/**`, `activities/**` — `request.auth.uid in get(/databases/$(database)/documents/children/$(childId)).data.parentUids`

- `invites/{token}` — readable unauthenticated by token; write only via `acceptInvite` callable



## Migration Phases



Each phase ships independently and leaves the app working end-to-end. Use the standard Mom Bucks workflow: feature branch + worktree, show-and-tell per phase, PR per phase.



### Phase 0 — New repo + project setup (1 PR in `mom-bucks-backend`)

- Create the `atbrew/mom-bucks-backend` repo with the layout above.

- Create Firebase projects `mom-bucks-prod` and `mom-bucks-staging`, enable Firestore, Auth, Storage, Hosting, Functions.

- Upgrade to Blaze, set a $10/month budget alert.

- Add `firebase.json`, `firestore.rules`, `storage.rules`, `firestore.indexes.json`, `.firebaserc` at repo root.

- Initialize `functions/` as a TypeScript project with `firebase-functions` v5+ and `firebase-admin`.

- Wire `firebase emulators` for local dev. Add `scripts/start-emulators.sh`.

- Write `mom-bucks-backend/CLAUDE.md` defining the Firebase Backend Developer role and emulator workflow.

- Write `docs/schema.md` capturing the collection layout (source of truth).



**Verification:** `firebase emulators:start` boots all five emulators (Auth, Firestore, Functions, Storage, Hosting); rules unit tests run via `@firebase/rules-unit-testing`; an empty `helloWorld` callable function deploys to staging.



### Phase 1 — Firebase Auth cutover (1 PR in `atbrew/mom-bucks`)

- Add Firebase Auth Android SDK to `app/` and Firebase Web SDK to the simulator. Both still talk to the Flask API; only the auth source changes.

- Add `firebase_uid` column to existing Postgres `users` table (still running).

- Flask middleware: accept **either** legacy JWT **or** Firebase ID token (verify via Admin SDK). New file: `web-app/src/mombucks/firebase_auth.py`.

- New users register through Firebase Auth; existing users get migrated on next login (verify password against bcrypt, then create Firebase user, store `firebase_uid`).

- Delete `auth.py` register/login/refresh routes once all clients ship the new flow.

- Drop `password_reset_tokens` table — Firebase Auth handles resets (default Firebase-branded email).



Note: this phase touches `atbrew/mom-bucks` only. `mom-bucks-backend` is not yet involved beyond providing the Firebase project that Auth points at.



**Verification:** `scripts/qa-api-test-activities.sh` and `qa-api-test-bounties.sh` pass with Firebase-issued tokens. `/qa-cross-platform` skill confirms Android + web both log in via Firebase.



### Phase 2 — Firestore data model + dual-write (1 PR per repo, coordinated)



**In `mom-bucks-backend`:**

- Commit `firestore.rules` enforcing the `parentUids` membership check on children and their subcollections.

- Implement `scripts/firestore-backfill.ts` — connects to a **read-only Postgres replica DSN** of the live database, walks `users`, `family_members`, `children`, `transactions`, `activities`, etc., and writes deterministic-ID Firestore docs. Critically: **it flattens families out of existence** by translating "user U is in family F, family F has child C" into "append U to children/C.parentUids". A child shared by two households ends up with both parents' uids in `parentUids[]`. Idempotent. Tested against a fixture with at least one co-parented child.



**In `atbrew/mom-bucks`:**

- Add a **dual-write layer** in the Flask API: every successful Postgres write also writes to the staging Firebase project via Firebase Admin SDK (best-effort, logged on failure). New module: `web-app/src/mombucks/firestore_sync.py`. The dual-write for children must apply the same family-flattening logic: look up which users are members of which family the child belongs to, and write the union into `parentUids[]`.

- Configuration: `FIRESTORE_DUAL_WRITE_ENABLED`, `FIREBASE_PROJECT_ID`, service account credentials.



**Coordination:** the schema doc in `mom-bucks-backend/docs/schema.md` is the contract; the Flask dual-write code must conform. Clients still read from the Flask API only.



**Verification:** Backfill script run against staging; spot-check via Firebase console that families/children/transactions/activities all exist with correct shape. Dual-write monitored for 48h with no drift.



### Phase 3 — Client read cutover (1 PR per platform in `atbrew/mom-bucks`, can parallelize)

- Introduce a `USE_FIREBASE_BACKEND` build flag in both clients.

- Android: behind the flag, route reads through new `Firestore*Repository` classes that use real-time listeners. Default off in prod, on in staging builds. Delete polling code that called `/sync/status` once the flag flips on for all builds.

- Web simulator: same pattern with the Firebase Web SDK and `onSnapshot`.

- Flask API still accepts writes; clients POST through it. Reads for flag-enabled builds come from Firestore.



**Verification:** `/qa-fresh-install` and `/qa-regression` skills pass on both platforms. Real-time updates verified by editing data in one client and watching it appear in the other without refresh.



### Phase 4 — Client write cutover + Cloud Functions (1 PR per repo, coordinated)



**In `mom-bucks-backend`:**

- Implement and deploy Cloud Functions:

  - `acceptInvite` (callable) — validates token, appends invitee uid to each `childIds` entry's `parentUids[]`

  - `removeParentFromChildren` (callable) — removes a uid from one or more children's `parentUids[]`

  - `onTransactionCreate` trigger — recompute `child.balance` in a Firestore transaction

  - `onChildDelete` trigger — cascade cleanup of subcollections

  - `sendHabitNotifications` (`onSchedule("every 1 hours")`) — replaces APScheduler

  - `sendChildPush` (Firestore trigger) — replaces Flask FCM fan-out, pushes to every uid in the child's `parentUids[]`

- Functions unit tests cover each handler against the Firestore emulator, including a co-parenting scenario.



**In `atbrew/mom-bucks`:**

- Flip `USE_FIREBASE_BACKEND` on by default in both clients.

- Move ordinary writes (create activity, edit child name, etc.) directly to Firestore, gated by security rules.

- Security-sensitive writes call the new callable functions.

- Disable APScheduler and the Flask FCM fan-out (now handled by Functions).



**Verification:** `/qa-regression` full suite. Manual: create transaction → balance updates without page refresh. Habit notification fires on schedule (test with 5-minute schedule first).



### Phase 5 — Hard cutover, decommission Flask + Postgres (1 PR in `atbrew/mom-bucks`)

- Stop dual-writes; Firestore is the source of truth.

- Take a final Postgres backup, archive to GCS (90-day retention — only rollback path).

- Tear down Flask container, GCP instance, Cloud SQL.

- Delete `web-app/src/mombucks/api/`, `models/`, `alembic/`, `scheduler.py`, `storage.py`, `auth.py`, `firebase_auth.py`, `firestore_sync.py`, JWT code, idempotency code.

- Keep `web-app/` only as the simulator SPA, deployed via Firebase Hosting from `mom-bucks-backend`'s `firebase.json` (or the SPA can move to `mom-bucks-backend/hosting/` — to be decided in Phase 5 PR).

- Update `CLAUDE.md`, `README.md`, deployment docs in both repos.

- Archive or rewrite `atbrew/mom-bucks/specs/` since the Flask API contracts no longer apply; the source of truth is now `mom-bucks-backend/docs/schema.md`.



**Verification:** Full `/qa-regression` against production Firebase project. Show-and-tell with side-by-side Android + web screenshots of every screen. Cost dashboard reviewed after 7 days to confirm <$5/month.



## Critical Files



**To create:**

- `firebase.json`, `firestore.rules`, `firestore.indexes.json`, `storage.rules`

- `functions/` (new top-level directory) with `acceptInvite`, `removeParentFromChildren`, `onTransactionCreate`, `onChildDelete`, `sendHabitNotifications`, `sendChildPush`

- `scripts/start-emulators.sh`

- `scripts/firestore-backfill.ts`

- `web-app/src/mombucks/firebase_auth.py` (Phase 1, deleted Phase 5)

- `web-app/src/mombucks/firestore_sync.py` (Phase 2, deleted Phase 5)



**To modify (Android):**

- `app/build.gradle.kts` — add Firebase BoM, Auth, Firestore, Storage, FCM dependencies

- `app/src/main/.../data/repository/*Repository.kt` — Firestore listener-based rewrites

- `app/src/main/.../auth/AuthManager.kt` — Firebase Auth SDK

- Delete: Retrofit interfaces, JWT storage, polling sync code



**To modify (Web simulator):**

- Login screen → Firebase Auth JS SDK

- Data fetching → Firestore Web SDK with `onSnapshot`

- Delete: fetch calls to `/api/*`, polling code



**To delete (Phase 5):**

- `web-app/src/mombucks/api/` (entire directory)

- `web-app/src/mombucks/models/` (entire directory)

- `web-app/alembic/`

- `web-app/Dockerfile`, GCP deploy scripts

- `web-app/src/mombucks/auth.py`, `scheduler.py`, `storage.py`



## Reused Existing Utilities



- `scripts/qa-api-test-activities.sh`, `scripts/qa-api-test-bounties.sh` — adapt to take a Firebase ID token instead of JWT (tiny change to the auth helper).

- `scripts/qa-android-show-and-tell-screenshots.sh`, `scripts/qa-web-app-journey-screenshots.py` — unchanged, they just drive the UI.

- `scripts/pre-push-check.sh` — extend to run Firestore rules unit tests and Functions unit tests.

- Firebase Admin SDK is already initialized in the codebase for FCM (`NOTIFICATIONS_ENABLED` gate) — reuse the same service account.

- `app/src/test/.../contract/` — contract tests get retargeted at the Functions emulator instead of Flask.



## End-to-End Verification



1. **Emulator suite:** `scripts/start-emulators.sh` boots Auth + Firestore + Functions + Storage locally. `firebase emulators:exec "scripts/pre-push-check.sh"` runs the full test suite against emulators.

2. **Rules tests:** `web-app/tests/firestore_rules_test.ts` (or Python equivalent) — verify a parent in family A cannot read family B's children, invites can be read unauthenticated by token only, etc.

3. **Functions unit tests:** `functions/test/` covers `acceptInvite`, balance recomputation, cascade delete.

4. **Contract tests:** Android contract tests run against the Functions emulator; assert callable function shapes match what the Android SDK expects.

5. **QA skills:** `/qa-fresh-install`, `/qa-web-smoke`, `/qa-cross-platform`, `/qa-regression` all pass against staging Firebase project before each PR merges.

6. **Cost gate:** After Phase 5 ships, watch the Firebase billing dashboard for 7 days. If monthly projection >$10, file a follow-up issue to investigate read amplification.

7. **Show-and-tell:** Each phase commits `docs/specs/YY-MM-DD-firebase-phase-N/show-and-tell.md` with side-by-side Android + web screenshots, per the project's standard quality gate.



## Risks & Mitigations



- **Listener cost runaway** — mitigated by per-family scoping and the $10 budget alert. Real-time listeners only bill for changed docs, so this is far cheaper than the current polling pattern.

- **Migration data drift** — dual-write phase (Phase 2) runs for 48h and is monitored before clients cut over.

- **Lost optimistic locking** — replaced by Firestore transactions which retry on contention; tested explicitly in Phase 4 with concurrent-write integration tests.

- **No rollback after Phase 5** — keep the Postgres backup in GCS for 90 days, and keep the dual-write code on a tag in case we need to resurrect it.

- **Co-parent removal** — when Alice removes Bob from co-parenting Sam, the `removeParentFromChildren` callable strips Bob's uid from `children/sam.parentUids[]`. Bob immediately loses access via security rules. If Bob also co-parented Jamie with Alice and that's not removed, Bob keeps Jamie. Explicit integration test: parent A removes parent B from one of two co-parented children; B retains access to the other.

- **Last parent standing** — `removeParentFromChildren` must refuse to remove the last uid from `parentUids[]`. Orphaning a child has no recovery path. Enforced in the Cloud Function and unit tested.



## Resolved Decisions



- **Functions language:** TypeScript (Node), 2nd gen, region `us-central1`. `functions/` is a Node project with `tsconfig.json` and `firebase-functions` v5+.

- **Domain model:** No `family` entity. Children carry a `parentUids[]` array; that is the only relationship.

- **Password reset branding:** Firebase default email template. No custom action handler.

- **Phase 5 decommission:** Hard cutover. Flask + Postgres torn down immediately after Phase 4 bakes. Postgres backup in GCS for 90 days is the only rollback.

- **Repository:** New `atbrew/mom-bucks-backend` repo for all Firebase code; `atbrew/mom-bucks` keeps the Android app, web simulator frontend, and (until Phase 5) Flask API.

- **Region:** `us-central1`, confirmed as matching current GCP region — no change needed.

- **Plan document location:** This plan will be copied into `mom-bucks-backend/docs/firebase-migration-plan.md` once that repo exists (Phase 0).

