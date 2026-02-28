#!/usr/bin/env bash
# ~/.config/bootstrap.sh
# Purpose: Ensures Homebrew exists, records its version, then runs every install-*.sh in ~/.config/bootstrap.
# Usage: bash ~/.config/bootstrap.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTSTRAP_DIR="$ROOT_DIR/bootstrap"
VERSIONS_FILE="$ROOT_DIR/.versions"

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

{
  echo "# generated on $(date '+%Y-%m-%d %H:%M:%S')"
} > "$VERSIONS_FILE"

# Bootstrap Homebrew first so all install scripts can use it.
if ! command -v brew >/dev/null 2>&1; then
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

if command -v brew >/dev/null 2>&1; then
  upsert_version_line "HOMEBREW" "$(brew --version | head -n1)" "$VERSIONS_FILE"
fi

shopt -s nullglob
scripts=("$BOOTSTRAP_DIR"/install-*.sh)

if ((${#scripts[@]} == 0)); then
  echo "No install scripts found in $BOOTSTRAP_DIR"
  exit 0
fi

for script in "${scripts[@]}"; do
  [[ "$(basename "$script")" == "install-template.sh" ]] && continue
  echo "==> Running $(basename "$script")"
  bash "$script"
done

echo "Done. Versions written to $VERSIONS_FILE"
