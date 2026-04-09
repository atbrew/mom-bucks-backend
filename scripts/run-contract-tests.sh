#!/usr/bin/env bash
#
# Run the Phase 5 contract tests (functions/test/contract/**).
#
# These tests drive both the Flask + Postgres stack (booted via
# docker-compose from the mom-bucks repo) and the Firebase stack
# (Firestore + Auth + Functions emulators) with identical inputs,
# then assert parity on the observable state.
#
# This wrapper orchestrates the Firebase side:
#
#   1. Ensure Java 21+ is on PATH (firebase-tools requirement; same
#      check as run-rules-tests.sh). Auto-pick a Homebrew openjdk if
#      the system java is too old.
#
#   2. Launch `firebase emulators:exec` with Firestore + Auth +
#      Functions. The Functions emulator is required because the
#      contract tests assert `child.balance` has been updated by
#      `onTransactionCreate` (#15), which only runs inside the
#      Functions emulator.
#
#   3. Inside the emulator shell, run `vitest run` against the
#      contract config. That config's globalSetup brings Flask up
#      via docker-compose.
#
# Prerequisites:
#
#   - docker (or Colima) running, with docker-compose available as
#     `docker compose`.
#   - The mom-bucks Flask repo checked out. Default location:
#     ~/Development/mom-bucks. Override via MOM_BUCKS_REPO_PATH.
#   - The Flask repo must contain
#     integration-tests/docker-compose.test.yml — that's the anchor
#     bootFlask.ts layers its override on top of.
#
# Called from functions/package.json as `npm run test:contract`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── Java 21+ check / auto-pick recent Homebrew openjdk ────────────────
if command -v java >/dev/null 2>&1; then
  CURRENT_JAVA_MAJOR="$(java -version 2>&1 | awk -F '"' '/version/ {split($2, v, "."); print v[1]}')"
else
  CURRENT_JAVA_MAJOR=0
fi

if [ "${CURRENT_JAVA_MAJOR:-0}" -lt 21 ]; then
  if command -v brew >/dev/null 2>&1; then
    BREW_OPENJDK_BIN="$(brew --prefix openjdk 2>/dev/null)/bin"
    if [ -x "${BREW_OPENJDK_BIN}/java" ]; then
      echo "[run-contract-tests] system java is ${CURRENT_JAVA_MAJOR}; using ${BREW_OPENJDK_BIN}" >&2
      PATH="${BREW_OPENJDK_BIN}:${PATH}"
      export PATH
    else
      echo "error: java ${CURRENT_JAVA_MAJOR} is too old for firebase-tools (requires 21+)." >&2
      echo "  install: brew install openjdk" >&2
      exit 1
    fi
  else
    echo "error: java ${CURRENT_JAVA_MAJOR} is too old for firebase-tools (requires 21+)." >&2
    exit 1
  fi
fi

# ── docker-compose sanity check ───────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is not on PATH. Contract tests need docker to boot the Flask stack." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "error: 'docker compose' subcommand not available. Upgrade Docker Desktop / Colima." >&2
  exit 1
fi

# Build the functions first so `onTransactionCreate` is compiled and
# the Functions emulator can serve it. Without this the emulator
# loads stale code from a previous run (or none at all).
npm --prefix "${REPO_ROOT}/functions" run build

cd "${REPO_ROOT}/functions"
exec firebase emulators:exec \
  --only firestore,auth,functions \
  --config "${REPO_ROOT}/firebase.json" \
  --project demo-mom-bucks-contract \
  "vitest run --config vitest.contract.config.ts"
