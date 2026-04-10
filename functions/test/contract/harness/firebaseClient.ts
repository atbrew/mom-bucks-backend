/**
 * Firebase client used by the contract test suite.
 *
 * Why the client SDK (and not Admin SDK)
 * ---------------------------------------
 * The contract tests have to exercise the **full** Firebase write
 * path, including the security rules we landed in PR #24 (the
 * WITHDRAW overspend guard). The Admin SDK bypasses rules, so if we
 * used it here an overspend WITHDRAW would silently succeed on the
 * Firebase side, parity would fail, and we'd be testing the wrong
 * thing. Using the client SDK through the Auth + Firestore emulators
 * gives us the same rule enforcement a real mobile client would hit.
 *
 * User lifecycle
 * --------------
 * For each test user we:
 *   1. Create an Auth emulator user via the client SDK's
 *      `createUserWithEmailAndPassword`. The Auth emulator accepts
 *      any password and mints a UID we can then use as the
 *      `users/{uid}` doc ID.
 *   2. Seed the `users/{uid}` doc so the user is discoverable in
 *      Firestore (not strictly required for transactions tests,
 *      but keeps parity with the Flask register flow).
 *
 * To act as a given user on a subsequent call we sign in to the
 * same Auth emulator with email+password; the client SDK then
 * attaches that identity to every Firestore request. Firestore
 * security rules see `request.auth.uid` and evaluate accordingly.
 *
 * Per-user app instances
 * ----------------------
 * Firebase client SDK sign-in state is per-app. To avoid flakiness
 * where one test's sign-in leaks into another, every test user gets
 * its own named Firebase app instance via
 * `initializeApp(config, name)`. Tests clean them up via `cleanup()`
 * at the end.
 */

import {
  initializeApp,
  deleteApp,
  type FirebaseApp,
} from "firebase/app";
import {
  getAuth,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  type Auth,
} from "firebase/auth";
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  collection,
  addDoc,
  serverTimestamp,
  Timestamp,
  type Firestore,
} from "firebase/firestore";
import {
  NormalizedActivity,
  NormalizedChild,
  NormalizedTransaction,
  normalizeFirebaseActivity,
  normalizeFirebaseChild,
  normalizeFirebaseTransaction,
} from "./normalize";

// Must match the emulator ports declared in firebase.json.
const AUTH_EMULATOR_HOST = "http://127.0.0.1:9099";
const FIRESTORE_EMULATOR_HOST = "127.0.0.1";
const FIRESTORE_EMULATOR_PORT = 8080;

// Any project ID that starts with `demo-` forces the Firebase SDKs
// into demo mode (no credentials, no network to real Firebase).
export const CONTRACT_PROJECT_ID = "demo-mom-bucks-contract";

let appCounter = 0;

export interface FirebaseUserHandle {
  uid: string;
  email: string;
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  /** Release the Firebase app so its internal listeners shut down. */
  cleanup(): Promise<void>;
}

/**
 * Build a fresh Firebase app instance wired to the local emulators.
 *
 * Each test user gets its own instance so sign-in state doesn't
 * bleed across parallel tests.
 */
