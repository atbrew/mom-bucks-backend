/**
 * createActivity — callable, slice 4 of the activities refresh.
 *
 * Single path for creating an activity. Validates the input (including
 * the structured schedule map), enforces the allowance-uniqueness
 * invariant via `children.allowanceId`, and stamps `nextClaimAt = now`
 * so new activities are immediately claimable.
 *
 * All activity writes go through this callable, so rules deny direct
 * client creates on `children/{id}/activities/{id}`.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { getFirestore, FieldValue, Timestamp } from "../admin";
import { parseSchedule, type Schedule } from "../lib/schedule";

// ─── Types ──────────────────────────────────────────────────────────

export interface CreateActivityRequest {
  childId: string;
  title: string;
  reward: number;
  type: "ALLOWANCE" | "CHORE";
  schedule: unknown;
}

export interface CreateActivityResponse {
  activityId: string;
}

interface ChildDoc {
  parentUids: string[];
  allowanceId?: string | null;
}

export type CreateActivityDecision =
  | {
      kind: "accept";
      type: "ALLOWANCE" | "CHORE";
      title: string;
      reward: number;
      schedule: Schedule;
    }
  | { kind: "reject"; code: HttpsError["code"]; message: string };

// ─── Pure decision logic ────────────────────────────────────────────

export function decideCreateActivity(params: {
  callerUid: string;
  child: ChildDoc | null | undefined;
  input: {
    title: unknown;
    reward: unknown;
    type: unknown;
    schedule: unknown;
  };
}): CreateActivityDecision {
  const { callerUid, child, input } = params;

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

  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    return {
      kind: "reject",
      code: "invalid-argument",
      message: "title is required",
    };
  }
  if (
    typeof input.reward !== "number" ||
    !Number.isInteger(input.reward) ||
    input.reward < 0
  ) {
    return {
      kind: "reject",
      code: "invalid-argument",
      message: "reward must be a non-negative integer (cents)",
    };
  }
  if (input.type !== "ALLOWANCE" && input.type !== "CHORE") {
    return {
      kind: "reject",
      code: "invalid-argument",
      message: "type must be 'ALLOWANCE' or 'CHORE'",
    };
  }
  if (input.type === "ALLOWANCE" && child.allowanceId) {
    return {
      kind: "reject",
      code: "already-exists",
      message: "child already has an allowance activity",
    };
  }

  const parsed = parseSchedule(input.schedule);
  if (!parsed.ok) {
    return { kind: "reject", code: "invalid-argument", message: parsed.reason };
  }

  return {
    kind: "accept",
    type: input.type,
    title: input.title.trim(),
    reward: input.reward,
    schedule: parsed.schedule,
  };
}

// ─── Handler ────────────────────────────────────────────────────────

export const createActivity = onCall<
  CreateActivityRequest,
  Promise<CreateActivityResponse>
>({ region: "us-central1", invoker: "public" }, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError(
      "unauthenticated",
      "createActivity requires a signed-in caller",
    );
  }
  const callerUid = request.auth.uid;
  const data = request.data ?? ({} as Partial<CreateActivityRequest>);
  const childId = data.childId;
  if (typeof childId !== "string" || childId.length === 0) {
    throw new HttpsError("invalid-argument", "childId is required");
  }

  const db = getFirestore();
  const childRef = db.doc(`children/${childId}`);
  const activityRef = db.collection(`children/${childId}/activities`).doc();

  return db.runTransaction(async (tx) => {
    const childSnap = await tx.get(childRef);
    const child = childSnap.exists ? (childSnap.data() as ChildDoc) : null;

    const decision = decideCreateActivity({
      callerUid,
      child,
      input: {
        title: data.title,
        reward: data.reward,
        type: data.type,
        schedule: data.schedule,
      },
    });

    if (decision.kind === "reject") {
      throw new HttpsError(decision.code, decision.message);
    }

    const now = Timestamp.now();
    tx.create(activityRef, {
      title: decision.title,
      reward: decision.reward,
      type: decision.type,
      schedule: decision.schedule,
      nextClaimAt: now,
      lastClaimedAt: null,
      createdAt: FieldValue.serverTimestamp(),
    });

    if (decision.type === "ALLOWANCE") {
      tx.update(childRef, {
        allowanceId: activityRef.id,
        version: FieldValue.increment(1),
      });
    }

    logger.info("[createActivity] created", {
      childId,
      activityId: activityRef.id,
      type: decision.type,
      callerUid,
    });
    return { activityId: activityRef.id };
  });
});
