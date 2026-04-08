# Phase 4 show-and-tell — Cloud Functions

**Date:** 2026-04-08
**PR:** atbrew/mom-bucks-backend#21 (merged)
**Branch:** `phase-4-cloud-functions` → `main`
**Scope:** All server-side business logic that previously lived in Flask is now TypeScript Cloud Functions, deployed to `mom-bucks-dev-b3772` and `mom-bucks-prod-81096`.

This is the load-bearing phase for the migration. With these six handlers in place, the Flask container's only remaining jobs are read-through API endpoints and APScheduler — both of which Phase 5 will rip out.

## What shipped

Six handlers under `functions/src/handlers/`, plus a shared FCM fan-out helper and the `admin.ts` SDK bootstrap.

| # | Handler | Type | Purpose | Closes issue |
|---|---|---|---|---|
| 1 | `acceptInvite` | Callable (`onCall`) | Redeem an invite token, `arrayUnion` caller into child's `parentUids` | atbrew/mom-bucks-backend#13 |
| 2 | `removeParentFromChildren` | Callable (`onCall`) | Remove a parent from one or more children, with last-parent guard | atbrew/mom-bucks-backend#14 |
| 3 | `onTransactionCreate` | Firestore trigger (`onDocumentCreated`) | Recompute `child.balance` in a transaction | atbrew/mom-bucks-backend#15 |
| 4 | `onChildDelete` | Firestore trigger (`onDocumentDeleted`) | Cascade delete all subcollections via `BulkWriter` | atbrew/mom-bucks-backend#16 |
| 5 | `sendHabitNotifications` | Scheduled (`onSchedule`, hourly) | Replaces APScheduler allowance reminders | atbrew/mom-bucks-backend#17 |
| 6 | `sendChildPush` | Firestore trigger (`onDocumentCreated` / `onDocumentWritten`) | FCM fan-out on new transactions + activity `LOCKED → READY` | atbrew/mom-bucks-backend#18 |

All functions run in `us-central1`, on the 2nd-gen runtime, Node 22.

## Design decisions worth highlighting

### Pure-logic extraction in every handler

Every handler has a **pure decision function** that can be unit-tested without mocking Firestore:

- `acceptInvite.ts` → `decideInviteAcceptance(invite, child, caller, now)` returns `{ kind: "accept" | "idempotent-replay" | "reject" }`.
- `removeParentFromChildren.ts` → `decideRemoval(targetUid, childDocs)` returns `{ removedFrom, skipped }` with a `WOULD_ORPHAN_CHILD` reason for the last-parent guard.
- `onTransactionCreate.ts` → `computeNewBalance(prev, txn)` — LODGE adds, WITHDRAW subtracts, clamps at 0.
- `sendHabitNotifications.ts` → `shouldNotifyForConfig(config, now)` — DAILY / WEEKLY / FORTNIGHTLY / MONTHLY cadences.
- `sendChildPush.ts` → `buildTransactionPush`, `buildActivityPush`, `formatCents`.

The I/O wrappers (transactions, reads, writes) are thin enough that they don't need mocking. This keeps the unit test suite fast — 96 tests run in ~1 second — and lets us lean on executable rules tests for the Firestore-facing concerns.

### Invites are issued one child at a time

The original design let an invite carry `childIds: string[]` (1..10 entries). During review, that turned out to be needless complexity: rules had to enforce a fan-out cap, `acceptInvite` had to run an all-or-nothing re-verification loop, and the test matrix doubled. Zero product benefit — nobody actually shares multiple kids on a single link.

The final shape is `invites/{token}.childId: string`. One invite → one child → one `arrayUnion`. Keeps the security boundary trivial. Commit: 7ea25bb.

### Shared `fanOutToParents` helper

`sendHabitNotifications` and `sendChildPush` both need the exact same "resolve parent tokens → FCM multicast → reap dead tokens" sequence. Initially that block was duplicated; Gemini's PR review flagged it and, in the same pass, also flagged that the stale-token cleanup was running sequentially.

Extracted to `functions/src/handlers/fanOutToParents.ts`. Both handlers delegate to it, and the cleanup loop now uses `Promise.all` so per-user `arrayRemove` calls run in parallel. Commit: 2d3318a.

### Cursor-paginated children scan

`sendHabitNotifications` originally did `db.collection("children").get()`, loading every child into memory at once. Gemini (HIGH) called out the OOM risk as the collection grows. Replaced with a cursor loop that pages 500 docs at a time via `orderBy(documentId) + startAfter(lastDoc)`. Memory stays bounded regardless of collection size. Commit: 2d3318a.

### Loop-guard on `sendChildPush`

