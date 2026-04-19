import { describe, expect, it } from "vitest";

import {
  computeInterestPayout,
  computeMatchAmount,
  computeMaxDeposit,
} from "../../src/lib/vault";

const NOW = new Date("2026-04-18T12:00:00Z").getTime();
const ONE_WEEK_AGO = NOW - 7 * 86_400_000;
const ONE_DAY_AGO = NOW - 1 * 86_400_000;

describe("computeInterestPayout", () => {
  it("returns the floor-of-accrued when well under the cap", () => {
    // balance 10000 (€100), 1% weekly, 1 week elapsed → 100 cents.
    expect(
      computeInterestPayout({
        balance: 10000,
        weeklyRate: 0.01,
        lastAccrualMs: ONE_WEEK_AGO,
        nowMs: NOW,
        target: 100000,
      }),
    ).toBe(100);
  });

  it("caps the payout at target - balance", () => {
    // balance 9950, target 10000 → cap=50. Accrual would be 99, so
    // capped output is 50.
    expect(
      computeInterestPayout({
        balance: 9950,
        weeklyRate: 0.01,
        lastAccrualMs: ONE_WEEK_AGO,
        nowMs: NOW,
        target: 10000,
      }),
    ).toBe(50);
  });

  it("returns 0 when balance already meets or exceeds target", () => {
    expect(
      computeInterestPayout({
        balance: 10000,
        weeklyRate: 0.01,
        lastAccrualMs: ONE_WEEK_AGO,
        nowMs: NOW,
        target: 10000,
      }),
    ).toBe(0);
  });

  it("returns 0 when the interval is zero", () => {
    expect(
      computeInterestPayout({
        balance: 10000,
        weeklyRate: 0.01,
        lastAccrualMs: NOW,
        nowMs: NOW,
        target: 100000,
      }),
    ).toBe(0);
  });

  it("returns 0 when weeklyRate is zero or negative", () => {
    expect(
      computeInterestPayout({
        balance: 10000,
        weeklyRate: 0,
        lastAccrualMs: ONE_WEEK_AGO,
        nowMs: NOW,
        target: 100000,
      }),
    ).toBe(0);
  });

  it("returns 0 when balance is zero", () => {
    expect(
      computeInterestPayout({
        balance: 0,
        weeklyRate: 0.01,
        lastAccrualMs: ONE_WEEK_AGO,
        nowMs: NOW,
        target: 100000,
      }),
    ).toBe(0);
  });

  it("floors fractional accrual (never over-pays)", () => {
    // 10000 * 0.01 * (1/7) ≈ 14.28 → floor to 14.
    expect(
      computeInterestPayout({
        balance: 10000,
        weeklyRate: 0.01,
        lastAccrualMs: ONE_DAY_AGO,
        nowMs: NOW,
        target: 100000,
      }),
    ).toBe(14);
  });
});

describe("computeMaxDeposit", () => {
  it("returns the whole room when matching is disabled", () => {
    expect(
      computeMaxDeposit({ roomAfterInterest: 100, matchingRate: null }),
    ).toBe(100);
  });

  it("matches the design §4.6 worked example (R=10, rate=0.5 → 7)", () => {
    // d=7: 7 + floor(3.5)=3 → 10 (exact fill).
    // d=8: 8 + 4 → 12 (overshoots).
    expect(
      computeMaxDeposit({ roomAfterInterest: 10, matchingRate: 0.5 }),
    ).toBe(7);
  });

  it("splits evenly at rate=1.0 (dollar-for-dollar)", () => {
    expect(
      computeMaxDeposit({ roomAfterInterest: 10, matchingRate: 1.0 }),
    ).toBe(5);
    expect(
      computeMaxDeposit({ roomAfterInterest: 11, matchingRate: 1.0 }),
    ).toBe(5); // 5+5=10 <=11; 6+6=12 >11
  });

  it("floors match at high rates (rate=2.0 triples total)", () => {
    // d=3: 3 + floor(6)=6 → 9 <=10. d=4: 4 + 8 = 12 > 10. Answer 3.
    expect(
      computeMaxDeposit({ roomAfterInterest: 10, matchingRate: 2.0 }),
    ).toBe(3);
  });

  it("returns 0 when room is zero or negative", () => {
    expect(
      computeMaxDeposit({ roomAfterInterest: 0, matchingRate: 0.5 }),
    ).toBe(0);
    expect(
      computeMaxDeposit({ roomAfterInterest: -5, matchingRate: 0.5 }),
    ).toBe(0);
  });

  it("handles small rooms precisely (rate=0.5, R=1..5)", () => {
    // d=1: 1 + 0 = 1. So R=1 → 1. R=2 → d=2 (2+1=3? no). Let's trace.
    // R=1: d=1 → 1 <= 1 ✓. answer 1.
    // R=2: d=1 → 1 <= 2 ✓. d=2 → 2 + 1 = 3 > 2 ✗. answer 1.
    // R=3: d=2 → 2 + 1 = 3 <= 3 ✓. answer 2.
    // R=4: d=2 → 3 <= 4 ✓. d=3 → 3 + 1 = 4 <= 4 ✓. answer 3.
    // R=5: d=3 → 4 <=5 ✓. d=4 → 4 + 2 = 6 > 5 ✗. answer 3.
    expect(computeMaxDeposit({ roomAfterInterest: 1, matchingRate: 0.5 })).toBe(1);
    expect(computeMaxDeposit({ roomAfterInterest: 2, matchingRate: 0.5 })).toBe(1);
    expect(computeMaxDeposit({ roomAfterInterest: 3, matchingRate: 0.5 })).toBe(2);
    expect(computeMaxDeposit({ roomAfterInterest: 4, matchingRate: 0.5 })).toBe(3);
    expect(computeMaxDeposit({ roomAfterInterest: 5, matchingRate: 0.5 })).toBe(3);
  });
});

describe("computeMatchAmount", () => {
  it("floors the match and caps at remaining room", () => {
    expect(
      computeMatchAmount({ deposit: 7, matchingRate: 0.5, room: 100 }),
    ).toBe(3); // floor(3.5)
  });

  it("caps at room when the floored match would overflow", () => {
    expect(
      computeMatchAmount({ deposit: 10, matchingRate: 1.0, room: 5 }),
    ).toBe(5);
  });

  it("returns 0 when matching is disabled", () => {
    expect(
      computeMatchAmount({ deposit: 10, matchingRate: null, room: 100 }),
    ).toBe(0);
  });

  it("returns 0 for zero deposit or room", () => {
    expect(computeMatchAmount({ deposit: 0, matchingRate: 1.0, room: 100 })).toBe(0);
    expect(computeMatchAmount({ deposit: 10, matchingRate: 1.0, room: 0 })).toBe(0);
  });
});
