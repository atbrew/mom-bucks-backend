import { describe, expect, it } from "vitest";
import {
  buildActivityCreatePush,
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

describe("buildActivityCreatePush", () => {
  const child = { name: "Sam", parentUids: ["fb-alice"] };

  it("fires on a fresh create with reward", () => {
    const payload = buildActivityCreatePush("c-sam", child, {
      title: "Take out the bins",
      reward: 200,
    });
    expect(payload).toEqual({
      kind: "ACTIVITY_CREATED",
      childId: "c-sam",
      title: "Sam unlocked €2.00",
      body: "Take out the bins",
    });
  });

  it("falls back to a generic title when reward is missing", () => {
    const payload = buildActivityCreatePush("c-sam", child, {
      title: "chore",
    });
    expect(payload?.title).toBe("Sam — new activity");
  });

  it("falls back to a generic title when reward is zero", () => {
    const payload = buildActivityCreatePush("c-sam", child, {
      title: "chore",
      reward: 0,
    });
    expect(payload?.title).toBe("Sam — new activity");
  });

  it("falls back to description when title is empty", () => {
    const payload = buildActivityCreatePush("c-sam", child, {
      title: "",
      description: "helping in the garden",
      reward: 100,
    });
    expect(payload?.body).toBe("helping in the garden");
  });

  it("falls back to a generic body when title and description are empty", () => {
    const payload = buildActivityCreatePush("c-sam", child, { reward: 100 });
    expect(payload?.body).toBe("Tap to review.");
  });

  it("falls back to 'your child' when the child doc has no name", () => {
    const payload = buildActivityCreatePush(
      "c-sam",
      { parentUids: [] },
      { title: "chore", reward: 100 },
    );
    expect(payload?.title).toBe("your child unlocked €1.00");
  });

  it("returns null when child is missing", () => {
    expect(
      buildActivityCreatePush("c-sam", null, { title: "chore" }),
    ).toBeNull();
  });

  it("returns null when activity is missing", () => {
    expect(buildActivityCreatePush("c-sam", child, null)).toBeNull();
  });
});
