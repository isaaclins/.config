#!/usr/bin/env bash
# ~/.config/bootstrap/install-fnm.sh
# Purpose: Ensures fnm is installed via Homebrew and records its version.
# Usage: Run via bootstrap.sh or directly with: bash ~/.config/bootstrap/install-fnm.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/bootstrap/common.sh"

SOFTWARE="fnm"
BREW_PACKAGE="fnm"
INSTALL_KIND="formula"

bootstrap_install_and_record