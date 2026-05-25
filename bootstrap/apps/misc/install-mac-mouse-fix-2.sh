#!/usr/bin/env bash
# ~/.config/bootstrap/templates/install-template.sh
# Purpose: Template installer. Duplicate to install-<software>.sh and change SOFTWARE/BREW_PACKAGE.
# Usage: bash ~/.config/bootstrap/<category>/install-<software>.sh
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

# ==== CHANGE THESE LINES IN EACH DUPLICATE ====
SOFTWARE="mac-mouse-fix@2"
BREW_PACKAGE="mac-mouse-fix@2"
INSTALL_KIND="cask"
# ===================================================

bootstrap_install_and_record
