/**
 * Flask API client used by the contract test suite.
 *
 * Deliberately narrow: this module only exposes the operations the
 * contract tests actually exercise (transactions + balance math).
 * Anything else — co-parenting flows, vault, activities, habit
 * notifications — lives in a future follow-up PR if/when the
 * contract scope widens.
 *
 * Auth model
 * ----------
 * The Flask test-auth shim is gated on `TEST_AUTH_BYPASS_ENABLED=1`
 * (set by the docker-compose override in this directory). Once
 * enabled, any request carrying `X-Test-Auth-User: <email>` is
 * treated as if that user had logged in via JWT. We exploit this to
 * impersonate pre-seeded users without storing real passwords or
 * login tokens in the harness.
 *
 * Users still need to *exist* in the Flask DB before the shim can
 * resolve their email — the shim does not auto-create. See
 * `createUser()` below, which hits the public `/api/v1/auth/register`
 * endpoint (no auth required for that route) to seed the DB.
 *
 * Wire format
 * -----------
 * Money on the Flask wire is **dollars-as-float** (`Numeric(10,2)`).
 * This client accepts `amountCents` at the function boundary and
 * converts to dollars-float just before sending, so the contract
 * tests never have to touch the dollars representation. Responses
 * go through `normalize.ts` to land back in cents.
 */

import { FLASK_BASE_URL } from "./bootFlask";
import {
  NormalizedActivity,
  NormalizedChild,
  NormalizedTransaction,
  normalizeFlaskActivity,
  normalizeFlaskChild,
  normalizeFlaskTransaction,
} from "./normalize";

const TEST_AUTH_HEADER = "X-Test-Auth-User";

class FlaskApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly responseBody: string,
  ) {
    super(`Flask ${path} → ${status}: ${responseBody}`);
    this.name = "FlaskApiError";
  }
}

/**
 * Wrapper around fetch() that throws FlaskApiError on non-2xx and
 * returns the parsed JSON body on success. Keeps call sites tidy.
 */
