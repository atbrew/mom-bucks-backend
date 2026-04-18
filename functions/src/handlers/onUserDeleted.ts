/**
 * onUserDeleted — Auth event trigger (v1 API).
 *
 * Fires asynchronously when a Firebase Auth user is deleted (any
 * method: Admin SDK, Firebase console, or Auth REST API). Cleans up:
 *
 *   1. Profile image at `users/{uid}/profile.jpg` (Storage).
 *   2. Invites sent by this user (`invites` where `invitedByUid == uid`).
 *
 * Without this trigger, deleting a user account leaves orphaned
 * Storage objects and dangling invite docs that accumulate
 * indefinitely.
 *
 * Uses the v1 `auth.user().onDelete()` API because firebase-functions
 * v2 only offers blocking identity triggers (beforeUserCreated,
 * beforeUserSignedIn) — there is no v2 `beforeUserDeleted`. The v1
 * onDelete fires post-deletion (non-blocking), which is exactly what
 * we need for best-effort cleanup.
 *
 * All cleanup is best-effort: failures are logged but don't crash the
 * trigger. Same pattern as `onChildDelete`.
 */

import * as functions from "firebase-functions/v1";
import { logger } from "firebase-functions";
import { getFirestore, getStorage } from "../admin";

// ─── Pure logic ──────────────────────────────────────────────────────

export interface UserCleanupPlan {
  storagePath: string;
}

/**
 * Determine what needs cleaning up when a user is deleted.
 * Returns null if the uid is invalid (defensive — shouldn't happen
 * in practice since Firebase Auth always provides a uid).
 */
export function buildUserCleanupPlan(uid: string): UserCleanupPlan | null {
  if (!uid) return null;
  return { storagePath: `users/${uid}/profile.jpg` };
}

// ─── Handler ─────────────────────────────────────────────────────────

export const onUserDeleted = functions
  .region("us-central1")
  .auth.user()
  .onDelete(async (user) => {
    if (!user) {
      logger.warn("[onUserDeleted] no user data in event");
      return;
    }

    const plan = buildUserCleanupPlan(user.uid);
    if (!plan) {
      logger.warn("[onUserDeleted] invalid uid, skipping cleanup");
      return;
    }

    // 1. Profile image cleanup (Storage, best-effort).
    try {
      const bucket = getStorage().bucket();
      await bucket.file(plan.storagePath).delete({ ignoreNotFound: true });
      logger.info("[onUserDeleted] profile image deleted", {
        uid: user.uid,
        storagePath: plan.storagePath,
      });
    } catch (err) {
      logger.warn("[onUserDeleted] profile image cleanup failed", {
        uid: user.uid,
        error: (err as Error).message,
      });
    }

    // 2. Orphaned invites cleanup (Firestore, best-effort).
    //    Delete all invites where invitedByUid == uid — these are
    //    dangling now that the sender no longer exists.
    try {
      const db = getFirestore();
      const snap = await db
        .collection("invites")
        .where("invitedByUid", "==", user.uid)
        .get();

      if (!snap.empty) {
        const bulkWriter = db.bulkWriter();
        for (const doc of snap.docs) {
          void bulkWriter.delete(doc.ref);
        }
        await bulkWriter.close();
        logger.info("[onUserDeleted] orphaned invites deleted", {
          uid: user.uid,
          count: snap.size,
        });
      }
    } catch (err) {
      logger.warn("[onUserDeleted] invite cleanup failed", {
        uid: user.uid,
        error: (err as Error).message,
      });
    }
  });
