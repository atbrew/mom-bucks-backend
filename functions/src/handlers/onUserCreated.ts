/**
 * onUserCreated — Auth blocking trigger.
 *
 * Fires synchronously when a new Firebase Auth user is created
 * (any method: email/password, OAuth, Admin SDK). Creates the
 * corresponding `users/{uid}` Firestore doc with sensible defaults
 * so every client can assume the doc exists after sign-in.
 *
 * Requires Identity Platform (GCIP) to be enabled on the project.
 *
 * Idempotency: uses `set` with merge so re-fires on the same
 * user are harmless.
 */

import { beforeUserCreated } from "firebase-functions/v2/identity";
import { logger } from "firebase-functions";
import { getFirestore, FieldValue } from "../admin";

export const onUserCreated = beforeUserCreated(
  { region: "us-central1" },
  async (event) => {
    const user = event.data;
    if (!user) {
      logger.warn("[onUserCreated] no user data in event");
      return;
    }
    const db = getFirestore();

    await db.doc(`users/${user.uid}`).set(
      {
        displayName: user.displayName ?? user.email?.split("@")[0] ?? "",
        email: user.email ?? "",
        photoUrl: null,
        fcmTokens: [],
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    logger.info("[onUserCreated] user doc created", {
      uid: user.uid,
      email: user.email,
    });
  },
);
