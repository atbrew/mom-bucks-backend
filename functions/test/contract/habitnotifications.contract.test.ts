/**
 * Habit notifications parity — Phase 5 contract tests.
 *
 * Unlike the other contract suites (children, transactions,
 * activities, invites, co-parenting), this one is a **pure-function
 * comparison** rather than a two-backend integration test. Flask's
 * scheduling decision logic (`_cadence_matches` + `NotificationLog`
 * cooldown) is internal to the Python service and not exposed via
 * API. We port it to TypeScript as a reference implementation and
 * run both decision functions against a shared grid of inputs.
 *
 * Scope (docs/firebase-migration-plan.md:399):
 *   assert `shouldNotifyForConfig` agrees with Flask's APScheduler
 *   cadence evaluator for DAILY / WEEKLY / FORTNIGHTLY / MONTHLY.
 *
 * ---
 *
 * Asymmetries worth calling out:
 *
 * - **Day-of-week encoding.** Firebase uses JS `getUTCDay()`
 *   (Sunday = 0, Saturday = 6). Flask uses Python `weekday()`
 *   (Monday = 0, Sunday = 6). The reference implementation
 *   converts between them so both functions receive the correct
 *   encoding for the same wall-clock day.
 *
 * - **Cooldown mechanism.** Firebase combines cadence matching and
 *   cooldown in `shouldNotifyForConfig` via `lastGeneratedAt` +
 *   `sameCalendarDay`. Flask splits them: `_cadence_matches` is
 *   pure cadence, `NotificationLog` handles cooldown with
 *   time-based windows (DAILY: 20h, WEEKLY: 6d, FORTNIGHTLY: 13d,
 *   MONTHLY: 27d). Both prevent double-firing; the test models
 *   Flask's full decision (cadence + cooldown) for a fair
 *   comparison.
 *
 * - **FORTNIGHTLY anchor.** Firebase uses elapsed days from
 *   `lastGeneratedAt` (>= 14 days). Flask anchors to
 *   `config.created_at` and fires on even-numbered weeks from that
 *   anchor. Under normal operation these agree, but after a missed
 *   cycle they can permanently diverge (documented in the
 *   divergence test below).
 *
 * - **9 AM local-time gate.** Flask only evaluates cadence when the
 *   parent's local time is 9 AM; Firebase's scheduled function has
 *   no time-of-day gate (it runs hourly from Cloud Scheduler). This
 *   is a deployment-level difference, not a cadence-logic
 *   difference, so the test ignores it.
 */

import { describe, expect, it } from "vitest";
import {
  shouldNotifyForConfig,
  type AllowanceConfig,
} from "../../src/handlers/sendHabitNotifications";

// ─── Day-of-week conversion ────────────────────────────────────────

/**
 * Convert a JS day-of-week (Sunday = 0) to Python weekday
 * (Monday = 0). Used to feed the Flask reference the same
 * wall-clock day the Firebase function sees.
 *
 *   JS 0 (Sun) → Python 6
 *   JS 1 (Mon) → Python 0
 *   JS 3 (Wed) → Python 2
 */
function jsDayToPythonWeekday(jsDay: number): number {
  return (jsDay + 6) % 7;
}

// ─── Flask reference implementation ────────────────────────────────
//
// Ported from:
//   web-app/src/mombucks/services/notifications.py
//     _cadence_matches()     — lines 174-195
//     _COOLDOWNS             — lines 21-26
//     cooldown check         — lines 138-152
//
// The reference models the full Flask decision: cadence match AND
// cooldown not active. This makes it comparable to Firebase's
// `shouldNotifyForConfig`, which also combines both concerns.

type FlaskFrequency = "DAILY" | "WEEKLY" | "FORTNIGHTLY" | "MONTHLY";

/** Flask's `_COOLDOWNS` dict, in milliseconds. */
const FLASK_COOLDOWNS: Record<FlaskFrequency, number> = {
  DAILY: 20 * 60 * 60 * 1000,       // 20 hours
  WEEKLY: 6 * 24 * 60 * 60 * 1000,  // 6 days
  FORTNIGHTLY: 13 * 24 * 60 * 60 * 1000, // 13 days
  MONTHLY: 27 * 24 * 60 * 60 * 1000, // 27 days
};

/**
 * Port of Flask's `_cadence_matches(frequency, allowance_day,
 * local_time, config_created_at)`.
 *
 * `allowanceDay` uses Python's Monday = 0 encoding for
 * WEEKLY/FORTNIGHTLY, and day-of-month (1..31) for MONTHLY.
 */
