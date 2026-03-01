#!/usr/bin/env bash
# ~/.config/bootstrap/common.sh
# Purpose: Shared helper functions for install-*.sh scripts.
# Usage: Source this file from an install script, then call `bootstrap_install_and_record`.
set -euo pipefail

: "${ROOT_DIR:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
: "${VERSIONS_FILE:=$ROOT_DIR/.versions}"

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

bootstrap_install_and_record() {
  : "${SOFTWARE:?SOFTWARE is required}"
  : "${BREW_PACKAGE:?BREW_PACKAGE is required}"
  : "${INSTALL_KIND:=formula}"

  if [[ "$INSTALL_KIND" == "cask" ]]; then
    if ! brew list --cask "$BREW_PACKAGE" >/dev/null 2>&1; then
      brew install --cask "$BREW_PACKAGE"
    fi

    if brew list --cask "$BREW_PACKAGE" >/dev/null 2>&1; then
      local version_line
      version_line="$(brew list --cask --versions "$BREW_PACKAGE" 2>/dev/null | awk '{$1=""; sub(/^ /,""); print}')"
      [[ -z "$version_line" ]] && version_line="installed (version unavailable)"
      local label
      label="$(printf '%s' "$BREW_PACKAGE" | tr '[:lower:]-' '[:upper:]_')"
      upsert_version_line "$label" "$version_line" "$VERSIONS_FILE"
    fi
    return
  fi

  if ! command -v "$SOFTWARE" >/dev/null 2>&1; then
    brew install "$BREW_PACKAGE"
  fi

  if command -v "$SOFTWARE" >/dev/null 2>&1; then
    local version_line
    version_line="$("$SOFTWARE" --version 2>/dev/null | head -n1 || true)"
    if [[ -z "$version_line" ]]; then
      version_line="$("$SOFTWARE" -v 2>/dev/null | head -n1 || true)"
    fi
    [[ -z "$version_line" ]] && version_line="installed (version command unavailable)"
    local label
    label="$(printf '%s' "$SOFTWARE" | tr '[:lower:]' '[:upper:]')"
    upsert_version_line "$label" "$version_line" "$VERSIONS_FILE"
  fi
}
