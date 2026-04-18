# Firestore Schema

This document is the **source of truth** for the Mom Bucks Firestore
collection layout. Both this repo (rules, functions, backfill) and the
clients in `atbrew/mom-bucks` (Android app, web simulator) consume it.
If you change a collection shape, update this file in the same PR.

## Domain model in one sentence

There is no `family`. Each child carries a `parentUids` array of the
Firebase Auth UIDs allowed to see and edit it. That is the only
relationship that matters.

### Why no `family` entity

The Postgres schema this is replacing has a `families` table with a
`family_members` join. In practice, that misrepresents reality:

- A parent has 1+ children.
- A child has 1+ parents.
- Two parents can co-parent **some** children but not others.

> Alice and Bob co-parent Sam.
> Alice and Carol co-parent Jamie.
> Bob and Carol don't know each other.

A first-class `family` entity assumes a stable `(parents × children)`
set, but that set is per-child, not global. So we drop it. **The child
is the unit.** When Alice invites Bob to co-parent Sam, Bob's UID is
appended to `children/sam.parentUids`. If Alice later co-parents Jamie
with Carol, only Carol's UID lands in `children/jamie.parentUids`. Bob
never sees Jamie; Carol never sees Sam. No coordinating `family` doc.

## Collections

### `users/{uid}`

One doc per parent. The doc ID matches the Firebase Auth UID exactly so
rules can do `request.auth.uid == uid` without a lookup.

| Field         | Type             | Notes                                     |
|---------------|------------------|-------------------------------------------|
| `displayName` | `string`         | Human-readable name.                      |
| `email`       | `string`         | Mirrors Firebase Auth, denormalised here. |
| `photoUrl`    | `string \| null` | Path in Storage or null.                  |
| `fcmTokens`   | `string[]`       | Device push tokens for FCM fan-out.       |
| `timezone`    | `string`         | IANA timezone (e.g. `Europe/Dublin`, `America/New_York`). Drives civil-date boundaries for activity schedules — `claimActivity`, `createActivity`, and `updateActivity` read the acting parent's timezone to compute `nextClaimAt`. Defaults to `Europe/Dublin` on user create. |
| `createdAt`   | `Timestamp`      | Server timestamp at user creation.        |

**Ownership:** A user doc is created on first sign-in. The owning user
can read and write it; nobody else can.

### `children/{childId}`

The unit of access. Top-level collection (not nested under users) so a
single `array-contains` query can power the home screen for any parent.

