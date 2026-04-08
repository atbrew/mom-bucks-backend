/**
 * Shared FCM fan-out helper — used by every function that needs to
 * push a notification to the parents of a child.
 *
 * Why this lives in its own module: both `sendHabitNotifications`
 * (#17) and `sendChildPush` (#18) need the exact same sequence —
 * "given a set of parent uids and a payload, collect their
 * `fcmTokens`, multicast via FCM, and reap any tokens FCM told us
 * are dead." Before extraction that block was duplicated verbatim in
 * two places; Gemini flagged it on PR #21 and, separately, flagged
 * the sequential `await` on the cleanup loop. Pulling the helper out
 * lets us fix both at once and keeps the two handlers focused on
 * their own decision logic.
 *
 * Stale token reaping: FCM returns one of two error codes when a
 * token is permanently dead —
 *   - `messaging/registration-token-not-registered`
 *   - `messaging/invalid-registration-token`
 * We `arrayRemove` those from the owning user doc so subsequent
 * runs stop trying. The per-user update calls are parallelised
 * (Promise.all) rather than awaited sequentially — Gemini's #3
 * comment on PR #21.
 */

import { FieldValue, getMessaging } from "../admin";

export interface PushPayload {
  title: string;
  body: string;
  /** Drives client-side routing; passed through as `data.kind`. */
  kind: string;
  /** Drives client-side routing; passed through as `data.childId`. */
  childId: string;
}

export interface FanOutResult {
  tokensAttempted: number;
  notificationsSent: number;
  tokensCleaned: number;
}

/**
 * Given the Firestore handle, a set of parent uids, and a notification
 * payload, fan out a multicast and reap any stale tokens.
 *
 * This does NOT read the child doc — callers are expected to have
 * already resolved `parentUids` (usually by reading the child) so the
 * helper stays focused on just the messaging + cleanup side.
 */
export async function fanOutToParents(
  db: FirebaseFirestore.Firestore,
  parentUids: string[],
  payload: PushPayload,
): Promise<FanOutResult> {
  const result: FanOutResult = {
    tokensAttempted: 0,
    notificationsSent: 0,
    tokensCleaned: 0,
  };
  if (parentUids.length === 0) return result;

  const parentSnaps = await Promise.all(
    parentUids.map((uid) => db.doc(`users/${uid}`).get()),
  );
  const allTokens: string[] = [];
  const tokenOwnerByToken = new Map<string, string>();
  for (let i = 0; i < parentSnaps.length; i += 1) {
    const snap = parentSnaps[i];
    if (!snap) continue;
    const uid = parentUids[i];
    if (!uid) continue;
    const tokens = (snap.get("fcmTokens") as string[] | undefined) ?? [];
    for (const tok of tokens) {
      allTokens.push(tok);
      tokenOwnerByToken.set(tok, uid);
    }
  }
  if (allTokens.length === 0) return result;

  result.tokensAttempted = allTokens.length;

  const response = await getMessaging().sendEachForMulticast({
    tokens: allTokens,
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data: {
      kind: payload.kind,
      childId: payload.childId,
    },
  });
  result.notificationsSent = response.successCount;

  // Group dead tokens by owning user.
  const deadTokensByOwner = new Map<string, Set<string>>();
  response.responses.forEach((resp, i) => {
    if (resp.success) return;
    const code = resp.error?.code ?? "";
    if (
      code === "messaging/registration-token-not-registered" ||
      code === "messaging/invalid-registration-token"
    ) {
      const tok = allTokens[i];
      if (!tok) return;
      const owner = tokenOwnerByToken.get(tok);
      if (!owner) return;
      const set = deadTokensByOwner.get(owner) ?? new Set();
      set.add(tok);
      deadTokensByOwner.set(owner, set);
    }
  });

  // Parallelise per-user cleanup. Each entry is an independent
  // document update and they don't need to run in any particular
  // order.
  const cleanupTasks = Array.from(deadTokensByOwner.entries()).map(
    async ([uid, deadSet]) => {
      const dead = Array.from(deadSet);
      await db.doc(`users/${uid}`).update({
        fcmTokens: FieldValue.arrayRemove(...dead),
      });
      return dead.length;
    },
  );
  const cleanedCounts = await Promise.all(cleanupTasks);
  result.tokensCleaned = cleanedCounts.reduce((sum, n) => sum + n, 0);

  return result;
}
