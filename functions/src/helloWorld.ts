import { onCall, HttpsError } from "firebase-functions/v2/https";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

// Ensure the Admin SDK is initialised exactly once. Other handlers that land
// later (Phase 4) will reuse this guard.
if (getApps().length === 0) {
  initializeApp();
}

/**
 * helloWorld — permanent health probe / end-to-end smoke test.
 *
 * Issue #8. Purpose:
 *   1. Prove the full deploy pipeline works: repo → `firebase deploy`
 *      → live callable in `mom-bucks-dev-b3772`.
 *   2. Give us a cheap, always-available round-trip canary we can hit
 *      from a workstation or CI to confirm the Functions runtime is up.
 *
 * Behaviour:
 *   - Writes a doc to `hello/{timestamp}` via Admin SDK (bypasses security
 *     rules) so we can confirm Firestore connectivity from inside the
 *     Functions runtime.
 *   - Returns `{ ok: true, ts: <ISO string>, runtime: "node20", project }`
 *     so the caller can verify the request was handled by the expected
 *     project and runtime.
 *   - Does not require the caller to be authenticated — the rules in
 *     #5 leave `hello/{docId}` open to authenticated clients, but the
 *     Function itself uses Admin and is callable unauthenticated so a
 *     plain `curl` can exercise it. (Switch to auth-required in #10 if
 *     we decide the smoke test should prove auth too.)
 */
export const helloWorld = onCall(
  { region: "us-central1" },
  async (request) => {
    const project =
      process.env.GCLOUD_PROJECT ?? process.env.GCP_PROJECT ?? "unknown";

    try {
      const db = getFirestore();
      const ref = db.collection("hello").doc();
      await ref.set({
        calledAt: FieldValue.serverTimestamp(),
        callerUid: request.auth?.uid ?? null,
      });
    } catch (err) {
      // If Firestore is reachable from the runtime this should never fire.
      // Surface a clean error so the caller knows the runtime is up but
      // Firestore plumbing is broken.
      throw new HttpsError(
        "internal",
        `firestore write failed: ${(err as Error).message}`,
      );
    }

    return {
      ok: true,
      ts: new Date().toISOString(),
      runtime: "node20",
      project,
    };
  },
);