| Field             | Type                    | Notes                                                                                                                |
|-------------------|-------------------------|----------------------------------------------------------------------------------------------------------------------|
| `name`            | `string`                | Child's display name.                                                                                                |
| `dateOfBirth`     | `Timestamp`             | **Required, editable.** Child's calendar date of birth. Mirrors Flask's `Child.date_of_birth` (`db.Date, nullable=False`). Stored as a `timestamp` but semantically a day — callers should ignore the time-of-day component. `firestore.rules` enforces `is timestamp` on both create and update, so parents can fix typos post-create but cannot strip the field or retype it to a non-timestamp. |
| `createdAt`       | `Timestamp`             | **Required and immutable.** Instant the child record was created. On the client path, `firestore.rules` forces `createdAt == request.time` — clients must write `serverTimestamp()`, they cannot choose or backdate it. On the backfill path, the Admin SDK carries the Postgres `created_at` through verbatim so historical creation order survives the migration. Any update that touches this field is refused. |
| `photoUrl`        | `string \| null`        | Path in Storage.                                                                                                     |
| `balance`         | `integer`               | Spendable balance **in cents** (e.g. `1250` = €12.50). See "Monetary values" below. Maintained by `onTransactionCreate` (#15) and by the activity/vault callables. |
| `allowanceId`     | `string \| null`        | ID of the child's single allowance activity, or `null`. Enforces "at most one ALLOWANCE activity per child" — set atomically inside `createActivity` when creating an `ALLOWANCE`; cleared inside `deleteActivity`. Clients cannot write this field directly (rules pin it to Admin-SDK writes). |
| `vault`           | `map \| null`           | Nested vault map; `null` until configured. Shape: `{ balance: integer, target: integer, unlockedAt: Timestamp \| null, interest: { weeklyRate: number, lastAccrualWrite: Timestamp } \| null, matching: { rate: number } \| null }`. `interest` and `matching` are independently optional. Clients cannot write this map directly — all mutations flow through vault callables (`depositToVault`, `claimInterest`, `unlockVault`) and `mb vault configure` (Admin SDK). See "Vault state machine" below. |
| `parentUids`      | `string[]`              | **The only relationship that matters.** UIDs allowed to read/write this child and its subcollections.               |
| `createdByUid`    | `string`                | **Required and immutable.** UID of the parent who created the child. On create, `firestore.rules` enforces `createdByUid == request.auth.uid` so a client cannot forge it. On update, it is pinned so a parent cannot rewrite history and reassign "creator" after the fact. Audit only — does not grant any extra privilege. |
| `lastTxnAt`       | `Timestamp \| null`     | Updated by `onTransactionCreate` (#15).                                                                              |
| `deletedAt`       | `Timestamp \| null`     | Soft-delete marker (rarely used; hard delete via `onChildDelete` (#16) is the norm).                                 |
| `version`         | `number`                | Bumped by `onTransactionCreate` so clients can detect stale reads. Replaces Postgres optimistic locking.             |

**Index requirements:**
- `children where parentUids array-contains <uid>` — single-field index, the
  Firestore default suffices.
- If we ever need ordering by `lastTxnAt`, add a composite index on
  `(parentUids array, lastTxnAt desc)`.

#### `children/{childId}/transactions/{txnId}`

Ledger rows are **write-once by design**: `amount`, `type`, and
`createdByUid` are consumed exactly once by `onTransactionCreate`
(#15) when it bumps `child.balance`, so a post-create client
mutation would silently desync the derived balance from the stored
row. `firestore.rules` pins all three as immutable on update (plus
`createdAt`, same reasoning as children).

| Field         | Type                                  | Notes                                                |
|---------------|---------------------------------------|------------------------------------------------------|
| `amount`      | `integer`                             | Always positive, **in cents** (e.g. `500` = €5.00). **Immutable after create** — any update that touches it is refused. |
| `type`        | `'LODGE' \| 'WITHDRAW' \| 'EARN'`     | Direction of the transaction. `LODGE` (parent adds money) and `EARN` (activity claim or vault unlock payout) both increment `child.balance`; `WITHDRAW` decrements it. **Immutable after create** — rules refuse a post-create flip, which would re-sign the row against `child.balance`. |
| `description` | `string`                              | Free-text reason. Mutable — parents can correct typos or tag rows after the fact. |
| `createdAt`   | `Timestamp`                           | **Required and immutable.** On the client path, `firestore.rules` forces `createdAt == request.time` — clients must write `serverTimestamp()`, they cannot choose or backdate it. On the backfill path, the Admin SDK carries the Postgres `created_at` through verbatim. Any update that touches this field is refused so the ledger audit trail cannot be silently re-stamped. |
| `createdByUid`| `string`                              | UID of the parent who logged it. **Immutable after create** — audit-only field, rewriting it would forge the trail. |

Triggers: `onTransactionCreate` (#15) recomputes `child.balance`.

#### `children/{childId}/vaultTransactions/{id}`

Like the main transactions ledger, vault rows are **write-once by
design**. `amount` and `type` are pinned immutable on update because
they drive `vault.balance`, interest accrual, and unlock timing — any
post-create mutation would silently re-sign the row against every
derived state. Unlike `transactions`, vault rows have no
`createdByUid` field (the vault ledger is driven by the parent who
owns the child's `parentUids` membership, not by individual
authorship).

| Field         | Type                                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                 |
|---------------|-----------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `amount`      | `integer`                                                 | Positive, **in cents**. `firestore.rules` enforces `amount is number && amount >= 0` on create; on update, the field is pinned immutable so derived balances cannot silently drift. |
| `type`        | `'DEPOSIT' \| 'UNLOCK' \| 'INTEREST_CLAIM' \| 'MATCH'`   | Vault event kind. Mirrors Flask's `VaultTransaction` type enum. `firestore.rules` enforces the enum on create (rejecting any other string, including the main-ledger `WITHDRAW`); on update, the field is pinned immutable so a row's sign against `vault.balance` cannot be flipped after the fact. |
| `description` | `string`                                                  | Free-text reason (e.g. "weekly interest", "goal unlocked"). Mutable — parents can correct typos. |
| `createdAt`   | `Timestamp`                                               | **Required and immutable.** Same contract as `transactions.createdAt`: clients must write `serverTimestamp()` (rules pin it to `request.time`), the backfill carries Postgres `created_at` through verbatim, and updates cannot touch the field. Vault ledger drives interest + unlocks, so forged creation timestamps would corrupt those derivations. |
| `unlockAt`    | `Timestamp \| null`                                       | Time-locked savings; null = unlocked.                                                                                                                                                                                                                                                                                                                                                 |

#### `children/{childId}/activities/{activityId}`

Schedule-driven, single-state model. An activity is claimable iff
`nextClaimAt <= now` in the acting parent's timezone — there is no
`status` field, no scheduled function to flip state, and no
post-claim bookkeeping beyond advancing `nextClaimAt`. See
`/Users/atbrew/Development/mom-bucks-backend/docs/specs/2026-04-18-activities-refresh/design.md`
for the full rationale.

All activity writes flow through callables (`createActivity`,
`updateActivity`, `deleteActivity`, `claimActivity`). Direct client
writes are denied by rules — the `nextClaimAt` recompute and the
`children.allowanceId` pointer update have to happen atomically with
the activity-doc write, which only a callable transaction can
guarantee.

| Field           | Type                         | Notes                                                       |
|-----------------|------------------------------|-------------------------------------------------------------|
| `title`         | `string`                     | Activity / chore name.                                      |
| `reward`        | `integer`                    | Amount paid out on claim, **in cents**.                     |
| `type`          | `'ALLOWANCE' \| 'CHORE'`     | Cosmetic for UI grouping. **Immutable post-create** — flipping at runtime would require atomic pointer rewiring we don't need to build. Uniqueness of `ALLOWANCE` is enforced by `children.allowanceId`, not by this field. |
| `schedule`      | `map`                        | Recurrence rule. One of: `{ kind: 'DAILY' }`, `{ kind: 'WEEKLY', dayOfWeek: 0..6 }` (0 = Sun, 6 = Sat), `{ kind: 'MONTHLY', dayOfMonth: 1..31 }` (clamped to month length for shorter months). |
| `nextClaimAt`   | `Timestamp`                  | When next claimable. Claimable iff `<= now`. Stamped to `now` on create (immediately claimable), advanced by `claimActivity` and recomputed on `schedule` edits. |
| `lastClaimedAt` | `Timestamp \| null`          | Set on each claim; purely historical.                       |
| `createdAt`     | `Timestamp`                  | Server-stamped on create.                                   |

### `invites/{token}`

Top-level so an unauthenticated client can read by token (the invite
link is the secret). **Invites are issued one child at a time** — if a
parent wants to share two children they send two links. Keeping the
invite single-child keeps the security boundary trivial: one invite,
one `arrayUnion` at acceptance time.

| Field                   | Type            | Notes                                                                                  |
|-------------------------|-----------------|----------------------------------------------------------------------------------------|
| `childId`               | `string`        | Which child to grant the invitee access to. **Drives co-parenting.**                   |
| `childName`             | `string`        | Denormalised from `children/{childId}.name` at send time, so the inbox can render names without N+1 reads. Cosmetic — the rule check uses `childId`. |
| `invitedEmail`          | `string`        | Invitee's email, **lowercased** server-side. The inbox rule matches `request.auth.token.email.lower()`, so the stored value must be pre-lowercased. |
| `invitedByUid`          | `string`        | The parent who issued the invite. Stamped by `sendInvite` from `request.auth.uid`.     |
| `invitedByDisplayName`  | `string`        | Denormalised from `users/{invitedByUid}.displayName` at send time. Cosmetic; may be empty if the user doc is missing. |
| `expiresAt`             | `Timestamp`     | Server-stamped by `sendInvite` as `now + 7d`. `acceptInvite` rejects after this.       |
| `createdAt`             | `Timestamp`     | `FieldValue.serverTimestamp()` at send time.                                           |
| `acceptedByUid`         | `string \| null`| Set by `acceptInvite` on first redemption, locks the invite.                           |
| `acceptedAt`            | `Timestamp \| null` | Set by `acceptInvite` on first redemption.                                         |

**Reads:**
- `get` (by token): unauthenticated allowed — the URL is the secret.
- `list`: scoped to the caller. A signed-in user can list invites
  where `invitedEmail == request.auth.token.email.lower()` (inbox) or
  `invitedByUid == request.auth.uid` (sent). Unfiltered listing is
  denied to prevent harvesting invitee emails (PII) and childIds.

**Writes:** direct client writes are denied. All mutations flow
through three callables:

| Callable | Effect | Caller constraint |
|----------|--------|-------------------|
| `sendInvite`   | Creates the doc, stamps `invitedByUid`, `createdAt`, `expiresAt`; denormalises names; lowercases `invitedEmail`. Runs in a transaction that also deletes any existing unaccepted invite for the same `(childId, invitedEmail)` pair — a resend supersedes the old token rather than creating inbox spam. | Caller must be in `parentUids` of the target child; cannot invite themselves (`invitedEmail` != caller email). |
| `acceptInvite` | Sets `acceptedByUid`/`acceptedAt` and `arrayUnion`s the caller into the child's `parentUids`. | Caller must be signed in; invite must be unaccepted and unexpired. |
| `revokeInvite` | Deletes the invite doc. | Caller must equal `invitedByUid`; invite must be unaccepted (accepted invites must be undone via `removeParentFromChildren`). |

## Storage (profile images)

Profile photos are stored in Firebase Storage at predictable paths:

| Path | Owner | Notes |
|------|-------|-------|
| `users/{uid}/profile.jpg` | User themselves | Only the owning user can read/write |
| `children/{childId}/profile.jpg` | Parents (via `parentUids`) | Any parent can read/write |

**Upload constraints:** max 100MB, image content types only (`image/*`).

**Server-side resize:** The `onProfileImageUpload` Cloud Function fires
on every upload. If the file exceeds 5MB, it downloads the image,
progressively resizes using `sharp` (max 1200px longest edge, JPEG
quality stepping down from 85), and overwrites the original. The
function then sets `photoUrl` on the corresponding Firestore doc
(`users/{uid}` or `children/{childId}`).

**Infinite-loop prevention:** The re-uploaded file carries custom
metadata `{ resized: "true" }`. On the next trigger fire the function
sees this flag and skips resize processing.

**Cleanup:** `onChildDelete` (#16) already deletes
`children/{childId}/profile.jpg` on child deletion.

## Monetary values

**All monetary fields are stored as integer cents** (the smallest
currency unit). A balance of €12.50 is stored as `1250`. There is no
decimal point anywhere in the stored data; formatting happens in the
client at render time.

### Why not `number`

Firestore's only numeric type is IEEE 754 double-precision float. That
means `number` is fine for counters but lousy for money: `0.1 + 0.2`
famously yields `0.30000000000000004`, and running totals drift as
transactions accumulate. Storing integers sidesteps the problem
entirely — integer arithmetic in a double is exact up to `2^53`, which
is ~€90 trillion, so we will never overflow at this app's scale.

### Backfill mapping (Phase 2, issue #12)

The existing Postgres schema uses `Numeric(10, 2)` for money (see
`mom-bucks/web-app/src/mombucks/models/{child,transaction,vault,activity}.py`).
The backfill script at `functions/src/backfill/` converts every such
column to integer cents by multiplying by 100 and rounding to the
nearest integer:

```ts
// functions/src/backfill/transform.ts — toCents()
const cents = Math.round(Number(row.balance) * 100);
```

The round is load-bearing — floating-point coercion from Postgres `Numeric`
to JS `number` can introduce sub-cent noise (`12.50` → `12.499999...`),
and silently truncating that would drop a cent.

### Client rendering

Both the Android app and the web simulator must divide by 100 and format
with two decimal places at render time:

```kotlin
// Kotlin
val euros = cents / 100.0
val display = String.format("€%.2f", euros)
```

```ts
// TypeScript (web simulator)
const display = new Intl.NumberFormat("en-IE", {
  style: "currency",
  currency: "EUR",
}).format(cents / 100);
```

This is a Phase 3 concern — the client repositories get rewritten to
hit Firestore directly and the cents-to-euros conversion moves to the
UI layer at the same time.

## Security model (prose)

Full rules live in `firestore.rules`. The model in plain English:

- `users/{uid}` — only the owning user can read or write.
- `children/{childId}` — read/update if `request.auth.uid in resource.data.parentUids`.
  Create requires the caller to include their own UID in the new doc's
  `parentUids` (no creating a child you can't access). `parentUids`
  itself can only be mutated by the `acceptInvite` (#13) and
  `removeParentFromChildren` (#14) callables — clients cannot edit it
  directly. The `allowanceId` field and the whole `vault` map are
  similarly pinned: rules deny any client-driven change, so the only
  way they move is through the Admin-SDK callables that own them
  (`createActivity` / `deleteActivity` for `allowanceId`;
  `depositToVault` / `claimInterest` / `unlockVault` / `mb vault
  configure` for `vault`).
- `children/{childId}/{transactions|vaultTransactions}/**` —
  read/write if the caller is in the parent child's `parentUids`. The
  rule does a `get(/databases/.../children/$(childId)).data.parentUids`
  lookup. That's an extra read per query, but listeners only re-fire on
  changes, so this stays cheap at our scale.
- `children/{childId}/activities/**` — **read** only from rules; all
  writes (create / update / delete) are denied for direct clients and
  must flow through the activity callables. The callables enforce
  `children.allowanceId` uniqueness and recompute `nextClaimAt`
  atomically with the activity-doc write, which is what the
  deny-direct-writes posture protects.
- `children/{childId}/transactions/**` additionally enforces two
  guards on create: (a) `amount` must be a non-negative number
  (shape check — without it, a client could send a negative-amount
  WITHDRAW and bypass the overspend test below), and (b) a `WITHDRAW`
  whose `amount` exceeds the parent child's current `balance` is
  rejected synchronously. Both have to live in the rules because
  `onTransactionCreate` (#15) fires after the doc has already been
  written — refusal at the trigger can't un-do the write. The
  trigger's clamp-at-zero path remains as defense-in-depth for
  Admin-SDK writers (which bypass rules) and concurrent-WITHDRAW
  races.
- `invites/{token}` — `get` by token is readable unauthenticated (URL
  is the secret); `list` is scoped to the caller (own inbox or own
  sent invites only — anonymous/unscoped list is denied to avoid
  harvesting PII). Client writes are fully denied; all mutations flow
  through `sendInvite` / `acceptInvite` / `revokeInvite` callables.

## Co-parenting walkthrough

Concrete sequence to make the model click:

1. **Alice signs up.** `users/alice` is created. Alice creates her son
   Sam: `children/sam = { name: "Sam", parentUids: ["alice"], createdByUid: "alice", ... }`.
2. **Alice invites Bob to co-parent Sam.** Alice's client calls the
   `sendInvite` callable, which creates
   `invites/<token> = { childId: "sam", childName: "Sam",
   invitedByUid: "alice", invitedByDisplayName: "Alice",
   invitedEmail: "bob@example.com", expiresAt: now + 7d, ... }` and
   returns the token. Alice shares the invite URL with Bob.
3. **Bob signs up and opens the link.** Bob's client calls the
   `acceptInvite` callable (#13). The function reads the invite, appends
   `"bob"` to `children/sam.parentUids` via `arrayUnion`, and marks the
   invite consumed. `children/sam.parentUids` is now `["alice", "bob"]`.
4. **Bob's home screen query** is `children where parentUids array-contains "bob"`,
   which returns `[sam]`. Bob can read Sam's transactions because the
   subcollection rule sees `"bob"` in `children/sam.parentUids`.
5. **Alice meets Carol and co-parents Jamie with her.** Alice creates
   `children/jamie = { parentUids: ["alice"], ... }`, then issues an
   invite with `childId: "jamie"`. Carol accepts. Now
   `children/jamie.parentUids = ["alice", "carol"]`.
6. **Bob's home screen still returns `[sam]`** — `"bob"` is not in
   `children/jamie.parentUids`, and there is no `family` doc tying him
   to Carol. Carol's home screen returns `[jamie]`. Alice sees both.
7. **Alice and Bob break up.** Alice (or Bob) calls
   `removeParentFromChildren` (#14) with `{ targetUid: "bob", childIds: ["sam"] }`.
   Bob's UID is removed from `children/sam.parentUids`. Bob immediately
   loses access via the security rules. Bob retains access to any other
   children he was on, because each `children/*.parentUids` is
   independent.

## Forward-compatible escape hatches

- **Read amplification.** If a single user ends up with 50+ children
  and the per-subcollection-read `get()` lookup becomes expensive, add a
  `setChildClaims` Cloud Function that mirrors `parentUids` into Firebase
  Auth custom claims. Security rules can then check the claim instead of
  doing a `get()`. The data model does not have to change.
- **Soft delete.** `deletedAt` exists on `children` for clients that
  want a recoverable trash can; current behaviour is hard-delete via
  `onChildDelete` (#16).
- **Optimistic concurrency.** `version` is bumped on every transaction
  so clients can detect stale reads if needed. Cloud Functions use
  Firestore transactions to avoid the issue server-side.
