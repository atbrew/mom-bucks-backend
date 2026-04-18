# Activities & Vault Refresh — Design

**Status:** Draft, awaiting sign-off before implementation.
**Branch:** `refresh-activities`.
**Target:** Replaces the current activities lifecycle and extracts
interest out of `activities` and into the vault concept.

---

## 1. Why

The current activities model conflates two unrelated mechanics:

- **Scheduled payouts** (allowances, chores) — a parent
  configures "child gets €5 every Saturday"; the child claims when the
  due date arrives; the payout lands in the main balance.
- **Interest accrual** — a modelled-as-activity row of `type:
  'INTEREST'` that is really a vault event. The money flows into the
  vault, not the main balance, and its "claimable amount" is dynamic
  (depends on `vaultBalance`, a configured rate, and elapsed time).

Both are shoehorned into the same `LOCKED → READY` two-state
lifecycle with a single `dueDate` timestamp, and the two-state flag
has to be flipped by code that doesn't exist yet (neither a scheduled
function advances `LOCKED → READY` nor a post-claim handler rolls
`dueDate` forward). The mechanic is half-built and the conceptual
overloading makes finishing it harder, not easier.

This refresh:

1. Simplifies activities to a **schedule-driven, stateless** model —
   claimable iff `nextClaimAt <= now`, no explicit status field, no
   scheduled function required.
2. Moves **interest** out of activities and into the **vault** as a
   dedicated mechanic with its own callable and its own math.
