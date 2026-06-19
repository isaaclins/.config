#!/usr/bin/env bash
#
# sync-skills.sh — keep every agent's skills in sync from ONE canonical store.
#
# Canonical (real, git-versioned content):  ~/.config/agents/skills
# Consumers (read at runtime):
#   - Claude Code : ~/.config/agents/claude/skills -> symlink to the canonical dir
#                   (and ~/.claude/skills as a fallback symlink for bare `npx skills`)
#   - Codex       : ~/.config/agents/codex/skills/<name> -> per-skill symlinks into canonical
#                   (codex skills/.system is left untouched — those are Codex built-ins)
#
# Staging:  ~/.agents/skills  is where `npx skills` installs. It is NOT read by any
# agent at runtime, so this script ABSORBS new installs from there into the canonical
# repo (copying real content in) and otherwise leaves it alone.
#
# Rules (AGENTS.md) are NOT synced here: Claude imports the shared file via its
# CLAUDE.md and Codex reads it via a symlinked AGENTS.md, so there is nothing to copy.
#
# Safe + idempotent: re-run any time. Use --dry-run to preview.
#
set -euo pipefail

CANON="$HOME/.config/agents/skills"
AGENTS="$HOME/.agents/skills"
CODEX="$HOME/.config/agents/codex/skills"
CLAUDE_LINK="$HOME/.claude/skills"

DRY=0
[[ "${1:-}" == "--dry-run" || "${1:-}" == "-n" ]] && DRY=1

run() { if [[ $DRY -eq 1 ]]; then echo "  [dry] $*"; else eval "$*"; fi; }
is_skill() { [[ -f "$1/SKILL.md" ]]; }   # a valid skill dir has a SKILL.md

echo "==> Canonical store: $CANON"
[[ -d "$CANON" ]] || { echo "FATAL: canonical dir missing"; exit 1; }

# 1) Absorb new/updated skills from the ~/.agents staging area into the canonical repo.
#    Pulls in anything `npx skills` installed that the repo doesn't have (or has empty).
if [[ -d "$AGENTS" ]]; then
  echo "==> Absorbing new installs from $AGENTS"
  for d in "$AGENTS"/*/; do
    [[ -d "$d" ]] || continue
    n="$(basename "$d")"
    is_skill "$d" || continue                      # skip empty/broken staging dirs
    if ! is_skill "$CANON/$n"; then                # missing or empty in canonical
      echo "  absorb  $n"
      run "rm -rf '$CANON/$n'"
      run "cp -R '$d' '$CANON/$n'"
    fi
  done
fi

# 2) Claude: ensure ~/.claude/skills points at the canonical dir.
echo "==> Claude link: $CLAUDE_LINK -> $CANON"
mkdir -p "$(dirname "$CLAUDE_LINK")"   # ~/.claude may not exist yet on a fresh machine
if [[ -L "$CLAUDE_LINK" && "$(readlink "$CLAUDE_LINK")" == "$CANON" ]]; then
  echo "  ok      already linked"
elif [[ -e "$CLAUDE_LINK" && ! -L "$CLAUDE_LINK" ]]; then
  echo "  WARN    $CLAUDE_LINK exists and is NOT a symlink — leaving it; fix by hand"
else
  run "ln -snf '$CANON' '$CLAUDE_LINK'"
  echo "  linked"
fi

# 3) Codex: one symlink per canonical skill into the codex skills dir (preserve .system).
echo "==> Codex links: $CODEX/<name> -> $CANON/<name>"
run "mkdir -p '$CODEX'"
linked=0
for d in "$CANON"/*/; do
  [[ -d "$d" ]] || continue
  n="$(basename "$d")"
  is_skill "$d" || { echo "  skip    $n (no SKILL.md)"; continue; }
  tgt="$CODEX/$n"
  if [[ -L "$tgt" && "$(readlink "$tgt")" == "$CANON/$n" ]]; then
    :   # already correct
  else
    run "rm -rf '$tgt'"
    run "ln -s '$CANON/$n' '$tgt'"
    echo "  link    $n"
    linked=$((linked+1))
  fi
done
[[ $linked -eq 0 ]] && echo "  ok      all codex links already current"

# 4) Prune stale Codex symlinks (skill removed from canonical). Never touch .system or real dirs.
echo "==> Pruning stale Codex symlinks"
pruned=0
for e in "$CODEX"/*; do
  [[ -L "$e" ]] || continue                        # only symlinks; leaves .system + any real dir
  n="$(basename "$e")"
  if ! is_skill "$CANON/$n"; then
    run "rm -f '$e'"
    echo "  prune   $n"
    pruned=$((pruned+1))
  fi
done
[[ $pruned -eq 0 ]] && echo "  ok      nothing stale"

echo "==> Done.$([[ $DRY -eq 1 ]] && echo ' (dry run — nothing changed)')  Restart Codex to pick up new skills."
