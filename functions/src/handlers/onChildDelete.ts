/**
 * onChildDelete — Phase 4, issue #16.
 *
 * Firestore does NOT cascade — deleting `children/{childId}` leaves
 * orphan docs in `transactions/`, `vaultTransactions/`, and
 * `activities/`, plus an orphaned profile image in Storage. This
 * trigger fans out the cleanup so the database doesn't accumulate
 * dead data and the storage bill stays predictable.
 *
 * Uses `BulkWriter` for the subcollection cleanup — this is the
 * Firebase-recommended pattern for cascade deletes: it batches
 * writes, handles retries, and survives transient failures without
 * losing progress (each delete() is independent).
 *
 * Storage object deletion is best-effort: if the profile.jpg
 * doesn't exist or the Storage API hiccups, we log a warning but
 * don't fail the whole trigger. The Firestore cleanup is the
 * load-bearing part.
 *
 * Idempotency: re-running on an already-empty child is a no-op.
 * BulkWriter on an empty query yields nothing and returns cleanly.
 */

import { onDocumentDeleted } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions";
import { getFirestore, getStorage } from "../admin";

const SUBCOLLECTIONS = [
  "transactions",
  "vaultTransactions",
  "activities",
] as const;

export const onChildDelete = onDocumentDeleted(
  {
    document: "children/{childId}",
    region: "us-central1",
  },
  async (event) => {
    const childId = event.params.childId;
    const db = getFirestore();
    const bulkWriter = db.bulkWriter();

    // Surface individual delete failures without aborting the whole
    // operation. BulkWriter retries on transient errors by default.
    bulkWriter.onWriteError((err) => {
      logger.error("[onChildDelete] bulkWriter delete failed", {
        childId,
        path: err.documentRef.path,
        code: err.code,
        attempts: err.failedAttempts,
      });
      // Keep retrying a handful of times for transient failures;
      // give up after 5 attempts so the trigger doesn't loop forever.
      return err.failedAttempts < 5;
    });

    let subcollectionDocs = 0;
    for (const subcollection of SUBCOLLECTIONS) {
      const path = `children/${childId}/${subcollection}`;
      const count = await deleteCollection(db, bulkWriter, path);
      subcollectionDocs += count;
      logger.info("[onChildDelete] subcollection cleaned", {
        childId,
        subcollection,
        deleted: count,
      });
    }

    await bulkWriter.close();

    // Best-effort profile image cleanup.
    try {
      const bucket = getStorage().bucket();
      await bucket.file(`children/${childId}/profile.jpg`).delete({
        ignoreNotFound: true,
      });
    } catch (err) {
      logger.warn("[onChildDelete] profile image cleanup failed", {
        childId,
        error: (err as Error).message,
      });
    }

    logger.info("[onChildDelete] cascade complete", {
      childId,
      subcollectionDocs,
    });
  },
);

/**
 * Walk a collection and queue a delete for every document on the
 * supplied BulkWriter. Uses paged reads of 500 docs at a time so
 * memory stays bounded regardless of collection size.
 *
 * Returns the number of docs enqueued for deletion. Callers should
 * still call `bulkWriter.close()` to flush and await.
 */
async function deleteCollection(
  db: FirebaseFirestore.Firestore,
  bulkWriter: FirebaseFirestore.BulkWriter,
  path: string,
): Promise<number> {
  const collection = db.collection(path);
  const PAGE_SIZE = 500;
  let deleted = 0;

  // Paged scan. `orderBy(__name__)` gives a stable cursor so we can
  // resume from the last doc. Each page fetches PAGE_SIZE docs, queues
  // their deletes, and loops.
  //
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snap = await collection
      .orderBy("__name__")
      .limit(PAGE_SIZE)
      .get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      void bulkWriter.delete(doc.ref);
      deleted += 1;
    }

    // If we got fewer than PAGE_SIZE docs, we've drained the
    // collection. Otherwise flush and continue — the next loop will
    // see the freshly-deleted docs gone.
    await bulkWriter.flush();
    if (snap.size < PAGE_SIZE) break;
  }

  return deleted;
}
