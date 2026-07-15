#!/usr/bin/env bash
# ~/.config/bootstrap/cli/misc/install-tmux.sh
# Purpose: Idempotent installer for tmux.
# Usage: bash ~/.config/bootstrap/cli/misc/install-tmux.sh

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
SOFTWARE="tmux"
BREW_PACKAGE="tmux"
INSTALL_KIND="formula"
# ===================================================

bootstrap_install_and_record
