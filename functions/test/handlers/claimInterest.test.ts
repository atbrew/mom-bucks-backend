import { describe, expect, it } from "vitest";

import { decideClaimInterest } from "../../src/handlers/claimInterest";

const PARENT = "fb-alice";
const OTHER = "fb-bob";
const NOW = new Date("2026-04-18T12:00:00Z").getTime();
const ONE_WEEK_AGO = NOW - 7 * 86_400_000;

function ts(ms: number): { toMillis(): number } {
  return { toMillis: () => ms };
}

const vault = (overrides: Record<string, unknown> = {}) => ({
  balance: 10000,
  target: 100000,
  unlockedAt: null,
  interest: {
    weeklyRate: 0.01,
    lastAccrualWrite: ts(ONE_WEEK_AGO),
  },
  matching: null,
  ...overrides,
});

describe("decideClaimInterest", () => {
  it("pays the accrued interest when well below target", () => {
    const decision = decideClaimInterest({
      callerUid: PARENT,
      child: { parentUids: [PARENT], vault: vault() as never },
      nowMs: NOW,
    });
    expect(decision).toEqual({ kind: "pay", payout: 100, unlocks: false });
  });

  it("flags unlocks:true when the payout fills the vault", () => {
    const decision = decideClaimInterest({
      callerUid: PARENT,
      child: {
        parentUids: [PARENT],
        vault: vault({ balance: 9950, target: 10000 }) as never,
      },
      nowMs: NOW,
    });
    // accrual would be 99, capped at 50 → unlocks.
    expect(decision).toEqual({ kind: "pay", payout: 50, unlocks: true });
  });

  it("returns noop when the computed payout is zero", () => {
    const decision = decideClaimInterest({
      callerUid: PARENT,
      child: {
        parentUids: [PARENT],
        vault: vault({ balance: 100000 }) as never,
      },
      nowMs: NOW,
    });
    expect(decision).toEqual({ kind: "noop" });
  });

  it("rejects with not-found when child is missing", () => {
    const decision = decideClaimInterest({
      callerUid: PARENT,
      child: null,
      nowMs: NOW,
    });
    expect(decision).toEqual({
      kind: "reject",
      code: "not-found",
      message: "child does not exist",
    });
  });

  it("rejects with permission-denied when caller is not a parent", () => {
    const decision = decideClaimInterest({
      callerUid: OTHER,
      child: { parentUids: [PARENT], vault: vault() as never },
      nowMs: NOW,
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("permission-denied");
  });

  it("rejects when vault is null", () => {
    const decision = decideClaimInterest({
      callerUid: PARENT,
      child: { parentUids: [PARENT] },
      nowMs: NOW,
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("failed-precondition");
  });

  it("rejects when interest is disabled", () => {
    const decision = decideClaimInterest({
      callerUid: PARENT,
      child: {
        parentUids: [PARENT],
        vault: vault({ interest: null }) as never,
      },
      nowMs: NOW,
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.message).toContain("interest is disabled");
  });

  it("rejects when the vault is already unlocked", () => {
    const decision = decideClaimInterest({
      callerUid: PARENT,
      child: {
        parentUids: [PARENT],
        vault: vault({ unlockedAt: ts(NOW) }) as never,
      },
      nowMs: NOW,
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject")
      expect(decision.message).toContain("unlocked");
  });

  it("rejects when lastAccrualWrite is missing", () => {
    const decision = decideClaimInterest({
      callerUid: PARENT,
      child: {
        parentUids: [PARENT],
        vault: vault({
          interest: { weeklyRate: 0.01, lastAccrualWrite: undefined },
        }) as never,
      },
      nowMs: NOW,
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("failed-precondition");
  });
});