3. Encodes the **allowance-is-unique** invariant as a
   `children.allowanceId` pointer (the data model enforces "0 or 1
   allowance per child"; rules check it).
4. Retires the `onActivityPush` `LOCKED → READY` edge and replaces
   it with an on-create push.

## 2. Scope

In scope:

- Activity schema change: drop `status`/`dueDate`/`claimedAt`; keep
  `type` with values `'ALLOWANCE' | 'CHORE'` (immutable post-create);
  add `schedule`/`nextClaimAt`/`lastClaimedAt`.
- `children.allowanceId` pointer for allowance uniqueness.
- Pure `nextOccurrence(schedule, now, tz)` helper.
- Activity callables: `createActivity`, `updateActivity`,
  `deleteActivity`, `claimActivity`.
- Vault reshape: nested `children/{id}.vault` map with independently
  optional `interest` and `matching` sub-objects. Retires flat
  `vaultBalance`.
- Vault callables: `getClaimableInterest`, `claimInterest`,
  `depositToVault` (interest-first ordering, optional match,
  auto-unlocks on hitting target), `unlockVault` (vault balance →
  main, preserves config for the next cycle).
- Retire `onActivityPush` LOCKED→READY trigger; replace with an
  on-create push (`onActivityCreate`).
- Destroy-and-rebuild CLI so the breaking schema change lands without
  a migration path.
- Firestore rules + rules tests to match.
- CLI updates (`mb activities`, new `mb vault`, new `mb admin reset`).

Out of scope (deferred to follow-ups):

- `configureVault` callable (CLI `mb vault configure` wraps Admin SDK
  for now; a proper callable lands later).
- Child-initiated vault deposits from the Android app. The
  `depositToVault` callable is parent-auth-only for now; the Android
  side can reuse it later once the UX is defined.
- Partial/approval flows for activity claims (parent approves before
  money moves).

## 3. Activities — schedule-driven, single-state

### 3.1 Schema

Current `children/{childId}/activities/{activityId}`:

| Field | Type |
|-------|------|
| `title` | `string` |
| `reward` | `integer` (cents) |
| `type` | `'ALLOWANCE' \| 'BOUNTY_RECURRING' \| 'INTEREST'` (old) |
| `status` | `'LOCKED' \| 'READY'` |
| `dueDate` | `Timestamp` |
| `claimedAt` | `Timestamp \| null` |
| `createdAt` | `Timestamp` |

Proposed `children/{childId}/activities/{activityId}`:

| Field | Type | Notes |
|-------|------|-------|
| `title` | `string` | Activity name. |
| `reward` | `integer` | Amount paid on claim, **in cents**. |
| `type` | `'ALLOWANCE' \| 'CHORE'` | Cosmetic for UI grouping; uniqueness of `ALLOWANCE` is enforced by `children.allowanceId`, not by this field. |
| `schedule` | `map` (see §3.2) | Recurrence rule. Required. |
| `nextClaimAt` | `Timestamp` | When next claimable. Claimable iff `<= now` in the acting parent's tz. See §3.5. |
| `lastClaimedAt` | `Timestamp \| null` | Set on each claim; purely historical. |
| `createdAt` | `Timestamp` | Server-stamped on create. |

**Removed:** `status`, `dueDate`, `claimedAt`.
**`type` retained**, but with a narrower domain (`INTEREST` moves out).

Additionally, a new field on `children/{childId}`:

| Field | Type | Notes |
|-------|------|-------|
| `allowanceId` | `string \| null` | ID of the child's allowance activity, or `null`. **Enforced by rules as "at most one"** — see §3.8. |

### 3.2 Schedule shape

A structured map. Not an RRULE string — RRULE parsing needs a
library, cannot be validated in Firestore rules, and we only need
three recurrence patterns.

```ts
type Schedule =
  | { kind: 'DAILY' }
  | { kind: 'WEEKLY';  dayOfWeek:  0|1|2|3|4|5|6 }   // 0 = Sun … 6 = Sat
  | { kind: 'MONTHLY'; dayOfMonth: 1 | 2 | … | 31 }; // clamped to month length
```

Validation:

- `kind` is one of the three literals.
- `dayOfWeek` present iff `kind === 'WEEKLY'`; an integer 0–6.
- `dayOfMonth` present iff `kind === 'MONTHLY'`; an integer 1–31. If
  the month has fewer days (e.g. `dayOfMonth: 31` in February), the
  next occurrence is clamped to that month's last day.

All activity writes go through the `createActivity` / `updateActivity`
callables, which use the Admin SDK and therefore bypass Firestore
rules. Shape validation is the **callable's** responsibility: both
create and update must validate the schedule map (kind literal, day-of-*
bounds, no extra keys) before writing. Firestore rules mirror the
constraints as defence in depth and, more importantly, **deny direct
client writes** to the activities collection entirely (§6). Schedule
edits are **allowed** (via `updateActivity`, see §3.7) — after
validation passes, changing a schedule triggers a recomputation of
`nextClaimAt`.

### 3.3 Claim semantics

On `claimActivity`:

1. Verify caller is in the child's `parentUids`.
2. Verify `activity.nextClaimAt <= now`.
3. In a single Firestore transaction:
   - Append a row to `children/{childId}/transactions` with
     `type: 'EARN'`, `amount: activity.reward`,
     `description: activity.title`, `createdByUid: caller`,
     `createdAt: serverTimestamp()`.
   - Update `activity.nextClaimAt = nextOccurrence(schedule, now, actingParentTz)`.
   - Update `activity.lastClaimedAt = now`.
   - Update `children/{childId}.balance += activity.reward`.

The child's main balance is updated in the same transaction that
writes the ledger row. (This is how the existing `transactions`
ledger already expects the balance to move — no change to that
contract.)

### 3.4 `nextOccurrence(schedule, now, tz)`

A **pure function**, no I/O, fully unit-testable. Lives at
`functions/src/lib/schedule.ts`.

Returns the smallest `d` such that:

- `d` matches the schedule, and
- `d > now` (strictly greater than `now`), and
- `d` is at **00:00:00 in the given timezone**.

Worked examples (tz = `Europe/Dublin`):

| Schedule | `now` | `nextOccurrence` |
|----------|-------|------------------|
| `WEEKLY{dayOfWeek:6}` (Sat) | Sat 2026-04-18 10:00 | Sat 2026-04-25 00:00 |
| `WEEKLY{dayOfWeek:6}` (Sat) | Fri 2026-04-24 10:00 | Sat 2026-04-25 00:00 |
| `WEEKLY{dayOfWeek:6}` (Sat) | Sat 2026-04-18 00:00 | Sat 2026-04-25 00:00 |
| `DAILY` | any time 2026-04-18 | 2026-04-19 00:00 |
| `MONTHLY{dayOfMonth:1}` | any time 2026-04-18 | 2026-05-01 00:00 |
| `MONTHLY{dayOfMonth:31}` | any time 2026-02-10 | 2026-02-28 00:00 (clamped) |
| `MONTHLY{dayOfMonth:31}` | any time 2026-01-31 | 2026-02-28 00:00 (clamped, next month) |

The timezone matters because "Saturday" is a civil-calendar concept:
23:00 Friday in Dublin is already Saturday in Sydney. `nextClaimAt`
is stored as a UTC-normalised `Timestamp`; the boundary is computed
in the acting parent's tz.

Implementation: `Intl.DateTimeFormat` with `timeZone` option for
civil date extraction, or a small timezone library. Choice at
implementation time — pure function with table-driven tests either
way.

### 3.5 Timezone — on `users/{uid}`

| Field | Type | Notes |
|-------|------|-------|
| `users/{uid}.timezone` | `string` | IANA tz string (`Europe/Dublin`, `America/New_York`). Defaults to `Europe/Dublin` on user create. |

`claimActivity` reads the *acting parent's* timezone (the caller's
`users/{uid}.timezone`) to compute `nextOccurrence`. `createActivity`
and `updateActivity` do the same when stamping `nextClaimAt` on edits.