function buildEmulatorApp(): { app: FirebaseApp; auth: Auth; db: Firestore } {
  const name = `contract-app-${++appCounter}-${Date.now()}`;
  const app = initializeApp(
    { projectId: CONTRACT_PROJECT_ID, apiKey: "fake-api-key" },
    name,
  );
  const auth = getAuth(app);
  connectAuthEmulator(auth, AUTH_EMULATOR_HOST, { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, FIRESTORE_EMULATOR_HOST, FIRESTORE_EMULATOR_PORT);
  return { app, auth, db };
}

/**
 * Create a Firebase Auth user (email + password) against the Auth
 * emulator and seed the mirroring `users/{uid}` doc. Returns a
 * handle the test can use to make further authed calls.
 */
export async function createFirebaseUser(input: {
  email: string;
  password: string;
  name: string;
}): Promise<FirebaseUserHandle> {
  const { app, auth, db } = buildEmulatorApp();
  const cred = await createUserWithEmailAndPassword(
    auth,
    input.email,
    input.password,
  );
  const uid = cred.user.uid;
  // Seed users/{uid}. The rules allow self-writes here (see
  // `match /users/{uid}` in firestore.rules).
  await setDoc(doc(db, "users", uid), {
    displayName: input.name,
    email: input.email,
    photoUrl: null,
    fcmTokens: [],
    createdAt: serverTimestamp(),
  });
  return {
    uid,
    email: input.email,
    app,
    auth,
    db,
    async cleanup() {
      await deleteApp(app);
    },
  };
}

/**
 * Sign an existing user into a fresh app instance.
 *
 * Used when a test needs to act as a second parent that was created
 * earlier in the same run (e.g. the co-parenting concurrent-write
 * case).
 */
export async function signInFirebaseUser(input: {
  email: string;
  password: string;
}): Promise<FirebaseUserHandle> {
  const { app, auth, db } = buildEmulatorApp();
  const cred = await signInWithEmailAndPassword(
    auth,
    input.email,
    input.password,
  );
  return {
    uid: cred.user.uid,
    email: input.email,
    app,
    auth,
    db,
    async cleanup() {
      await deleteApp(app);
    },
  };
}

export interface FirebaseCreateChildInput {
  user: FirebaseUserHandle;
  name: string;
}

/**
 * Create a `children/{id}` doc owned by the given user. Returns the
 * generated child ID.
 *
 * Shape matches the Firestore rules' create gate: the caller seeds
 * `parentUids: [<my uid>]` — any other arrangement is rejected.
 */
export async function createFirebaseChild(
  input: FirebaseCreateChildInput,
): Promise<string> {
  const childrenCol = collection(input.user.db, "children");
  const childRef = await addDoc(childrenCol, {
    name: input.name,
    balance: 0,
    vaultBalance: 0,
    parentUids: [input.user.uid],
    createdByUid: input.user.uid,
    version: 1,
  });
  return childRef.id;
}

/**
 * Read a child doc via the given user's authed client. Goes through
 * the security rules, so a non-parent read will throw.
 */
export async function getFirebaseChild(input: {
  user: FirebaseUserHandle;
  childId: string;
}): Promise<NormalizedChild> {
  const snap = await getDoc(doc(input.user.db, "children", input.childId));
  if (!snap.exists()) {
    throw new Error(`Firebase child ${input.childId} not found`);
  }
  return normalizeFirebaseChild(snap.data());
}

export interface FirebaseGetChildResult {
  ok: boolean;
  /** Set when `ok === false`: either `permission-denied` or `not-found`. */
  errorCode?: string;
  child?: NormalizedChild;
}

/**
 * Non-throwing `getFirebaseChild`. Returns a discriminated shape so
 * tests can assert on "the backend refused this read" without having
 * to wrap every call in try/catch.
 *
 * Error shapes **under the current rule set**:
 *   - non-parent read         → `{ ok: false, errorCode: "permission-denied" }`
 *   - read of a deleted child → `{ ok: false, errorCode: "permission-denied" }`
 *
 * Both failure modes collapse to `permission-denied` because the
 * children READ rule (`firestore.rules:78`) dereferences
 * `resource.data.parentUids` without a null guard. On a missing doc,
 * `resource` is null and the rule errors out before Firestore can
 * surface "doc doesn't exist" — the SDK reports permission-denied.
 * See the `deleteFirebaseChild` note below for the longer version.
 *
 * Consequence: **this helper cannot be used to verify post-delete
 * absence**. Use `awaitFirebaseChildDocAbsent` from `adminClient.ts`
 * for that — admin SDK bypasses rules and returns a faithful
 * "exists / doesn't exist" signal.
 *
 * The `not-found` branch below is kept as forward-compat: if the
 * rule ever gains a `resource != null` guard, a post-delete read by
 * a legitimate parent would start returning `!snap.exists()` cleanly
 * and this branch would activate. Until then it's unreachable for
 * `children/{id}` reads, and the inline comment says so.
 */
export async function tryGetFirebaseChild(input: {
  user: FirebaseUserHandle;
  childId: string;
}): Promise<FirebaseGetChildResult> {
  try {
    const snap = await getDoc(doc(input.user.db, "children", input.childId));
    if (!snap.exists()) {
      // Unreachable under the current children read rule (the rule
      // errors out before we get here on a missing doc). Kept as
      // forward-compat in case the rule grows a null guard — see the
      // docstring above.
      return { ok: false, errorCode: "not-found" };
    }
    return { ok: true, child: normalizeFirebaseChild(snap.data()) };
  } catch (err) {
    const code = extractFirestoreErrorCode(err);
    if (code === "permission-denied") {
      return { ok: false, errorCode: code };
    }
    throw err;
  }
}

export interface FirebaseRenameChildInput {
  user: FirebaseUserHandle;
  childId: string;
  name: string;
}

/**
 * Rename a child via `updateDoc`. The update rule
 * (`firestore.rules:96-98`) allows any current parent to update the
 * child doc as long as `parentUids` is untouched — so a plain
 * `updateDoc({name})` is all we need.
 */
export async function renameFirebaseChild(
  input: FirebaseRenameChildInput,
): Promise<void> {
  await updateDoc(doc(input.user.db, "children", input.childId), {
    name: input.name,
  });
}

/**
 * Delete a child doc. The `onChildDelete` trigger (#16) fires
 * asynchronously and cascades the child's subcollections
 * (`transactions`, `vaultTransactions`, `activities`); use
 * `awaitFirebaseChildDocAbsent` + `awaitFirebaseChildSubcollectionEmpty`
 * from `adminClient.ts` to wait for the cascade to land.
 *
 * Note: we deliberately do NOT expose a client-SDK-based "is it gone
 * yet" poller here. The children read rule (`firestore.rules:78`)
 * dereferences `resource.data.parentUids` without a null guard, so
 * a `getDoc` on a deleted child surfaces as a rule Null value error,
 * which the SDK reports as `permission-denied`. That's indistinguishable
 * from a genuine access denial, so we rely on the admin-SDK helper
 * for post-delete doc absence verification.
 */
export async function deleteFirebaseChild(input: {
  user: FirebaseUserHandle;
  childId: string;
}): Promise<void> {
  await deleteDoc(doc(input.user.db, "children", input.childId));
}

export interface FirebaseCreateTransactionInput {
  user: FirebaseUserHandle;
  childId: string;
  type: "LODGE" | "WITHDRAW";
  amountCents: number;
  description: string;
}

export interface FirebaseCreateTransactionResult {
  ok: boolean;
  /** Set when `ok === false` so tests can distinguish rule denials from other errors. */
  errorCode?: string;
  transaction?: NormalizedTransaction;
}

/**
 * Narrow an unknown thrown value to a Firestore-style error code
 * (e.g. "permission-denied"). Uses duck typing on the `.code`
 * property rather than `instanceof FirestoreError` because the
 * client SDK can be loaded through multiple module entrypoints
 * ("firebase/firestore", the bundled lite entry, etc.) and
 * `instanceof` silently mis-reports when two copies of the class
 * are in play. The shape of a real FirebaseError is stable even
 * across those copies, so structural checks are safer here.
 */
function extractFirestoreErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * Write a transaction doc. Catches Firestore PermissionDenied so
 * the overspend test can assert "the rule rejected it" without a
 * try/catch at the call site.
 */
export async function createFirebaseTransaction(
  input: FirebaseCreateTransactionInput,
): Promise<FirebaseCreateTransactionResult> {
  const txnsCol = collection(
    input.user.db,
    "children",
    input.childId,
    "transactions",
  );
  const payload = {
    amount: input.amountCents,
    type: input.type,
    description: input.description,
    createdByUid: input.user.uid,
    createdAt: serverTimestamp(),
  };
  try {
    await addDoc(txnsCol, payload);
    return {
      ok: true,
      transaction: normalizeFirebaseTransaction(payload),
    };
  } catch (err) {
    const code = extractFirestoreErrorCode(err);
    if (code === "permission-denied") {
      return { ok: false, errorCode: code };
    }
    throw err;
  }
}

// ─── Activities ─────────────────────────────────────────────────────
//
// Parity note: Flask has a server-side `claim` endpoint that bundles
// (create-LODGE-txn + bump-balance + recycle-activity-to-LOCKED) into
// one atomic request. Firebase has no equivalent Cloud Function —
// the client is responsible for issuing the same three writes in
// sequence, and `onTransactionCreate` (#15) handles the balance
// recompute asynchronously. The `claimFirebaseActivity` helper below
// reproduces that client-side protocol faithfully so the contract
// test can call it with the same `{childId, activityId, reward}`
// arguments on both sides and end up in the same state.

export interface FirebaseCreateActivityInput {
  user: FirebaseUserHandle;
  childId: string;
  title: string;
  rewardCents: number;
  type: "BOUNTY_RECURRING" | "ALLOWANCE" | "INTEREST";
  status: "LOCKED" | "READY";
  /** YYYY-MM-DD — stored as a Firestore Timestamp at UTC midnight. */
  dueDate: string;
}

/**
 * Create an activity doc under `children/{id}/activities/{newId}`.
 * Writes the canonical shape from `transform.ts` (title, reward in
 * cents, type, status, dueDate, createdAt, claimedAt:null) so the
 * doc is indistinguishable from a backfilled one.
 *
 * The rules (`firestore.rules:162-164`) allow `isChildParent` to
 * write anything under the activities subcollection, so there's no
 * schema validation on the server side — the caller is trusted to
 * seed the canonical fields. That's a known rule-surface weakness
 * but out of scope for this contract suite (it's tested in
 * `firestore.rules.test.ts`).
 */
export async function createFirebaseActivity(
  input: FirebaseCreateActivityInput,
): Promise<string> {
  const activitiesCol = collection(
    input.user.db,
    "children",
    input.childId,
    "activities",
  );
  const ref = await addDoc(activitiesCol, {
    title: input.title,
    reward: input.rewardCents,
    type: input.type,
    status: input.status,
    dueDate: Timestamp.fromDate(dueDateToUtcMidnight(input.dueDate)),
    claimedAt: null,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

/**
 * Parse a YYYY-MM-DD string into a UTC-midnight Date so the
 * Firestore Timestamp round-trips back to the same calendar day
 * via `extractDueDate` in `normalize.ts`, regardless of the host
 * timezone. Using `new Date("YYYY-MM-DD")` directly is already UTC
 * under ECMA-262, but being explicit is clearer and avoids a
 * surprise if Node ever tightens the parser.
 */
function dueDateToUtcMidnight(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map((s) => parseInt(s, 10));
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * List all activities under a child via the client SDK. Goes
 * through the rules (`isChildParent`), so a non-parent will throw.
 */
export async function listFirebaseActivities(input: {
  user: FirebaseUserHandle;
  childId: string;
}): Promise<NormalizedActivity[]> {
  const activitiesCol = collection(
    input.user.db,
    "children",
    input.childId,
    "activities",
  );
  const snap = await getDocs(activitiesCol);
  return snap.docs.map((d) => normalizeFirebaseActivity(d.data()));
}

export interface FirebaseListActivitiesResult {
  ok: boolean;
  errorCode?: string;
  activities?: NormalizedActivity[];
}

/**
 * Non-throwing list for the non-parent access test. The children
 * activities rule is `isChildParent(childId)` which does a `get()`
 * on the parent child doc — a non-parent trips that check and gets
 * `permission-denied` from the SDK.
 */
export async function tryListFirebaseActivities(input: {
  user: FirebaseUserHandle;
  childId: string;
}): Promise<FirebaseListActivitiesResult> {
  try {
    const activitiesCol = collection(
      input.user.db,
      "children",
      input.childId,
      "activities",
    );
    const snap = await getDocs(activitiesCol);
    return {
      ok: true,
      activities: snap.docs.map((d) => normalizeFirebaseActivity(d.data())),
    };
  } catch (err) {
    const code = extractFirestoreErrorCode(err);
    if (code === "permission-denied") {
      return { ok: false, errorCode: code };
    }
    throw err;
  }
}

export interface FirebaseClaimActivityInput {
  user: FirebaseUserHandle;
  childId: string;
  activityId: string;
  rewardCents: number;
  description: string;
  /** YYYY-MM-DD for where to land the recycled activity. */
  nextDueDate: string;
}

/**
 * Client-orchestrated claim: create a LODGE transaction doc for the
 * reward, then update the activity to LOCKED with the next due date.
 * The caller supplies `nextDueDate` explicitly so both backends
 * compute it the same way — Flask uses its own recurrence logic
 * server-side, and this helper would have to duplicate that to match
 * otherwise. The contract test computes the expected date once
 * (`addDays(today, 7)` for a WEEKLY bounty) and passes the same
 * value to both sides' claim helpers.
 *
 * Does NOT wait for `onTransactionCreate` to finish — the caller
 * uses `awaitFirebaseBalance` to sync up on the balance before
 * asserting.
 */
export async function claimFirebaseActivity(
  input: FirebaseClaimActivityInput,
): Promise<void> {
  // 1. LODGE transaction for the reward. onTransactionCreate (#15)
  //    will pick this up and bump the child's balance.
  const txnsCol = collection(
    input.user.db,
    "children",
    input.childId,
    "transactions",
  );
  await addDoc(txnsCol, {
    amount: input.rewardCents,
    type: "LODGE",
    description: input.description,
    createdByUid: input.user.uid,
    createdAt: serverTimestamp(),
  });

  // 2. Recycle the activity: status=LOCKED, advance dueDate, clear
  //    claimedAt. This mirrors Flask's `_recycle_into_next_due`.
  await updateDoc(
    doc(input.user.db, "children", input.childId, "activities", input.activityId),
    {
      status: "LOCKED",
      dueDate: Timestamp.fromDate(dueDateToUtcMidnight(input.nextDueDate)),
      claimedAt: null,
    },
  );
}

/**
 * Delete an activity doc. Parity with Flask's bounty delete — both
 * hard-remove the record.
 */
export async function deleteFirebaseActivity(input: {
  user: FirebaseUserHandle;
  childId: string;
  activityId: string;
}): Promise<void> {
  await deleteDoc(
    doc(input.user.db, "children", input.childId, "activities", input.activityId),
  );
}

/**
 * Poll `children/{id}.balance` until it matches the expected value
 * or we time out. Needed because `onTransactionCreate` (#15) is a
 * trigger and balance updates land asynchronously — a direct read
 * immediately after an `addDoc` will still see the pre-update
 * balance.
 *
 * Timeout is aggressive (5s) because the trigger runs in the
 * Functions emulator locally, which is much faster than prod cold
 * starts.
 */
export async function awaitFirebaseBalance(input: {
  user: FirebaseUserHandle;
  childId: string;
  expectedCents: number;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<NormalizedChild> {
  const deadline = Date.now() + (input.timeoutMs ?? 5_000);
  const interval = input.intervalMs ?? 100;
  let last: NormalizedChild | undefined;
  while (Date.now() < deadline) {
    const snap = await getDoc(doc(input.user.db, "children", input.childId));
    if (snap.exists()) {
      last = normalizeFirebaseChild(snap.data());
      if (last.balanceCents === input.expectedCents) return last;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `Firebase child ${input.childId} did not reach balance=${input.expectedCents} in time; last=${JSON.stringify(last)}`,
  );
}