async function callFlask<T = unknown>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  opts: { body?: unknown; impersonateEmail?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.impersonateEmail) {
    headers[TEST_AUTH_HEADER] = opts.impersonateEmail;
  }
  const res = await fetch(`${FLASK_BASE_URL}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new FlaskApiError(res.status, path, text);
  }
  return text.length === 0 ? (undefined as T) : (JSON.parse(text) as T);
}

export interface FlaskCreateUserInput {
  email: string;
  password: string;
  name: string;
}

/**
 * Register a Flask user via the public /auth/register endpoint.
 * Returns the user's email (which is what the test-auth shim keys on).
 */
export async function createFlaskUser(input: FlaskCreateUserInput): Promise<string> {
  await callFlask("POST", "/api/v1/auth/register", {
    body: {
      email: input.email,
      password: input.password,
      name: input.name,
    },
  });
  return input.email;
}

export interface FlaskCreateChildInput {
  impersonateEmail: string;
  name: string;
  /** ISO date string, e.g. "2018-06-01". Flask requires this on create. */
  dateOfBirth: string;
}

/**
 * Create a child under the impersonated parent. Returns the Flask
 * child ID (opaque to the caller — only used for subsequent calls).
 */
export async function createFlaskChild(input: FlaskCreateChildInput): Promise<string> {
  const res = await callFlask<{ id: string }>("POST", "/api/v1/children", {
    impersonateEmail: input.impersonateEmail,
    body: {
      name: input.name,
      date_of_birth: input.dateOfBirth,
    },
  });
  return res.id;
}

/**
 * Read a child and normalise into the common shape.
 */
export async function getFlaskChild(
  impersonateEmail: string,
  childId: string,
): Promise<NormalizedChild> {
  const res = await callFlask<unknown>("GET", `/api/v1/children/${childId}`, {
    impersonateEmail,
  });
  return normalizeFlaskChild(res);
}

export interface FlaskGetChildResult {
  ok: boolean;
  status: number;
  child?: NormalizedChild;
}

/**
 * Non-throwing variant of `getFlaskChild`. Used when a test needs to
 * observe a 404 (post-delete assertions, cross-parent reads) without
 * wrapping every call site in try/catch. Mirrors the shape of
 * `createFlaskTransaction`'s `{ok, status}` return.
 *
 * Note: Flask collapses "not found" and "not your child" into a
 * single 404 — see `require_child_for_parent` in the Flask children
 * API (`web-app/src/mombucks/api/children.py`). A caller that needs
 * to disambiguate the two cases can't, and shouldn't try to: both
 * are "the caller cannot see this child" from the parity standpoint.
 */
export async function tryGetFlaskChild(input: {
  impersonateEmail: string;
  childId: string;
}): Promise<FlaskGetChildResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [TEST_AUTH_HEADER]: input.impersonateEmail,
  };
  const res = await fetch(
    `${FLASK_BASE_URL}/api/v1/children/${input.childId}`,
    { method: "GET", headers },
  );
  if (!res.ok) {
    return { ok: false, status: res.status };
  }
  const body = (await res.json()) as unknown;
  return {
    ok: true,
    status: res.status,
    child: normalizeFlaskChild(body),
  };
}

export interface FlaskRenameChildInput {
  impersonateEmail: string;
  childId: string;
  name: string;
}

/**
 * Rename a child via `PATCH /api/v1/children/:id`. Flask accepts both
 * `name` and `date_of_birth` on this endpoint; we only send `name`
 * because the contract test never changes a DOB. The PATCH endpoint
 * supports an optional `If-Match` header for optimistic concurrency
 * but the contract tests never hit a concurrent-rename case, so we
 * omit it and let Flask apply the update unconditionally.
 */
export async function renameFlaskChild(
  input: FlaskRenameChildInput,
): Promise<NormalizedChild> {
  const res = await callFlask<unknown>(
    "PATCH",
    `/api/v1/children/${input.childId}`,
    {
      impersonateEmail: input.impersonateEmail,
      body: { name: input.name },
    },
  );
  return normalizeFlaskChild(res);
}

/**
 * Delete a child. Flask returns 204 No Content on success. The Flask
 * handler cascades explicitly (deletes transactions, vault rows,
 * activities, etc. before the child row itself), so a follow-up GET
 * on either the child or any of its subresources is guaranteed to
 * 404.
 */
export async function deleteFlaskChild(input: {
  impersonateEmail: string;
  childId: string;
}): Promise<void> {
  await callFlask<void>("DELETE", `/api/v1/children/${input.childId}`, {
    impersonateEmail: input.impersonateEmail,
  });
}

export interface FlaskCreateTransactionInput {
  impersonateEmail: string;
  childId: string;
  type: "LODGE" | "WITHDRAW";
  amountCents: number;
  description: string;
}

export interface FlaskCreateTransactionResult {
  /** Did the write succeed? Used so overspend tests can assert "denied". */
  ok: boolean;
  /** HTTP status code, whether success or failure. */
  status: number;
  /** Only populated when `ok === true`. */
  transaction?: NormalizedTransaction;
}

/**
 * Create a transaction against a child. Does NOT throw on 4xx — the
 * overspend contract test deliberately sends an invalid WITHDRAW and
 * asserts a rejection, so the caller needs to observe the status
 * code directly rather than fight with try/catch.
 */
export async function createFlaskTransaction(
  input: FlaskCreateTransactionInput,
): Promise<FlaskCreateTransactionResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [TEST_AUTH_HEADER]: input.impersonateEmail,
  };
  // Flask wire format: dollars as float. amountCents 1050 → amount 10.5.
  // Division by 100 keeps the value close enough for Flask's Numeric(10,2)
  // to round correctly; `centsFromDollars` in normalize.ts uses Math.round
  // on the return trip to absorb any IEEE-754 noise.
  const amountDollars = input.amountCents / 100;
  const res = await fetch(
    `${FLASK_BASE_URL}/api/v1/children/${input.childId}/transactions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: input.type,
        amount: amountDollars,
        description: input.description,
      }),
    },
  );
  if (!res.ok) {
    // Capture the body for CI log diagnostics (overspend tests send a
    // deliberate 4xx, so we can't throw; we just record the reason).
    const errBody = await res.text().catch(() => "");
    if (errBody) {
      console.error(`[flaskClient] ${input.type} → ${res.status}: ${errBody}`);
    }
    return { ok: false, status: res.status };
  }
  const body = (await res.json()) as { transaction: unknown };
  return {
    ok: true,
    status: res.status,
    transaction: normalizeFlaskTransaction(body.transaction),
  };
}

