/**
 * Test user pair factory.
 *
 * Each contract test operates on a **parity pair**: one user on the
 * Flask side and one on the Firebase side, both created with the
 * same email so logs/debugging stay coherent across backends.
 *
 * The pair is independent state (Flask and Firebase don't share
 * anything at the data layer); the email match is purely a naming
 * convention for humans. Neither side knows about the other.
 *
 * Emails are generated as `contract-<slug>-<n>-<timestamp>@mombucks-contract.dev`
 * so each test run gets a fresh namespace. Flask's Postgres is wiped
 * by the ephemeral volume between runs; the Auth emulator in
 * Firestore loses state when the emulator stops.
 *
 * Why `.dev` and not `.test` / `.example`: Flask uses the Python
 * `email-validator` package, which rejects RFC 2606 reserved TLDs
 * (`.test`, `.example`, `.invalid`, `.localhost`) as "special-use or
 * reserved". `.dev` is a real ICANN gTLD so it passes validation,
 * and `mombucks-contract.dev` is namespaced enough that it will
 * never collide with a real address if one of these emails somehow
 * leaked out of the test sandbox.
 */

import {
  createFlaskUser,
  createFlaskChild,
} from "./flaskClient";
import {
  createFirebaseUser,
  createFirebaseChild,
  type FirebaseUserHandle,
} from "./firebaseClient";

export interface ParityUser {
  email: string;
  password: string;
  name: string;
  firebase: FirebaseUserHandle;
}

export interface ParityPair {
  user: ParityUser;
  /** Flask child ID — opaque string, use with flaskClient calls. */
  flaskChildId: string;
  /** Firebase child ID — different from flaskChildId. */
  firebaseChildId: string;
  /** Human-readable child name shared between both backends. */
  childName: string;
  /** Release Firebase app instances created during setup. */
  cleanup(): Promise<void>;
}

const CONTRACT_PASSWORD = "contract-test-password";
let counter = 0;

/**
 * Generate a stable-ish email that's unique per test case in a run.
 * Includes a monotonic counter + timestamp so parallel test files
 * don't collide even if two use the same slug.
 */
export function makeContractEmail(slug: string): string {
  counter += 1;
  return `contract-${slug}-${counter}-${Date.now()}@mombucks-contract.dev`;
}

/**
 * Create a standalone parity user — one Flask account + one Firebase
 * account sharing the same email, no children attached. Used for
 * negative-parity cases (cross-parent reads, unauthorised writes)
 * where the test needs a "second unrelated parent" that does NOT
 * own any of the child docs the assertion touches.
 *
 * Callers are responsible for calling `user.firebase.cleanup()` at
 * test teardown to release the Firebase app instance.
 */
export async function createParityUser(input: {
  slug: string;
}): Promise<ParityUser> {
  const email = makeContractEmail(input.slug);
  const name = `Contract ${input.slug}`;
  // Flask first, same ordering rationale as createParityPair.
  await createFlaskUser({ email, password: CONTRACT_PASSWORD, name });
  const firebase = await createFirebaseUser({
    email,
    password: CONTRACT_PASSWORD,
    name,
  });
  return { email, password: CONTRACT_PASSWORD, name, firebase };
}

/**
 * Create a parity pair: one Flask user, one Firebase user, one
 * child on each side. Both children share the same `name` so
 * parity assertions compare like-for-like. Balances start at zero
 * on both sides.
 */
export async function createParityPair(input: {
  slug: string;
  childName: string;
}): Promise<ParityPair> {
  const user = await createParityUser({ slug: input.slug });

  const flaskChildId = await createFlaskChild({
    impersonateEmail: user.email,
    name: input.childName,
    dateOfBirth: "2018-06-01",
  });

  const firebaseChildId = await createFirebaseChild({
    user: user.firebase,
    name: input.childName,
  });

  return {
    user,
    flaskChildId,
    firebaseChildId,
    childName: input.childName,
    async cleanup() {
      await user.firebase.cleanup();
    },
  };
}
