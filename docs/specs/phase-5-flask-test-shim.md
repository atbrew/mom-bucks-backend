# Flask test-auth shim — Phase 5 contract-test prerequisite

**Target repo:** `atbrew/mom-bucks` (the Flask + Postgres backend).
**Target directory:** `web-app/` (the Flask app).
**Why this file lives in the other repo:** it's the handoff brief. Paste
this into a session against `atbrew/mom-bucks`, or hand it to the mom-bucks
API developer directly.

---

## What this unblocks

[`docs/firebase-migration-plan.md → Phase 5`](../firebase-migration-plan.md) —
the side-by-side contract test suite that drives both Flask and Firebase
with identical inputs and asserts parity. The contract tests live in
`atbrew/mom-bucks-backend/functions/test/contract/` and are **blocked on
this Flask change.**

The contract tests need to exercise Flask routes without managing real
JWT login state — logging in for every test, re-authing on refresh, and
pre-seeding bcrypt passwords is noise that doesn't contribute to what
we're actually testing (balance math, cascade deletes, activity claims,
etc.). The shim described below lets the test harness impersonate a
pre-seeded user by setting a single environment flag + a per-request
header.

**Important context:** Mom Bucks is still in development mode. There is
no production user data to protect, and no live deployment serving real
families. This shim's threat model is "don't ship it to prod by
accident", not "defend against abuse". Keep it simple.

---

## The contract

The Flask app must support a **two-gate test-auth mode**:

### Gate 1 — `TEST_AUTH_BYPASS_ENABLED` env var (boot-time)

When this env var is set to a truthy value (`1`, `true`, `yes` — pick
whatever matches existing conventions) at Flask boot:

- The test-auth pathway becomes available on all requests.
- A large warning is logged at startup:
  `WARNING: TEST_AUTH_BYPASS_ENABLED is set — JWT auth can be bypassed via X-Test-Auth-User header. DO NOT USE IN PRODUCTION.`
- Regular JWT auth continues to work exactly as today. This is additive.

When the env var is **not** set, behaviour is unchanged — the shim is
invisible and all `@jwt_required()` routes reject unauthenticated
requests as they always have.

### Gate 2 — `X-Test-Auth-User: <email>` request header

Only honored when `TEST_AUTH_BYPASS_ENABLED` is set. Per-request header
that selects which user to impersonate:

- Value is an **email address** matching an existing row in the `users`
  table.
- When present and the email resolves to a user, the request proceeds
  as if that user had JWT'd in successfully. `get_jwt_identity()` (or
  whatever the current per-request user accessor is) returns that
  user's id exactly as it would after a normal login.
- When present but the email does not match any user, return **401
  Unauthorized** with a clear error body.
- When absent, fall through to normal JWT validation.
- Never read this header at all unless `TEST_AUTH_BYPASS_ENABLED` is
  set — defence-in-depth.

### Gate 3 — production refusal

This is the critical safety gate.

- If `TEST_AUTH_BYPASS_ENABLED` is set **and** `FLASK_ENV` (or whatever
  this project uses to identify prod — `APP_ENV`, `MOMBUCKS_ENV`, etc.)
  is `production`, the Flask app must **refuse to boot**. Raise an
  exception during app creation with a clear message:
  `TEST_AUTH_BYPASS_ENABLED cannot be set in production environments`.
- This check runs in `create_app()` or whatever the equivalent is, not
  in a request handler. It must fail fast at startup, before the first
  request.

---

## Why a header and not a second env var

The original sketch used `TEST_AUTH_BYPASS=<uid>` — env var only, fixed
uid for the whole Flask process. That was rejected because the contract
tests need to switch between users mid-run (e.g. the co-parenting tests
create two parents and assert that removing one doesn't lose access to
the other). Restarting Flask between tests is unworkable.

The header approach lets the test harness impersonate different users
on different requests without restarting, while the env var gates
whether the feature exists at all.

---

## Database pre-seeding — what the test harness will do

The contract-test harness running on the `atbrew/mom-bucks-backend`
side is responsible for creating the users that will be impersonated
via the shim. It will do one of:

- **Option A — POST `/api/v1/auth/register`:** create users via the
  public register endpoint (no auth required for that route today),
  then use their email addresses in the `X-Test-Auth-User` header on
  subsequent requests. This is the simplest path and requires **no
  changes** to the shim or Flask data access.

- **Option B — direct SQL:** the harness connects to the test Postgres
  directly and inserts user rows with deterministic emails. Faster but
  couples the harness to the `users` schema. Only considered if Option
  A is too slow.

The shim itself does not need to know anything about how the user rows
got there — it just looks them up by email.

---

## Acceptance criteria

Add the following **pytest** cases to the existing Flask test suite
(under `web-app/tests/`). They must all pass before this is considered
shippable.

### Test 1 — Shim off (default)

```python
def test_shim_off_rejects_unauthenticated(client):
    # TEST_AUTH_BYPASS_ENABLED is not set
    response = client.get("/api/v1/me", headers={"X-Test-Auth-User": "alice@example.com"})
    assert response.status_code == 401
```

The `X-Test-Auth-User` header must be completely ignored when the env
var is off.

### Test 2 — Shim on, header resolves to real user

```python
def test_shim_on_accepts_known_user(client_with_shim_enabled, seeded_user):
    # TEST_AUTH_BYPASS_ENABLED=1 for this fixture; seeded_user is a users row with email alice@example.com
    response = client_with_shim_enabled.get(
        "/api/v1/me",
        headers={"X-Test-Auth-User": "alice@example.com"},
    )
    assert response.status_code == 200
    assert response.json["user"]["email"] == "alice@example.com"
```

### Test 3 — Shim on, header points at unknown user

