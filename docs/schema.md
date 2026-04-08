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
| `createdAt`   | `Timestamp`      | Server timestamp at user creation.        |

**Ownership:** A user doc is created on first sign-in. The owning user
can read and write it; nobody else can.

### `children/{childId}`

The unit of access. Top-level collection (not nested under users) so a
single `array-contains` query can power the home screen for any parent.

| Field             | Type                    | Notes                                                                                                                |
|-------------------|-------------------------|----------------------------------------------------------------------------------------------------------------------|
| `name`            | `string`                | Child's display name.                                                                                                |
| `photoUrl`        | `string \| null`        | Path in Storage.                                                                                                     |
| `balance`         | `integer`               | Spendable balance **in cents** (e.g. `1250` = €12.50). See "Monetary values" below. Maintained by `onTransactionCreate` (#15). |
| `vaultBalance`    | `integer`               | Locked / saving balance **in cents**.                                                                                |
| `activeCardId`    | `string \| null`        | Currently active reward card / activity.                                                                             |
| `allowanceConfig` | `object`                | `{ amount: integer (cents), cadence: 'WEEKLY' \| 'MONTHLY', dayOfWeek: 0..6, ... }`. Drives `sendHabitNotifications` (#17). |
| `parentUids`      | `string[]`              | **The only relationship that matters.** UIDs allowed to read/write this child and its subcollections.               |
| `createdByUid`    | `string`                | UID of the parent who created the child. Audit only — does not grant any extra privilege.                            |
| `lastTxnAt`       | `Timestamp \| null`     | Updated by `onTransactionCreate` (#15).                                                                              |
| `deletedAt`       | `Timestamp \| null`     | Soft-delete marker (rarely used; hard delete via `onChildDelete` (#16) is the norm).                                 |
| `version`         | `number`                | Bumped by `onTransactionCreate` so clients can detect stale reads. Replaces Postgres optimistic locking.             |

**Index requirements:**
- `children where parentUids array-contains <uid>` — single-field index, the
  Firestore default suffices.
- If we ever need ordering by `lastTxnAt`, add a composite index on
  `(parentUids array, lastTxnAt desc)`.

#### `children/{childId}/transactions/{txnId}`

| Field         | Type                                  | Notes                                                |
|---------------|---------------------------------------|------------------------------------------------------|
| `amount`      | `integer`                             | Always positive, **in cents** (e.g. `500` = €5.00).  |
| `type`        | `'LODGE' \| 'WITHDRAW'`               | Direction of the transaction.                        |
| `description` | `string`                              | Free-text reason.                                    |
| `createdAt`   | `Timestamp`                           | Server timestamp.                                    |
| `createdByUid`| `string`                              | UID of the parent who logged it.                     |

Triggers: `onTransactionCreate` (#15) recomputes `child.balance`.

#### `children/{childId}/vaultTransactions/{id}`

| Field      | Type                          | Notes                                 |
|------------|-------------------------------|---------------------------------------|
| `amount`   | `integer`                     | Positive, **in cents**.               |
| `type`     | `'DEPOSIT' \| 'WITHDRAW'`     | Direction.                            |
| `createdAt`| `Timestamp`                   |                                       |
| `unlockAt` | `Timestamp \| null`           | Time-locked savings; null = unlocked. |

#### `children/{childId}/activities/{activityId}`

| Field         | Type                                                | Notes                                                          |
|---------------|-----------------------------------------------------|----------------------------------------------------------------|
| `title`       | `string`                                            | Activity / chore name.                                         |
| `reward`      | `integer`                                           | Amount paid out on completion, **in cents**.                   |
| `status`      | `'OPEN' \| 'CLAIMED' \| 'COMPLETED' \| 'CANCELLED'` | Drives `sendChildPush` (#18) on transitions.                  |
| `claimedAt`   | `Timestamp \| null`                                 |                                                                |
| `completedAt` | `Timestamp \| null`                                 |                                                                |

### `invites/{token}`

Top-level so an unauthenticated client can read by token (the invite
link is the secret).

| Field          | Type            | Notes                                                                                  |
|----------------|-----------------|----------------------------------------------------------------------------------------|
| `childIds`     | `string[]`      | Which children to grant the invitee access to. **Drives co-parenting.**                |
| `invitedEmail` | `string \| null`| Optional email to gate the redemption (nice-to-have, not required for the model).      |
| `invitedByUid` | `string`        | The parent who issued the invite.                                                      |
| `expiresAt`    | `Timestamp`     | Hard expiry — `acceptInvite` (#13) rejects after this.                                 |
| `acceptedByUid`| `string \| null`| Set on first redemption, locks the invite.                                             |
| `acceptedAt`   | `Timestamp \| null` | Set on first redemption.                                                           |

Reads: unauthenticated allowed (the URL is the secret). Writes: only via
the `acceptInvite` callable (#13) — direct client writes are denied.

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
  directly.
- `children/{childId}/{transactions|vaultTransactions|activities}/**` —
  read/write if the caller is in the parent child's `parentUids`. The
  rule does a `get(/databases/.../children/$(childId)).data.parentUids`
  lookup. That's an extra read per query, but listeners only re-fire on
  changes, so this stays cheap at our scale.
- `invites/{token}` — readable unauthenticated (URL is the secret),
  not directly writable.

## Co-parenting walkthrough

Concrete sequence to make the model click:

1. **Alice signs up.** `users/alice` is created. Alice creates her son
   Sam: `children/sam = { name: "Sam", parentUids: ["alice"], createdByUid: "alice", ... }`.
2. **Alice invites Bob to co-parent Sam.** Alice's client creates
   `invites/<token> = { childIds: ["sam"], invitedByUid: "alice", expiresAt: ... }`
   and shares the invite URL with Bob.
3. **Bob signs up and opens the link.** Bob's client calls the
   `acceptInvite` callable (#13). The function reads the invite, appends
   `"bob"` to `children/sam.parentUids` via `arrayUnion`, and marks the
   invite consumed. `children/sam.parentUids` is now `["alice", "bob"]`.
4. **Bob's home screen query** is `children where parentUids array-contains "bob"`,
   which returns `[sam]`. Bob can read Sam's transactions because the
   subcollection rule sees `"bob"` in `children/sam.parentUids`.
5. **Alice meets Carol and co-parents Jamie with her.** Alice creates
   `children/jamie = { parentUids: ["alice"], ... }`, then issues an
   invite with `childIds: ["jamie"]`. Carol accepts. Now
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
