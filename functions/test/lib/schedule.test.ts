import { describe, expect, it } from "vitest";

import { nextOccurrence, type Schedule } from "../../src/lib/schedule";

type Row = {
  label: string;
  schedule: Schedule;
  now: string;
  tz: string;
  expected: string;
};

const DAILY: Schedule = { kind: "DAILY" };
const WEEKLY_SAT: Schedule = { kind: "WEEKLY", dayOfWeek: 6 };
const WEEKLY_FRI: Schedule = { kind: "WEEKLY", dayOfWeek: 5 };
const MONTHLY_1: Schedule = { kind: "MONTHLY", dayOfMonth: 1 };
const MONTHLY_31: Schedule = { kind: "MONTHLY", dayOfMonth: 31 };

const DUBLIN = "Europe/Dublin";
const NY = "America/New_York";

const rows: Row[] = [
  // --- DAILY in Europe/Dublin ---
  {
    label: "DAILY mid-morning Dublin rolls to tomorrow's Dublin midnight",
    schedule: DAILY,
    now: "2026-04-18T09:00:00Z", // Sat 10:00 IST
    tz: DUBLIN,
    expected: "2026-04-18T23:00:00Z", // Sun 2026-04-19 00:00 IST
  },
  {
    label: "DAILY at Dublin civil midnight rolls to the NEXT Dublin midnight",
    schedule: DAILY,
    now: "2026-04-17T23:00:00Z", // Sat 2026-04-18 00:00 IST
    tz: DUBLIN,
    expected: "2026-04-18T23:00:00Z", // Sun 2026-04-19 00:00 IST
  },

  // --- WEEKLY ---
  {
    label: "WEEKLY{Sat} on Saturday morning rolls to NEXT Saturday, not today",
    schedule: WEEKLY_SAT,
    now: "2026-04-18T09:00:00Z", // Sat 10:00 Dublin
    tz: DUBLIN,
    expected: "2026-04-24T23:00:00Z", // Sat 2026-04-25 00:00 Dublin
  },
  {
    label: "WEEKLY{Sat} at Saturday midnight still rolls forward 7 days",
    schedule: WEEKLY_SAT,
    now: "2026-04-17T23:00:00Z", // Sat 2026-04-18 00:00 Dublin
    tz: DUBLIN,
    expected: "2026-04-24T23:00:00Z",
  },
  {
    label: "WEEKLY{Sat} on Friday returns tomorrow's Dublin midnight",
    schedule: WEEKLY_SAT,
    now: "2026-04-24T09:00:00Z", // Fri 10:00 Dublin
    tz: DUBLIN,
    expected: "2026-04-24T23:00:00Z", // Sat 2026-04-25 00:00 Dublin
  },
  {
    label: "WEEKLY{Fri} on Sunday returns the following Friday",
    schedule: WEEKLY_FRI,
    now: "2026-04-19T09:00:00Z", // Sun 10:00 Dublin
    tz: DUBLIN,
    expected: "2026-04-23T23:00:00Z", // Fri 2026-04-24 00:00 Dublin
  },

  // --- MONTHLY ---
  {
    label: "MONTHLY{1} mid-month rolls to the first of next month",
    schedule: MONTHLY_1,
    now: "2026-04-15T09:00:00Z",
    tz: DUBLIN,
    expected: "2026-04-30T23:00:00Z", // 2026-05-01 00:00 Dublin
  },
  {
    label: "MONTHLY{31} in Feb clamps to Feb 28 (non-leap 2026)",
    schedule: MONTHLY_31,
    now: "2026-02-10T09:00:00Z",
    tz: DUBLIN,
    expected: "2026-02-28T00:00:00Z", // Feb 28 midnight GMT
  },
  {
    label: "MONTHLY{31} ON the 31st rolls to next month's clamped end",
    schedule: MONTHLY_31,
    now: "2026-01-31T14:00:00Z", // Jan 31 14:00 Dublin (GMT)
    tz: DUBLIN,
    expected: "2026-02-28T00:00:00Z",
  },
  {
    label: "MONTHLY{31} in Feb 2028 clamps to Feb 29 (leap year)",
    schedule: MONTHLY_31,
    now: "2028-02-10T09:00:00Z",
    tz: DUBLIN,
    expected: "2028-02-29T00:00:00Z",
  },

  // --- DST: Europe/Dublin spring-forward 2026-03-29 (01:00 UTC) ---
  {
    label: "DAILY the day before spring-forward: next midnight is still GMT",
    schedule: DAILY,
    now: "2026-03-28T10:00:00Z", // Sat 10:00 Dublin (GMT)
    tz: DUBLIN,
    expected: "2026-03-29T00:00:00Z", // Sun 2026-03-29 00:00 Dublin (still GMT pre-transition)
  },
  {
    label: "DAILY on spring-forward day rolls to post-transition midnight (BST)",
    schedule: DAILY,
    now: "2026-03-29T12:00:00Z", // Sun 13:00 Dublin (BST, offset=+1 after 01:00 UTC)
    tz: DUBLIN,
    expected: "2026-03-29T23:00:00Z", // Mon 2026-03-30 00:00 Dublin (BST)
  },

  // --- DST: Europe/Dublin fall-back 2026-10-25 (01:00 UTC) ---
  {
    label: "DAILY the day before fall-back: next Dublin midnight is still BST",
    schedule: DAILY,
    now: "2026-10-24T09:00:00Z", // Sat 10:00 Dublin (BST)
    tz: DUBLIN,
    expected: "2026-10-24T23:00:00Z", // Sun 2026-10-25 00:00 Dublin (still BST at midnight)
  },
  {
    label: "DAILY on fall-back day rolls to next GMT-anchored midnight",
    schedule: DAILY,
    now: "2026-10-25T10:00:00Z", // Sun 10:00 Dublin (GMT, post-fall-back)
    tz: DUBLIN,
    expected: "2026-10-26T00:00:00Z", // Mon 2026-10-26 00:00 Dublin (GMT)
  },

  // --- America/New_York ---
  {
    label: "DAILY mid-morning New York rolls to next NY midnight (EDT)",
    schedule: DAILY,
    now: "2026-04-18T14:00:00Z", // 10:00 EDT
    tz: NY,
    expected: "2026-04-19T04:00:00Z", // 2026-04-19 00:00 EDT
  },
  {
    label: "WEEKLY{Sat} from Friday 23:00 New York rolls to Sat midnight NY",
    schedule: WEEKLY_SAT,
    now: "2026-04-18T03:00:00Z", // Fri 23:00 EDT (Apr 17 local)
    tz: NY,
    expected: "2026-04-18T04:00:00Z", // Sat 2026-04-18 00:00 EDT
  },

  // --- Year boundary ---
  {
    label: "WEEKLY{Sat} from Mon 2026-12-28 crosses into 2027",
    schedule: WEEKLY_SAT,
    now: "2026-12-28T10:00:00Z", // Mon 10:00 Dublin (GMT)
    tz: DUBLIN,
    expected: "2027-01-02T00:00:00Z", // Sat 2027-01-02 00:00 Dublin (GMT)
  },
  {
    label: "MONTHLY{1} from mid-December crosses into January",
    schedule: MONTHLY_1,
    now: "2026-12-15T09:00:00Z",
    tz: DUBLIN,
    expected: "2027-01-01T00:00:00Z",
  },
];

describe("nextOccurrence", () => {
  for (const row of rows) {
    it(row.label, () => {
      const actual = nextOccurrence(
        row.schedule,
        new Date(row.now),
        row.tz,
      );
      expect(actual.toISOString()).toBe(
        new Date(row.expected).toISOString(),
      );
    });
  }

  it("always returns a time strictly greater than `now`", () => {
    const now = new Date("2026-04-18T09:00:00Z");
    for (const schedule of [
      DAILY,
      WEEKLY_SAT,
      WEEKLY_FRI,
      MONTHLY_1,
      MONTHLY_31,
    ]) {
      const next = nextOccurrence(schedule, now, DUBLIN);
      expect(next.getTime()).toBeGreaterThan(now.getTime());
    }
  });
});