**Co-parent divergence** (parents in different tz) is an accepted
limitation — we assume co-parents share a timezone for now. If this
becomes a real problem, the fix is to move tz to `children` and make
the schedule boundary stable across parents. File as a follow-up if
we ever hit it.

### 3.6 Initial `nextClaimAt` on create

On `createActivity`, `nextClaimAt` is set to **`now`** — the activity
is **immediately claimable**. No "first due date" picker, no client
juggling. The child can simply not claim it if they don't want to;
but in practice parents create an allowance and the child claims it
right away, so "immediate" matches intent.

### 3.7 Edit semantics — `updateActivity`

Parents **can edit** activities after create (title, reward,
schedule, type). All edits flow through an `updateActivity` callable;
direct client writes to mutate an activity are denied.

Editable fields: `title`, `reward`, `schedule`. Any subset can be
patched in one call. `type` is **immutable** after create — rules
pin it; once a row is an ALLOWANCE it stays an ALLOWANCE until
deleted. An activity's kind is its identity; flipping it at runtime
would require atomic pointer-rewiring we don't need to build.

Editing `reward` on its own just changes the reward; the pending
claim still fires on its existing `nextClaimAt` with the new amount.
Editing `title` is cosmetic. Editing `schedule` carries a
side-effect.

On `updateActivity(activityId, patch)`:

1. Verify caller is in the child's `parentUids`.
2. Reject if the patch contains `type` (immutable).
3. Apply allowed patch fields (`title`, `reward`, `schedule`) to the
   activity doc.
4. **Side-effect if `schedule` is in the patch:** recompute
   `nextClaimAt = nextOccurrence(newSchedule, now, actingParentTz)`.

Rationale: the parent's mental model is "I just changed the schedule
from Saturday to Friday — next claim is the upcoming Friday". Rolling
`nextClaimAt` forward on edit matches that model. Edits that don't
touch `schedule` (e.g. just raising `reward`) leave `nextClaimAt`
alone — the pending claim still fires on its original date, but with
the new reward.

### 3.8 Allowance uniqueness — `children.allowanceId`

Firestore rules **cannot** query a collection. "At most one
ALLOWANCE activity per child" cannot be enforced by a rule that
looks at other activities. Instead:

- `children/{childId}.allowanceId: string | null` — a pointer to the
  single allowance activity, or `null`.
- `createActivity(childId, {type: 'ALLOWANCE', …})`:
  - In a transaction, reject if `children.allowanceId != null`.
  - Otherwise set `children.allowanceId = newActivityId`.
- `createActivity(childId, {type: 'CHORE', …})`:
  - No pointer update; many allowed.
- Deleting an ALLOWANCE activity clears the pointer (via the
  `deleteActivity` callable).
- No runtime type swaps — `type` is immutable post-create (see §3.7),
  so the pointer is set exactly once on create and cleared exactly
  once on delete.