// ─── Activities ─────────────────────────────────────────────────────
//
// Flask exposes bounty-style activities through
// `POST /api/v1/children/:child_id/activities` (create),
// `GET    .../activities`                      (list + lazy generate),
// `POST   .../activities/:aid/claim`           (claim + recycle),
// `DELETE .../activities/:aid`                 (delete bounty).
//
// Only BOUNTY_RECURRING activities are user-creatable/deletable
// (see `bounty_id is None` guards in `activities.py`). ALLOWANCE and
// INTEREST activities are generated server-side and are out of scope
// for the contract suite — there's no Firebase-side equivalent of
// lazy allowance generation yet, and parity-testing a cron is a
// different kind of test.

export interface FlaskCreateActivityInput {
  impersonateEmail: string;
  childId: string;
  description: string;
  amountCents: number;
  /** Must be DAILY/WEEKLY/FORTNIGHTLY/MONTHLY — Flask rejects anything else. */
  recurrence: "DAILY" | "WEEKLY" | "FORTNIGHTLY" | "MONTHLY";
  /** YYYY-MM-DD. Flask defaults to "today" if omitted, which hurts
   * parity determinism; the contract test always pins an explicit date. */
  dueDate: string;
}

export interface FlaskCreatedActivity {
  /** Opaque Flask activity ID — used for subsequent claim/delete calls. */
  id: string;
  activity: NormalizedActivity;
}

/**
 * Create a BOUNTY_RECURRING activity. Returns both the raw Flask ID
 * (needed to call claim/delete later) and the normalized shape for
 * parity assertions.
 */
export async function createFlaskActivity(
  input: FlaskCreateActivityInput,
): Promise<FlaskCreatedActivity> {
  const res = await callFlask<unknown>(
    "POST",
    `/api/v1/children/${input.childId}/activities`,
    {
      impersonateEmail: input.impersonateEmail,
      body: {
        description: input.description,
        amount: input.amountCents / 100,
        recurrence: input.recurrence,
        due_date: input.dueDate,
      },
    },
  );
  const obj = res as { id?: unknown };
  if (typeof obj.id !== "string") {
    throw new TypeError(
      `createFlaskActivity: missing id in response: ${JSON.stringify(res)}`,
    );
  }
  return {
    id: obj.id,
    activity: normalizeFlaskActivity(res),
  };
}

/**
 * List activities for a child via `GET /api/v1/children/:id/activities`.
 *
 * Note: the list endpoint triggers lazy generation of ALLOWANCE
 * activities if the child has an `allowance_config`. The contract
 * tests never set one up, so the result is deterministically
 * "whatever bounties the test wrote, in whatever server order".
 * The caller is expected to search by title/id, not index.
 */
export async function listFlaskActivities(input: {
  impersonateEmail: string;
  childId: string;
}): Promise<NormalizedActivity[]> {
  const res = await callFlask<{ activities: unknown[] }>(
    "GET",
    `/api/v1/children/${input.childId}/activities`,
    { impersonateEmail: input.impersonateEmail },
  );
  return res.activities.map(normalizeFlaskActivity);
}

