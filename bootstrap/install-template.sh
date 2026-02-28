#!/usr/bin/env bash
# ~/.config/bootstrap/install-template.sh
# Purpose: Template installer. Duplicate to install-<software>.sh and change SOFTWARE/BREW_PACKAGE.
# Usage: bash ~/.config/bootstrap/install-<software>.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSIONS_FILE="$ROOT_DIR/.versions"

# ==== CHANGE THESE TWO LINES IN EACH DUPLICATE ====
SOFTWARE="example"     # command name to check (ex: "fnm", "zoxide", "pnpm")
BREW_PACKAGE="example" # brew formula/cask to install (ex: "fnm", "zoxide", "pnpm")
# ===================================================

upsert_version_line() {
  local key="$1"
  local value="$2"
  local file="$3"
  local tmp
  tmp="$(mktemp)"

  touch "$file"
  awk -v k="$key" -v v="$value" '
    BEGIN { replaced=0 }
    $0 ~ ("^" k ": ") {
      if (!replaced) {
        print k ": " v
        replaced=1
      }
      next
    }
    { print }
    END {
      if (!replaced) {
        print k ": " v
      }
    }
  ' "$file" > "$tmp"

  mv "$tmp" "$file"
}

if ! command -v "$SOFTWARE" >/dev/null 2>&1; then
  brew install "$BREW_PACKAGE"
fi

if command -v "$SOFTWARE" >/dev/null 2>&1; then
  VERSION_LINE="$("$SOFTWARE" --version 2>/dev/null | head -n1 || true)"
  if [[ -z "$VERSION_LINE" ]]; then
    VERSION_LINE="$("$SOFTWARE" -v 2>/dev/null | head -n1 || true)"
  fi
  [[ -z "$VERSION_LINE" ]] && VERSION_LINE="installed (version command unavailable)"
  SOFTWARE_LABEL="$(printf '%s' "$SOFTWARE" | tr '[:lower:]' '[:upper:]')"
  upsert_version_line "$SOFTWARE_LABEL" "$VERSION_LINE" "$VERSIONS_FILE"
fi