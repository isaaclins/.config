#!/usr/bin/env bash
# ~/.config/bootstrap/install-template.sh
# Purpose: Template installer. Duplicate to install-<software>.sh and change SOFTWARE/BREW_PACKAGE.
# Usage: bash ~/.config/bootstrap/install-<software>.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/bootstrap/common.sh"

# ==== CHANGE THESE LINES IN EACH DUPLICATE ====
SOFTWARE="codex-app")
BREW_PACKAGE="codex-app")
INSTALL_KIND="cask"
# ===================================================

bootstrap_install_and_record