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
 * app's current scale that's cheap. If the collection ever grows
 * past a few thousand docs we can add a `allowanceConfig.frequency`
 * index and query by frequency instead of scanning everything.
 */

import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import { getFirestore, FieldValue, getMessaging } from "../admin";

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

    const childSnap = await db.collection("children").get();
    childrenScanned = childSnap.size;

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

      // Fetch every parent's fcmTokens in parallel.
      const parentSnaps = await Promise.all(
        parentUids.map((uid) => db.doc(`users/${uid}`).get()),
      );
      const allTokens: string[] = [];
      const tokenOwnerByToken = new Map<string, string>();
      for (let i = 0; i < parentSnaps.length; i += 1) {
        const snap = parentSnaps[i];
        if (!snap) continue;
        const uid = parentUids[i];
        if (!uid) continue;
        const tokens = (snap.get("fcmTokens") as string[] | undefined) ?? [];
        for (const tok of tokens) {
          allTokens.push(tok);
          tokenOwnerByToken.set(tok, uid);
        }
      }
      if (allTokens.length === 0) continue;

      const response = await getMessaging().sendEachForMulticast({
        tokens: allTokens,
        notification: {
          title: `${data.name ?? "Your child"} — time for allowance`,
          body: "Tap to review and confirm this week's allowance.",
        },
        data: {
          kind: "HABIT_REMINDER",
          childId: childDoc.id,
        },
      });

      notificationsSent += response.successCount;

      // Reap unregistered tokens so we stop trying to send to stale
      // devices. FCM error codes that indicate a permanent failure:
      //   messaging/registration-token-not-registered
      //   messaging/invalid-registration-token
      const deadTokensByOwner = new Map<string, Set<string>>();
      response.responses.forEach((resp, i) => {
        if (resp.success) return;
        const code = resp.error?.code ?? "";
        if (
          code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token"
        ) {
          const tok = allTokens[i];
          if (!tok) return;
          const owner = tokenOwnerByToken.get(tok);
          if (!owner) return;
          const set = deadTokensByOwner.get(owner) ?? new Set();
          set.add(tok);
          deadTokensByOwner.set(owner, set);
        }
      });
      for (const [uid, deadSet] of deadTokensByOwner.entries()) {
        const dead = Array.from(deadSet);
        await db.doc(`users/${uid}`).update({
          fcmTokens: FieldValue.arrayRemove(...dead),
        });
        tokensCleaned += dead.length;
      }

      // Advance lastGeneratedAt so the next run skips this child.
      await childDoc.ref.update({
        "allowanceConfig.lastGeneratedAt": FieldValue.serverTimestamp(),
      });
    }

    logger.info("[sendHabitNotifications] run complete", {
      childrenScanned,
      childrenMatched,
      notificationsSent,
      tokensCleaned,
    });
  },
);
