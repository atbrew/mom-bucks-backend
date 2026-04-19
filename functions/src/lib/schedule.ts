export type Schedule =
  | { kind: "DAILY" }
  | { kind: "WEEKLY"; dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6 }
  | { kind: "MONTHLY"; dayOfMonth: number };

type CivilParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6;
};

// Intl.DateTimeFormat construction is surprisingly expensive — each
// `new` call spins up an ICU locale object. `tzParts` is called ~3
// times per `nextOccurrence` evaluation (direct + `tzMidnightUtc`'s
// two-shot offset resolve), and `nextOccurrence` itself is called on
// every activity create/update/claim, so we cache formatters by tz.
// The set of timezones is small and stable (one per user, bounded by
// the IANA zone database), so the cache will never grow unbounded.
const TZ_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function getFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = TZ_FORMATTERS.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    TZ_FORMATTERS.set(tz, fmt);
  }
  return fmt;
}

function tzParts(date: Date, tz: string): CivilParts {
  const fmt = getFormatter(tz);
  const parts = fmt.formatToParts(date);
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  const year = Number(p.year);
  const month = Number(p.month);
  const day = Number(p.day);

  // Derive weekday numerically from the civil y/m/d we just extracted
  // rather than parsing the localised "weekday" string. The
  // `Intl.DateTimeFormat` weekday token is locale-sensitive and can
  // vary across ICU versions / Node builds ("Sat" vs "Sab" vs "土");
  // reconstructing a Date.UTC from the civil parts and reading
  // `getUTCDay()` is deterministic regardless of locale.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() as
    | 0
    | 1
    | 2
    | 3
    | 4
    | 5
    | 6;

  return {
    year,
    month,
    day,
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday,
  };
}

function tzOffsetMs(date: Date, tz: string): number {
  const p = tzParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - date.getTime();
}

function tzMidnightUtc(
  year: number,
  month: number,
  day: number,
  tz: string,
): Date {
  const guess = Date.UTC(year, month - 1, day);
  const offset1 = tzOffsetMs(new Date(guess), tz);
  const candidate = new Date(guess - offset1);
  const offset2 = tzOffsetMs(candidate, tz);
  if (offset2 === offset1) return candidate;
  return new Date(guess - offset2);
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addCivilDays(
  year: number,
  month: number,
  day: number,
  n: number,
): { year: number; month: number; day: number } {
  const ts = Date.UTC(year, month - 1, day) + n * 86_400_000;
  const dt = new Date(ts);
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate(),
  };
}

export function nextOccurrence(
  schedule: Schedule,
  now: Date,
  tz: string,
): Date {
  const p = tzParts(now, tz);
  switch (schedule.kind) {
    case "DAILY": {
      const { year, month, day } = addCivilDays(p.year, p.month, p.day, 1);
      return tzMidnightUtc(year, month, day, tz);
    }
    case "WEEKLY": {
      let daysToAdd = (schedule.dayOfWeek - p.weekday + 7) % 7;
      if (daysToAdd === 0) daysToAdd = 7;
      const { year, month, day } = addCivilDays(
        p.year,
        p.month,
        p.day,
        daysToAdd,
      );
      return tzMidnightUtc(year, month, day, tz);
    }
    case "MONTHLY": {
      // Runtime guard: `Schedule.dayOfMonth` is typed as a raw
      // `number` (kept wide so the same type round-trips across the
      // Firestore client, which serialises to `number`). If the
      // persisted value is out-of-range (0, negative, fractional,
      // > 31, NaN), `Date.UTC` silently wraps to the previous month
      // or fractional days — both of which would return a bogus
      // "next occurrence" that the `claimActivity` callable would
      // then stamp onto `nextClaimAt`. Refuse early instead.
      const d = schedule.dayOfMonth;
      if (!Number.isInteger(d) || d < 1 || d > 31) {
        throw new Error(
          `MONTHLY.dayOfMonth must be an integer in 1..31 (got ${d})`,
        );
      }
      const thisMonthTarget = Math.min(d, lastDayOfMonth(p.year, p.month));
      const candidate = tzMidnightUtc(p.year, p.month, thisMonthTarget, tz);
      if (candidate.getTime() > now.getTime()) return candidate;
      let nextY = p.year;
      let nextM = p.month + 1;
      if (nextM > 12) {
        nextM = 1;
        nextY += 1;
      }
      const nextTarget = Math.min(d, lastDayOfMonth(nextY, nextM));
      return tzMidnightUtc(nextY, nextM, nextTarget, tz);
    }
  }
}
