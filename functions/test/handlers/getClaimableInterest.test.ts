import { describe, expect, it } from "vitest";

import { decideClaimableInterest } from "../../src/handlers/getClaimableInterest";

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

describe("decideClaimableInterest", () => {
  it("returns the computed payout for a configured vault", () => {
    const result = decideClaimableInterest({
      callerUid: PARENT,
      child: { parentUids: [PARENT], vault: vault() as never },
      nowMs: NOW,
    });
    expect(result).toEqual({ claimable: 100 });
  });

  it("rejects with not-found when child is missing", () => {
    const result = decideClaimableInterest({
      callerUid: PARENT,
      child: null,
      nowMs: NOW,
    });
    expect(result).toEqual({
      reject: { code: "not-found", message: "child does not exist" },
    });
  });

  it("rejects with permission-denied when caller is not a parent", () => {
    const result = decideClaimableInterest({
      callerUid: OTHER,
      child: { parentUids: [PARENT], vault: vault() as never },
      nowMs: NOW,
    });
    expect("reject" in result && result.reject.code).toBe("permission-denied");
  });

  it("returns 0 when vault is null", () => {
    expect(
      decideClaimableInterest({
        callerUid: PARENT,
        child: { parentUids: [PARENT] },
        nowMs: NOW,
      }),
    ).toEqual({ claimable: 0 });
  });

  it("returns 0 when interest is disabled", () => {
    expect(
      decideClaimableInterest({
        callerUid: PARENT,
        child: {
          parentUids: [PARENT],
          vault: vault({ interest: null }) as never,
        },
        nowMs: NOW,
      }),
    ).toEqual({ claimable: 0 });
  });

  it("returns 0 when the vault is unlocked", () => {
    expect(
      decideClaimableInterest({
        callerUid: PARENT,
        child: {
          parentUids: [PARENT],
          vault: vault({ unlockedAt: ts(NOW) }) as never,
        },
        nowMs: NOW,
      }),
    ).toEqual({ claimable: 0 });
  });

  it("returns 0 when lastAccrualWrite is missing", () => {
    expect(
      decideClaimableInterest({
        callerUid: PARENT,
        child: {
          parentUids: [PARENT],
          vault: vault({
            interest: { weeklyRate: 0.01, lastAccrualWrite: undefined },
          }) as never,
        },
        nowMs: NOW,
      }),
    ).toEqual({ claimable: 0 });
  });
});
