/**
 * deleteActivity — callable, slice 4 of the activities refresh.
 *
 * Deletes an activity. When the deleted row is the child's allowance,
 * clears `children.allowanceId` in the same transaction so the
 * uniqueness invariant holds for the next `createActivity` call.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { getFirestore, FieldValue } from "../admin";

// ─── Types ──────────────────────────────────────────────────────────

export interface DeleteActivityRequest {
  childId: string;
  activityId: string;
}

export interface DeleteActivityResponse {
  deleted: true;
}

interface ChildDoc {
  parentUids: string[];
  allowanceId?: string | null;
}

interface ActivityDoc {
  type: "ALLOWANCE" | "CHORE";
}

export type DeleteActivityDecision =
  | { kind: "delete"; clearAllowancePointer: boolean }
  | { kind: "reject"; code: HttpsError["code"]; message: string };

// ─── Pure decision logic ────────────────────────────────────────────

export function decideDeleteActivity(params: {
  callerUid: string;
  activityId: string;
  child: ChildDoc | null | undefined;
  activity: ActivityDoc | null | undefined;
}): DeleteActivityDecision {
  const { callerUid, activityId, child, activity } = params;

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

  const clearAllowancePointer =
    activity.type === "ALLOWANCE" && child.allowanceId === activityId;

  return { kind: "delete", clearAllowancePointer };
}

// ─── Handler ────────────────────────────────────────────────────────

export const deleteActivity = onCall<
  DeleteActivityRequest,
  Promise<DeleteActivityResponse>
>({ region: "us-central1", invoker: "public" }, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError(
      "unauthenticated",
      "deleteActivity requires a signed-in caller",
    );
  }
  const callerUid = request.auth.uid;
  const data = request.data ?? ({} as Partial<DeleteActivityRequest>);
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

  return db.runTransaction(async (tx) => {
    const [childSnap, activitySnap] = await Promise.all([
      tx.get(childRef),
      tx.get(activityRef),
    ]);
    const child = childSnap.exists
      ? (childSnap.data() as ChildDoc)
      : null;
    const activity = activitySnap.exists
      ? (activitySnap.data() as ActivityDoc)
      : null;

    const decision = decideDeleteActivity({
      callerUid,
      activityId,
      child,
      activity,
    });

    if (decision.kind === "reject") {
      throw new HttpsError(decision.code, decision.message);
    }

    tx.delete(activityRef);
    if (decision.clearAllowancePointer) {
      tx.update(childRef, {
        allowanceId: null,
        version: FieldValue.increment(1),
      });
    }

    logger.info("[deleteActivity] deleted", {
      childId,
      activityId,
      clearedAllowancePointer: decision.clearAllowancePointer,
      callerUid,
    });
    return { deleted: true };
  });
});
