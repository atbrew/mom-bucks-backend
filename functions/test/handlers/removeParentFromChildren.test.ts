import { describe, expect, it } from "vitest";
import { decideRemoval } from "../../src/handlers/removeParentFromChildren";

describe("decideRemoval", () => {
  it("applies the removal in the happy two-parent path", () => {
    const decision = decideRemoval({
      callerUid: "fb-alice",
      targetUid: "fb-bob",
      child: { parentUids: ["fb-alice", "fb-bob"] },
    });
    expect(decision).toEqual({ kind: "apply", removeUid: "fb-bob" });
  });

  it("allows self-removal from a multi-parent child", () => {
    const decision = decideRemoval({
      callerUid: "fb-bob",
      targetUid: "fb-bob",
      child: { parentUids: ["fb-alice", "fb-bob"] },
    });
    expect(decision).toEqual({ kind: "apply", removeUid: "fb-bob" });
  });

  it("skips with CHILD_NOT_FOUND when the child doc is null", () => {
    const decision = decideRemoval({
      callerUid: "fb-alice",
      targetUid: "fb-bob",
      child: null,
    });
    expect(decision).toEqual({ kind: "skip", reason: "CHILD_NOT_FOUND" });
  });

  it("skips with CALLER_NOT_PARENT when caller isn't on parentUids", () => {
    const decision = decideRemoval({
      callerUid: "fb-outsider",
      targetUid: "fb-bob",
      child: { parentUids: ["fb-alice", "fb-bob"] },
    });
    expect(decision).toEqual({ kind: "skip", reason: "CALLER_NOT_PARENT" });
  });

  it("skips with TARGET_NOT_PARENT when target is already absent", () => {
    const decision = decideRemoval({
      callerUid: "fb-alice",
      targetUid: "fb-ghost",
      child: { parentUids: ["fb-alice"] },
    });
    expect(decision).toEqual({ kind: "skip", reason: "TARGET_NOT_PARENT" });
  });

  describe("last-parent guard (orphan prevention)", () => {
    it("skips when removing the target would leave parentUids empty", () => {
      const decision = decideRemoval({
        callerUid: "fb-alice",
        targetUid: "fb-alice",
        child: { parentUids: ["fb-alice"] },
      });
      expect(decision).toEqual({
        kind: "skip",
        reason: "WOULD_ORPHAN_CHILD",
      });
    });

    it("skips even when the caller is the target (solo self-removal)", () => {
      // Bob is the only parent of his solo child and tries to remove
      // himself. Not allowed — orphaning a child has no recovery path.
      const decision = decideRemoval({
        callerUid: "fb-bob",
        targetUid: "fb-bob",
        child: { parentUids: ["fb-bob"] },
      });
      expect(decision).toEqual({
        kind: "skip",
        reason: "WOULD_ORPHAN_CHILD",
      });
    });

    it("allows removing one of two co-parents (the canonical case)", () => {
      const decision = decideRemoval({
        callerUid: "fb-alice",
        targetUid: "fb-bob",
        child: { parentUids: ["fb-alice", "fb-bob"] },
      });
      expect(decision).toEqual({ kind: "apply", removeUid: "fb-bob" });
    });
  });

  describe("Phase 2 co-parenting continuity", () => {
    // Mirrors the Alice/Bob/Carol scenario from docs/schema.md.
    // Bob co-parents Sam (with Alice) and Jamie (with Alice).
    // Alice removes Bob from Sam only — Bob should keep Jamie.
    it("handles per-child isolation: Bob removed from Sam keeps Jamie", () => {
      const samDecision = decideRemoval({
        callerUid: "fb-alice",
        targetUid: "fb-bob",
        child: { parentUids: ["fb-alice", "fb-bob"], name: "Sam" },
      });
      expect(samDecision).toEqual({ kind: "apply", removeUid: "fb-bob" });

      // A second call to decideRemoval on Jamie, unchanged, would
      // return apply too. But in practice the caller only passes
      // childIds: [sam] and Jamie is untouched because the function
      // only looks at what's in the request.
      const jamieDecision = decideRemoval({
        callerUid: "fb-alice",
        targetUid: "fb-bob",
        child: { parentUids: ["fb-alice", "fb-bob"], name: "Jamie" },
      });
      expect(jamieDecision).toEqual({ kind: "apply", removeUid: "fb-bob" });
      // Whether Jamie gets touched is determined by the CALLER's
      // childIds, not by decideRemoval. This test just documents
      // that decideRemoval is a pure per-child function.
    });
  });
});
