/**
 * onUserDeleted — Auth event trigger (v1 API).
 *
 * Fires asynchronously when a Firebase Auth user is deleted (any
 * method: Admin SDK, Firebase console, or Auth REST API). Cleans up:
 *
 *   1. Profile image at `users/{uid}/profile.jpg` (Storage).
 *   2. User doc at `users/{uid}` (Firestore).
 *   3. Children where this user is in `parentUids`:
 *        - Sole parent  → child doc deleted (triggers `onChildDelete`,
 *          which cascades subcollections, Storage profile image, and
 *          invites referencing that child).
 *        - Co-parented  → `uid` removed from `parentUids` via
 *          `arrayRemove` so remaining parents still have access.
 *   4. Invites sent by this user (`invites` where `invitedByUid == uid`).
 *
 * Without this trigger, deleting a user account from the Firebase
 * console (or via the Admin SDK outside the CLI) leaves orphaned
 * Storage objects, a stale users doc, inaccessible or dangling children,
 * and lingering invite docs that accumulate indefinitely.
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
import { getFirestore, getStorage, FieldValue } from "../admin";

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
        ...(err instanceof Error
          ? { errorMessage: err.message, errorStack: err.stack }
          : { error: String(err) }),
      });
    }

    const db = getFirestore();

    // 2. User Firestore doc cleanup (best-effort).
    //    The CLI deletes this before triggering auth deletion, but if
    //    a user is deleted via the Firebase console or Admin SDK the
    //    users/{uid} doc would otherwise be orphaned indefinitely.
    try {
      await db.doc(`users/${user.uid}`).delete();
      logger.info("[onUserDeleted] user doc deleted", { uid: user.uid });
    } catch (err) {
      logger.warn("[onUserDeleted] user doc cleanup failed", {
        uid: user.uid,
        ...(err instanceof Error
          ? { errorMessage: err.message, errorStack: err.stack }
          : { error: String(err) }),
      });
    }

    // 3. Children cascade (best-effort).
    //    Find all children that list this uid in parentUids and either:
    //      - Delete the child doc (sole parent) — triggers onChildDelete,
    //        which cascades subcollections, Storage profile image, and
    //        child-scoped invites.
    //      - Remove uid from parentUids (co-parented) — the remaining
    //        parents keep uninterrupted access.
    try {
      const childrenSnap = await db
        .collection("children")
        .where("parentUids", "array-contains", user.uid)
        .get();

      let soleParentDeleted = 0;
      let coParentDelinked = 0;

      for (const childDoc of childrenSnap.docs) {
        const parentUids: string[] =
          (childDoc.data().parentUids as string[]) ?? [];

        if (parentUids.length === 1) {
          // Sole parent — delete the child doc.  onChildDelete fires
          // automatically and handles subcollections, Storage, and
          // child-scoped invites.
          await childDoc.ref.delete();
          soleParentDeleted += 1;
        } else {
          // Co-parented — remove this uid so remaining parents keep
          // access and the child doc stays valid.
          await childDoc.ref.update({
            parentUids: FieldValue.arrayRemove(user.uid),
          });
          coParentDelinked += 1;
        }
      }

      if (soleParentDeleted + coParentDelinked > 0) {
        logger.info("[onUserDeleted] children cascade complete", {
          uid: user.uid,
          soleParentDeleted,
          coParentDelinked,
        });
      }
    } catch (err) {
      logger.warn("[onUserDeleted] children cascade failed", {
        uid: user.uid,
        ...(err instanceof Error
          ? { errorMessage: err.message, errorStack: err.stack }
          : { error: String(err) }),
      });
    }

    // 4. Orphaned invites cleanup (Firestore, best-effort).
    //    Delete all invites where invitedByUid == uid — these are
    //    dangling now that the sender no longer exists.  (Child-scoped
    //    invites for deleted sole-parent children are already cleaned
    //    up by onChildDelete in step 3, but this catches any invites
    //    the user sent for co-parented children.)
    try {
      const snap = await db
        .collection("invites")
        .where("invitedByUid", "==", user.uid)
        .get();

      if (!snap.empty) {
        const bulkWriter = db.bulkWriter();
        bulkWriter.onWriteError((err) => {
          logger.error("[onUserDeleted] invite delete failed", {
            uid: user.uid,
            path: err.documentRef.path,
            code: err.code,
            attempts: err.failedAttempts,
          });
          return err.failedAttempts < 5;
        });
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
        ...(err instanceof Error
          ? { errorMessage: err.message, errorStack: err.stack }
          : { error: String(err) }),
      });
    }
  });