function flaskCadenceMatches(
  frequency: FlaskFrequency,
  allowanceDay: number,
  now: Date,
  configCreatedAt: Date | null,
): boolean {
  const weekday = jsDayToPythonWeekday(now.getUTCDay());

  switch (frequency) {
    case "DAILY":
      return true;

    case "WEEKLY":
      return weekday === allowanceDay;

    case "FORTNIGHTLY": {
      if (weekday !== allowanceDay) return false;
      if (!configCreatedAt) return true;
      const daysSinceAnchor = Math.floor(
        (now.getTime() - configCreatedAt.getTime()) / (24 * 60 * 60 * 1000),
      );
      const weeksSince = Math.floor(daysSinceAnchor / 7);
      return weeksSince % 2 === 0;
    }

    case "MONTHLY":
      return now.getUTCDate() === allowanceDay;

    default:
      return false;
  }
}

/**
 * Flask's full notification decision: cadence matches AND no
 * recent notification within the cooldown window.
 *
 * `lastNotifiedAt` is the most recent `NotificationLog.sent_at`
 * for this child with type `HABIT_REMINDER`. Null means "never
 * notified."
 */
function flaskShouldNotify(input: {
  frequency: FlaskFrequency;
  allowanceDay: number;
  now: Date;
  lastNotifiedAt: Date | null;
  configCreatedAt: Date | null;
}): boolean {
  if (!flaskCadenceMatches(
    input.frequency, input.allowanceDay, input.now, input.configCreatedAt,
  )) {
    return false;
  }
  if (input.lastNotifiedAt) {
    const cooldown = FLASK_COOLDOWNS[input.frequency];
    if (input.now.getTime() - input.lastNotifiedAt.getTime() < cooldown) {
      return false;
    }
  }
  return true;
}

// ─── Firebase helper ───────────────────────────────────────────────

/** Fake Timestamp matching the `.toDate()` shape. */
function ts(d: Date): { toDate(): Date } {
  return { toDate: () => d };
}

/**
 * Wrap `shouldNotifyForConfig` with friendlier inputs.
 * `dayOfWeek` uses JS encoding (Sunday = 0) for WEEKLY/FORTNIGHTLY,
 * and day-of-month (1..31) for MONTHLY.
 */
function firebaseShouldNotify(input: {
  frequency: "DAILY" | "WEEKLY" | "FORTNIGHTLY" | "MONTHLY";
  dayOfWeek: number;
  now: Date;
  lastGeneratedAt: Date | null;
}): boolean {
  const config: AllowanceConfig = {
    amount: 500,
    frequency: input.frequency,
    dayOfWeek: input.dayOfWeek,
    lastGeneratedAt: input.lastGeneratedAt
      ? (ts(input.lastGeneratedAt) as unknown as FirebaseFirestore.Timestamp)
      : null,
  };
  return shouldNotifyForConfig(config, input.now);
}

// ─── Test anchor ───────────────────────────────────────────────────

// Wednesday 2026-04-08 09:00 UTC.
const NOW = new Date(Date.UTC(2026, 3, 8, 9, 0, 0));
const JS_WEDNESDAY = 3;    // getUTCDay()
const PY_WEDNESDAY = 2;    // weekday()
const JS_MONDAY = 1;
const PY_MONDAY = 0;

// ─── Tests ─────────────────────────────────────────────────────────

