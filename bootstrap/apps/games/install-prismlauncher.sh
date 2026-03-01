#!/usr/bin/env bash
# ~/.config/bootstrap/apps/games/install-prismlauncher.sh
# Purpose: Ensures prismlauncher cask is installed via Homebrew and records its version.
# Usage: Run via bootstrap.sh or directly with: bash ~/.config/bootstrap/apps/games/install-prismlauncher.sh
set -euo pipefail

BOOTSTRAP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
while [[ ! -f "$BOOTSTRAP_DIR/common.sh" ]]; do
  BOOTSTRAP_DIR="$(cd "$BOOTSTRAP_DIR/.." && pwd)"
  if [[ "$BOOTSTRAP_DIR" == "/" ]]; then
    echo "Error: could not locate bootstrap/common.sh" >&2
    exit 1
  fi
done
source "$BOOTSTRAP_DIR/common.sh"

SOFTWARE="prismlauncher"
BREW_PACKAGE="prismlauncher"
INSTALL_KIND="cask"
bootstrap_install_and_record