Rules-enforceable: on activity create with `type == 'ALLOWANCE'`,
require `children.allowanceId` to be null *at the start* of the
operation and set *at the end* — the callable does both writes in
one transaction.

UI benefit: the Android app reads `children.allowanceId` directly to
render the pocket-money card; no `where('type', '==', 'ALLOWANCE')`
query needed.

## 4. Vault — interest as a vault mechanic

### 4.1 Vault config on `children`

The vault lives as a **nested map** on the child doc. The whole map
is `null` when no vault is configured. Both `interest` and `matching`
are **independently optional** sub-objects — either can be absent
without affecting the other.

```ts
children/{childId}.vault: {
  balance:     integer,                      // cents
  target:      integer,                      // cents
  unlockedAt:  Timestamp | null,             // null = still saving; set = balance hit target
  interest: {
    weeklyRate:       number,                // decimal, 0.01 = 1% per week
    lastAccrualWrite: Timestamp,             // advanced on every non-zero vault write (§4.5)
  } | null,                                  // null = interest disabled
  matching: {
    rate: number,                            // decimal, 0.5 = 50% bonus on deposits
  } | null,                                  // null = matching disabled
} | null                                     // null = vault not configured
```

The existing flat `vaultBalance` field is retired; all vault state
lives inside `vault`. Safe because the project is destroy-and-rebuild
(§8).

**Match rate convention:** `matching.rate` is the **bonus fraction** —
a rate of `0.5` means "for every €10 the child deposits, the parent
adds €5". `1.0` = dollar-for-dollar. `2.0` = triple total (€10
deposit + €20 match = €30 into the vault).

**Unlocked state:** the vault is "unlocked" iff `unlockedAt != null`.
This is set atomically inside any vault write that causes
`balance >= target`. See §4.7 for what unlocked means and how the
money gets out.

### 4.2 Orthogonal switches + two states

Config switches (independent):

| `vault` | `vault.interest` | `vault.matching` | Config meaning |
|---------|------------------|------------------|----------------|
| `null` | — | — | No vault. All vault callables reject. |
| set | `null` | `null` | Plain savings goal. Only `DEPOSIT` / `UNLOCK` rows. |
| set | set | `null` | Savings goal + interest. `INTEREST_CLAIM` possible. No `MATCH`. |
| set | `null` | set | Savings goal + matching. `MATCH` on deposits. No `INTEREST_CLAIM`. |
| set | set | set | All mechanics on. |

Lifecycle states (within a configured vault):

| `vault.unlockedAt` | `balance` vs `target` | State | What's allowed |
|--------------------|-----------------------|-------|----------------|
| `null` | `balance < target` | **Saving** | `depositToVault`, `claimInterest`, `getClaimableInterest` |
| set | `balance == target` | **Unlocked** | `unlockVault` only. `claimInterest` / `depositToVault` reject. |

**Critical invariants:**

- `MATCH` rows are created **only** in response to a `DEPOSIT`
  operation (see §4.6). `INTEREST_CLAIM` operations never trigger
  matching — the vault gains the interest amount only, not interest
  + match.
- **While unlocked, no more interest can be claimed.** The clock
  (`interest.lastAccrualWrite`) stops moving and no `INTEREST_CLAIM`
  rows can be written until `unlockVault` resets the state.
- A vault that hits `target` mid-transaction atomically sets
  `unlockedAt = serverTimestamp()` before the transaction commits.

Vault config is set atomically (all sub-fields of `vault`, including
which sub-objects are `null`, written in one update). Config flows
through `mb vault configure` (Admin-SDK CLI) in this PR; a
`configureVault` callable is a follow-up.

### 4.3 `getClaimableInterest(childId)` — read-only callable

Returns the amount (cents, integer) of interest claimable *right
now*. No writes. Safe to call from UI on every render.

```
if vault is null:                              return 0
if vault.interest is null:                     return 0
if vault.unlockedAt is not null:               return 0   // unlocked — no more interest
days    = (now - vault.interest.lastAccrualWrite) / 86_400_000
accrued = vault.balance * vault.interest.weeklyRate * (days / 7)
cap     = max(0, vault.target - vault.balance)
return floor(min(accrued, cap))                // cents
```

