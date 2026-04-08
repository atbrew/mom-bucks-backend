/**
 * sendHabitNotifications — Phase 4, issue #17.
 *
 * Scheduled function (Cloud Scheduler-backed) that replaces the
 * Flask-side APScheduler hourly habit notification job. Runs
 * hourly; for each child whose `allowanceConfig` matches the
 * current wall-clock window, fan out an FCM multicast to every
 * parent in `parentUids`.
 *
 * Why this is the load-bearing Phase 4 function: it's the reason
 * Phase 5 can tear down the long-running Flask container. As long
 * as the client depends on APScheduler for habit reminders, Flask
 * has to stay up; migrating to Cloud Scheduler + Functions closes
 * that dependency.
 *
 * Structure:
 *   - `shouldNotifyForConfig(config, now)` — pure, returns true if
 *     the allowance cadence + day-of-week matches the current window.
 *     Unit-tested.
 *   - `sendHabitNotifications` — the scheduled wrapper that scans
 *     the `children` collection, filters by `shouldNotifyForConfig`,
 *     then issues FCM multicasts via the shared Admin helper.
 *
 * Cost note: the scan is a full `children` read each hour. At the
 * app's current scale that's cheap, but we iterate with a cursor
 * loop (`limit(BATCH_SIZE) + startAfter(lastDoc)`) rather than
 * loading the whole collection into memory, so the function stays
 * bounded in memory use as the collection grows. If we ever need to
 * trim cost further, the escape hatch is to add an
 * `allowanceConfig.frequency` index and query by frequency.
 */

import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import { getFirestore, FieldValue, FieldPath } from "../admin";
import { fanOutToParents } from "./fanOutToParents";

// ─── Types ──────────────────────────────────────────────────────────

export interface AllowanceConfig {
  amount: number; // integer cents
  frequency: "DAILY" | "WEEKLY" | "FORTNIGHTLY" | "MONTHLY";
  /**
   * For WEEKLY/FORTNIGHTLY: day of week (0 = Sunday, 6 = Saturday).
   * For MONTHLY: day of month (1..31).
   * For DAILY: ignored.
   */
  dayOfWeek: number;
  lastGeneratedAt: FirebaseFirestore.Timestamp | null;
}

export interface ChildSnapshotLite {
  id: string;
  name: string;
  parentUids: string[];
  allowanceConfig: AllowanceConfig | null;
}

export interface UserSnapshotLite {
  uid: string;
  fcmTokens: string[];
}

// ─── Pure scheduling decision ───────────────────────────────────────

/**
 * Decide whether a child's allowanceConfig should trigger a
 * notification at the given `now`. Runs inside the scheduled handler
 * once per child, so we keep it cheap and side-effect-free.
 *
 * The rules are intentionally simple: we compare the configured
 * cadence / day against `now` and also consult `lastGeneratedAt`
 * to avoid double-firing within a cadence window.
 *
 *   DAILY       → once per calendar day
 *   WEEKLY      → once per calendar week, on `dayOfWeek`
 *   FORTNIGHTLY → once every 14 days, on `dayOfWeek` (anchored to the
 *                 ISO week; simpler to reason about than anchoring
 *                 against a per-child start date which we don't have)
 *   MONTHLY     → once per calendar month, on `dayOfWeek` interpreted
 *                 as day-of-month (1..31)
 *
 * `lastGeneratedAt === null` means "never fired," which always
 * qualifies if the current wall-clock matches the cadence. Once fired
 * we set `lastGeneratedAt` in the calling handler to the invocation
 * time so the next scan skips the same window.
 */
export function shouldNotifyForConfig(
  config: AllowanceConfig,
  now: Date,
): boolean {
  const last = config.lastGeneratedAt?.toDate?.() ?? null;

  switch (config.frequency) {
    case "DAILY":
      // Fire at most once per calendar day.
      return !last || !sameCalendarDay(last, now);

    case "WEEKLY":
      if (now.getUTCDay() !== config.dayOfWeek) return false;
      return !last || !sameCalendarDay(last, now);

    case "FORTNIGHTLY": {
      if (now.getUTCDay() !== config.dayOfWeek) return false;
      if (!last) return true;
      if (sameCalendarDay(last, now)) return false;
      const daysSince = Math.floor(
        (now.getTime() - last.getTime()) / (24 * 60 * 60 * 1000),
      );
      return daysSince >= 14;
    }

    case "MONTHLY":
      // Interpret dayOfWeek as day-of-month in the MONTHLY case.
      if (now.getUTCDate() !== config.dayOfWeek) return false;
      return !last || !sameCalendarDay(last, now);

    default:
      return false;
  }
}

function sameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

// ─── Scheduled handler ──────────────────────────────────────────────

/**
 * Cursor page size. 500 is comfortably under Firestore's per-query
 * limits and keeps the in-memory footprint bounded: each child doc
 * is tiny, so 500 docs at once is well under a MB of heap.
 */
const CHILDREN_BATCH_SIZE = 500;

export const sendHabitNotifications = onSchedule(
  {
    schedule: "every 1 hours",
    region: "us-central1",
    timeZone: "Europe/Dublin",
  },
  async () => {
    const db = getFirestore();
    const now = new Date();

    let childrenScanned = 0;
    let childrenMatched = 0;
    let notificationsSent = 0;
    let tokensCleaned = 0;

    // Cursor-paginated scan of the `children` collection. A single
    // `.get()` would load every child into memory at once; instead we
    // page through in chunks of CHILDREN_BATCH_SIZE using `startAfter`
    // so memory stays bounded regardless of how many children exist.
    // The query is ordered by document id so the cursor is stable.
    let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    for (;;) {
      let query = db
        .collection("children")
        .orderBy(FieldPath.documentId())
        .limit(CHILDREN_BATCH_SIZE);
      if (lastDoc) query = query.startAfter(lastDoc);

      const childSnap = await query.get();
      if (childSnap.empty) break;
      childrenScanned += childSnap.size;

      for (const childDoc of childSnap.docs) {
        const data = childDoc.data() as {
          name?: string;
          parentUids?: string[];
          allowanceConfig?: AllowanceConfig | null;
        };
        const config = data.allowanceConfig;
        if (!config) continue;
        if (!shouldNotifyForConfig(config, now)) continue;

        childrenMatched += 1;

        const parentUids = data.parentUids ?? [];
        if (parentUids.length === 0) continue;

        const result = await fanOutToParents(db, parentUids, {
          kind: "HABIT_REMINDER",
          childId: childDoc.id,
          title: `${data.name ?? "Your child"} — time for allowance`,
          body: "Tap to review and confirm this week's allowance.",
        });
        notificationsSent += result.notificationsSent;
        tokensCleaned += result.tokensCleaned;

        // Advance lastGeneratedAt so the next run skips this child.
        await childDoc.ref.update({
          "allowanceConfig.lastGeneratedAt": FieldValue.serverTimestamp(),
        });
      }

      if (childSnap.size < CHILDREN_BATCH_SIZE) break;
      lastDoc = childSnap.docs[childSnap.docs.length - 1] ?? null;
      if (!lastDoc) break;
    }

    logger.info("[sendHabitNotifications] run complete", {
      childrenScanned,
      childrenMatched,
      notificationsSent,
      tokensCleaned,
    });
  },
);
