/**
 * updateActivity — callable, slice 4 of the activities refresh.
 *
 * Edits an existing activity. `title`, `reward`, and `schedule` are
 * editable; `type` is pinned (see design §3.7 — activity kind is
 * identity, not a runtime toggle). When `schedule` changes, the
 * callable recomputes `nextClaimAt` so the parent's mental model of
 * "I just changed the schedule; next claim moves with it" holds.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { getFirestore, Timestamp } from "../admin";
import {
  nextOccurrence,
  parseSchedule,
  type Schedule,
} from "../lib/schedule";

// ─── Types ──────────────────────────────────────────────────────────

export interface UpdateActivityRequest {
  childId: string;
  activityId: string;
  patch: {
    title?: unknown;
    reward?: unknown;
    schedule?: unknown;
    type?: unknown;
  };
}

export interface UpdateActivityResponse {
  updated: true;
}

interface ChildDoc {
  parentUids: string[];
}

interface ActivityDoc {
  type: "ALLOWANCE" | "CHORE";
  schedule: Schedule;
}

export type UpdateActivityPatch = {
  title?: string;
  reward?: number;
  schedule?: Schedule;
};

export type UpdateActivityDecision =
  | { kind: "accept"; patch: UpdateActivityPatch }
  | { kind: "noop" }
  | { kind: "reject"; code: HttpsError["code"]; message: string };

// ─── Pure decision logic ────────────────────────────────────────────

export function decideUpdateActivity(params: {
  callerUid: string;
  child: ChildDoc | null | undefined;
  activity: ActivityDoc | null | undefined;
  patch: UpdateActivityRequest["patch"];
}): UpdateActivityDecision {
  const { callerUid, child, activity, patch } = params;

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
  if (Object.prototype.hasOwnProperty.call(patch, "type")) {
    return {
      kind: "reject",
      code: "invalid-argument",
      message: "type is immutable; delete and recreate to change kind",
    };
  }

  const out: UpdateActivityPatch = {};

  if (Object.prototype.hasOwnProperty.call(patch, "title")) {
    if (typeof patch.title !== "string" || patch.title.trim().length === 0) {
      return {
        kind: "reject",
        code: "invalid-argument",
        message: "title must be a non-empty string",
      };
    }
    out.title = patch.title.trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, "reward")) {
    if (
      typeof patch.reward !== "number" ||
      !Number.isInteger(patch.reward) ||
      patch.reward < 0
    ) {
      return {
        kind: "reject",
        code: "invalid-argument",
        message: "reward must be a non-negative integer (cents)",
      };
    }
    out.reward = patch.reward;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "schedule")) {
    const parsed = parseSchedule(patch.schedule);
    if (!parsed.ok) {
      return {
        kind: "reject",
        code: "invalid-argument",
        message: parsed.reason,
      };
    }
    out.schedule = parsed.schedule;
  }

  if (Object.keys(out).length === 0) {
    return { kind: "noop" };
  }
  return { kind: "accept", patch: out };
}

// ─── Handler ────────────────────────────────────────────────────────

export const updateActivity = onCall<
  UpdateActivityRequest,
  Promise<UpdateActivityResponse>
>({ region: "us-central1", invoker: "public" }, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError(
      "unauthenticated",
      "updateActivity requires a signed-in caller",
    );
  }
  const callerUid = request.auth.uid;
  const data = request.data ?? ({} as Partial<UpdateActivityRequest>);
  const childId = data.childId;
  const activityId = data.activityId;
  if (typeof childId !== "string" || childId.length === 0) {
    throw new HttpsError("invalid-argument", "childId is required");
  }
  if (typeof activityId !== "string" || activityId.length === 0) {
    throw new HttpsError("invalid-argument", "activityId is required");
  }
  const patch = (data.patch ?? {}) as UpdateActivityRequest["patch"];

  const db = getFirestore();
  const childRef = db.doc(`children/${childId}`);
  const activityRef = db.doc(
    `children/${childId}/activities/${activityId}`,
  );
  const userRef = db.doc(`users/${callerUid}`);

  return db.runTransaction(async (tx) => {
    const [childSnap, activitySnap, userSnap] = await Promise.all([
      tx.get(childRef),
      tx.get(activityRef),
      tx.get(userRef),
    ]);

    const child = childSnap.exists
      ? (childSnap.data() as ChildDoc)
      : null;
    const activity = activitySnap.exists
      ? (activitySnap.data() as ActivityDoc)
      : null;

    const decision = decideUpdateActivity({
      callerUid,
      child,
      activity,
      patch,
    });

    if (decision.kind === "reject") {
      throw new HttpsError(decision.code, decision.message);
    }
    if (decision.kind === "noop") {
      logger.info("[updateActivity] noop patch", {
        childId,
        activityId,
        callerUid,
      });
      return { updated: true };
    }

    const writePatch: Record<string, unknown> = {};
    if (decision.patch.title !== undefined) writePatch.title = decision.patch.title;
    if (decision.patch.reward !== undefined) writePatch.reward = decision.patch.reward;
    if (decision.patch.schedule !== undefined) {
      writePatch.schedule = decision.patch.schedule;
      const tz =
        (userSnap.exists
          ? (userSnap.data() as { timezone?: string }).timezone
          : undefined) ?? "Europe/Dublin";
      const now = new Date();
      writePatch.nextClaimAt = Timestamp.fromDate(
        nextOccurrence(decision.patch.schedule, now, tz),
      );
    }
    tx.update(activityRef, writePatch);

    logger.info("[updateActivity] patched", {
      childId,
      activityId,
      keys: Object.keys(writePatch),
      callerUid,
    });
    return { updated: true };
  });
});
