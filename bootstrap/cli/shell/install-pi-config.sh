#!/usr/bin/env bash
# ~/.config/bootstrap/cli/shell/install-pi-config.sh
# Purpose: Wire the Pi coding agent (~/.pi/agent) to the dotfile-tracked config
#   at ~/.config/pi. Only deliberate config is tracked and symlinked:
#     ~/.pi/agent/settings.json  -> ~/.config/pi/settings.json
#     ~/.pi/agent/models.json    -> ~/.config/pi/models.json
#     ~/.pi/agent/AGENTS.md      -> ~/.config/agents/AGENTS.md (ONE unified
#                                   rules file for Claude, Codex, and Pi)
#     ~/.pi/agent/extensions     -> ~/.config/pi/extensions (whole-dir link)
#     ~/.pi/agent/lib            -> ~/.config/pi/lib (extension support modules)
#     ~/.pi/agent/assets         -> ~/.config/pi/assets (Claude Notifier.app
#                                   needed by the notify-sound extension)
#   Everything else under ~/.pi/agent is runtime state (auth.json, sessions,
#   npm packages, git clones, run history) and stays untracked on disk.
#   auth.json is a secret: on a new machine, run `pi` once and log in.
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
link "$PI_HOME/models.json" "$CANON/models.json"
link "$PI_HOME/AGENTS.md" "$HOME/.config/agents/AGENTS.md"
link "$PI_HOME/extensions" "$CANON/extensions"
link "$PI_HOME/lib" "$CANON/lib"
link "$PI_HOME/assets" "$CANON/assets"

# Note: the fish-function shims Pi's bash puts on PATH (shellCommandPrefix)
# are regenerated automatically on every session start by the fish-shims
# extension (~/.config/pi/extensions/fish-shims.ts); nothing to do here.
