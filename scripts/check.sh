#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v shellcheck >/dev/null 2>&1; then
  echo "shellcheck not found."
  echo "Install it with: brew install shellcheck"
  exit 1
fi

shellcheck "$ROOT_DIR"/bootstrap.sh "$ROOT_DIR"/bootstrap/*.sh
