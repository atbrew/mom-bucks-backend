/**
 * claimActivity — callable, slice 4 of the activities refresh.
 *
 * Claims the reward for an activity, atomically writing an EARN
 * transaction, advancing `nextClaimAt` to the next occurrence, setting
 * `lastClaimedAt`, and bumping the child's main balance. All in one
 * Firestore transaction — the balance move and ledger row cannot
 * diverge.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { getFirestore, FieldValue, Timestamp } from "../admin";
import {
  nextOccurrence,
  parseSchedule,
  resolveTimezone,
  type Schedule,
} from "../lib/schedule";

// ─── Types ──────────────────────────────────────────────────────────

export interface ClaimActivityRequest {
  childId: string;
  activityId: string;
}

export interface ClaimActivityResponse {
  txnId: string;
  amount: number;
  newBalance: number;
  nextClaimAt: string;
}

interface ChildDoc {
  parentUids: string[];
  balance?: number;
}

interface ActivityDoc {
  title: string;
  reward: number;
  type: "ALLOWANCE" | "CHORE";
  schedule: Schedule;
  nextClaimAt?: FirebaseFirestore.Timestamp;
}

export type ClaimActivityDecision =
  | {
      kind: "accept";
      title: string;
      reward: number;
      schedule: Schedule;
      previousBalance: number;
    }
  | { kind: "reject"; code: HttpsError["code"]; message: string };

// ─── Pure decision logic ────────────────────────────────────────────

export function decideClaimActivity(params: {
  callerUid: string;
  child: ChildDoc | null | undefined;
  activity: ActivityDoc | null | undefined;
  nowMs: number;
}): ClaimActivityDecision {
  const { callerUid, child, activity, nowMs } = params;

  if (!child) {
    return { kind: "reject", code: "not-found", message: "child does not exist" };
  }
  if (!child.parentUids?.includes(callerUid)) {
    return {
      kind: "reject",
      code: "permission-denied",
      message: "caller is not a parent of this child",
    };
  }
  if (!activity) {
    return { kind: "reject", code: "not-found", message: "activity does not exist" };
  }

  const nextClaimMs = activity.nextClaimAt?.toMillis?.();
  if (typeof nextClaimMs !== "number") {
    return {
      kind: "reject",
      code: "failed-precondition",
      message: "activity has no nextClaimAt",
    };
  }
  if (nextClaimMs > nowMs) {
    return {
      kind: "reject",
      code: "failed-precondition",
      message: "activity is not yet claimable",
    };
  }

  if (
    typeof activity.reward !== "number" ||
    !Number.isInteger(activity.reward) ||
    activity.reward < 0
  ) {
    return {
      kind: "reject",
      code: "failed-precondition",
      message: `invalid activity reward: ${activity.reward}`,
    };
  }

  // Runtime validation of the schedule + title. Rules deny direct
  // writes to activities, so in normal operation these fields are
  // callable-owned and well-formed. But the Admin-SDK backfill or
  // a migration bug could still plant a doc with a bogus schedule
  // (missing `kind`, wrong map shape) or a non-string title — and
  // feeding a malformed schedule into `nextOccurrence` below would
  // crash the entire transaction with an opaque error. Parse once
  // here and surface a clear `failed-precondition` so the parent
  // gets a legible rejection.
  if (typeof activity.title !== "string" || activity.title.length === 0) {
    return {
      kind: "reject",
      code: "failed-precondition",
      message: "activity has a missing or invalid title",
    };
  }
  const parsed = parseSchedule(activity.schedule);
  if (!parsed.ok) {
    return {
      kind: "reject",
      code: "failed-precondition",
      message: `activity has an invalid schedule: ${parsed.reason}`,
    };
  }

  const previousBalance = Number(child.balance ?? 0);
  return {
    kind: "accept",
    title: activity.title,
    reward: activity.reward,
    schedule: parsed.schedule,
    previousBalance,
  };
}

// ─── Handler ────────────────────────────────────────────────────────

export const claimActivity = onCall<
  ClaimActivityRequest,
  Promise<ClaimActivityResponse>
>({ region: "us-central1", invoker: "public" }, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError(
      "unauthenticated",
      "claimActivity requires a signed-in caller",
    );
  }
  const callerUid = request.auth.uid;
  const data = request.data ?? ({} as Partial<ClaimActivityRequest>);
  const childId = data.childId;
  const activityId = data.activityId;
  if (typeof childId !== "string" || childId.length === 0) {
    throw new HttpsError("invalid-argument", "childId is required");
  }
  if (typeof activityId !== "string" || activityId.length === 0) {
    throw new HttpsError("invalid-argument", "activityId is required");
  }

  const db = getFirestore();
  const childRef = db.doc(`children/${childId}`);
  const activityRef = db.doc(
    `children/${childId}/activities/${activityId}`,
  );
  const userRef = db.doc(`users/${callerUid}`);
  const txnRef = db.collection(`children/${childId}/transactions`).doc();

  const result = await db.runTransaction(async (tx) => {
    const [childSnap, activitySnap, userSnap] = await Promise.all([
      tx.get(childRef),
      tx.get(activityRef),
      tx.get(userRef),
    ]);

    const child = childSnap.exists ? (childSnap.data() as ChildDoc) : null;
    const activity = activitySnap.exists
      ? (activitySnap.data() as ActivityDoc)
      : null;

    const now = new Date();
    const decision = decideClaimActivity({
      callerUid,
      child,
      activity,
      nowMs: now.getTime(),
    });

    if (decision.kind === "reject") {
      throw new HttpsError(decision.code, decision.message);
    }

    const tz = resolveTimezone(
      userSnap.exists
        ? (userSnap.data() as { timezone?: unknown }).timezone
        : undefined,
    );
    const nextAt = nextOccurrence(decision.schedule, now, tz);
    const newBalance = decision.previousBalance + decision.reward;

    tx.create(txnRef, {
      amount: decision.reward,
      type: "EARN",
      description: decision.title,
      createdByUid: callerUid,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(activityRef, {
      nextClaimAt: Timestamp.fromDate(nextAt),
      lastClaimedAt: Timestamp.fromDate(now),
    });
    tx.update(childRef, {
      balance: newBalance,
      lastTxnAt: FieldValue.serverTimestamp(),
      version: FieldValue.increment(1),
    });

    return {
      txnId: txnRef.id,
      amount: decision.reward,
      newBalance,
      nextClaimAt: nextAt.toISOString(),
    };
  });

  logger.info("[claimActivity] claimed", {
    childId,
    activityId,
    txnId: result.txnId,
    amount: result.amount,
    callerUid,
  });
  return result;
});
