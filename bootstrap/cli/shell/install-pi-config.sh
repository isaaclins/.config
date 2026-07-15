#!/usr/bin/env bash
# ~/.config/bootstrap/cli/shell/install-pi-config.sh
# Purpose: Wire the Pi coding agent (~/.pi/agent) to the dotfile-tracked config
#   at ~/.config/pi. Only deliberate config is tracked and symlinked:
#     ~/.pi/agent/settings.json  -> ~/.config/pi/settings.json
#     ~/.pi/agent/AGENTS.md      -> ~/.config/pi/AGENTS.md
#     ~/.pi/agent/extensions     -> ~/.config/pi/extensions (whole-dir link)
#   Everything else under ~/.pi/agent is runtime state (auth.json, sessions,
#   npm packages, git clones, run history, assets) and stays untracked on disk.
# Usage: Idempotent. Run via bootstrap.sh, or directly:
#   bash ~/.config/bootstrap/cli/shell/install-pi-config.sh

set -euo pipefail

CANON="$HOME/.config/pi"
PI_HOME="$HOME/.pi/agent"

mkdir -p "$PI_HOME"

# link PATH_IN_PI CANONICAL_PATH
# Idempotently ensure the pi path is a symlink to the canonical tracked path.
# A pre-existing real file/dir is backed up with a timestamped suffix first.
link() {
  local t="$1" c="$2"
  if [[ -L "$t" ]]; then
    local cur
    cur="$(readlink "$t")"
    if [[ "$cur" == "$c" ]]; then
      echo "ok: $t -> $c"
    else
      ln -snf "$c" "$t"
      echo "relinked: $t -> $c (was -> $cur)"
    fi
  elif [[ -e "$t" ]]; then
    local backup
    backup="${t}.pre-symlink.bak.$(date +%Y%m%dT%H%M%S)"
    echo "backing up $t -> $backup"
    mv "$t" "$backup"
    ln -s "$c" "$t"
    echo "linked: $t -> $c"
  else
    ln -s "$c" "$t"
    echo "linked: $t -> $c"
  fi
}

link "$PI_HOME/settings.json" "$CANON/settings.json"
link "$PI_HOME/AGENTS.md" "$CANON/AGENTS.md"
link "$PI_HOME/extensions" "$CANON/extensions"
