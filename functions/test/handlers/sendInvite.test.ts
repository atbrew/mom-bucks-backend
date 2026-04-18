import { describe, expect, it } from "vitest";
import { decideSendInvite } from "../../src/handlers/sendInvite";

describe("decideSendInvite", () => {
  it("accepts and lowercases the email when caller is a parent", () => {
    const decision = decideSendInvite({
      callerUid: "alice",
      callerEmail: "alice@example.com",
      childId: "sam",
      invitedEmail: "Bob@Example.COM",
      child: { parentUids: ["alice"], name: "Sam" },
    });
    expect(decision).toEqual({ kind: "send", normalizedEmail: "bob@example.com" });
  });

  it("trims whitespace around the email before lowercasing", () => {
    const decision = decideSendInvite({
      callerUid: "alice",
      callerEmail: "alice@example.com",
      childId: "sam",
      invitedEmail: "  Bob@Example.com  ",
      child: { parentUids: ["alice"], name: "Sam" },
    });
    expect(decision).toEqual({ kind: "send", normalizedEmail: "bob@example.com" });
  });

  it("rejects when caller is not in parentUids (defence in depth)", () => {
    const decision = decideSendInvite({
      callerUid: "eve",
      callerEmail: "eve@example.com",
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
      callerEmail: "alice@example.com",
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
      callerEmail: "alice@example.com",
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
      callerEmail: "alice@example.com",
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
      callerEmail: "alice@example.com",
      childId: "sam",
      invitedEmail: "not-an-email",
      child: { parentUids: ["alice"], name: "Sam" },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") {
      expect(decision.code).toBe("invalid-argument");
    }
  });

  it("rejects a self-invite (inviter addressing their own email)", () => {
    const decision = decideSendInvite({
      callerUid: "alice",
      callerEmail: "alice@example.com",
      childId: "sam",
      invitedEmail: "alice@example.com",
      child: { parentUids: ["alice"], name: "Sam" },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") {
      expect(decision.code).toBe("invalid-argument");
      expect(decision.message).toMatch(/yourself/i);
    }
  });

  it("rejects a self-invite even when case or whitespace differ", () => {
    // Normalisation has to run on both sides of the comparison, not
    // just the incoming email — otherwise `ALICE@Example.com` vs the
    // stored `alice@example.com` slips through.
    const decision = decideSendInvite({
      callerUid: "alice",
      callerEmail: "alice@example.com",
      childId: "sam",
      invitedEmail: "  ALICE@Example.COM  ",
      child: { parentUids: ["alice"], name: "Sam" },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") {
      expect(decision.code).toBe("invalid-argument");
    }
  });

  it("allows the invite when callerEmail is missing (no enforcement possible)", () => {
    // Phone-auth and anonymous-auth callers have no email in the
    // token. We'd rather send the invite than block legitimate co-
    // parenting flows — self-invite-by-email isn't possible for them
    // anyway.
    const decision = decideSendInvite({
      callerUid: "alice",
      callerEmail: null,
      childId: "sam",
      invitedEmail: "bob@example.com",
      child: { parentUids: ["alice"], name: "Sam" },
    });
    expect(decision).toEqual({ kind: "send", normalizedEmail: "bob@example.com" });
  });
});
