import { describe, expect, it } from "vitest";
import { decideRevert } from "../../src/handlers/revertTransaction";

const CALLER = "fb-alice";

const VALID_CHILD = {
  parentUids: ["fb-alice"],
};

const LODGE_TXN = {
  amount: 500,
  type: "LODGE" as const,
  description: "Pocket money",
  createdByUid: "fb-alice",
};

const WITHDRAW_TXN = {
  amount: 250,
  type: "WITHDRAW" as const,
  description: "Sweets",
  createdByUid: "fb-alice",
};

describe("decideRevert", () => {
  describe("happy path", () => {
    it("reverts a LODGE into a WITHDRAW", () => {
      const decision = decideRevert({
        callerUid: CALLER,
        txn: { ...LODGE_TXN },
        child: { ...VALID_CHILD },
      });
      expect(decision).toEqual({
        kind: "revert",
        inverseType: "WITHDRAW",
        amount: 500,
        description: "Revert of Pocket money",
      });
    });

    it("reverts a WITHDRAW into a LODGE", () => {
      const decision = decideRevert({
        callerUid: CALLER,
        txn: { ...WITHDRAW_TXN },
        child: { ...VALID_CHILD },
      });
      expect(decision).toEqual({
        kind: "revert",
        inverseType: "LODGE",
        amount: 250,
        description: "Revert of Sweets",
      });
    });

    it("handles missing description gracefully", () => {
      const decision = decideRevert({
        callerUid: CALLER,
        txn: { amount: 100, type: "LODGE" },
        child: { ...VALID_CHILD },
      });
      expect(decision).toEqual({
        kind: "revert",
        inverseType: "WITHDRAW",
        amount: 100,
        description: "Revert of ",
      });
    });
  });

  describe("idempotent replay", () => {
    it("returns existing revert ID if already reverted", () => {
      const decision = decideRevert({
        callerUid: CALLER,
        txn: { ...LODGE_TXN, revertedByTxnId: "existing-revert-id" },
        child: { ...VALID_CHILD },
      });
      expect(decision).toEqual({
        kind: "idempotent-replay",
        revertTxnId: "existing-revert-id",
      });
    });
  });

  describe("rejections", () => {
    it("rejects when child does not exist", () => {
      const decision = decideRevert({
        callerUid: CALLER,
        txn: { ...LODGE_TXN },
        child: null,
      });
      expect(decision).toEqual({
        kind: "reject",
        code: "not-found",
        message: "child does not exist",
      });
    });

    it("rejects when caller is not a parent", () => {
      const decision = decideRevert({
        callerUid: "fb-mallory",
        txn: { ...LODGE_TXN },
        child: { parentUids: ["fb-alice"] },
      });
      expect(decision).toEqual({
        kind: "reject",
        code: "permission-denied",
        message: "caller is not a parent of this child",
      });
    });

    it("rejects when transaction does not exist", () => {
      const decision = decideRevert({
        callerUid: CALLER,
        txn: null,
        child: { ...VALID_CHILD },
      });
      expect(decision).toEqual({
        kind: "reject",
        code: "not-found",
        message: "transaction does not exist",
      });
    });

    it("rejects when transaction type is unknown", () => {
      const decision = decideRevert({
        callerUid: CALLER,
        txn: { amount: 100, type: "REFUND" as never },
        child: { ...VALID_CHILD },
      });
      expect(decision).toEqual({
        kind: "reject",
        code: "failed-precondition",
        message: "unknown transaction type: REFUND",
      });
    });
  });
});
