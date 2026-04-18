import { describe, expect, it } from "vitest";

import { decideUnlockVault } from "../../src/handlers/unlockVault";

const PARENT = "fb-alice";
const OTHER = "fb-bob";
const NOW = new Date("2026-04-18T12:00:00Z").getTime();

function ts(ms: number): { toMillis(): number } {
  return { toMillis: () => ms };
}

const lockedVault = () => ({
  balance: 10000,
  target: 10000,
  unlockedAt: null,
  interest: null,
  matching: null,
});

const unlockedVault = (overrides: Record<string, unknown> = {}) => ({
  ...lockedVault(),
  unlockedAt: ts(NOW),
  ...overrides,
});

describe("decideUnlockVault", () => {
  it("accepts and reports released amount when vault is unlocked", () => {
    const decision = decideUnlockVault({
      callerUid: PARENT,
      child: {
        parentUids: [PARENT],
        vault: unlockedVault() as never,
      },
    });
    expect(decision).toEqual({
      kind: "accept",
      released: 10000,
      hasInterest: false,
    });
  });

  it("flags hasInterest:true when interest is configured", () => {
    const decision = decideUnlockVault({
      callerUid: PARENT,
      child: {
        parentUids: [PARENT],
        vault: unlockedVault({
          interest: { weeklyRate: 0.01, lastAccrualWrite: ts(NOW) },
        }) as never,
      },
    });
    expect(decision).toEqual({
      kind: "accept",
      released: 10000,
      hasInterest: true,
    });
  });

  it("rejects with not-found when child is missing", () => {
    const decision = decideUnlockVault({ callerUid: PARENT, child: null });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("not-found");
  });

  it("rejects with permission-denied when caller is not a parent", () => {
    const decision = decideUnlockVault({
      callerUid: OTHER,
      child: { parentUids: [PARENT], vault: unlockedVault() as never },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject")
      expect(decision.code).toBe("permission-denied");
  });

  it("rejects when vault is null", () => {
    const decision = decideUnlockVault({
      callerUid: PARENT,
      child: { parentUids: [PARENT] },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject")
      expect(decision.code).toBe("failed-precondition");
  });

  it("rejects when vault is not yet unlocked", () => {
    const decision = decideUnlockVault({
      callerUid: PARENT,
      child: { parentUids: [PARENT], vault: lockedVault() as never },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject")
      expect(decision.message).toContain("not unlocked");
  });
});
