#!/usr/bin/env bash
# ~/.config/bootstrap/apps/automation/install-hammerspoon.sh
# Purpose: Post-install for Hammerspoon (installed via Brewfile). Points it at
#   the tracked init.lua. Idempotent.
# Usage: Run via bootstrap.sh or directly: bash ~/.config/bootstrap/apps/automation/install-hammerspoon.sh
set -euo pipefail

wdir="${HOME}/.config/hammerspoon"
defaults write org.hammerspoon.Hammerspoon MJConfigFile "${wdir}/init.lua"
