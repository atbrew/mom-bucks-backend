/**
 * Shared Firebase Admin SDK bootstrap.
 *
 * Every handler under `functions/src/` should import the Admin SDK
 * through this module. It ensures `initializeApp()` runs exactly once
 * per cold start (required — a second call throws) and gives us a
 * single place to inject test fakes later if needed.
 */

import { initializeApp, getApps } from "firebase-admin/app";

if (getApps().length === 0) {
  initializeApp();
}

export { getAuth } from "firebase-admin/auth";
export { getFirestore, FieldValue, FieldPath, Timestamp } from "firebase-admin/firestore";
export { getMessaging } from "firebase-admin/messaging";
export { getStorage } from "firebase-admin/storage";