describe("habit notifications parity — Firebase shouldNotifyForConfig vs Flask _cadence_matches", () => {
  // ──────────────────────────────────────────────────────────────
  // DAILY
  // ──────────────────────────────────────────────────────────────
  describe("DAILY", () => {
    it("both fire when never notified before", () => {
      const firebase = firebaseShouldNotify({
        frequency: "DAILY",
        dayOfWeek: 0, // ignored for DAILY
        now: NOW,
        lastGeneratedAt: null,
      });
      const flask = flaskShouldNotify({
        frequency: "DAILY",
        allowanceDay: 0,
        now: NOW,
        lastNotifiedAt: null,
        configCreatedAt: null,
      });
      expect(firebase, "Firebase: DAILY first fire").toBe(true);
      expect(flask, "Flask: DAILY first fire").toBe(true);
    });

    it("both suppress when already fired today", () => {
      const earlierToday = new Date(Date.UTC(2026, 3, 8, 3, 0, 0));
      const firebase = firebaseShouldNotify({
        frequency: "DAILY",
        dayOfWeek: 0,
        now: NOW,
        lastGeneratedAt: earlierToday,
      });
      const flask = flaskShouldNotify({
        frequency: "DAILY",
        allowanceDay: 0,
        now: NOW,
        lastNotifiedAt: earlierToday,
        configCreatedAt: null,
      });
      expect(firebase, "Firebase: DAILY same-day suppression").toBe(false);
      expect(flask, "Flask: DAILY same-day suppression").toBe(false);
    });

    it("both fire on the next calendar day", () => {
      const yesterday = new Date(Date.UTC(2026, 3, 7, 9, 0, 0));
      const firebase = firebaseShouldNotify({
        frequency: "DAILY",
        dayOfWeek: 0,
        now: NOW,
        lastGeneratedAt: yesterday,
      });
      const flask = flaskShouldNotify({
        frequency: "DAILY",
        allowanceDay: 0,
        now: NOW,
        lastNotifiedAt: yesterday,
        configCreatedAt: null,
      });
      expect(firebase, "Firebase: DAILY next-day fire").toBe(true);
      expect(flask, "Flask: DAILY next-day fire").toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // WEEKLY
  // ──────────────────────────────────────────────────────────────
  describe("WEEKLY", () => {
    it("both fire when day matches and never notified", () => {
      const firebase = firebaseShouldNotify({
        frequency: "WEEKLY",
        dayOfWeek: JS_WEDNESDAY,
        now: NOW,
        lastGeneratedAt: null,
      });
      const flask = flaskShouldNotify({
        frequency: "WEEKLY",
        allowanceDay: PY_WEDNESDAY,
        now: NOW,
        lastNotifiedAt: null,
        configCreatedAt: null,
      });
      expect(firebase, "Firebase: WEEKLY day match").toBe(true);
      expect(flask, "Flask: WEEKLY day match").toBe(true);
    });

    it("both suppress when day does not match", () => {
      const firebase = firebaseShouldNotify({
        frequency: "WEEKLY",
        dayOfWeek: JS_MONDAY,
        now: NOW,
        lastGeneratedAt: null,
      });
      const flask = flaskShouldNotify({
        frequency: "WEEKLY",
        allowanceDay: PY_MONDAY,
        now: NOW,
        lastNotifiedAt: null,
        configCreatedAt: null,
      });
      expect(firebase, "Firebase: WEEKLY day mismatch").toBe(false);
      expect(flask, "Flask: WEEKLY day mismatch").toBe(false);
    });

    it("both suppress when same day but already fired", () => {
      const earlierToday = new Date(Date.UTC(2026, 3, 8, 1, 0, 0));
      const firebase = firebaseShouldNotify({
        frequency: "WEEKLY",
        dayOfWeek: JS_WEDNESDAY,
        now: NOW,
        lastGeneratedAt: earlierToday,
      });
      const flask = flaskShouldNotify({
        frequency: "WEEKLY",
        allowanceDay: PY_WEDNESDAY,
        now: NOW,
        lastNotifiedAt: earlierToday,
        configCreatedAt: null,
      });
      expect(firebase, "Firebase: WEEKLY same-day suppression").toBe(false);
      expect(flask, "Flask: WEEKLY same-day suppression").toBe(false);
    });

    it("both fire on the next matching weekday", () => {
      const lastWednesday = new Date(Date.UTC(2026, 3, 1, 9, 0, 0));
      const firebase = firebaseShouldNotify({
        frequency: "WEEKLY",
        dayOfWeek: JS_WEDNESDAY,
        now: NOW,
        lastGeneratedAt: lastWednesday,
      });
      const flask = flaskShouldNotify({
        frequency: "WEEKLY",
        allowanceDay: PY_WEDNESDAY,
        now: NOW,
        lastNotifiedAt: lastWednesday,
        configCreatedAt: null,
      });
      expect(firebase, "Firebase: WEEKLY next-week fire").toBe(true);
      expect(flask, "Flask: WEEKLY next-week fire").toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // MONTHLY
  // ──────────────────────────────────────────────────────────────
  describe("MONTHLY", () => {
    it("both fire when day-of-month matches and never notified", () => {
      // NOW is the 8th → dayOfWeek = 8 for both backends.
      const firebase = firebaseShouldNotify({
        frequency: "MONTHLY",
        dayOfWeek: 8,
        now: NOW,
        lastGeneratedAt: null,
      });
      const flask = flaskShouldNotify({
        frequency: "MONTHLY",
        allowanceDay: 8,
        now: NOW,
        lastNotifiedAt: null,
        configCreatedAt: null,
      });
      expect(firebase, "Firebase: MONTHLY day match").toBe(true);
      expect(flask, "Flask: MONTHLY day match").toBe(true);
    });

    it("both suppress when day-of-month does not match", () => {
      const firebase = firebaseShouldNotify({
        frequency: "MONTHLY",
        dayOfWeek: 15,
        now: NOW,
        lastGeneratedAt: null,
      });
      const flask = flaskShouldNotify({
        frequency: "MONTHLY",
        allowanceDay: 15,
        now: NOW,
        lastNotifiedAt: null,
        configCreatedAt: null,
      });
      expect(firebase, "Firebase: MONTHLY day mismatch").toBe(false);
      expect(flask, "Flask: MONTHLY day mismatch").toBe(false);
    });

    it("both suppress when same day-of-month but already fired", () => {
      const earlierToday = new Date(Date.UTC(2026, 3, 8, 4, 0, 0));
      const firebase = firebaseShouldNotify({
        frequency: "MONTHLY",
        dayOfWeek: 8,
        now: NOW,
        lastGeneratedAt: earlierToday,
      });
      const flask = flaskShouldNotify({
        frequency: "MONTHLY",
        allowanceDay: 8,
        now: NOW,
        lastNotifiedAt: earlierToday,
        configCreatedAt: null,
      });
      expect(firebase, "Firebase: MONTHLY same-day suppression").toBe(false);
      expect(flask, "Flask: MONTHLY same-day suppression").toBe(false);
    });

    it("both fire again next month", () => {
      const lastMonth = new Date(Date.UTC(2026, 2, 8, 9, 0, 0));
      const firebase = firebaseShouldNotify({
        frequency: "MONTHLY",
        dayOfWeek: 8,
        now: NOW,
        lastGeneratedAt: lastMonth,
      });
      const flask = flaskShouldNotify({
        frequency: "MONTHLY",
        allowanceDay: 8,
        now: NOW,
        lastNotifiedAt: lastMonth,
        configCreatedAt: null,
      });
      expect(firebase, "Firebase: MONTHLY next-month fire").toBe(true);
      expect(flask, "Flask: MONTHLY next-month fire").toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // FORTNIGHTLY — normal operation (both agree)
  // ──────────────────────────────────────────────────────────────
  describe("FORTNIGHTLY — normal operation", () => {
    // Anchor: config created on Wednesday 2026-03-25 (14 days before NOW).
    const configCreatedAt = new Date(Date.UTC(2026, 2, 25, 9, 0, 0));

    it("both fire on the matching day when 14+ days have elapsed", () => {
      const firebase = firebaseShouldNotify({
        frequency: "FORTNIGHTLY",
        dayOfWeek: JS_WEDNESDAY,
        now: NOW,
        lastGeneratedAt: configCreatedAt,
      });
      const flask = flaskShouldNotify({
        frequency: "FORTNIGHTLY",
        allowanceDay: PY_WEDNESDAY,
        now: NOW,
        lastNotifiedAt: configCreatedAt,
        configCreatedAt,
      });
      expect(firebase, "Firebase: FORTNIGHTLY 14-day fire").toBe(true);
      expect(flask, "Flask: FORTNIGHTLY 14-day fire").toBe(true);
    });

    it("both suppress before 14 days have elapsed", () => {
      // Last fired 7 days ago (last Wednesday).
      const sevenDaysAgo = new Date(Date.UTC(2026, 3, 1, 9, 0, 0));
      const firebase = firebaseShouldNotify({
        frequency: "FORTNIGHTLY",
        dayOfWeek: JS_WEDNESDAY,
        now: NOW,
        lastGeneratedAt: sevenDaysAgo,
      });
      // Flask: weeks_since = (8 Apr - 25 Mar) / 7 = 14/7 = 2, 2%2=0 → cadence matches,
      // but cooldown is 13 days and only 7 days elapsed → suppressed.
      const flask = flaskShouldNotify({
        frequency: "FORTNIGHTLY",
        allowanceDay: PY_WEDNESDAY,
        now: NOW,
        lastNotifiedAt: sevenDaysAgo,
        configCreatedAt,
      });
      expect(firebase, "Firebase: FORTNIGHTLY 7-day suppression").toBe(false);
      expect(flask, "Flask: FORTNIGHTLY 7-day suppression").toBe(false);
    });

    it("both fire on first run (never notified)", () => {
      const firebase = firebaseShouldNotify({
        frequency: "FORTNIGHTLY",
        dayOfWeek: JS_WEDNESDAY,
        now: NOW,
        lastGeneratedAt: null,
      });
      const flask = flaskShouldNotify({
        frequency: "FORTNIGHTLY",
        allowanceDay: PY_WEDNESDAY,
        now: NOW,
        lastNotifiedAt: null,
        configCreatedAt,
      });
      expect(firebase, "Firebase: FORTNIGHTLY first fire").toBe(true);
      expect(flask, "Flask: FORTNIGHTLY first fire").toBe(true);
    });

    it("both suppress when day does not match", () => {
      const firebase = firebaseShouldNotify({
        frequency: "FORTNIGHTLY",
        dayOfWeek: JS_MONDAY,
        now: NOW,
        lastGeneratedAt: null,
      });
      const flask = flaskShouldNotify({
        frequency: "FORTNIGHTLY",
        allowanceDay: PY_MONDAY,
        now: NOW,
        lastNotifiedAt: null,
        configCreatedAt,
      });
      expect(firebase, "Firebase: FORTNIGHTLY day mismatch").toBe(false);
      expect(flask, "Flask: FORTNIGHTLY day mismatch").toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // FORTNIGHTLY — missed-cycle divergence (documented)
  //
  // When a cycle is missed, the two backends diverge because they
  // anchor differently:
  //   - Firebase: elapsed days from lastGeneratedAt (re-anchors on
  //     every fire)
  //   - Flask: weeks since config_created_at (fixed anchor, fires
  //     on even-numbered weeks)
  //
  // After a missed even-week cycle, Firebase fires on the next
  // matching weekday (odd week from Flask's perspective) because
  // 14+ days have elapsed. Flask skips it because it's an odd week.
  //
  // This is a known divergence. Firebase's approach is arguably
  // more user-friendly (always fire 14 days after the last fire)
  // while Flask's is more predictable (always fire on the same
  // biweekly cadence). Neither is wrong — the test documents the
  // difference.
  // ──────────────────────────────────────────────────────────────
  describe("FORTNIGHTLY — missed-cycle divergence", () => {
    it("Firebase fires after a missed cycle; Flask skips (odd week from anchor)", () => {
      // Config created Wed 2026-03-11 (week 0 from anchor).
      const configCreatedAt = new Date(Date.UTC(2026, 2, 11, 9, 0, 0));

      // Normal fire on Wed 2026-03-11 (week 0, even → cadence matches).
      // System misses Wed 2026-03-25 (week 2, even → would have fired).
      // Now it's Wed 2026-04-08 (week 4, even from anchor).
      //
      // But lastGeneratedAt is still 2026-03-11 (28 days ago).
      // Firebase: 28 >= 14 → fire ✓
      // Flask: weeks_since = 4, 4%2 = 0 → cadence matches, but let's
      //   check cooldown: 28 days > 13 day cooldown → fire ✓
      //
      // Actually both agree here. The divergence happens on an ODD
      // week. Let's use Wed 2026-04-01 (week 3 from anchor).
      const oddWeekNow = new Date(Date.UTC(2026, 3, 1, 9, 0, 0));

      // lastGeneratedAt = 2026-03-11 (21 days ago).
      const lastFire = configCreatedAt;

      const firebase = firebaseShouldNotify({
        frequency: "FORTNIGHTLY",
        dayOfWeek: JS_WEDNESDAY,
        now: oddWeekNow,
        lastGeneratedAt: lastFire,
      });
      const flask = flaskShouldNotify({
        frequency: "FORTNIGHTLY",
        allowanceDay: PY_WEDNESDAY,
        now: oddWeekNow,
        lastNotifiedAt: lastFire,
        configCreatedAt,
      });

      // Firebase re-anchors: 21 days >= 14 → fire.
      expect(firebase, "Firebase fires (21 days since last fire >= 14)").toBe(true);
      // Flask is anchored to creation: week 3, 3%2 = 1 (odd) → cadence
      // does NOT match, so it won't fire regardless of cooldown.
      expect(flask, "Flask skips (odd week from anchor)").toBe(false);
    });
  });
});