Floors to whole cents; math is in floating-point and rounds down so
we never over-pay.

### 4.4 `claimInterest(childId)` — mutating callable

Transaction:

1. Verify caller is in the child's `parentUids`.
2. Read child; reject with `failed-precondition` if any of:
   - `vault == null`
   - `vault.interest == null`
   - `vault.unlockedAt != null` (already unlocked — see §4.2)
3. Recompute `payout` exactly as in §4.3 (server-authoritative; the
   client-visible estimate is advisory).
4. **If `payout == 0`:** no-op. No `vaultTransactions` row. No
   clock advance. Return `{ paid: 0 }`.
5. **If `payout > 0`:**
   - Append row to `children/{childId}/vaultTransactions` with
     `type: 'INTEREST_CLAIM'`, `amount: payout`,
     `createdAt: serverTimestamp()`.
   - Update `vault.balance += payout`.
   - Update `vault.interest.lastAccrualWrite = now`. (Per §4.5 —
     every non-zero write advances the clock.)
   - **If `vault.balance == vault.target` after the payout:** set
     `vault.unlockedAt = now` in the same transaction.
   - **Do not write any `MATCH` row**, even if `vault.matching` is
     configured. Interest claims are never matched.
   - Return `{ paid: payout, unlocked: (unlockedAt was set in this call) }`.

### 4.5 Clock rule — advance on every non-zero vault write

The interest clock (`vault.interest.lastAccrualWrite`) advances
whenever any non-zero vault write occurs:

- **Non-zero `claimInterest` payout** — clock advances.
- **Deposit inside `depositToVault`** — clock advances to the deposit
  time, even if the pre-deposit interest claim was 0.
- **`unlockVault`** — clock cleared (vault resets; see §4.7).

Zero-effect operations (e.g. a standalone `claimInterest` call when
nothing has accrued) perform no write and leave the clock alone.

**Why:** this makes accrual exact between writes. Intervals between
vault writes are constant-balance, so
`balance * rate * (days/7)` is correct for that interval — no
approximation, no over-payment for periods where the balance was
lower than the current value.

### 4.6 `depositToVault(childId, amount)` — mutating callable

Moves money from the child's **main balance** into the vault.
Parent-initiated for this PR; child-initiated deposits (from the
Android app) can be added later by reusing this callable.

**Order of operations is load-bearing:** interest is claimed *first*,
then the deposit is sized against the post-interest room, then the
match is sized against the remaining room. If the deposit fills the
vault to target, the vault unlocks atomically in the same
transaction.

Transaction:

1. Verify caller is in the child's `parentUids`.
2. Read child; reject with `failed-precondition` if any of:
   - `vault == null`
   - `vault.unlockedAt != null` (vault already unlocked; call
     `unlockVault` first to reset).
3. Validate `amount`: integer cents, `> 0`, `<= child.balance`.
   Reject otherwise.
4. **Step A — claim interest first.** If `vault.interest != null`,
   compute `interestPayout` as in §4.3 and, if non-zero, apply it:
   - Append `INTEREST_CLAIM` row, `amount: interestPayout`.
   - `vault.balance += interestPayout`.
   - `vault.interest.lastAccrualWrite = now`.
   - Do **not** unlock the vault here even if this hits target — the
     deposit step has its own unlock check at the end; but guard: if
     the interest *alone* hit target, skip step B entirely (no
     deposit, no match) and proceed to step D.
5. **Step B — compute deposit sizing:**
   - `roomAfterInterest = vault.target - vault.balance`.
   - If `roomAfterInterest == 0`: skip to step D (interest filled
     the vault; no room for the deposit).
   - If `vault.matching != null`, each €1 deposited eats
     `(1 + matching.rate)` of room. So
     `maxDeposit = floor(roomAfterInterest / (1 + matching.rate))`.
   - If `vault.matching == null`: `maxDeposit = roomAfterInterest`.
   - `actualDeposit = min(amount, maxDeposit)`.
