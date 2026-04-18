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

const WEEKDAY_MAP: Record<string, 0 | 1 | 2 | 3 | 4 | 5 | 6> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function tzParts(date: Date, tz: string): CivilParts {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const weekday = WEEKDAY_MAP[get("weekday")];
  if (weekday === undefined) {
    throw new Error(`Unexpected weekday from Intl: ${get("weekday")}`);
  }
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
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
      const thisMonthTarget = Math.min(
        schedule.dayOfMonth,
        lastDayOfMonth(p.year, p.month),
      );
      const candidate = tzMidnightUtc(p.year, p.month, thisMonthTarget, tz);
      if (candidate.getTime() > now.getTime()) return candidate;
      let nextY = p.year;
      let nextM = p.month + 1;
      if (nextM > 12) {
        nextM = 1;
        nextY += 1;
      }
      const nextTarget = Math.min(
        schedule.dayOfMonth,
        lastDayOfMonth(nextY, nextM),
      );
      return tzMidnightUtc(nextY, nextM, nextTarget, tz);
    }
  }
}
