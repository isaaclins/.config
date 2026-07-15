#!/usr/bin/env bash
# ~/.config/bootstrap.sh
# Purpose: Ensure Homebrew exists, install everything in the Brewfile, then run
#   the non-brew config/symlink steps under ~/.config/bootstrap.
# Usage: bash ~/.config/bootstrap.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTSTRAP_DIR="$ROOT_DIR/bootstrap"
BREWFILE="$ROOT_DIR/Brewfile"

# Wire tracked git hooks (pre-commit credential guard, etc.) for this clone.
if [ -d "$ROOT_DIR/.git" ] && [ -d "$ROOT_DIR/.githooks" ]; then
  git -C "$ROOT_DIR" config core.hooksPath .githooks
fi

# Bootstrap Homebrew first so the bundle and config steps can use it.
if ! command -v brew >/dev/null 2>&1; then
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"

# Install/upgrade every tap, formula, and cask declared in the Brewfile.
echo "==> brew bundle (${BREWFILE#"$ROOT_DIR"/})"
brew bundle install --file="$BREWFILE"

# Run the remaining install-*.sh: these are NOT brew packages but config,
# symlink, and post-install steps (claude skills, pi config, tmux keys,
# node LTS, hammerspoon defaults). Brew packages they depend on are already
# installed by the bundle above.
scripts=()
while IFS= read -r script; do
  scripts+=("$script")
done < <(find "$BOOTSTRAP_DIR" -type f -name 'install-*.sh' | LC_ALL=C sort)

for script in "${scripts[@]}"; do
  echo "==> Running ${script#"$ROOT_DIR"/}"
  bash "$script"
done

echo "Done. Packages from $BREWFILE, config steps applied."
