#!/usr/bin/env bash
#
# Run the Firestore rules unit tests via `firebase emulators:exec`.
#
# Wrapper purpose: auto-discover a recent Homebrew openjdk (21+) if the
# system `java` is too old. firebase-tools dropped support for Java < 21
# in 2026 and many macOS contributors still have openjdk@17 as default.
#
# Called from functions/package.json as `npm run test:rules`.

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
      echo "[run-rules-tests] system java is ${CURRENT_JAVA_MAJOR}; using ${BREW_OPENJDK_BIN}" >&2
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

# The tests need to find firebase.json at the repo root and firestore.rules
# alongside it. `firebase emulators:exec` resolves paths relative to the
# --config directory, so we pass $REPO_ROOT/firebase.json and run vitest
# from the functions dir where the test files live.
cd "${REPO_ROOT}/functions"
exec firebase emulators:exec \
  --only firestore \
  --config "${REPO_ROOT}/firebase.json" \
  --project demo-mom-bucks-test \
  "vitest run test/rules"
