import { describe, expect, it } from "vitest";
import { computeNewBalance } from "../../src/handlers/onTransactionCreate";

// The handler itself (`onTransactionCreate` export) is exercised via the
// Firestore emulator in the rules test suite — unit-testing the full
// `onDocumentCreated` wrapper needs `firebase-functions-test` and a
// live Firestore. The balance math is the interesting part and is
// fully covered here via the pure `computeNewBalance` helper.

describe("computeNewBalance", () => {
  it("adds a LODGE to the running balance", () => {
    expect(computeNewBalance(1000, { amount: 500, type: "LODGE" })).toEqual({
      previousBalance: 1000,
      newBalance: 1500,
      clamped: false,
    });
  });

  it("subtracts a WITHDRAW from the running balance", () => {
    expect(computeNewBalance(1000, { amount: 300, type: "WITHDRAW" })).toEqual({
      previousBalance: 1000,
      newBalance: 700,
      clamped: false,
    });
  });

  it("clamps to 0 when a WITHDRAW would go negative", () => {
    expect(computeNewBalance(100, { amount: 500, type: "WITHDRAW" })).toEqual({
      previousBalance: 100,
      newBalance: 0,
      clamped: true,
    });
  });

  it("does NOT clamp an exact-zero WITHDRAW", () => {
    expect(computeNewBalance(500, { amount: 500, type: "WITHDRAW" })).toEqual({
      previousBalance: 500,
      newBalance: 0,
      clamped: false,
    });
  });

  it("handles a LODGE against a zero balance", () => {
    expect(computeNewBalance(0, { amount: 200, type: "LODGE" })).toEqual({
      previousBalance: 0,
      newBalance: 200,
      clamped: false,
    });
  });

  it("handles a zero-amount transaction as a no-op", () => {
    expect(computeNewBalance(1000, { amount: 0, type: "LODGE" })).toEqual({
      previousBalance: 1000,
      newBalance: 1000,
      clamped: false,
    });
  });
});
