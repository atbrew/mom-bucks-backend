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
  collection,
  addDoc,
  type Firestore,
  FirestoreError,
} from "firebase/firestore";
import {
  NormalizedChild,
  NormalizedTransaction,
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
  };
  try {
    await addDoc(txnsCol, payload);
    return {
      ok: true,
      transaction: normalizeFirebaseTransaction(payload),
    };
  } catch (err) {
    if (err instanceof FirestoreError && err.code === "permission-denied") {
      return { ok: false, errorCode: err.code };
    }
    throw err;
  }
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
