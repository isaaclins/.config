#!/usr/bin/env bash
# ~/.config/bootstrap/cli/misc/install-skills-sync.sh
# Purpose: Fan out the canonical skills store (~/.config/claude/skills) into every
#          agent that reads skills at runtime (Claude Code, Codex) via symlinks.
#          Not a brew install — uses the install-*.sh name so bootstrap.sh
#          auto-discovers and runs it.
# Usage: bash ~/.config/bootstrap/cli/misc/install-skills-sync.sh
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

SYNC="$ROOT_DIR/scripts/sync-skills.sh"
if [[ -x "$SYNC" ]]; then
  # A skills-sync hiccup (e.g. an agent dir absent) must not abort the bootstrap run.
  "$SYNC" || echo "  warn: sync-skills.sh exited non-zero — skills may be out of sync" >&2
else
  echo "  skip: $SYNC not found or not executable"
fi
