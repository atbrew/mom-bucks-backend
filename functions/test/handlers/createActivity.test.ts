import { describe, expect, it } from "vitest";

import { decideCreateActivity } from "../../src/handlers/createActivity";

const PARENT = "fb-alice";
const OTHER = "fb-bob";

const CHILD = { parentUids: [PARENT], allowanceId: null as string | null };

const VALID_DAILY = { kind: "DAILY" };
const VALID_WEEKLY = { kind: "WEEKLY", dayOfWeek: 6 };

describe("decideCreateActivity", () => {
  it("accepts a valid CHORE create", () => {
    const decision = decideCreateActivity({
      callerUid: PARENT,
      child: { ...CHILD },
      input: {
        title: "Take out bins",
        reward: 100,
        type: "CHORE",
        schedule: VALID_WEEKLY,
      },
    });
    expect(decision).toEqual({
      kind: "accept",
      type: "CHORE",
      title: "Take out bins",
      reward: 100,
      schedule: { kind: "WEEKLY", dayOfWeek: 6 },
    });
  });

  it("accepts a valid ALLOWANCE create when no existing allowance", () => {
    const decision = decideCreateActivity({
      callerUid: PARENT,
      child: { ...CHILD, allowanceId: null },
      input: {
        title: "Weekly pocket money",
        reward: 500,
        type: "ALLOWANCE",
        schedule: VALID_DAILY,
      },
    });
    expect(decision.kind).toBe("accept");
    if (decision.kind === "accept") expect(decision.type).toBe("ALLOWANCE");
  });

  it("trims title whitespace on accept", () => {
    const decision = decideCreateActivity({
      callerUid: PARENT,
      child: { ...CHILD },
      input: {
        title: "  Walk dog  ",
        reward: 50,
        type: "CHORE",
        schedule: VALID_DAILY,
      },
    });
    if (decision.kind === "accept") expect(decision.title).toBe("Walk dog");
  });

  it("rejects when child is missing", () => {
    const decision = decideCreateActivity({
      callerUid: PARENT,
      child: null,
      input: {
        title: "x",
        reward: 0,
        type: "CHORE",
        schedule: VALID_DAILY,
      },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("not-found");
  });

  it("rejects when caller is not a parent", () => {
    const decision = decideCreateActivity({
      callerUid: OTHER,
      child: { ...CHILD },
      input: {
        title: "x",
        reward: 0,
        type: "CHORE",
        schedule: VALID_DAILY,
      },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("permission-denied");
  });

  it("rejects an empty title", () => {
    const decision = decideCreateActivity({
      callerUid: PARENT,
      child: { ...CHILD },
      input: { title: "   ", reward: 0, type: "CHORE", schedule: VALID_DAILY },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("invalid-argument");
  });

  it("rejects a non-integer reward", () => {
    const decision = decideCreateActivity({
      callerUid: PARENT,
      child: { ...CHILD },
      input: { title: "x", reward: 1.5, type: "CHORE", schedule: VALID_DAILY },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("invalid-argument");
  });

  it("rejects a negative reward", () => {
    const decision = decideCreateActivity({
      callerUid: PARENT,
      child: { ...CHILD },
      input: { title: "x", reward: -1, type: "CHORE", schedule: VALID_DAILY },
    });
    expect(decision.kind).toBe("reject");
  });

  it("rejects an unknown type", () => {
    const decision = decideCreateActivity({
      callerUid: PARENT,
      child: { ...CHILD },
      input: {
        title: "x",
        reward: 0,
        type: "INTEREST",
        schedule: VALID_DAILY,
      },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("invalid-argument");
  });

  it("rejects a second ALLOWANCE when one already exists", () => {
    const decision = decideCreateActivity({
      callerUid: PARENT,
      child: { ...CHILD, allowanceId: "existing-allowance-id" },
      input: {
        title: "x",
        reward: 0,
        type: "ALLOWANCE",
        schedule: VALID_DAILY,
      },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("already-exists");
  });

  it("permits additional CHORE activities even when an allowance exists", () => {
    const decision = decideCreateActivity({
      callerUid: PARENT,
      child: { ...CHILD, allowanceId: "existing-allowance-id" },
      input: { title: "x", reward: 0, type: "CHORE", schedule: VALID_DAILY },
    });
    expect(decision.kind).toBe("accept");
  });

  it("rejects an invalid schedule shape", () => {
    const decision = decideCreateActivity({
      callerUid: PARENT,
      child: { ...CHILD },
      input: {
        title: "x",
        reward: 0,
        type: "CHORE",
        schedule: { kind: "WEEKLY", dayOfWeek: 9 },
      },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("invalid-argument");
  });
});
