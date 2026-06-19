#!/usr/bin/env bash
# ~/.config/bootstrap/cli/shell/install-claude-skills.sh
# Purpose: Wire the legacy `~/.claude/skills/` path to the canonical dotfile-tracked
#   skills store at `~/.config/agents/skills`. Claude Code reads skills from
#   `$CLAUDE_CONFIG_DIR/skills` (set to `~/.config/agents/claude` in
#   `fish/conf.d/claude.fish`, where `skills` is itself a symlink to the
#   canonical store), but it does NOT propagate that env var to shell
#   subprocesses. Third-party CLIs like `npx skills add` therefore fall back to
#   the hard-coded `~/.claude/skills` path and silently bypass the dotfile sync.
#   Making `~/.claude/skills` a symlink to the canonical store fixes that.
# Usage: Idempotent. Run via bootstrap.sh, or directly:
#   bash ~/.config/bootstrap/cli/shell/install-claude-skills.sh

set -euo pipefail

CANONICAL="$HOME/.config/agents/skills"
LEGACY="$HOME/.claude/skills"

mkdir -p "$CANONICAL"
mkdir -p "$(dirname "$LEGACY")"

if [[ -L "$LEGACY" ]]; then
  target="$(readlink "$LEGACY")"
  if [[ "$target" == "$CANONICAL" ]]; then
    echo "ok: $LEGACY already symlinked to $CANONICAL"
    exit 0
  fi
  echo "warn: $LEGACY is a symlink to $target, replacing with link to $CANONICAL"
  rm "$LEGACY"
  ln -s "$CANONICAL" "$LEGACY"
  exit 0
fi

if [[ -d "$LEGACY" ]]; then
  # Real dir present (typically leftover from a pre-migration install). Move any
  # skills it has that the dotfile location is missing, then back up and replace.
  for d in "$LEGACY"/*/; do
    [[ -e "$d" ]] || continue
    name="$(basename "$d")"
    if [[ ! -e "$CANONICAL/$name" ]]; then
      echo "moving missing skill into dotfiles: $name"
      mv "$d" "$CANONICAL/$name"
    fi
  done
  backup="${LEGACY}.pre-symlink.bak.$(date +%Y%m%dT%H%M%S)"
  echo "backing up $LEGACY -> $backup"
  mv "$LEGACY" "$backup"
fi

ln -s "$CANONICAL" "$LEGACY"
echo "ok: linked $LEGACY -> $CANONICAL"
