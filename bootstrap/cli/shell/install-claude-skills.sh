#!/usr/bin/env bash
# ~/.config/bootstrap/cli/shell/install-claude-skills.sh
# Purpose: Own ALL skill symlink wiring for the shared agents umbrella in one
#   idempotent script. There is a single canonical, dotfile-tracked skills store
#   at `~/.config/agents/skills`. Every consumer points at it via a whole-dir
#   symlink, so adding a skill to the canonical store appears in both Claude and
#   Codex automatically with no per-skill fan-out and no recurring sync job.
#
#   Skill symlinks ensured (each a whole-dir link to the canonical store):
#     1. ~/.config/agents/claude/skills  (Claude Code, via $CLAUDE_CONFIG_DIR)
#     2. ~/.config/agents/codex/skills   (Codex, via $CODEX_HOME/skills)
#     3. ~/.claude/skills                (fallback for bare `npx skills`, which
#                                         hard-codes this path and bypasses the
#                                         $CLAUDE_CONFIG_DIR override)
#     4. ~/.agents/skills                (the `npx skills` CLI global store; it
#                                         hard-codes AGENTS_DIR=.agents, not
#                                         overridable, so a raw `npx skills add`
#                                         would otherwise miss the canonical store)
#
#   Also ensured: the Codex rules symlink
#     ~/.config/agents/codex/AGENTS.md -> ~/.config/agents/AGENTS.md
#   so Codex picks up the one canonical AGENTS.md.
#
#   Codex built-in skills live at `~/.config/agents/skills/.system` (gitignored,
#   Codex-managed). Because codex/skills is a whole-dir symlink, that path
#   resolves through the symlink for free.
#
#   This script replaces the retired per-skill fan-out and the recurring
#   sync-skills mechanism. It does NOT call any sync script.
# Usage: Idempotent. Run via bootstrap.sh, or directly:
#   bash ~/.config/bootstrap/cli/shell/install-claude-skills.sh

set -euo pipefail

# link_dir TARGET CANONICAL
# Idempotently ensure directory path TARGET is a whole-dir symlink to CANONICAL.
link_dir() {
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
  elif [[ -d "$t" ]]; then
    # Real directory (typically a pre-migration install). Preserve any skills it
    # has that the canonical store is missing, then back it up and replace it.
    local d name
    for d in "$t"/*/; do
      [[ -e "$d" ]] || continue
      name="$(basename "$d")"
      if [[ ! -e "$c/$name" ]]; then
        echo "moving missing skill into canonical store: $name"
        mv "$d" "$c/$name"
      fi
    done
    local backup
    backup="${t}.pre-symlink.bak.$(date +%Y%m%dT%H%M%S)"
    echo "backing up $t -> $backup"
    mv "$t" "$backup"
    ln -s "$c" "$t"
    echo "linked: $t -> $c"
  else
    mkdir -p "$(dirname "$t")"
    ln -s "$c" "$t"
    echo "linked: $t -> $c"
  fi
}

# link_file TARGET SOURCE
# Idempotently ensure file path TARGET is a symlink to SOURCE.
link_file() {
  local t="$1" s="$2"
  if [[ -L "$t" ]]; then
    local cur
    cur="$(readlink "$t")"
    if [[ "$cur" == "$s" ]]; then
      echo "ok: $t -> $s"
    else
      ln -snf "$s" "$t"
      echo "relinked: $t -> $s (was -> $cur)"
    fi
  elif [[ -f "$t" ]]; then
    local backup
    backup="${t}.pre-symlink.bak.$(date +%Y%m%dT%H%M%S)"
    echo "backing up $t -> $backup"
    mv "$t" "$backup"
    ln -s "$s" "$t"
    echo "linked: $t -> $s"
  else
    mkdir -p "$(dirname "$t")"
    ln -s "$s" "$t"
    echo "linked: $t -> $s"
  fi
}

CANON="$HOME/.config/agents/skills"
mkdir -p "$CANON"

link_dir "$HOME/.config/agents/claude/skills" "$CANON"
link_dir "$HOME/.config/agents/codex/skills" "$CANON"
link_dir "$HOME/.claude/skills" "$CANON"
# The `npx skills` CLI hard-codes its global store to ~/.agents/skills (constant
# AGENTS_DIR, not overridable), so a raw `npx skills add ...` would bypass the
# canonical store. Redirect it here too. link_dir backs up any pre-existing real
# dir with a timestamped suffix before symlinking, so no data is lost.
link_dir "$HOME/.agents/skills" "$CANON"

link_file "$HOME/.config/agents/codex/AGENTS.md" "$HOME/.config/agents/AGENTS.md"
