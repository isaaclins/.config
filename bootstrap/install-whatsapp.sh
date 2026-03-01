#!/usr/bin/env bash
# ~/.config/bootstrap/install-whatsapp.sh
# Purpose: Ensures whatsapp cask is installed via Homebrew and records its version.
# Usage: Run via bootstrap.sh or directly with: bash ~/.config/bootstrap/install-whatsapp.sh
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/bootstrap/common.sh"
SOFTWARE="whatsapp"
BREW_PACKAGE="whatsapp"
INSTALL_KIND="cask"
bootstrap_install_and_record

