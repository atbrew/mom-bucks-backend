import { describe, expect, it } from "vitest";

import { decideDeleteActivity } from "../../src/handlers/deleteActivity";

const PARENT = "fb-alice";
const OTHER = "fb-bob";

describe("decideDeleteActivity", () => {
  it("deletes a CHORE without clearing the allowance pointer", () => {
    const decision = decideDeleteActivity({
      callerUid: PARENT,
      activityId: "act-1",
      child: { parentUids: [PARENT], allowanceId: "some-other-id" },
      activity: { type: "CHORE" },
    });
    expect(decision).toEqual({ kind: "delete", clearAllowancePointer: false });
  });

  it("deletes an ALLOWANCE and clears the matching pointer", () => {
    const decision = decideDeleteActivity({
      callerUid: PARENT,
      activityId: "act-allow",
      child: { parentUids: [PARENT], allowanceId: "act-allow" },
      activity: { type: "ALLOWANCE" },
    });
    expect(decision).toEqual({ kind: "delete", clearAllowancePointer: true });
  });

  it("deletes an ALLOWANCE WITHOUT clearing a mismatched pointer", () => {
    // Inconsistent state (pointer doesn't match) — still safe to delete,
    // but don't clobber the live allowanceId that points elsewhere.
    const decision = decideDeleteActivity({
      callerUid: PARENT,
      activityId: "orphan-allow",
      child: { parentUids: [PARENT], allowanceId: "different-id" },
      activity: { type: "ALLOWANCE" },
    });
    expect(decision).toEqual({ kind: "delete", clearAllowancePointer: false });
  });

  it("rejects when child does not exist", () => {
    const decision = decideDeleteActivity({
      callerUid: PARENT,
      activityId: "act-1",
      child: null,
      activity: { type: "CHORE" },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("not-found");
  });

  it("rejects when caller is not a parent", () => {
    const decision = decideDeleteActivity({
      callerUid: OTHER,
      activityId: "act-1",
      child: { parentUids: [PARENT] },
      activity: { type: "CHORE" },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("permission-denied");
  });

  it("rejects when activity does not exist", () => {
    const decision = decideDeleteActivity({
      callerUid: PARENT,
      activityId: "act-1",
      child: { parentUids: [PARENT] },
      activity: null,
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.code).toBe("not-found");
  });
});