6. **Step C — apply the deposit + match:**
   - Decrement `child.balance` by `actualDeposit` (main ledger).
     The **untouched remainder** (`amount - actualDeposit`) stays
     in the main balance.
   - Append main ledger row: `type: 'WITHDRAW'`,
     `amount: actualDeposit`, `description: 'Vault deposit'`,
     `createdByUid: caller`, `createdAt: serverTimestamp()`.
   - `vault.balance += actualDeposit`.
   - Append vault ledger row: `type: 'DEPOSIT'`,
     `amount: actualDeposit`.
   - If `vault.matching != null` and `actualDeposit > 0`:
     `matchAmount = floor(actualDeposit * vault.matching.rate)`,
     capped at `vault.target - vault.balance`. If
     `matchAmount > 0`:
     - Append vault ledger row: `type: 'MATCH'`,
       `amount: matchAmount`.
     - `vault.balance += matchAmount`.
   - If `actualDeposit > 0` or `matchAmount > 0`: advance
     `vault.interest.lastAccrualWrite = now` (§4.5).
7. **Step D — unlock check.** If after all of the above
   `vault.balance >= vault.target`: set
   `vault.unlockedAt = serverTimestamp()`.
8. Return
   `{ interestClaimed, deposited: actualDeposit, matched: matchAmount, remainedInMain: amount - actualDeposit, unlocked }`.

**Worked example** (from the user spec): vault `balance=40`,
`target=50`, `matching.rate=1.0`, interest accrued = 2. User calls
`depositToVault(10)`.

1. Step A — interest 2 claimed. `balance=42`. Clock advances.
2. Step B — `roomAfterInterest = 8`. `maxDeposit = floor(8/2) = 4`.
   `actualDeposit = min(10, 4) = 4`.
3. Step C — main `-=4`. Vault `+=4`. Match = `floor(4 * 1.0) = 4`,
   cap = `50 - 46 = 4`, match = 4. Vault `+=4` → `balance=50`.
4. Step D — `balance == target`, set `unlockedAt = now`.
5. Return `{ interestClaimed: 2, deposited: 4, matched: 4, remainedInMain: 6, unlocked: true }`.

### 4.7 `unlockVault(childId)` — mutating callable

The opposite of deposit: moves the vault balance back to the main
balance and resets the vault to the saving state so a new cycle can
begin.

Transaction:

1. Verify caller is in the child's `parentUids`.
2. Read child; reject with `failed-precondition` if any of:
   - `vault == null`
   - `vault.unlockedAt == null` (not unlocked yet — goal not hit).
3. In one transaction:
   - `released = vault.balance`.
   - Append vault ledger row: `type: 'UNLOCK'`, `amount: released`.
   - `child.balance += released` (main ledger).
   - Append main ledger row: `type: 'EARN'`, `amount: released`,
     `description: 'Vault unlocked'`, `createdByUid: caller`,
     `createdAt: serverTimestamp()`.
   - `vault.balance = 0`.
   - `vault.unlockedAt = null`.
   - If `vault.interest != null`: reset
     `vault.interest.lastAccrualWrite = now` (fresh cycle — no
     back-accrual).
4. Return `{ released }`.

Config (`target`, `interest`, `matching`) is **preserved** across
unlock. The family typically wants to save for the same goal again,
and re-entering config every cycle would be friction for no benefit.

## 5. Cloud Functions inventory

| Function | Kind | New/change |
|----------|------|------------|
| `createActivity` | Callable | **New.** Transactional create. Sets `nextClaimAt = now`. For `type: 'ALLOWANCE'`, sets `children.allowanceId`; rejects if already set. |
| `updateActivity` | Callable | **New.** Transactional edit of `title` / `reward` / `schedule`. If `schedule` changes, recomputes `nextClaimAt`. Rejects `type` in the patch (immutable). |
| `deleteActivity` | Callable | **New.** Transactional delete. Clears `children.allowanceId` when deleting the allowance. |
| `claimActivity` | Callable | **New.** Owns ledger write + balance update + `nextClaimAt` advance, all transactional. |
| `getClaimableInterest` | Callable | **New.** Read-only. See §4.3. Returns 0 when vault null, interest disabled, or unlocked. |
| `claimInterest` | Callable | **New.** See §4.4. Rejects when vault null, interest disabled, or unlocked. Never triggers matching. Atomically sets `unlockedAt` if the payout hits target. |
| `depositToVault` | Callable | **New.** See §4.6. Interest-first ordering: claims interest, then deposits with optional match, then unlocks if target hit — all transactional. |
| `unlockVault` | Callable | **New.** See §4.7. Moves vault balance → main, resets `balance` to 0 and `unlockedAt` to null. Config preserved. |
| `onActivityCreate` | Firestore onCreate trigger | **New (replaces `onActivityPush`).** Fan-out push notification on activity creation. |
| `onActivityPush` | Firestore onUpdate trigger | **Retire in this PR.** LOCKED→READY edge no longer exists. |
| `onChildDelete` | Firestore onDelete trigger | No change — still cascades `transactions`, `vaultTransactions`, `activities`. |

