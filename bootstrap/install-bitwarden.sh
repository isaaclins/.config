#!/usr/bin/env bash
# ~/.config/bootstrap/install-bitwarden.sh
# Purpose: Ensures bitwarden cask is installed via Homebrew and records its version.
# Usage: Run via bootstrap.sh or directly with: bash ~/.config/bootstrap/install-bitwarden.sh
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/bootstrap/common.sh"
SOFTWARE="bitwarden"
BREW_PACKAGE="bitwarden"
INSTALL_KIND="cask"
bootstrap_install_and_record

