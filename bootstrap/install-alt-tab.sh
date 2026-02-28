#!/usr/bin/env bash
# ~/.config/bootstrap/install-alt-tab.sh
# Purpose: Ensures alt-tab cask is installed via Homebrew and records its version.
# Usage: Run via bootstrap.sh or directly with: bash ~/.config/bootstrap/install-alt-tab.sh
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/bootstrap/common.sh"
SOFTWARE="alt-tab"
BREW_PACKAGE="alt-tab"
INSTALL_KIND="cask"
bootstrap_install_and_record

