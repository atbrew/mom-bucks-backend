# Contract tests (Phase 5)

Side-by-side parity tests that drive the legacy Flask + Postgres stack
and the Firebase stack with **identical inputs** and assert the
observable state matches. The goal is not to test either backend in
isolation — the unit tests and rules tests already do that — but to
prove that migrating a client from Flask to Firebase will not change
the numbers a user sees.

These tests are the safety net for the Phase 5 write cutover described
in [`docs/firebase-migration-plan.md`](../../../docs/firebase-migration-plan.md).

## What's covered

The first suite (`transactions.contract.test.ts`) pins the balance-math
contract:

1. Single `LODGE` lands with the same balance on both backends.
2. `LODGE` then `WITHDRAW` leaves the expected balance.
3. Both backends reject a `WITHDRAW` that exceeds the current balance.
4. A `LODGE`/`WITHDRAW`/`LODGE` sequence produces the same final balance.
5. Boundary cent values (`1`, `9999`, `10000`) round-trip cleanly.
6. Concurrent `LODGE`s are both applied without loss.

Out of scope for this pass (follow-up PRs if the transactions suite
shakes out cleanly): activities/bounty cards, vault transactions,
invites, habit notifications, profile images.

## How to run

```bash
cd functions
npm run test:contract
```

Under the hood that runs `scripts/run-contract-tests.sh`, which:

1. Ensures Java 21+ is on `PATH` (same auto-pick-Homebrew-openjdk
   dance as `run-rules-tests.sh`).
2. Verifies `docker` and the `docker compose` subcommand are
   available.
3. Builds the Functions source so `onTransactionCreate` is compiled
   and the emulator serves fresh code.
4. Launches `firebase emulators:exec` with Firestore + Auth +
   Functions on the `demo-mom-bucks-contract` project.
5. Inside that shell, runs `vitest run --config vitest.contract.config.ts`,
   whose `globalSetup` brings up the Flask stack via `docker compose`.

## Prerequisites

- **Docker** (or Colima) running locally with the `docker compose`
  subcommand available. Contract tests boot the Flask API via
  `docker compose up -d --wait`.

- **Flask repo checked out.** Default location is
  `~/Development/mom-bucks`. Override with:

  ```bash
  MOM_BUCKS_REPO_PATH=/path/to/mom-bucks npm run test:contract
  ```

  The harness looks for `integration-tests/docker-compose.test.yml`
  inside that path and fails fast if it's missing.

- **Java 21+** (firebase-tools requirement). The wrapper script
  auto-picks `brew --prefix openjdk` if the system Java is too old.

## Why a separate config and script

Contract tests have fundamentally different operational shape from
unit tests:

- They boot Flask via `docker compose` (globalSetup/teardown).
- They need `firebase emulators:exec` around them so the emulator
  ports are reachable.
- Individual tests are slow — network I/O, emulator writes, trigger
  propagation — so the per-test timeout is 30 s and hooks get 60 s.
- They must **not** run as part of `npm test`, which is the fast
  inner-loop path devs hit on every save.

That's why `vitest.contract.config.ts` is separate from the root
`vitest.config.ts`, and why `test:contract` is its own script outside
the default `test` chain.

## How parity is asserted

Every test creates a **fresh parity pair** via `createParityPair()` in
[`harness/testUser.ts`](./harness/testUser.ts). That function:

1. Creates a Flask user via `POST /api/v1/auth/register`.
2. Creates a Firebase Auth user + seeds `users/{uid}`.
3. Creates a child on each side with the same name.
4. Returns a `ParityPair` with both IDs and a `cleanup()` helper.

Fresh pairs per test means failures are reproducible in isolation and
no test leaks state into the next.

After every Firebase transaction write we have to wait for the
`onTransactionCreate` trigger to land the balance update —
`awaitFirebaseBalance()` polls the child doc until the expected value
shows up. Flask recomputes the balance inline in the request handler
so no polling is needed there.

## Wire format: the money translation

Flask stores money as `Numeric(10, 2)` and serialises as dollars-as-float
on the wire (`{"amount": 12.34}`). Firebase stores integer cents
(`{"amount": 1234}`). The harness normalises to **integer cents** in
all comparisons — see `harness/normalize.ts`.

The conversion direction is always Flask → cents via `centsFromDollars()`,
which uses `Math.round(dollars * 100)` to absorb IEEE-754 float noise.
Never the reverse: the source of truth is cents, and going cents →
dollars → cents can lose precision for specific values.

## Firebase SDK choice: client, not Admin

The Firebase side deliberately uses the **client SDK** (`firebase/app`,
`firebase/auth`, `firebase/firestore`) pointed at the Auth + Firestore
emulators, not the Admin SDK. Rationale: the Admin SDK bypasses
security rules, but rules are *the* synchronous balance gate (the
overspend guard lives in `firestore.rules`). A test that uses the
Admin SDK would silently mask rule regressions. Using the client SDK
ensures every contract test run exercises the real rule path.

Each parity user gets its own **named Firebase app instance** so
sign-in state doesn't leak between tests.

## Flask test-auth bypass

The contract harness impersonates users via an `X-Test-Auth-User: <email>`
header, which only works when `TEST_AUTH_BYPASS_ENABLED=1` is set in
the Flask container's environment. We enable it via the
`docker-compose.override.yml` in this directory — the Flask repo's
compose file is untouched.

## Files

```
functions/test/contract/
├── README.md                         — this file
├── docker-compose.override.yml       — sets TEST_AUTH_BYPASS_ENABLED=1
├── transactions.contract.test.ts     — the suite
└── harness/
    ├── bootFlask.ts                  — docker compose lifecycle
    ├── firebaseClient.ts             — Firebase client SDK wrapper
    ├── flaskClient.ts                — Flask HTTP client
    ├── globalSetup.ts                — vitest globalSetup hook
    ├── normalize.ts                  — Flask↔cents + shared types
    └── testUser.ts                   — createParityPair()
```

Related top-level files:

- `functions/vitest.contract.config.ts` — vitest config for this suite.
- `scripts/run-contract-tests.sh` — orchestration wrapper.
