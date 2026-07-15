#!/usr/bin/env bash
# ~/.config/bootstrap/cli/misc/install-gitleaks.sh
# Purpose: Install gitleaks, used by .githooks/pre-commit for staged-secret
#   scanning with a maintained ruleset (the hook falls back to a small regex
#   blocklist when gitleaks is absent).
# Usage: bash ~/.config/bootstrap/cli/misc/install-gitleaks.sh
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

SOFTWARE="gitleaks"
BREW_PACKAGE="gitleaks"
INSTALL_KIND="formula"

bootstrap_install_and_record
