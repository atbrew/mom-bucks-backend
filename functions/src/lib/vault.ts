/**
 * Pure vault math — no I/O, no Admin SDK, no timestamps from the
 * clock. The vault callables bind an injected `now` and call into
 * this module so the interesting logic (interest accrual, matching,
 * max-deposit sizing) can be unit-tested with table-driven cases.
 *
 * See design.md §4.3–§4.6 for the specification these helpers
 * implement.
 */

import type { Timestamp } from "firebase-admin/firestore";

/**
 * Vault subdocument shape carried on `children/{childId}.vault`. See
 * schema.md for field semantics. Shared across the vault callables
 * (`depositToVault`, `claimInterest`, `getClaimableInterest`,
 * `unlockVault`) so they can't drift on a field name.
 */
export interface VaultInterest {
  weeklyRate: number;
  lastAccrualWrite: Timestamp;
}

export interface Vault {
  balance: number;
  target: number;
  unlockedAt: Timestamp | null;
  interest: VaultInterest | null;
  matching: { rate: number } | null;
}

const MS_PER_DAY = 86_400_000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

/**
 * Interest accrued on `balance` between `lastAccrualMs` and `nowMs`,
 * capped at `target - balance`, floored to whole cents.
 *
 * Mirrors design §4.3:
 *   accrued = balance * weeklyRate * (elapsedMs / MS_PER_WEEK)
 *   cap     = max(0, target - balance)
 *   payout  = floor(min(accrued, cap))
 *
 * Returns 0 when:
 *   - the interval is zero or negative (clock somehow ahead of now),
 *   - the weekly rate is non-positive,
 *   - the balance is at or above target (no room for interest).
 */
export function computeInterestPayout(params: {
  balance: number;
  weeklyRate: number;
  lastAccrualMs: number;
  nowMs: number;
  target: number;
}): number {
  const { balance, weeklyRate, lastAccrualMs, nowMs, target } = params;
  const elapsedMs = nowMs - lastAccrualMs;
  if (elapsedMs <= 0) return 0;
  if (!(weeklyRate > 0)) return 0;
  if (!(balance > 0)) return 0;
  const room = target - balance;
  if (room <= 0) return 0;
  // Single-division form keeps the arithmetic in one float op rather
  // than two separate (elapsedMs/DAY) and (days/7) divisions, which
  // reduces rounding error at the extremes (very large balances or
  // very long intervals).
  const accrued = (balance * weeklyRate * elapsedMs) / MS_PER_WEEK;
  return Math.max(0, Math.floor(Math.min(accrued, room)));
}

/**
 * Largest integer `d` such that `d + floor(d * matchingRate) <=
 * roomAfterInterest`. When matching is disabled (`rate == null`),
 * this is just `roomAfterInterest`.
 *
 * This is the "tight" form from design §4.6 — `floor(room / (1 +
 * rate))` is a safe lower bound but can leave a cent gap when `rate`
 * is fractional (e.g. R=10, rate=0.5: naive=6 → total 9; tight=7 →
 * total 10). Binary search is O(log room) and avoids the rounding
 * trap.
 */
export function computeMaxDeposit(params: {
  roomAfterInterest: number;
  matchingRate: number | null;
}): number {
  const { roomAfterInterest, matchingRate } = params;
  if (roomAfterInterest <= 0) return 0;
  if (matchingRate === null || matchingRate <= 0) return roomAfterInterest;
  let lo = 0;
  let hi = roomAfterInterest;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (mid + Math.floor(mid * matchingRate) <= roomAfterInterest) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/**
 * Match amount for a given deposit: `floor(deposit * rate)`, capped
 * at the remaining room. `rate == null` disables matching.
 */
export function computeMatchAmount(params: {
  deposit: number;
  matchingRate: number | null;
  room: number;
}): number {
  const { deposit, matchingRate, room } = params;
  if (matchingRate === null || matchingRate <= 0) return 0;
  if (deposit <= 0) return 0;
  if (room <= 0) return 0;
  return Math.max(0, Math.min(Math.floor(deposit * matchingRate), room));
}
