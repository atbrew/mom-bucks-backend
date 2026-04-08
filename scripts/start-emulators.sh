#!/usr/bin/env bash
#
# Boot the local Firebase emulator suite (Auth, Firestore, Functions,
# Storage, Hosting + UI). State is imported from .emulator-data/ at start
# and exported on exit so seed data persists across runs.
#
# Usage:
#   ./scripts/start-emulators.sh
#
# Requires:
#   - firebase-tools (`npm install -g firebase-tools`)
#   - JDK 21+ on PATH for the Firestore / Auth emulators (firebase-tools
#     dropped support for Java < 21 in 2026). On macOS this script tries
#     to auto-discover a recent Homebrew openjdk if the system `java` is
#     too old.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v firebase >/dev/null 2>&1; then
  echo "error: firebase CLI not found." >&2
  echo "  install with: npm install -g firebase-tools" >&2
  exit 1
fi

# ── Java 21+ check / auto-pick recent Homebrew openjdk ────────────────
# firebase-tools requires JDK 21+ to run the Firestore/Auth emulators.
# Many macOS users still have openjdk@17 as their default `java`. If we
# detect an old default, prepend the latest Homebrew openjdk (if any) to
# PATH for the lifetime of this script so contributors don't have to
# remember to export JAVA_HOME themselves.
if command -v java >/dev/null 2>&1; then
  CURRENT_JAVA_MAJOR="$(java -version 2>&1 | awk -F '"' '/version/ {split($2, v, "."); print v[1]}')"
else
  CURRENT_JAVA_MAJOR=0
fi

if [ "${CURRENT_JAVA_MAJOR:-0}" -lt 21 ]; then
  if command -v brew >/dev/null 2>&1; then
    BREW_OPENJDK_BIN="$(brew --prefix openjdk 2>/dev/null)/bin"
    if [ -x "${BREW_OPENJDK_BIN}/java" ]; then
      echo "[start-emulators] system java is < 21; using ${BREW_OPENJDK_BIN}" >&2
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

# Build functions before booting so the emulator picks up the latest code.
if [ -d "functions" ]; then
  echo "[start-emulators] building functions..."
  (cd functions && npm run build)
fi

EMULATOR_DATA_DIR="${REPO_ROOT}/.emulator-data"
mkdir -p "$EMULATOR_DATA_DIR"

echo "[start-emulators] booting suite (UI: http://localhost:4000)"
exec firebase emulators:start \
  --project "${FIREBASE_PROJECT:-mom-bucks-dev-b3772}" \
  --import "$EMULATOR_DATA_DIR" \
  --export-on-exit "$EMULATOR_DATA_DIR"