export interface FlaskListActivitiesResult {
  ok: boolean;
  status: number;
  activities?: NormalizedActivity[];
}

/**
 * Non-throwing list for the non-parent access test. Flask returns
 * 404 from `require_child_for_parent` when the caller isn't a parent
 * of the child, matching the `tryGetFlaskChild` shape.
 */
export async function tryListFlaskActivities(input: {
  impersonateEmail: string;
  childId: string;
}): Promise<FlaskListActivitiesResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [TEST_AUTH_HEADER]: input.impersonateEmail,
  };
  const res = await fetch(
    `${FLASK_BASE_URL}/api/v1/children/${input.childId}/activities`,
    { method: "GET", headers },
  );
  if (!res.ok) {
    return { ok: false, status: res.status };
  }
  const body = (await res.json()) as { activities: unknown[] };
  return {
    ok: true,
    status: res.status,
    activities: body.activities.map(normalizeFlaskActivity),
  };
}

export interface FlaskClaimActivityResult {
  activity: NormalizedActivity | null;
  newBalanceCents: number;
  transaction: NormalizedTransaction;
}

/**
 * Claim a READY activity. Flask does the full server-side dance:
 * creates a LODGE transaction, bumps the child balance, and recycles
 * the activity (status → LOCKED, due_date advanced by recurrence).
 * The response body carries all three pieces of that outcome.
 *
 * The `activity` field is null only when the activity had no
 * recurrence (Flask deletes one-off bounties on claim). The contract
 * test always creates recurring bounties, so it gets a recycled
 * activity back, but the return type allows for the other shape to
 * keep the helper honest.
 */
export async function claimFlaskActivity(input: {
  impersonateEmail: string;
  childId: string;
  activityId: string;
}): Promise<FlaskClaimActivityResult> {
  const res = await callFlask<{
    activity: unknown;
    new_balance: unknown;
    transaction: unknown;
  }>(
    "POST",
    `/api/v1/children/${input.childId}/activities/${input.activityId}/claim`,
    { impersonateEmail: input.impersonateEmail, body: {} },
  );
  if (typeof res.new_balance !== "number") {
    throw new TypeError(
      `claimFlaskActivity: missing new_balance: ${JSON.stringify(res)}`,
    );
  }
  return {
    activity: res.activity ? normalizeFlaskActivity(res.activity) : null,
    newBalanceCents: Math.round(res.new_balance * 100),
    transaction: normalizeFlaskTransaction(res.transaction),
  };
}

/**
 * Delete a bounty activity. Flask returns 204 on success. Flask
 * rejects with 404 if the target is an ALLOWANCE/INTEREST activity
 * (bounty_id null) — the contract test only ever targets bounties.
 */
export async function deleteFlaskActivity(input: {
  impersonateEmail: string;
  childId: string;
  activityId: string;
}): Promise<void> {
  await callFlask<void>(
    "DELETE",
    `/api/v1/children/${input.childId}/activities/${input.activityId}`,
    { impersonateEmail: input.impersonateEmail },
  );
}

// ─── Invites ──────────────────────────────────────────────────────
//
// Flask invites live at `/api/v1/family/invites`. They're keyed by
// invite `id` (UUID) and scoped per-child like Firebase's. The
// accept endpoint checks email match + PENDING status but does NOT
// check that the inviter is still a parent (see the
// revoked-parent-loophole test for the parity divergence).

export interface FlaskCreatedInvite {
  id: string;
  childId: string;
  status: string;
}

/**
 * Issue a co-parenting invite on Flask. Returns the Flask invite ID
 * (needed for accept/revoke). The invitee must be a registered
 * Flask user whose email matches `inviteeEmail`.
 */