`configureVault` is deferred to a follow-up (CLI wraps Admin SDK for
now).

## 6. Firestore rules changes

`firestore.rules` needs updates for:

- **Activities** —
  - `create`: deny. All creates must go through `createActivity`
    callable (so allowance pointer is set atomically).
  - `update`: deny. All updates must go through `updateActivity`
    callable (so `nextClaimAt` recompute is atomic).
  - `delete`: deny. Must go through `deleteActivity` callable (so
    `children.allowanceId` is cleared atomically).
  - `read`: parents of the child (same as today).

- **`children.allowanceId`** — pinned to only transition via Admin
  SDK writes (i.e. direct client writes cannot change it). Read
  allowed for parents.

- **`children.vault` (whole map)** — pinned to Admin-SDK-only writes.
  Direct client writes cannot create, modify, or clear the map. Read
  allowed for parents. Map-shape validation:
  - When `vault != null`: `balance`, `target` are required integers;
    `interest` is either `null` or a map with `weeklyRate` (number)
    and `lastAccrualWrite` (Timestamp); `matching` is either `null`
    or a map with `rate` (number).
  - The legacy flat `vaultBalance` field is removed in these rules.

Rules tests (`functions/test/rules/firestore.rules.test.ts`) need
parallel updates: activities section becomes "direct writes denied,
reads allowed for parents"; new `vault`-map shape assertions with
interest-on / matching-on / both-on / both-off permutations.

## 7. CLI changes

`tools/src/mb/commands/activities.py`:

- `mb activities create` — replaces `--type BOUNTY_RECURRING` with
  `--type (allowance|chore)` and adds `--schedule`. Schedule
  shorthand: `daily`, `weekly:sat`, `monthly:1`. Internally calls
  `createActivity` callable.
- `mb activities edit` — **new.** Calls `updateActivity`. Accepts
  `--title`, `--reward`, `--schedule`. (No `--type`: `type` is
  immutable post-create.)
- `mb activities delete` — **new.** Calls `deleteActivity`.
- `mb activities claim` — calls `claimActivity` instead of directly
  flipping status.
- `mb activities list` — shows `schedule` and `nextClaimAt`; adds a
  "claimable now?" column.

New `tools/src/mb/commands/vault.py`:

- `mb vault configure --child-id … --target 50.00 [--weekly-rate 0.01] [--match-rate 0.5]`
  — Admin-SDK write (no callable yet); sets `child.vault` atomically.
  `--weekly-rate` omitted → `vault.interest = null` (interest
  disabled). `--match-rate` omitted → `vault.matching = null`
  (matching disabled). Both omitted → plain savings goal.
- `mb vault deposit --child-id … --amount 10.00` — calls
  `depositToVault`. Reports interest claimed, deposited, matched,
  remainder-in-main, and unlocked flag.
- `mb vault claim-interest --child-id …` — calls `claimInterest`.
- `mb vault preview --child-id …` — calls `getClaimableInterest`.
- `mb vault unlock --child-id …` — calls `unlockVault`. Reports the
  released amount.
- `mb vault show --child-id …` — prints the current `vault` map for
  debugging (Admin-SDK read).

New `tools/src/mb/commands/admin.py`:

- `mb admin reset` — destroys and rebuilds the project (see §8).

## 8. Destroy-and-rebuild

The schema change is breaking. Rather than a migration path, the
project is still pre-production — **wipe and re-seed**.

`mb admin reset`:

