import { describe, expect, it } from "vitest";

import { decideUpdateActivity } from "../../src/handlers/updateActivity";
import type { Schedule } from "../../src/lib/schedule";

const PARENT = "fb-alice";
const OTHER = "fb-bob";
const CHILD = { parentUids: [PARENT] };

const ACTIVITY = {
  type: "CHORE" as const,
  schedule: { kind: "WEEKLY", dayOfWeek: 6 } as Schedule,
};

describe("decideUpdateActivity", () => {
  it("accepts a title-only patch", () => {
    const decision = decideUpdateActivity({
      callerUid: PARENT,
      child: { ...CHILD },
      activity: { ...ACTIVITY },
      patch: { title: "Renamed" },
    });
    expect(decision).toEqual({
      kind: "accept",
      patch: { title: "Renamed" },
    });
  });

  it("accepts a reward-only patch", () => {
    const decision = decideUpdateActivity({
      callerUid: PARENT,
      child: { ...CHILD },
      activity: { ...ACTIVITY },
      patch: { reward: 200 },
    });
    expect(decision).toEqual({ kind: "accept", patch: { reward: 200 } });
  });

  it("accepts a schedule-only patch and normalises the parsed shape", () => {
    const decision = decideUpdateActivity({
      callerUid: PARENT,
      child: { ...CHILD },
      activity: { ...ACTIVITY },
      patch: { schedule: { kind: "DAILY" } },
    });
    expect(decision).toEqual({
      kind: "accept",
      patch: { schedule: { kind: "DAILY" } },
    });
  });

  it("accepts combined title/reward/schedule patches in one call", () => {
    const decision = decideUpdateActivity({
      callerUid: PARENT,
      child: { ...CHILD },
      activity: { ...ACTIVITY },
      patch: {
        title: "new",
        reward: 10,
        schedule: { kind: "MONTHLY", dayOfMonth: 15 },
      },
    });
    expect(decision.kind).toBe("accept");
  });

  it("returns noop for an empty patch", () => {
    const decision = decideUpdateActivity({
      callerUid: PARENT,
      child: { ...CHILD },
      activity: { ...ACTIVITY },
      patch: {},
    });
    expect(decision.kind).toBe("noop");
  });

  it("rejects when child does not exist", () => {
    const decision = decideUpdateActivity({
      callerUid: PARENT,
      child: null,
      activity: { ...ACTIVITY },
      patch: { title: "x" },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("not-found");
  });

  it("rejects when caller is not a parent", () => {
    const decision = decideUpdateActivity({
      callerUid: OTHER,
      child: { ...CHILD },
      activity: { ...ACTIVITY },
      patch: { title: "x" },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("permission-denied");
  });

  it("rejects when activity does not exist", () => {
    const decision = decideUpdateActivity({
      callerUid: PARENT,
      child: { ...CHILD },
      activity: null,
      patch: { title: "x" },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("not-found");
  });

  it("rejects a patch that includes type (immutable)", () => {
    const decision = decideUpdateActivity({
      callerUid: PARENT,
      child: { ...CHILD },
      activity: { ...ACTIVITY },
      patch: { type: "ALLOWANCE" },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") {
      expect(decision.code).toBe("invalid-argument");
      expect(decision.message).toContain("immutable");
    }
  });

  it("rejects an empty title patch", () => {
    const decision = decideUpdateActivity({
      callerUid: PARENT,
      child: { ...CHILD },
      activity: { ...ACTIVITY },
      patch: { title: "  " },
    });
    expect(decision.kind).toBe("reject");
  });

  it("rejects a non-integer reward patch", () => {
    const decision = decideUpdateActivity({
      callerUid: PARENT,
      child: { ...CHILD },
      activity: { ...ACTIVITY },
      patch: { reward: 2.5 },
    });
    expect(decision.kind).toBe("reject");
  });

  it("rejects an invalid schedule patch", () => {
    const decision = decideUpdateActivity({
      callerUid: PARENT,
      child: { ...CHILD },
      activity: { ...ACTIVITY },
      patch: { schedule: { kind: "NEVER" } },
    });
    expect(decision.kind).toBe("reject");
  });
});