export async function createFlaskInvite(input: {
  impersonateEmail: string;
  childId: string;
  inviteeEmail: string;
}): Promise<FlaskCreatedInvite> {
  const res = await callFlask<{ invite: unknown }>(
    "POST",
    "/api/v1/family/invites",
    {
      impersonateEmail: input.impersonateEmail,
      body: {
        child_id: input.childId,
        invitee_email: input.inviteeEmail,
      },
    },
  );
  const invite = res.invite as {
    id?: unknown;
    child_id?: unknown;
    status?: unknown;
  };
  if (typeof invite.id !== "string") {
    throw new TypeError(
      `createFlaskInvite: missing id: ${JSON.stringify(res)}`,
    );
  }
  return {
    id: invite.id,
    childId: invite.child_id as string,
    status: invite.status as string,
  };
}

export interface FlaskAcceptInviteResult {
  ok: boolean;
  status: number;
}

/**
 * Accept a Flask invite. Non-throwing so the contract test can
 * observe 404 / 403 / 409 rejections without try/catch.
 */
export async function acceptFlaskInvite(input: {
  impersonateEmail: string;
  inviteId: string;
}): Promise<FlaskAcceptInviteResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [TEST_AUTH_HEADER]: input.impersonateEmail,
  };
  const res = await fetch(
    `${FLASK_BASE_URL}/api/v1/family/invites/${input.inviteId}/accept`,
    { method: "POST", headers, body: JSON.stringify({}) },
  );
  return { ok: res.ok, status: res.status };
}

/**
 * Revoke (delete) a Flask invite. Flask sets status to REVOKED
 * and returns 204. Used for the stale-invite rejection test.
 */
export async function revokeFlaskInvite(input: {
  impersonateEmail: string;
  inviteId: string;
}): Promise<void> {
  await callFlask<void>(
    "DELETE",
    `/api/v1/family/invites/${input.inviteId}`,
    { impersonateEmail: input.impersonateEmail },
  );
}

/**
 * Remove a family member from a child on Flask. Used by the
 * revoked-parent-loophole test.
 *
 * Flask requires the caller to be an admin of the child, and
 * refuses to remove the primary parent (`child.parent_id`).
 * Returns nothing — the DELETE response has no body.
 */
export async function removeFlaskFamilyMember(input: {
  impersonateEmail: string;
  childId: string;
  memberId: string;
}): Promise<void> {
  await callFlask<void>(
    "DELETE",
    `/api/v1/family/children/${input.childId}/members/${input.memberId}`,
    { impersonateEmail: input.impersonateEmail },
  );
}

/**
 * Non-throwing variant of `removeFlaskFamilyMember`. Returns
 * `{ ok, status }` so the caller can assert on rejection codes
 * (e.g. 403 for primary-parent removal).
 */
export async function tryRemoveFlaskFamilyMember(input: {
  impersonateEmail: string;
  childId: string;
  memberId: string;
}): Promise<{ ok: boolean; status: number }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [TEST_AUTH_HEADER]: input.impersonateEmail,
  };
  const res = await fetch(
    `${FLASK_BASE_URL}/api/v1/family/children/${input.childId}/members/${input.memberId}`,
    { method: "DELETE", headers },
  );
  return { ok: res.ok, status: res.status };
}

/**
 * List family members of a child. Used to find a co-parent's
 * membership ID for the remove call.
 */
export async function listFlaskFamilyMembers(input: {
  impersonateEmail: string;
  childId: string;
}): Promise<Array<{ id: string; userId: string }>> {
  const res = await callFlask<{ members: unknown[] }>(
    "GET",
    `/api/v1/family/children/${input.childId}/members`,
    { impersonateEmail: input.impersonateEmail },
  );
  return res.members.map((m) => {
    const obj = m as { id?: unknown; user_id?: unknown };
    if (typeof obj.id !== "string" && typeof obj.id !== "number") {
      throw new TypeError(`listFlaskFamilyMembers: member missing id`);
    }
    if (typeof obj.user_id !== "string" && typeof obj.user_id !== "number") {
      throw new TypeError(`listFlaskFamilyMembers: member missing user_id`);
    }
    return {
      id: String(obj.id),
      userId: String(obj.user_id),
    };
  });
}
