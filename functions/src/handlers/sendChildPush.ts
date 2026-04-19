/**
 * sendChildPush — Phase 4, issue #18.
 *
 * Real-time FCM push notifications when something interesting
 * happens on a child:
 *   - a new transaction is created (`LODGE` or `WITHDRAW`), OR
 *   - a new activity is created.
 *
 * Replaces the Flask-side inline FCM fan-out. With this trigger in
 * place, the Flask request/response path no longer has to block on
 * push delivery.
 *
 * Activities changed shape in the activities/vault refresh (slice 2):
 * the old `status: 'LOCKED' | 'READY'` lifecycle went away, so the
 * previous `onActivityPush` onWrite trigger (which fired on the
 * LOCKED→READY edge) is retired in favour of `onActivityCreate`,
 * which fires on doc creation. A fresh activity lands with
 * `nextClaimAt = now`, i.e. immediately claimable, so "create" is
 * the right moment to notify.
 *
 * LOOP GUARD: the trigger MUST NOT write back to the same docs it
 * observes. If we ever want to record "notification sent" metadata,
 * use a disjoint path like `children/{childId}/_meta/lastPushAt`
 * so we don't re-enter onCreate infinitely.
 */

import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions";
import { getFirestore } from "../admin";
import { fanOutToParents } from "./fanOutToParents";

// ─── Types ──────────────────────────────────────────────────────────

interface ChildDoc {
  name?: string;
  parentUids?: string[];
}

interface TransactionDoc {
  amount: number; // integer cents
  type: "LODGE" | "WITHDRAW";
  description?: string;
  createdByUid?: string;
}

interface ActivityDoc {
  title?: string;
  description?: string;
  reward?: number; // integer cents
}

export interface PushPayload {
  title: string;
  body: string;
  kind: "TRANSACTION" | "ACTIVITY_CREATED";
  childId: string;
}

// ─── Pure message builders ──────────────────────────────────────────

/**
 * Format an integer-cents amount as a Euro string (€12.50).
 */
export function formatCents(cents: number): string {
  const whole = Math.floor(cents / 100);
  const fraction = Math.abs(cents % 100)
    .toString()
    .padStart(2, "0");
  return `€${whole}.${fraction}`;
}

export function buildTransactionPush(
  childId: string,
  child: ChildDoc | null,
  txn: TransactionDoc | null,
): PushPayload | null {
  if (!child || !txn) return null;
  if (typeof txn.amount !== "number") return null;

  const childName = child.name ?? "your child";
  const amount = formatCents(txn.amount);

  if (txn.type === "LODGE") {
    return {
      kind: "TRANSACTION",
      childId,
      title: `${childName} earned ${amount}`,
      body: txn.description || "A new lodgement was added.",
    };
  }
  if (txn.type === "WITHDRAW") {
    return {
      kind: "TRANSACTION",
      childId,
      title: `${childName} spent ${amount}`,
      body: txn.description || "A new withdrawal was recorded.",
    };
  }
  return null;
}

export function buildActivityCreatePush(
  childId: string,
  child: ChildDoc | null,
  activity: ActivityDoc | null,
): PushPayload | null {
  if (!child || !activity) return null;

  const childName = child.name ?? "your child";
  const reward =
    typeof activity.reward === "number" && activity.reward > 0
      ? formatCents(activity.reward)
      : null;
  const title = reward
    ? `${childName} unlocked ${reward}`
    : `${childName} — new activity`;
  return {
    kind: "ACTIVITY_CREATED",
    childId,
    title,
    body: activity.title || activity.description || "Tap to review.",
  };
}

// ─── Firestore triggers ─────────────────────────────────────────────

export const onTransactionPush = onDocumentCreated(
  {
    document: "children/{childId}/transactions/{txnId}",
    region: "us-central1",
  },
  async (event) => {
    const childId = event.params.childId;
    const txn = event.data?.data() as TransactionDoc | undefined;
    if (!txn) return;

    const db = getFirestore();
    const childSnap = await db.doc(`children/${childId}`).get();
    const child = childSnap.exists ? (childSnap.data() as ChildDoc) : null;
    if (!child) {
      logger.warn("[onTransactionPush] child missing", { childId });
      return;
    }

    const payload = buildTransactionPush(childId, child, txn);
    if (!payload) return;

    const result = await fanOutToParents(db, child.parentUids ?? [], payload);
    logger.info("[onTransactionPush] fan-out complete", { childId, ...result });
  },
);

export const onActivityCreate = onDocumentCreated(
  {
    document: "children/{childId}/activities/{activityId}",
    region: "us-central1",
  },
  async (event) => {
    const childId = event.params.childId;
    const activity = event.data?.data() as ActivityDoc | undefined;
    if (!activity) return;

    const db = getFirestore();
    const childSnap = await db.doc(`children/${childId}`).get();
    const child = childSnap.exists ? (childSnap.data() as ChildDoc) : null;
    if (!child) {
      logger.warn("[onActivityCreate] child missing", { childId });
      return;
    }

    const payload = buildActivityCreatePush(childId, child, activity);
    if (!payload) return;

    const result = await fanOutToParents(db, child.parentUids ?? [], payload);
    logger.info("[onActivityCreate] fan-out complete", { childId, ...result });
  },
);
