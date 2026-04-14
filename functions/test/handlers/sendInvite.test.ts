import { describe, expect, it } from "vitest";
import { decideSendInvite } from "../../src/handlers/sendInvite";

describe("decideSendInvite", () => {
  it("accepts and lowercases the email when caller is a parent", () => {
    const decision = decideSendInvite({
      callerUid: "alice",
      childId: "sam",
      invitedEmail: "Bob@Example.COM",
      child: { parentUids: ["alice"], name: "Sam" },
    });
    expect(decision).toEqual({ kind: "send", normalizedEmail: "bob@example.com" });
  });

  it("trims whitespace around the email before lowercasing", () => {
    const decision = decideSendInvite({
      callerUid: "alice",
      childId: "sam",
      invitedEmail: "  Bob@Example.com  ",
      child: { parentUids: ["alice"], name: "Sam" },
    });
    expect(decision).toEqual({ kind: "send", normalizedEmail: "bob@example.com" });
  });

  it("rejects when caller is not in parentUids (defence in depth)", () => {
    const decision = decideSendInvite({
      callerUid: "eve",
      childId: "sam",
      invitedEmail: "bob@example.com",
      child: { parentUids: ["alice"], name: "Sam" },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") {
      expect(decision.code).toBe("permission-denied");
    }
  });

  it("rejects when child doc is missing", () => {
    const decision = decideSendInvite({
      callerUid: "alice",
      childId: "ghost",
      invitedEmail: "bob@example.com",
      child: null,
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") {
      expect(decision.code).toBe("not-found");
    }
  });

  it("rejects when childId is empty", () => {
    const decision = decideSendInvite({
      callerUid: "alice",
      childId: "",
      invitedEmail: "bob@example.com",
      child: null,
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") {
      expect(decision.code).toBe("invalid-argument");
    }
  });

  it("rejects when invitedEmail is empty", () => {
    const decision = decideSendInvite({
      callerUid: "alice",
      childId: "sam",
      invitedEmail: "",
      child: { parentUids: ["alice"], name: "Sam" },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") {
      expect(decision.code).toBe("invalid-argument");
    }
  });

  it("rejects when invitedEmail does not look like an email", () => {
    const decision = decideSendInvite({
      callerUid: "alice",
      childId: "sam",
      invitedEmail: "not-an-email",
      child: { parentUids: ["alice"], name: "Sam" },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") {
      expect(decision.code).toBe("invalid-argument");
    }
  });
});
