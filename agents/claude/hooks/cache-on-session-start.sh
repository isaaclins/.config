#!/bin/sh
# SessionStart hook: prepare the per-repo CLAUDE.local.md cache.
#
# On a fresh session this makes sure a placeholder cache file exists and
# records the current working-tree signature as the baseline. The Stop
# hook later compares against this baseline to decide whether the cache
# needs to be populated or refreshed.
#
# The project-root CLAUDE.local.md is auto-loaded into context natively by
# Claude Code (CLAUDE.md and CLAUDE.local.md in the directory hierarchy are
# loaded in full at launch), so this hook does not emit additionalContext.
#
# Reads the hook JSON from stdin. Always exits 0.

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/cache-lib.sh"

# Recursion guard: the background refresh worker runs a forked claude without
# --bare, so this SessionStart hook fires inside that child. When the refresh
# env var is set, do nothing so the fork does not re-prepare the cache.
if [ -n "${CLAUDE_CACHE_REFRESH:-}" ]; then
  exit 0
fi

INPUT=$(cat)

DIR=$(resolve_project_dir "$INPUT")

if ! is_git_repo "$DIR"; then
  exit 0
fi

CACHE_FILE="$DIR/CLAUDE.local.md"

# Only a missing cache file is treated as fresh. When it already exists it may
# already be populated, so we must never flag it for populate.
if [ ! -f "$CACHE_FILE" ]; then
  {
    printf '%s\n\n' '# Local repo cache (machine-only, gitignored)'
    printf '%s\n' "$CACHE_SENTINEL"
    printf '%s\n' 'This file is a local, auto-maintained cache of how this repo is structured so fresh sessions do not have to re-explore it. It is never committed.'
  } >"$CACHE_FILE"
  NEEDS_POPULATE_FILE=$(needs_populate_path "$DIR") && touch "$NEEDS_POPULATE_FILE"
fi

BASELINE_FILE=$(baseline_path "$DIR") || exit 0
SIG=$(working_tree_signature "$DIR")
write_atomic "$BASELINE_FILE" "$SIG"

exit 0