The Firestore-trigger handlers intentionally **do not write back to the documents they observe** — that would re-enter the trigger infinitely. If we ever want to record "notification sent" metadata, the escape hatch is a disjoint path like `children/{childId}/_meta/lastPushAt`. The docstring on `sendChildPush.ts` calls this out so it doesn't get lost.

### `FieldPath` re-exported from `admin.ts`

Minor, but: the cursor ordering needs `FieldPath.documentId()`, so `admin.ts` now re-exports `FieldPath` alongside `FieldValue` and `Timestamp`. Keeps every handler import routed through the single SDK bootstrap point.

## Test coverage

```
96 unit tests + 46 rules tests = 142 passing
```

- `test/backfill/transform.test.ts` — 37 tests (from Phase 2, now updated for `childId: string`).
- `test/handlers/acceptInvite.test.ts` — 10 tests, including the "revoked parent loophole" regression case.
- `test/handlers/removeParentFromChildren.test.ts` — 9 tests, including the last-parent guard.
- `test/handlers/onTransactionCreate.test.ts` — 6 tests on `computeNewBalance`.
- `test/handlers/sendHabitNotifications.test.ts` — 15 tests on `shouldNotifyForConfig` across all cadences.
- `test/handlers/sendChildPush.test.ts` — 15 tests on the message builders.
- `test/rules/firestore.rules.test.ts` — 46 tests against the emulator, including co-parenting isolation, `parentUids` mutation lockdown, and single-child invite shape validation.

Rules tests run via `scripts/run-rules-tests.sh`, which auto-discovers Homebrew's `openjdk@21+` (the Firestore emulator refuses Java 17).

## Review feedback (gemini-code-assist)

Three findings on atbrew/mom-bucks-backend#21, all accepted:

| # | Priority | Finding | Fix |
|---|---|---|---|
| 1 | HIGH | `sendHabitNotifications` loads entire `children` collection into memory | Cursor loop with `limit(500) + startAfter(lastDoc)` |
| 2 | MEDIUM | Duplicated fan-out logic between `sendHabitNotifications` and `sendChildPush` | Extracted to `fanOutToParents.ts`, both handlers delegate |
| 3 | MEDIUM | Sequential stale-token cleanup | `Promise.all` inside the shared helper |

Triage response: atbrew/mom-bucks-backend#21 issuecomment-4209068923.

## Deploy targets

| Project | Alias | Functions deployed (pre-Phase-4) | Functions deployed (post-Phase-4) |
|---|---|---|---|
| `mom-bucks-dev-b3772` | `dev` / `default` | `helloWorld` | `helloWorld` + 6 Phase 4 handlers |
| `mom-bucks-prod-81096` | `prod` | *(none — cold project)* | `helloWorld` + 6 Phase 4 handlers |

Both projects are on Blaze with a $10/month budget alert (atbrew/mom-bucks-backend#2). The scheduled function's hourly cadence is the only guaranteed baseline cost; everything else is request-driven and rounds to zero at this app's scale.

## What's still on the client side (Phases 1, 3, 5)

These live in [`atbrew/mom-bucks`](https://github.com/atbrew/mom-bucks), **not** this repo. Tracked here only so the migration picture stays whole:

- **Phase 1** — Android + web simulator auth cutover to Firebase Auth (Flask-side uid backfill so `users.firebase_uid` is populated at cutover).
- **Phase 3** — Client repositories rewritten to hit Firestore directly via listeners, cents-to-euros formatting moves to the UI layer.
- **Phase 5** — Flask container + Postgres tear-down once all clients have migrated.

Phase 4 is the server half of the cutover. Once Phase 3 ships on the client side, Phase 5 is a tear-down PR.

## Things to exercise after deploy

1. **`helloWorld`** — health probe, unchanged from Phase 0. `curl` the public URL in each project, expect `{"status":"ok"}`.
2. **`acceptInvite`** — requires a Firebase ID token. End-to-end flow goes through the client; no curl-level smoke test.
3. **`onTransactionCreate`** — create a transaction in Firestore via the console or emulator, watch `child.balance` recompute.
4. **`sendHabitNotifications`** — scheduled, so the first run fires ≤1 hour post-deploy. Can be invoked manually via Cloud Scheduler "Run now" for immediate smoke.
5. **`sendChildPush`** — flip an activity from `LOCKED` to `READY` in Firestore, expect FCM multicast to every parent in `children/<id>.parentUids` that has `fcmTokens` on their user doc.

## Next in this repo

- **Deploy Phase 4 to dev** (in progress).
- **Deploy Phase 4 to prod** (in progress, first-ever deploy — expect Cloud Functions API to get enabled during the push).
- **Walkthrough** — summary of what's live, handed back to you once both deploys complete.
