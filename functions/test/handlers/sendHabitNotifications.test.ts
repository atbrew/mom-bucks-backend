import { describe, expect, it } from "vitest";
import {
  shouldNotifyForConfig,
  type AllowanceConfig,
} from "../../src/handlers/sendHabitNotifications";

// Fake Timestamp that satisfies the `.toDate()` shape the scheduling
// decision relies on. Avoids pulling in the real firebase-admin
// Timestamp just to construct a fixture.
function ts(d: Date): { toDate(): Date } {
  return { toDate: () => d };
}

// Wednesday 2026-04-08 at 09:00 UTC.
const NOW = new Date(Date.UTC(2026, 3, 8, 9, 0, 0));
const WEDNESDAY = 3; // getUTCDay() for Wed
const MONDAY = 1;

describe("shouldNotifyForConfig", () => {
  describe("DAILY", () => {
    it("fires when lastGeneratedAt is null", () => {
      const config: AllowanceConfig = {
        amount: 500,
        frequency: "DAILY",
        dayOfWeek: 0,
        lastGeneratedAt: null,
      };
      expect(shouldNotifyForConfig(config, NOW)).toBe(true);
    });

    it("does NOT fire again the same calendar day", () => {
      const earlierToday = new Date(Date.UTC(2026, 3, 8, 3, 0, 0));
      const config: AllowanceConfig = {
        amount: 500,
        frequency: "DAILY",
        dayOfWeek: 0,
        lastGeneratedAt: ts(
          earlierToday,
        ) as unknown as FirebaseFirestore.Timestamp,
      };
      expect(shouldNotifyForConfig(config, NOW)).toBe(false);
    });

    it("fires again the next calendar day", () => {
      const yesterday = new Date(Date.UTC(2026, 3, 7, 23, 0, 0));
      const config: AllowanceConfig = {
        amount: 500,
        frequency: "DAILY",
        dayOfWeek: 0,
        lastGeneratedAt: ts(
          yesterday,
        ) as unknown as FirebaseFirestore.Timestamp,
      };
      expect(shouldNotifyForConfig(config, NOW)).toBe(true);
    });
  });

  describe("WEEKLY", () => {
    it("fires when dayOfWeek matches and never fired before", () => {
      const config: AllowanceConfig = {
        amount: 500,
        frequency: "WEEKLY",
        dayOfWeek: WEDNESDAY,
        lastGeneratedAt: null,
      };
      expect(shouldNotifyForConfig(config, NOW)).toBe(true);
    });

    it("does NOT fire when dayOfWeek doesn't match", () => {
      const config: AllowanceConfig = {
        amount: 500,
        frequency: "WEEKLY",
        dayOfWeek: MONDAY,
        lastGeneratedAt: null,
      };
      expect(shouldNotifyForConfig(config, NOW)).toBe(false);
    });

    it("does NOT double-fire the same day", () => {
      const earlierToday = new Date(Date.UTC(2026, 3, 8, 1, 0, 0));
      const config: AllowanceConfig = {
        amount: 500,
        frequency: "WEEKLY",
        dayOfWeek: WEDNESDAY,
        lastGeneratedAt: ts(
          earlierToday,
        ) as unknown as FirebaseFirestore.Timestamp,
      };
      expect(shouldNotifyForConfig(config, NOW)).toBe(false);
    });

    it("fires again the next matching dayOfWeek", () => {
      const lastWednesday = new Date(Date.UTC(2026, 3, 1, 9, 0, 0));
      const config: AllowanceConfig = {
        amount: 500,
        frequency: "WEEKLY",
        dayOfWeek: WEDNESDAY,
        lastGeneratedAt: ts(
          lastWednesday,
        ) as unknown as FirebaseFirestore.Timestamp,
      };
      expect(shouldNotifyForConfig(config, NOW)).toBe(true);
    });
  });

  describe("FORTNIGHTLY", () => {
    it("requires 14 days since lastGeneratedAt", () => {
      // Last fired 14 days ago exactly — should fire.
      const fourteenDaysAgo = new Date(Date.UTC(2026, 2, 25, 9, 0, 0));
      const config: AllowanceConfig = {
        amount: 500,
        frequency: "FORTNIGHTLY",
        dayOfWeek: WEDNESDAY,
        lastGeneratedAt: ts(
          fourteenDaysAgo,
        ) as unknown as FirebaseFirestore.Timestamp,
      };
      expect(shouldNotifyForConfig(config, NOW)).toBe(true);
    });

    it("does NOT fire before 14 days have elapsed", () => {
      // Last fired 7 days ago (last Wed) — too soon.
      const sevenDaysAgo = new Date(Date.UTC(2026, 3, 1, 9, 0, 0));
      const config: AllowanceConfig = {
        amount: 500,
        frequency: "FORTNIGHTLY",
        dayOfWeek: WEDNESDAY,
        lastGeneratedAt: ts(
          sevenDaysAgo,
        ) as unknown as FirebaseFirestore.Timestamp,
      };
      expect(shouldNotifyForConfig(config, NOW)).toBe(false);
    });

    it("fires on first run when lastGeneratedAt is null and the day matches", () => {
      const config: AllowanceConfig = {
        amount: 500,
        frequency: "FORTNIGHTLY",
        dayOfWeek: WEDNESDAY,
        lastGeneratedAt: null,
      };
      expect(shouldNotifyForConfig(config, NOW)).toBe(true);
    });

    it("does NOT fire when dayOfWeek doesn't match even with no last-fired", () => {
      const config: AllowanceConfig = {
        amount: 500,
        frequency: "FORTNIGHTLY",
        dayOfWeek: MONDAY,
        lastGeneratedAt: null,
      };
      expect(shouldNotifyForConfig(config, NOW)).toBe(false);
    });
  });

  describe("MONTHLY", () => {
    it("fires on the configured day of month", () => {
      const config: AllowanceConfig = {
        amount: 500,
        frequency: "MONTHLY",
        dayOfWeek: 8, // "day 8 of the month" for MONTHLY cadence
        lastGeneratedAt: null,
      };
      expect(shouldNotifyForConfig(config, NOW)).toBe(true);
    });

    it("does NOT fire on other days of month", () => {
      const config: AllowanceConfig = {
        amount: 500,
        frequency: "MONTHLY",
        dayOfWeek: 15,
        lastGeneratedAt: null,
      };
      expect(shouldNotifyForConfig(config, NOW)).toBe(false);
    });

    it("does NOT double-fire the same day", () => {
      const earlierToday = new Date(Date.UTC(2026, 3, 8, 4, 0, 0));
      const config: AllowanceConfig = {
        amount: 500,
        frequency: "MONTHLY",
        dayOfWeek: 8,
        lastGeneratedAt: ts(
          earlierToday,
        ) as unknown as FirebaseFirestore.Timestamp,
      };
      expect(shouldNotifyForConfig(config, NOW)).toBe(false);
    });

    it("fires again next month", () => {
      const lastMonth = new Date(Date.UTC(2026, 2, 8, 9, 0, 0));
      const config: AllowanceConfig = {
        amount: 500,
        frequency: "MONTHLY",
        dayOfWeek: 8,
        lastGeneratedAt: ts(
          lastMonth,
        ) as unknown as FirebaseFirestore.Timestamp,
      };
      expect(shouldNotifyForConfig(config, NOW)).toBe(true);
    });
  });
});
