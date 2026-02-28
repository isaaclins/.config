#!/usr/bin/env bash
# ~/.config/bootstrap/install-pnpm.sh
# Purpose: Ensures pnpm is installed via Homebrew and records its version.
# Usage: Run via bootstrap.sh or directly with: bash ~/.config/bootstrap/install-pnpm.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/bootstrap/common.sh"

SOFTWARE="pnpm"
BREW_PACKAGE="pnpm"
INSTALL_KIND="formula"

bootstrap_install_and_record