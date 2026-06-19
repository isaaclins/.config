#!/usr/bin/env bash
# ~/.config/bootstrap/cli/misc/install-skills-sync.sh
# Purpose: Wire the shared agents umbrella on a fresh machine and fan out the
#          canonical skills store (~/.config/agents/skills) into every agent that
#          reads skills at runtime (Claude Code, Codex) via symlinks. Also ensures
#          the per-tool rules + env wiring exists:
#            - Claude home : ~/.config/agents/claude (CLAUDE_CONFIG_DIR, set in fish)
#                            skills symlink: agents/claude/skills -> agents/skills
#                            fallback link : ~/.claude/skills -> agents/skills
#            - Codex home  : ~/.config/agents/codex  (CODEX_HOME, set in fish)
#                            rules symlink : agents/codex/AGENTS.md -> agents/AGENTS.md
#                            per-skill links under agents/codex/skills/<name>
#          Rules need no recurring sync: Claude imports the shared AGENTS.md via
#          CLAUDE.md and Codex reads it via the symlinked AGENTS.md.
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

AGENTS_DIR="$HOME/.config/agents"
CANON="$AGENTS_DIR/skills"
CLAUDE_HOME="$AGENTS_DIR/claude"
CODEX_HOME="$AGENTS_DIR/codex"

# 1) Claude home: skills symlink into the canonical store (CLAUDE_CONFIG_DIR points here).
if [[ -d "$CANON" ]]; then
  mkdir -p "$CLAUDE_HOME"
  if [[ ! -L "$CLAUDE_HOME/skills" ]]; then
    rm -rf "$CLAUDE_HOME/skills"
    ln -s "$CANON" "$CLAUDE_HOME/skills"
    echo "  linked agents/claude/skills -> $CANON"
  fi
fi

# 2) Codex home + rules symlink (env var is exported by fish/conf.d/codex.fish).
if [[ -d "$CANON" ]]; then
  mkdir -p "$CODEX_HOME"
  if [[ ! -L "$CODEX_HOME/AGENTS.md" ]]; then
    rm -f "$CODEX_HOME/AGENTS.md"
    ln -s "$AGENTS_DIR/AGENTS.md" "$CODEX_HOME/AGENTS.md"
    echo "  linked agents/codex/AGENTS.md -> $AGENTS_DIR/AGENTS.md"
  fi
fi

# 3) Fan out skills into every consumer (~/.claude/skills fallback, codex per-skill links).
SYNC="$ROOT_DIR/scripts/sync-skills.sh"
if [[ -x "$SYNC" ]]; then
  # A skills-sync hiccup (e.g. an agent dir absent) must not abort the bootstrap run.
  "$SYNC" || echo "  warn: sync-skills.sh exited non-zero — skills may be out of sync" >&2
else
  echo "  skip: $SYNC not found or not executable"
fi