- Refuses to run against `--project prod` unless
  `--yes-i-know-this-is-prod` *and* an interactive `"reset"` typed
  confirmation are both present.
- Wipes Firestore (all collections: `children`, `invites`, `users`,
  `deviceTokens`, …) via Admin SDK recursive delete.
- Wipes Auth users via Admin SDK `listUsers` + `deleteUsers` batching.
- Wipes Storage profile-photo paths.
- Exits non-zero on any partial failure.

The emulator suite already resets trivially (`make clean`), so this
command is for the `dev` project specifically.

## 9. Implementation plan

Rough PR slicing (each its own branch / PR):

1. **This PR (`refresh-activities`):** design doc + `Makefile`
   carry-over. No code changes. Merges once concept is agreed.
2. **Schema + rules** (`refresh-activities-schema`): update
   `docs/schema.md`, `firestore.rules`, rules tests. No Functions
   code yet — rules deny direct writes on activities (callables don't
   exist yet, so the CLI is temporarily broken; acceptable given §8).
3. **`nextOccurrence` pure function** + unit tests.
4. **Activity callables**: `createActivity`, `updateActivity`,
   `deleteActivity`, `claimActivity` + tests.
5. **Vault callables**: `getClaimableInterest`, `claimInterest`,
   `depositToVault`, `unlockVault` + tests. Establishes the nested
   `vault` map with `interest`, `matching`, and `unlockedAt`.
6. **Push trigger swap**: retire `onActivityPush`, add
   `onActivityCreate`.
7. **CLI updates**: `mb activities`, `mb vault`, `mb admin reset`.
8. **Rebuild**: run `mb admin reset` against dev, seed a smoke
   scenario, verify end-to-end.

Slices 3, 4, 5 can proceed in parallel once slice 2 lands. Slices 6
and 7 can land once 4 and 5 are green.

## 10. Decisions recap

All resolved (was §10 open questions):

- **Timezone: on `users/{uid}`**; assume co-parents share tz for now.
- **Interest clock: advance on any non-zero vault write** (interest
  payout, deposit, match). Vault-at-cap accrual is therefore
  accounted for on the next non-zero vault write, not only on
  interest payouts. See §4.5.
- **Retire `onActivityPush` in this PR**; replace with
  `onActivityCreate`. Full push redesign (claimable-now pings) still
  a follow-up.
- **Parents can edit** `title` / `reward` / `schedule` via
  `updateActivity`; schedule edits recompute `nextClaimAt`.
- **`type` is immutable** after create. No ALLOWANCE ↔ CHORE swaps
  at runtime.
- **Initial `nextClaimAt = now`** on create — immediately claimable.
- **Allowance uniqueness** via `children.allowanceId` pointer; rules
  enforce the null↔set invariant via callable-only writes.
- **Type retained** (`'ALLOWANCE' | 'CHORE'`) for UI grouping; not
  the uniqueness mechanism.
- **Vault is a nested map** on `children/{id}.vault`, not flat
  fields. Existing flat `vaultBalance` retired (safe under §8).
- **Interest and matching are independently optional** sub-objects
  of `vault`. Either, both, or neither can be enabled.
- **Matching only ever fires on `DEPOSIT`.** `INTEREST_CLAIM`
  operations never trigger a `MATCH` row.
- **Match rate is the bonus fraction:** `rate: 0.5` = "parent adds
  50% of the deposit". `1.0` = dollar-for-dollar. Capped so vault
  never overflows target.
- **`depositToVault` claims interest first**, then sizes the deposit
  against post-interest room, then sizes the match. Untouched
  remainder stays in the main balance.
- **Two vault states** — *saving* (`unlockedAt == null`) and
  *unlocked* (`unlockedAt != null`, `balance == target`). Hitting
  target atomically enters the unlocked state. No interest can
  accrue or be claimed while unlocked.
- **`unlockVault` callable** moves balance → main and resets the
  vault to the saving state. Config (target, interest, matching) is
  preserved for the next cycle.
- **Clock rule:** `vault.interest.lastAccrualWrite` advances on any
  non-zero vault write (interest payout, deposit, match) — not only
  on interest payouts. This makes accrual exact between writes.
