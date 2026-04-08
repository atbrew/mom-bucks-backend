import { describe, expect, it } from "vitest";
import { decideInviteAcceptance } from "../../src/handlers/acceptInvite";

// Fake Timestamp that satisfies the structural `.toMillis()` shape the
// decision function relies on. Avoids pulling in the real
// firebase-admin Timestamp just to construct a fixture.
function ts(ms: number): { toMillis(): number } {
  return { toMillis: () => ms };
}

const NOW = new Date("2026-04-08T12:00:00Z").getTime();
const SOON = NOW + 24 * 60 * 60 * 1000; // 1 day in the future
const LONG_AGO = NOW - 60 * 24 * 60 * 60 * 1000; // 60 days ago

const BASE_INVITE = {
  childIds: ["c-sam"],
  invitedByUid: "fb-alice",
  invitedEmail: null as string | null,
  expiresAt: ts(SOON) as unknown as import("firebase-admin/firestore").Timestamp,
  acceptedByUid: null as string | null,
  acceptedAt: null,
};

const VALID_CHILD = {
  parentUids: ["fb-alice"],
  name: "Sam",
};

describe("decideInviteAcceptance", () => {
  describe("happy path", () => {
    it("accepts a valid pending invite", () => {
      const decision = decideInviteAcceptance({
        callerUid: "fb-bob",
        callerEmail: "bob@test.com",
        invite: { ...BASE_INVITE },
        children: new Map([["c-sam", { ...VALID_CHILD }]]),
        nowMs: NOW,
      });
      expect(decision).toEqual({ kind: "accept", childIds: ["c-sam"] });
    });

    it("accepts a multi-child invite when inviter is on every child", () => {
      const decision = decideInviteAcceptance({
        callerUid: "fb-bob",
        callerEmail: null,
        invite: { ...BASE_INVITE, childIds: ["c-sam", "c-jamie"] },
        children: new Map([
          ["c-sam", { ...VALID_CHILD }],
          ["c-jamie", { parentUids: ["fb-alice"] }],
        ]),
        nowMs: NOW,
      });
      expect(decision).toEqual({
        kind: "accept",
        childIds: ["c-sam", "c-jamie"],
      });
    });

    it("accepts when caller email matches invitedEmail (case-insensitive)", () => {
      const decision = decideInviteAcceptance({
        callerUid: "fb-bob",
        callerEmail: "Bob@Test.COM",
        invite: { ...BASE_INVITE, invitedEmail: "bob@test.com" },
        children: new Map([["c-sam", { ...VALID_CHILD }]]),
        nowMs: NOW,
      });
      expect(decision.kind).toBe("accept");
    });
  });

  describe("idempotent replay", () => {
    it("returns idempotent-replay when the same caller already accepted", () => {
      const decision = decideInviteAcceptance({
        callerUid: "fb-bob",
        callerEmail: "bob@test.com",
        invite: { ...BASE_INVITE, acceptedByUid: "fb-bob" },
        children: new Map([["c-sam", { ...VALID_CHILD, parentUids: ["fb-alice", "fb-bob"] }]]),
        nowMs: NOW,
      });
      expect(decision).toEqual({
        kind: "idempotent-replay",
        childIds: ["c-sam"],
      });
    });
  });

  describe("rejections", () => {
    it("rejects a missing invite with not-found", () => {
      const decision = decideInviteAcceptance({
        callerUid: "fb-bob",
        callerEmail: null,
        invite: null,
        children: new Map(),
        nowMs: NOW,
      });
      expect(decision).toEqual({
        kind: "reject",
        code: "not-found",
        message: "invite does not exist",
      });
    });

    it("rejects an expired invite with deadline-exceeded", () => {
      const decision = decideInviteAcceptance({
        callerUid: "fb-bob",
        callerEmail: null,
        invite: {
          ...BASE_INVITE,
          expiresAt: ts(
            LONG_AGO,
          ) as unknown as import("firebase-admin/firestore").Timestamp,
        },
        children: new Map([["c-sam", { ...VALID_CHILD }]]),
        nowMs: NOW,
      });
      expect(decision.kind).toBe("reject");
      if (decision.kind === "reject") {
        expect(decision.code).toBe("deadline-exceeded");
      }
    });

    it("rejects when already accepted by a DIFFERENT uid", () => {
      const decision = decideInviteAcceptance({
        callerUid: "fb-bob",
        callerEmail: null,
        invite: { ...BASE_INVITE, acceptedByUid: "fb-carol" },
        children: new Map([["c-sam", { ...VALID_CHILD }]]),
        nowMs: NOW,
      });
      expect(decision.kind).toBe("reject");
      if (decision.kind === "reject") {
        expect(decision.code).toBe("already-exists");
      }
    });

    it("rejects when invitedEmail doesn't match callerEmail", () => {
      const decision = decideInviteAcceptance({
        callerUid: "fb-bob",
        callerEmail: "imposter@evil.com",
        invite: { ...BASE_INVITE, invitedEmail: "bob@test.com" },
        children: new Map([["c-sam", { ...VALID_CHILD }]]),
        nowMs: NOW,
      });
      expect(decision.kind).toBe("reject");
      if (decision.kind === "reject") {
        expect(decision.code).toBe("permission-denied");
      }
    });

    it("rejects an empty childIds invite", () => {
      const decision = decideInviteAcceptance({
        callerUid: "fb-bob",
        callerEmail: null,
        invite: { ...BASE_INVITE, childIds: [] },
        children: new Map(),
        nowMs: NOW,
      });
      expect(decision.kind).toBe("reject");
      if (decision.kind === "reject") {
        expect(decision.code).toBe("failed-precondition");
      }
    });

    it("rejects when a referenced child has been deleted", () => {
      const decision = decideInviteAcceptance({
        callerUid: "fb-bob",
        callerEmail: null,
        invite: { ...BASE_INVITE },
        children: new Map([["c-sam", null]]),
        nowMs: NOW,
      });
      expect(decision.kind).toBe("reject");
      if (decision.kind === "reject") {
        expect(decision.code).toBe("not-found");
      }
    });

    it("rejects when the inviter is NO LONGER in parentUids (revoked parent loophole)", () => {
      // Alice invited Bob, then Alice was removed as a co-parent of
      // Sam before Bob could accept. The invite is pending but should
      // NOT grant Bob access — Alice is no longer authorised.
      const decision = decideInviteAcceptance({
        callerUid: "fb-bob",
        callerEmail: null,
        invite: { ...BASE_INVITE, invitedByUid: "fb-alice" },
        children: new Map([
          ["c-sam", { parentUids: ["fb-carol"] }], // Alice gone, Carol in charge
        ]),
        nowMs: NOW,
      });
      expect(decision.kind).toBe("reject");
      if (decision.kind === "reject") {
        expect(decision.code).toBe("permission-denied");
        expect(decision.message).toContain("inviter is no longer authorised");
      }
    });

    it("rejects a multi-child invite when the inviter is gone from even ONE child", () => {
      // Alice invites Bob to co-parent both Sam and Jamie, then is
      // removed from Jamie. The whole invite must fail — Firestore
      // transactions are all-or-nothing, so accepting "just Sam" is
      // not an option.
      const decision = decideInviteAcceptance({
        callerUid: "fb-bob",
        callerEmail: null,
        invite: { ...BASE_INVITE, childIds: ["c-sam", "c-jamie"] },
        children: new Map([
          ["c-sam", { parentUids: ["fb-alice"] }],
          ["c-jamie", { parentUids: ["fb-carol"] }],
        ]),
        nowMs: NOW,
      });
      expect(decision.kind).toBe("reject");
      if (decision.kind === "reject") {
        expect(decision.code).toBe("permission-denied");
      }
    });
  });
});
