import { onRequest } from "firebase-functions/v2/https";
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
 *      → live HTTPS endpoint in `mom-bucks-dev-b3772`.
 *   2. Give us a cheap, always-available round-trip canary we can hit
 *      from a workstation, CI, or `curl` to confirm the Functions
 *      runtime is up and Firestore is reachable.
 *
 * Deliberately an `onRequest` (HTTPS) function, not an `onCall`
 * (Firebase callable):
 *   - Callables require a Firebase Auth ID token, which means you can't
 *     hit them from a plain `curl` without spinning up a Firebase client.
 *     That defeats the point of a smoke test you can run from a
 *     terminal.
 *   - The real handlers (Phase 4 — acceptInvite, removeParentFromChildren)
 *     will be `onCall` because they enforce per-user auth. helloWorld is
 *     intentionally different.
 *
 * The endpoint is public (`invoker: public`). The blast radius is
 * bounded:
 *   - Each call writes ONE doc to `hello/{docId}`.
 *   - No PII, no auth state changes.
 *   - The `hello/` collection is hidden behind a deny-all rule (#5);
 *     only the Admin SDK from inside this function can write to it.
 *   - Budget alert ($10/month per #2) catches any abuse.
 */
export const helloWorld = onRequest(
  { region: "us-central1", invoker: "public" },
  async (req, res) => {
    const project =
      process.env.GCLOUD_PROJECT ?? process.env.GCP_PROJECT ?? "unknown";

    try {
      const db = getFirestore();
      const ref = db.collection("hello").doc();
      await ref.set({
        calledAt: FieldValue.serverTimestamp(),
        method: req.method,
        userAgent: req.get("user-agent") ?? null,
      });
    } catch (err) {
      // If Firestore is reachable from the runtime this should never fire.
      // Surface a clean error so the caller knows the runtime is up but
      // Firestore plumbing is broken.
      res.status(500).json({
        ok: false,
        error: `firestore write failed: ${(err as Error).message}`,
      });
      return;
    }

    res.status(200).json({
      ok: true,
      ts: new Date().toISOString(),
      runtime: "node22",
      project,
    });
  },
);
