#!/usr/bin/env bash
# ~/.config/bootstrap/cli/node/install-fnm.sh
# Purpose: Post-install for fnm (installed via Brewfile). Ensures an LTS Node.js
#   is present. Idempotent: skips if node is already on PATH.
# Usage: Run via bootstrap.sh or directly: bash ~/.config/bootstrap/cli/node/install-fnm.sh
set -euo pipefail

if ! command -v fnm >/dev/null 2>&1; then
  echo "skip: fnm not installed yet (run brew bundle first)"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  fnm install --lts >/dev/null 2>&1 || true
fi
