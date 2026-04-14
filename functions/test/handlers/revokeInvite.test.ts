import { describe, expect, it } from "vitest";
import { decideRevokeInvite } from "../../src/handlers/revokeInvite";

describe("decideRevokeInvite", () => {
  it("revokes when caller is the inviter and invite is unaccepted", () => {
    const decision = decideRevokeInvite({
      callerUid: "alice",
      invite: { invitedByUid: "alice", acceptedByUid: null },
    });
    expect(decision).toEqual({ kind: "revoke" });
  });

  it("rejects when invite does not exist", () => {
    const decision = decideRevokeInvite({ callerUid: "alice", invite: null });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") {
      expect(decision.code).toBe("not-found");
    }
  });

  it("rejects when caller is not the inviter (can't revoke others' invites)", () => {
    const decision = decideRevokeInvite({
      callerUid: "bob",
      invite: { invitedByUid: "alice", acceptedByUid: null },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") {
      expect(decision.code).toBe("permission-denied");
    }
  });

  it("rejects when invite has already been accepted (use removeParentFromChildren)", () => {
    // Revoking an accepted invite wouldn't reverse the access grant;
    // it would just erase the audit trail. Force the caller to use
    // removeParentFromChildren for that case.
    const decision = decideRevokeInvite({
      callerUid: "alice",
      invite: { invitedByUid: "alice", acceptedByUid: "bob" },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") {
      expect(decision.code).toBe("failed-precondition");
    }
  });
});
