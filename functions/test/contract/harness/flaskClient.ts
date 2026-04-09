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
  NormalizedChild,
  NormalizedTransaction,
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
