import { describe, expect, it } from "vitest";

import { decideClaimActivity } from "../../src/handlers/claimActivity";
import type { Schedule } from "../../src/lib/schedule";

const PARENT = "fb-alice";
const OTHER = "fb-bob";
const NOW = new Date("2026-04-18T09:00:00Z").getTime();

function ts(ms: number): { toMillis(): number } {
  return { toMillis: () => ms };
}

const WEEKLY: Schedule = { kind: "WEEKLY", dayOfWeek: 6 };

const DUE_ACTIVITY = {
  title: "Chore",
  reward: 100,
  type: "CHORE" as const,
  schedule: WEEKLY,
  nextClaimAt: ts(NOW - 60_000) as unknown as FirebaseFirestore.Timestamp,
};

describe("decideClaimActivity", () => {
  it("accepts a claim when the activity is due", () => {
    const decision = decideClaimActivity({
      callerUid: PARENT,
      child: { parentUids: [PARENT], balance: 250 },
      activity: { ...DUE_ACTIVITY },
      nowMs: NOW,
    });
    expect(decision).toEqual({
      kind: "accept",
      title: "Chore",
      reward: 100,
      schedule: WEEKLY,
      previousBalance: 250,
    });
  });

  it("accepts when nextClaimAt is exactly now (<= now semantics)", () => {
    const decision = decideClaimActivity({
      callerUid: PARENT,
      child: { parentUids: [PARENT], balance: 0 },
      activity: {
        ...DUE_ACTIVITY,
        nextClaimAt: ts(NOW) as unknown as FirebaseFirestore.Timestamp,
      },
      nowMs: NOW,
    });
    expect(decision.kind).toBe("accept");
  });

  it("defaults previousBalance to 0 when child.balance is missing", () => {
    const decision = decideClaimActivity({
      callerUid: PARENT,
      child: { parentUids: [PARENT] },
      activity: { ...DUE_ACTIVITY },
      nowMs: NOW,
    });
    if (decision.kind === "accept") expect(decision.previousBalance).toBe(0);
  });

  it("rejects when child is missing", () => {
    const decision = decideClaimActivity({
      callerUid: PARENT,
      child: null,
      activity: { ...DUE_ACTIVITY },
      nowMs: NOW,
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("not-found");
  });

  it("rejects when caller is not a parent", () => {
    const decision = decideClaimActivity({
      callerUid: OTHER,
      child: { parentUids: [PARENT] },
      activity: { ...DUE_ACTIVITY },
      nowMs: NOW,
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("permission-denied");
  });

  it("rejects when activity does not exist", () => {
    const decision = decideClaimActivity({
      callerUid: PARENT,
      child: { parentUids: [PARENT] },
      activity: null,
      nowMs: NOW,
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("not-found");
  });

  it("rejects when the activity is not yet claimable", () => {
    const decision = decideClaimActivity({
      callerUid: PARENT,
      child: { parentUids: [PARENT] },
      activity: {
        ...DUE_ACTIVITY,
        nextClaimAt: ts(NOW + 60_000) as unknown as FirebaseFirestore.Timestamp,
      },
      nowMs: NOW,
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("failed-precondition");
  });

  it("rejects when activity has no nextClaimAt", () => {
    const decision = decideClaimActivity({
      callerUid: PARENT,
      child: { parentUids: [PARENT] },
      activity: { ...DUE_ACTIVITY, nextClaimAt: undefined },
      nowMs: NOW,
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("failed-precondition");
  });

  it("rejects a malformed reward", () => {
    const decision = decideClaimActivity({
      callerUid: PARENT,
      child: { parentUids: [PARENT] },
      activity: { ...DUE_ACTIVITY, reward: -5 },
      nowMs: NOW,
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("failed-precondition");
  });
});
