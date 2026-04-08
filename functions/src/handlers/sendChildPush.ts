/**
 * sendChildPush — Phase 4, issue #18.
 *
 * Real-time FCM push notifications when something interesting
 * happens on a child:
 *   - a new transaction is created (`LODGE` or `WITHDRAW`), OR
 *   - an activity transitions to `READY` (matching the source
 *     schema's `LOCKED → READY` lifecycle).
 *
 * Replaces the Flask-side inline FCM fan-out. With this trigger in
 * place, the Flask request/response path no longer has to block on
 * push delivery.
 *
 * LOOP GUARD: the trigger MUST NOT write back to the same docs it
 * observes. If we ever want to record "notification sent" metadata,
 * use a disjoint path like `children/{childId}/_meta/lastPushAt`
 * so we don't re-enter onWrite infinitely.
 *
 * Structure:
 *   - `buildTransactionPush(child, txn)` — pure, returns an FCM
 *     notification body or `null` to skip.
 *   - `buildActivityPush(child, before, after)` — pure, returns a
 *     body only on `LOCKED → READY` transitions, null otherwise.
 *   - `onTransactionPush`, `onActivityPush` — the thin Firestore
 *     trigger wrappers. They delegate to the shared
 *     `fanOutToParents` helper (`./fanOutToParents.ts`), which also
 *     backs `sendHabitNotifications`.
 */

import {
  onDocumentCreated,
  onDocumentWritten,
} from "firebase-functions/v2/firestore";
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
  status: "LOCKED" | "READY";
}

export interface PushPayload {
  title: string;
  body: string;
  kind: "TRANSACTION" | "ACTIVITY_READY";
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

export function buildActivityPush(
  childId: string,
  child: ChildDoc | null,
  before: ActivityDoc | null,
  after: ActivityDoc | null,
): PushPayload | null {
  if (!child || !after) return null;
  // Only push on the LOCKED → READY transition. A fresh create
  // that lands in READY (before === null) also counts.
  const wasLocked = !before || before.status === "LOCKED";
  if (!wasLocked || after.status !== "READY") return null;

  const childName = child.name ?? "your child";
  const reward = typeof after.reward === "number" ? formatCents(after.reward) : null;
  const title = reward
    ? `${childName} unlocked ${reward}`
    : `${childName} — activity ready`;
  return {
    kind: "ACTIVITY_READY",
    childId,
    title,
    body: after.title || after.description || "Tap to review.",
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

export const onActivityPush = onDocumentWritten(
  {
    document: "children/{childId}/activities/{activityId}",
    region: "us-central1",
  },
  async (event) => {
    const childId = event.params.childId;
    const before = event.data?.before?.exists
      ? (event.data.before.data() as ActivityDoc)
      : null;
    const after = event.data?.after?.exists
      ? (event.data.after.data() as ActivityDoc)
      : null;
    if (!after) return;

    const db = getFirestore();
    const childSnap = await db.doc(`children/${childId}`).get();
    const child = childSnap.exists ? (childSnap.data() as ChildDoc) : null;
    if (!child) {
      logger.warn("[onActivityPush] child missing", { childId });
      return;
    }

    const payload = buildActivityPush(childId, child, before, after);
    if (!payload) return;

    const result = await fanOutToParents(db, child.parentUids ?? [], payload);
    logger.info("[onActivityPush] fan-out complete", { childId, ...result });
  },
);
