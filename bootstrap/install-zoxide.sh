#!/usr/bin/env bash
# ~/.config/bootstrap/install-zoxide.sh
# Purpose: Ensures zoxide is installed via Homebrew and records its version.
# Usage: Run via bootstrap.sh or directly with: bash ~/.config/bootstrap/install-zoxide.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/bootstrap/common.sh"

SOFTWARE="zoxide"
BREW_PACKAGE="zoxide"
INSTALL_KIND="formula"

bootstrap_install_and_record