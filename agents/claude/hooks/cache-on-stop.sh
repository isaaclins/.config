#!/bin/sh
# Stop hook: keep the per-repo CLAUDE.local.md cache in sync, NON-BLOCKING.
#
# This hook never blocks the interactive session and never emits a block
# decision. When the cache still needs its first populate (a needs-populate
# marker exists) or the working tree changed during this session, it spawns a
# detached background worker that forks the current conversation into a headless
# claude, writes CLAUDE.local.md, and exits. The hook itself returns instantly.
#
# Populate state is read from a marker file under .git/info, never inferred from
# the cache content, so a cache that documents the placeholder text cannot loop.
# A rolling-window throttle allows up to 5 refreshes per session within any
# 1-hour window to keep background Opus forks bounded for cost. A mkdir-based
# lock ensures only one worker runs per repo at a time.
#
# Reads the hook JSON from stdin. Prints nothing. Always exits 0.

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/cache-lib.sh"

WORKER="$SCRIPT_DIR/cache-refresh-worker.sh"

INPUT=$(cat)
SESSION_ID=$(json_str_field "$INPUT" session_id)

# Recursion guard: the background refresh worker runs a forked claude (no
# --bare, so hooks DO load), and this Stop hook fires inside that child. When the
# refresh env var is set, exit so the fork never spawns another worker.
if [ -n "${CLAUDE_CACHE_REFRESH:-}" ]; then
  exit 0
fi

DIR=$(resolve_project_dir "$INPUT")

if ! is_git_repo "$DIR"; then
  exit 0
fi

BASELINE_FILE=$(baseline_path "$DIR") || exit 0
CUR=$(working_tree_signature "$DIR")

# No reference point yet: record the current signature and stop quietly.
if [ ! -f "$BASELINE_FILE" ]; then
  write_atomic "$BASELINE_FILE" "$CUR"
  exit 0
fi

BASELINE=$(cat "$BASELINE_FILE" 2>/dev/null)

# Populate-state comes from the marker file, never from the cache content.
NEEDS_POPULATE_FILE=$(needs_populate_path "$DIR")
NEEDS_POPULATE=no
if [ -f "$NEEDS_POPULATE_FILE" ]; then
  NEEDS_POPULATE=yes
fi

CHANGED=no
if [ "$CUR" != "$BASELINE" ]; then
  CHANGED=yes
fi

# Nothing to do.
if [ "$NEEDS_POPULATE" = no ] && [ "$CHANGED" = no ]; then
  exit 0
fi

# Throttle: keep background Opus forks bounded per session. When the budget is
# exhausted, stay silent and leave the baseline untouched so the pending change
# is still detected and fires once the window refills.
if ! throttle_allow "$DIR" "$SESSION_ID"; then
  exit 0
fi

# A worker is already running for this repo: skip spawning a second one.
if lock_is_held "$DIR"; then
  exit 0
fi

# Spawn the worker detached so the hook returns instantly and the worker
# outlives the turn. The worker acquires the lock, runs the fork, and on success
# resyncs the baseline and clears the needs-populate marker.
nohup "$WORKER" "$DIR" "$SESSION_ID" >/dev/null 2>&1 &

exit 0
