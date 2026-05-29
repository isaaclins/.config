#!/usr/bin/env bash
# ~/.config/bootstrap.sh
# Purpose: Ensures Homebrew exists, records its version, then runs every install-*.sh under ~/.config/bootstrap.
# Usage: bash ~/.config/bootstrap.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTSTRAP_DIR="$ROOT_DIR/bootstrap"
VERSIONS_FILE="$ROOT_DIR/.versions"

source "$ROOT_DIR/bootstrap/common.sh"

# Wire tracked git hooks (pre-commit credential guard, etc.) for this clone.
if [ -d "$ROOT_DIR/.git" ] && [ -d "$ROOT_DIR/.githooks" ]; then
  git -C "$ROOT_DIR" config core.hooksPath .githooks
fi

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

scripts=()
while IFS= read -r script; do
  scripts+=("$script")
done < <(find "$BOOTSTRAP_DIR" -type f -name 'install-*.sh' | LC_ALL=C sort)

if ((${#scripts[@]} == 0)); then
  echo "No install scripts found in $BOOTSTRAP_DIR"
  exit 0
fi

for script in "${scripts[@]}"; do
  [[ "$(basename "$script")" == "install-template.sh" ]] && continue
  echo "==> Running ${script#"$ROOT_DIR"/}"
  bash "$script"
done

echo "Done. Versions written to $VERSIONS_FILE"
