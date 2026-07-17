#!/usr/bin/env bash
# ~/.config/bootstrap/cli/shell/install-pmset-keepawake.sh
# Purpose: Grant the current user passwordless sudo for exactly
#   `pmset -a disablesleep 0|1`, so the pi keep-awake extension
#   (~/.config/pi/extensions/keep-awake.ts) can block lid-closed sleep for
#   the lifetime of every pi session and restore it afterwards. Without this
#   grant the extension still blocks idle/system sleep via caffeinate but
#   skips the lid-closed layer.
# Revert: sudo rm /etc/sudoers.d/pi-keepawake
# Usage: Idempotent, prompts for sudo once. Run via bootstrap.sh, or directly:
#   bash ~/.config/bootstrap/cli/shell/install-pmset-keepawake.sh

set -euo pipefail

[ "$(uname)" = "Darwin" ] || { echo "pmset-keepawake: macOS only, skipping"; exit 0; }

SUDOERS_FILE="/etc/sudoers.d/pi-keepawake"
CONTENT="$USER ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1"

if [ -f "$SUDOERS_FILE" ] && sudo grep -qxF "$CONTENT" "$SUDOERS_FILE" 2>/dev/null; then
  echo "pmset-keepawake: already installed"
  exit 0
fi

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT
printf '%s\n' "$CONTENT" >"$TMP_FILE"

# Validate before installing; a broken sudoers file locks out sudo entirely.
sudo visudo -c -f "$TMP_FILE" >/dev/null
sudo install -o root -g wheel -m 0440 "$TMP_FILE" "$SUDOERS_FILE"
echo "pmset-keepawake: installed $SUDOERS_FILE"
