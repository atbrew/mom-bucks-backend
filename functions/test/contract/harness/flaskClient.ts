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
  method: "GET" | "POST" | "PUT" | "DELETE",
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
  // Integer division by 100 keeps the value exact for any cents value.
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
    // Drain the body so the connection can close cleanly; we don't
    // use it for anything but it helps diagnose failures in CI logs.
    await res.text().catch(() => "");
    return { ok: false, status: res.status };
  }
  const body = (await res.json()) as { transaction: unknown };
  return {
    ok: true,
    status: res.status,
    transaction: normalizeFlaskTransaction(body.transaction),
  };
}
