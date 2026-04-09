/**
 * Admin-SDK verification helpers for the contract suite.
 *
 * Why admin SDK (and not the client SDK) lives in this file
 * ---------------------------------------------------------
 * The rest of the harness deliberately uses the Firestore **client
 * SDK** so tests exercise the same security rules real clients hit
 * (see `firebaseClient.ts` top-of-file comment). Admin SDK bypasses
 * rules, which is usually the wrong tool.
 *
 * But there is exactly one parity case the client SDK cannot check:
 * **post-delete subcollection verification** for the cascade test.
 * Once `children/{id}` is deleted, the client SDK can't read
 * `children/{id}/transactions` because the read rule evaluates
 * `get(children/{id})` and that returns null on a missing doc —
 * rule fails, read denied. So from the client's perspective, a
 * cascaded-deleted child and a cascade that *failed* to clean up
 * subcollections look identical.
 *
 * The admin SDK bypasses rules, so it can read the subcollection
 * directly and prove it's empty. That's the only thing this module
 * is used for: **assertions about post-delete state**, never to
 * drive writes under test. Writes still go through `firebaseClient`
 * so the rule boundary is exercised on the write path.
 *
 * Emulator wiring
 * ---------------
 * The Admin SDK auto-honors `FIRESTORE_EMULATOR_HOST` when set. The
 * contract suite runs inside `firebase emulators:exec`, which
 * publishes that env var before vitest starts, so calling
 * `initializeApp()` with no args gives us a Firestore client pointed
 * straight at the local emulator — no credentials, no network to
 * real Firebase.
 *
 * The init is guarded with a named app so it doesn't collide with
 * any other admin-SDK init that might happen in the same process
 * (e.g. if a future test imports production handler code directly).
 */

import {
  initializeApp,
  getApps,
  type App,
} from "firebase-admin/app";
import {
  getFirestore,
  type Firestore,
} from "firebase-admin/firestore";
import { CONTRACT_PROJECT_ID } from "./firebaseClient";

const ADMIN_APP_NAME = "contract-admin-verify";

let adminApp: App | undefined;
let adminDb: Firestore | undefined;

/**
 * Lazily construct (or reuse) the named admin app pointed at the
 * contract project. Idempotent — safe to call from any test.
 *
 * Throws if `FIRESTORE_EMULATOR_HOST` isn't set. That means the
 * caller is running outside `firebase emulators:exec`, so any
 * admin-SDK write would silently hit the real Firebase project.
 * Failing loud is the only safe behaviour.
 */
function getAdminDb(): Firestore {
  if (adminDb) return adminDb;
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "adminClient: FIRESTORE_EMULATOR_HOST is not set — refusing to " +
        "initialize admin SDK against a real project. Run the contract " +
        "suite via `npm run test:contract` (wraps firebase emulators:exec).",
    );
  }
  const existing = getApps().find((a) => a.name === ADMIN_APP_NAME);
  adminApp =
    existing ??
    initializeApp({ projectId: CONTRACT_PROJECT_ID }, ADMIN_APP_NAME);
  adminDb = getFirestore(adminApp);
  return adminDb;
}

/**
 * Poll until `children/{id}` is gone.
 *
 * Why admin SDK rather than the client SDK: the children read rule
 * (`firestore.rules:78`) evaluates `request.auth.uid in
 * resource.data.parentUids` *without* guarding for a missing
 * `resource`, so a client-side `getDoc` on a deleted child surfaces
 * as a `permission-denied` from a Null value error inside the rule,
 * not as a clean `snap.exists() === false`. Polling via admin SDK
 * bypasses the rule and gives us a faithful "is this doc there or
 * not" signal. Verification-only use, same as the subcollection
 * helper below.
 */
export async function awaitFirebaseChildDocAbsent(input: {
  childId: string;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<void> {
  const db = getAdminDb();
  const deadline = Date.now() + (input.timeoutMs ?? 5_000);
  const interval = input.intervalMs ?? 100;
  while (Date.now() < deadline) {
    const snap = await db.collection("children").doc(input.childId).get();
    if (!snap.exists) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `Firebase child ${input.childId} was still present after delete + wait`,
  );
}

/**
 * Return the number of docs currently in a `children/{id}/<sub>`
 * subcollection. Rules-bypassing: called after the child doc has
 * been deleted, which is exactly when the client SDK can't help us.
 */
export async function countFirebaseChildSubcollection(input: {
  childId: string;
  subcollection: "transactions" | "vaultTransactions" | "activities";
}): Promise<number> {
  const db = getAdminDb();
  const snap = await db
    .collection("children")
    .doc(input.childId)
    .collection(input.subcollection)
    .count()
    .get();
  return snap.data().count;
}

/**
 * Poll until a child's subcollection is empty, or time out.
 *
 * `onChildDelete` (#16) uses `BulkWriter` to fan out subcollection
 * deletes, which is asynchronous with respect to the client-side
 * `deleteDoc(children/{id})` call. A test that reads the count
 * immediately after the delete will almost always observe the old
 * doc count and fail. Polling absorbs the latency.
 *
 * Default timeout is generous (10s) because the trigger has to
 * page through the subcollection and flush `BulkWriter` batches.
 */
export async function awaitFirebaseChildSubcollectionEmpty(input: {
  childId: string;
  subcollection: "transactions" | "vaultTransactions" | "activities";
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? 10_000);
  const interval = input.intervalMs ?? 150;
  let lastCount = -1;
  while (Date.now() < deadline) {
    lastCount = await countFirebaseChildSubcollection({
      childId: input.childId,
      subcollection: input.subcollection,
    });
    if (lastCount === 0) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `Firebase child ${input.childId} subcollection "${input.subcollection}" ` +
      `still has ${lastCount} docs after timeout — onChildDelete cascade ` +
      `did not complete`,
  );
}