```python
def test_shim_on_rejects_unknown_email(client_with_shim_enabled):
    response = client_with_shim_enabled.get(
        "/api/v1/me",
        headers={"X-Test-Auth-User": "ghost@example.com"},
    )
    assert response.status_code == 401
```

### Test 4 — Shim on, no header → falls through to normal JWT

```python
def test_shim_on_falls_through_to_jwt(client_with_shim_enabled):
    # No X-Test-Auth-User header, no Authorization header
    response = client_with_shim_enabled.get("/api/v1/me")
    assert response.status_code == 401  # Same as today
```

This confirms the shim doesn't accidentally grant access to
unauthenticated requests.

### Test 5 — Shim on + real JWT still works

```python
def test_shim_on_does_not_break_real_jwt(client_with_shim_enabled, seeded_user, jwt_token_for):
    token = jwt_token_for(seeded_user)
    response = client_with_shim_enabled.get(
        "/api/v1/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
```

Shim-on must not regress the normal JWT code path.

### Test 6 — Production refusal

```python
def test_shim_refuses_to_boot_in_production(monkeypatch):
    monkeypatch.setenv("FLASK_ENV", "production")
    monkeypatch.setenv("TEST_AUTH_BYPASS_ENABLED", "1")
    with pytest.raises(RuntimeError, match="TEST_AUTH_BYPASS_ENABLED cannot be set in production"):
        create_app()
```

Whatever exception type fits the existing boot-time error conventions
is fine — the point is the app must fail to start.

### Test 7 — Idempotency key still works under the shim

```python
def test_shim_on_respects_idempotency_key(client_with_shim_enabled, seeded_user, seeded_child):
    headers = {
        "X-Test-Auth-User": "alice@example.com",
        "Idempotency-Key": "test-lodge-1",
    }
    body = {"type": "LODGE", "amount": 10.00, "description": "test"}
    r1 = client_with_shim_enabled.post(f"/api/v1/children/{seeded_child.id}/transactions", json=body, headers=headers)
    r2 = client_with_shim_enabled.post(f"/api/v1/children/{seeded_child.id}/transactions", json=body, headers=headers)
    assert r1.status_code == 201
    assert r2.status_code == 201
    assert r1.json["transaction"]["id"] == r2.json["transaction"]["id"]
```

The shim is purely an auth-layer concern — it must not break any of
the downstream middleware (idempotency keys, OCC, request validation,
etc.). This test catches accidental regressions where the shim swaps
out the full request context instead of just the auth bit.

---

## Not in scope

Things the mom-bucks agent should **not** do as part of this change:

- **No changes to route handlers.** The shim only touches auth
  middleware; every route continues to work exactly as today.
- **No new env vars beyond `TEST_AUTH_BYPASS_ENABLED`.** The shim is
  gated by a single flag + a single header. No feature-granular
  toggles.
- **No changes to the JWT secret, refresh flow, password hashing, or
  session cookies.** The shim lives alongside the real auth, not
  inside it.
- **No database migrations.** The shim reads users by email via the
  existing model layer; no new columns or tables.
- **No changes to rate limiting or CORS.** Orthogonal concerns.
- **No Firebase code.** This is the Flask side only. The Firebase
  backend's contract-test work happens in `atbrew/mom-bucks-backend`
  in a follow-up PR.

---

## Implementation notes (non-prescriptive)

Mom-bucks folks know their own auth layer best. A few pointers in case
they're useful:

- The shim is probably easiest to wire as a `@before_request` hook or
  a replacement for the decorator that `@jwt_required()` uses
  internally. Whichever matches the existing style.
- If the auth layer already has a concept of `current_user` /
  `g.user`, the shim should populate that same attribute. Don't invent
  a parallel accessor that handlers have to check.
- `TEST_AUTH_BYPASS_ENABLED` parsing should accept the same truthy
  conventions as other bool env vars in the codebase — don't invent a
  new parser.
- If there's a central `app_config.py` or equivalent, the production
  refusal check probably belongs next to the `FLASK_ENV` /
  `DEBUG` / `TESTING` logic.

---

## Questions / things to surface back

If any of the following come up during implementation, flag them in
the PR description so the Firebase side knows:

1. **What does `get_jwt_identity()` return?** The contract tests will
   assume it's a **user id (UUID string)**. If it's actually the
   email, or an integer, or a dict, the harness needs to know so it
   can match.
2. **Are there any routes that use `@jwt_required(refresh=True)`?**
   The shim should probably also bypass refresh-token requirements
   for the contract tests. If refresh-required routes are in scope
   for the contract test suite, the shim needs to handle them too.
3. **Is there a rate limiter that wraps auth?** If yes, does it kick
   in on the shim path? The tests hammer the API and don't expect
   429s.
4. **Does `FLASK_ENV=production` actually exist in this codebase?**
   If the project uses `APP_ENV=production` or similar, use whatever
   is idiomatic. The spec uses `FLASK_ENV` as a placeholder.

---

## PR checklist for the mom-bucks side

- [ ] Env var `TEST_AUTH_BYPASS_ENABLED` added and parsed at boot
- [ ] Header `X-Test-Auth-User` handler added, reading user by email
- [ ] Production refusal check in `create_app()` (or equivalent)
- [ ] Startup warning log line when the shim is active
- [ ] All 7 pytest cases above pass (or equivalents — test intent is
      what matters, not the exact fixture names)
- [ ] Existing JWT auth tests still pass (no regressions)
- [ ] PR description links back to this spec file
- [ ] PR description answers the four questions in the previous
      section so the Firebase side can plan the harness

Once this ships in `atbrew/mom-bucks`, the Phase 5 contract test
harness work in `atbrew/mom-bucks-backend` can start.
