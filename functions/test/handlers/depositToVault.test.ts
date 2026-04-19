import { describe, expect, it } from "vitest";

import { decideDepositToVault } from "../../src/handlers/depositToVault";

const PARENT = "fb-alice";
const OTHER = "fb-bob";
const NOW = new Date("2026-04-18T12:00:00Z").getTime();
const ONE_WEEK_AGO = NOW - 7 * 86_400_000;

function ts(ms: number): { toMillis(): number } {
  return { toMillis: () => ms };
}

const vault = (overrides: Record<string, unknown> = {}) => ({
  balance: 40,
  target: 50,
  unlockedAt: null,
  interest: null,
  matching: null,
  ...overrides,
});

describe("decideDepositToVault", () => {
  it("matches the design §4.6 worked example (balance=40, target=50, rate=1.0, accrual=2, amount=10)", () => {
    const decision = decideDepositToVault({
      callerUid: PARENT,
      child: {
        parentUids: [PARENT],
        balance: 100,
        vault: vault({
          balance: 40,
          target: 50,
          // 200 cents × 0.01 weekly × 1 week = 2 cents accrual on balance=200.
          // But our balance is 40 so we need a higher rate for accrual=2.
          // 40 × 1 weekly × 1 week = 40, capped at target-balance=10 → use balance
          // higher to get exactly 2. Actually: want accrued==2, so engineer it:
          // 40 × weeklyRate × 1 = 2 → weeklyRate = 0.05.
          interest: { weeklyRate: 0.05, lastAccrualWrite: ts(ONE_WEEK_AGO) },
          matching: { rate: 1.0 },
        }) as never,
      },
      amount: 10,
      nowMs: NOW,
    });
    expect(decision).toEqual({
      kind: "accept",
      interestClaimed: 2,
      actualDeposit: 4,
      matchAmount: 4,
      remainedInMain: 6,
      unlocks: true,
      advanceInterestClock: true,
    });
  });

  it("deposits without match when matching is disabled", () => {
    const decision = decideDepositToVault({
      callerUid: PARENT,
      child: {
        parentUids: [PARENT],
        balance: 500,
        vault: vault({ balance: 0, target: 1000 }) as never,
      },
      amount: 100,
      nowMs: NOW,
    });
    expect(decision).toEqual({
      kind: "accept",
      interestClaimed: 0,
      actualDeposit: 100,
      matchAmount: 0,
      remainedInMain: 0,
      unlocks: false,
      advanceInterestClock: false,
    });
  });

  it("caps actualDeposit at room when amount exceeds room", () => {
    const decision = decideDepositToVault({
      callerUid: PARENT,
      child: {
        parentUids: [PARENT],
        balance: 1000,
        vault: vault({ balance: 950, target: 1000 }) as never,
      },
      amount: 500,
      nowMs: NOW,
    });
    // room=50, no match, so actualDeposit=50, remainedInMain=450, fills target.
    expect(decision).toEqual({
      kind: "accept",
      interestClaimed: 0,
      actualDeposit: 50,
      matchAmount: 0,
      remainedInMain: 450,
      unlocks: true,
      advanceInterestClock: false,
    });
  });

  it("skips step B when interest alone fills the vault", () => {
    const decision = decideDepositToVault({
      callerUid: PARENT,
      child: {
        parentUids: [PARENT],
        balance: 100,
        vault: vault({
          balance: 99,
          target: 100,
          // accrual would be huge, capped at 1 cent room → fills.
          interest: { weeklyRate: 1.0, lastAccrualWrite: ts(ONE_WEEK_AGO) },
        }) as never,
      },
      amount: 10,
      nowMs: NOW,
    });
    expect(decision).toEqual({
      kind: "accept",
      interestClaimed: 1,
      actualDeposit: 0,
      matchAmount: 0,
      remainedInMain: 10,
      unlocks: true,
      advanceInterestClock: true,
    });
  });

  it("rejects when amount exceeds main balance", () => {
    const decision = decideDepositToVault({
      callerUid: PARENT,
      child: {
        parentUids: [PARENT],
        balance: 50,
        vault: vault() as never,
      },
      amount: 100,
      nowMs: NOW,
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject")
      expect(decision.code).toBe("failed-precondition");
  });

  it("rejects when amount is not a positive integer", () => {
    for (const bad of [0, -5, 1.5, Number.NaN]) {
      const decision = decideDepositToVault({
        callerUid: PARENT,
        child: { parentUids: [PARENT], balance: 100, vault: vault() as never },
        amount: bad,
        nowMs: NOW,
      });
      expect(decision.kind).toBe("reject");
      if (decision.kind === "reject")
        expect(decision.code).toBe("invalid-argument");
    }
  });

  it("rejects when caller is not a parent", () => {
    const decision = decideDepositToVault({
      callerUid: OTHER,
      child: { parentUids: [PARENT], balance: 100, vault: vault() as never },
      amount: 10,
      nowMs: NOW,
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("permission-denied");
  });

  it("rejects when vault is null", () => {
    const decision = decideDepositToVault({
      callerUid: PARENT,
      child: { parentUids: [PARENT], balance: 100 },
      amount: 10,
      nowMs: NOW,
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("failed-precondition");
  });

  it("rejects when vault is already unlocked", () => {
    const decision = decideDepositToVault({
      callerUid: PARENT,
      child: {
        parentUids: [PARENT],
        balance: 100,
        vault: vault({ unlockedAt: ts(NOW) }) as never,
      },
      amount: 10,
      nowMs: NOW,
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.message).toContain("unlocked");
  });

  it("rejects when child is missing", () => {
    const decision = decideDepositToVault({
      callerUid: PARENT,
      child: null,
      amount: 10,
      nowMs: NOW,
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("not-found");
  });
});
