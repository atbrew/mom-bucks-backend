import { describe, expect, it } from "vitest";
import {
  buildActivityPush,
  buildTransactionPush,
  formatCents,
} from "../../src/handlers/sendChildPush";

describe("formatCents", () => {
  it("formats whole euros", () => {
    expect(formatCents(500)).toBe("€5.00");
  });

  it("formats fractional euros", () => {
    expect(formatCents(1250)).toBe("€12.50");
    expect(formatCents(1205)).toBe("€12.05");
  });

  it("formats zero", () => {
    expect(formatCents(0)).toBe("€0.00");
  });
});

describe("buildTransactionPush", () => {
  const child = { name: "Sam", parentUids: ["fb-alice", "fb-bob"] };

  it("formats a LODGE with the childs name and amount", () => {
    const payload = buildTransactionPush("c-sam", child, {
      amount: 500,
      type: "LODGE",
      description: "washing the dishes",
    });
    expect(payload).toEqual({
      kind: "TRANSACTION",
      childId: "c-sam",
      title: "Sam earned €5.00",
      body: "washing the dishes",
    });
  });

  it("formats a WITHDRAW", () => {
    const payload = buildTransactionPush("c-sam", child, {
      amount: 250,
      type: "WITHDRAW",
      description: "sweets",
    });
    expect(payload).toEqual({
      kind: "TRANSACTION",
      childId: "c-sam",
      title: "Sam spent €2.50",
      body: "sweets",
    });
  });

  it("falls back to a generic body when description is empty", () => {
    const payload = buildTransactionPush("c-sam", child, {
      amount: 500,
      type: "LODGE",
      description: "",
    });
    expect(payload?.body).toBe("A new lodgement was added.");
  });

  it("falls back to 'your child' when the child doc has no name", () => {
    const payload = buildTransactionPush("c-sam", { parentUids: [] }, {
      amount: 500,
      type: "LODGE",
      description: "chore",
    });
    expect(payload?.title).toBe("your child earned €5.00");
  });

  it("returns null when child is missing", () => {
    const payload = buildTransactionPush("c-sam", null, {
      amount: 500,
      type: "LODGE",
    });
    expect(payload).toBeNull();
  });

  it("returns null when the transaction is missing", () => {
    expect(buildTransactionPush("c-sam", child, null)).toBeNull();
  });
});

describe("buildActivityPush", () => {
  const child = { name: "Sam", parentUids: ["fb-alice"] };

  it("fires on a LOCKED → READY transition", () => {
    const payload = buildActivityPush(
      "c-sam",
      child,
      { status: "LOCKED", title: "Take out the bins", reward: 200 },
      { status: "READY", title: "Take out the bins", reward: 200 },
    );
    expect(payload).toEqual({
      kind: "ACTIVITY_READY",
      childId: "c-sam",
      title: "Sam unlocked €2.00",
      body: "Take out the bins",
    });
  });

  it("fires on a fresh create that lands in READY (before === null)", () => {
    const payload = buildActivityPush(
      "c-sam",
      child,
      null,
      { status: "READY", title: "Homework", reward: 100 },
    );
    expect(payload?.kind).toBe("ACTIVITY_READY");
    expect(payload?.title).toBe("Sam unlocked €1.00");
  });

  it("does NOT fire on LOCKED → LOCKED (noop update)", () => {
    const payload = buildActivityPush(
      "c-sam",
      child,
      { status: "LOCKED", title: "chore" },
      { status: "LOCKED", title: "chore" },
    );
    expect(payload).toBeNull();
  });

  it("does NOT fire on READY → READY (second edit of an already-ready activity)", () => {
    const payload = buildActivityPush(
      "c-sam",
      child,
      { status: "READY", title: "chore" },
      { status: "READY", title: "chore (edited)" },
    );
    expect(payload).toBeNull();
  });

  it("does NOT fire on deletion (after === null)", () => {
    const payload = buildActivityPush(
      "c-sam",
      child,
      { status: "READY", title: "chore" },
      null,
    );
    expect(payload).toBeNull();
  });

  it("handles a missing reward gracefully", () => {
    const payload = buildActivityPush(
      "c-sam",
      child,
      { status: "LOCKED", title: "chore" },
      { status: "READY", title: "chore" },
    );
    expect(payload?.title).toBe("Sam — activity ready");
  });
});
