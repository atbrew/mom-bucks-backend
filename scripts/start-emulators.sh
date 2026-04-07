#!/usr/bin/env bash
#
# Boot the local Firebase emulator suite (Auth, Firestore, Functions,
# Storage, Hosting + UI). State is imported from .emulator-data/ at start
# and exported on exit so seed data persists across runs.
#
# Usage:
#   ./scripts/start-emulators.sh
#
# Requires: firebase-tools (`npm install -g firebase-tools`).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v firebase >/dev/null 2>&1; then
  echo "error: firebase CLI not found." >&2
  echo "  install with: npm install -g firebase-tools" >&2
  exit 1
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
