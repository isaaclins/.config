#!/bin/sh
# Detached background worker for the CLAUDE.local.md repo cache.
#
# Spawned by cache-on-stop.sh with nohup so it outlives the interactive turn.
# It forks the current conversation into a headless claude that updates the
# gitignored CLAUDE.local.md cache file, then exits. The foreground session is
# never blocked.
#
# Args:
#   $1 = repo dir
#   $2 = session id (may be empty; empty falls back to a fresh headless run)
#
# A mkdir-based lock (with staleness reclaim) ensures only one worker runs per
# repo at a time. On a successful fork the baseline is resynced to the current
# working-tree signature and the needs-populate marker is removed. On failure
# both are left untouched so a later Stop retries. Always exits 0.
#
# The fork runs WITHOUT --bare so it authenticates via the macOS Keychain and
# loads hooks plus CLAUDE.md. Two consequences are handled here:
#   1. Recursion: the child's SessionStart/Stop hooks fire. We export
#      CLAUDE_CACHE_REFRESH=1 so the child and its hook processes inherit it, and
#      both hooks early-exit on that var.
#   2. Delegation: CLAUDE.md tells claude to orchestrate and delegate to a
#      subagent. We pass --disallowedTools "Task" and tell the prompt to edit the
#      file itself so the fork writes CLAUDE.local.md directly.
# The prompt is passed via STDIN (not as a positional arg) because --allowedTools
# is variadic and would otherwise eat a trailing positional prompt.

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/cache-lib.sh"

DIR=$1
SID=${2:-}

if [ -z "$DIR" ] || ! is_git_repo "$DIR"; then
  exit 0
fi

# Acquire the lock or bail if another live worker holds it.
if ! lock_acquire "$DIR"; then
  exit 0
fi
# Always release the lock when we exit, however we exit.
trap 'lock_release "$DIR"' EXIT INT TERM

cd "$DIR" 2>/dev/null || exit 0

# Single line, no double quotes, no em dashes. The fork loads CLAUDE.md, which
# carries the delegate-to-implementer rule, so the prompt must explicitly tell it
# to do the work itself and not use the Task tool.
REFRESH_PROMPT='Update the gitignored CLAUDE.local.md at the repo root so a fresh session can rely on it without re-exploring this repo. Cover the purpose, a structure map, the key files and entry points, how to build and test and run, the conventions, and notable gotchas. Base it on this session plus a quick look. Replace the file contents entirely and remove any unpopulated sentinel comment. Keep it tight and skimmable. Do not use em dashes anywhere; use commas, periods, or parentheses instead. Do this YOURSELF by editing CLAUDE.local.md directly, do not delegate and do not use the Task tool. Edit ONLY CLAUDE.local.md, then stop.'

# Set the recursion guard so the forked claude AND its inherited hook processes
# see it and early-exit, preventing a nested worker spawn.
export CLAUDE_CACHE_REFRESH=1

# Per-repo log so a detached failure is visible (the worker is otherwise silent).
LOG_FILE=$(info_state_path "$DIR" claude-cache-refresh.log)

# Fork the live conversation when we have a session id; otherwise fall back to a
# fresh headless run with no prior context. The prompt goes in via stdin.
if [ -n "$SID" ]; then
  cache_log "$DIR" "refresh start (model=opus, fork=yes)"
  printf '%s' "$REFRESH_PROMPT" | claude -p \
    --resume "$SID" --fork-session --no-session-persistence \
    --model opus --permission-mode acceptEdits \
    --allowedTools "Read,Edit,Write,Glob,Grep,Bash" \
    --disallowedTools "Task" >>"$LOG_FILE" 2>&1
  CLAUDE_STATUS=$?
else
  cache_log "$DIR" "refresh start (model=opus, fork=no)"
  printf '%s' "$REFRESH_PROMPT" | claude -p \
    --no-session-persistence \
    --model opus --permission-mode acceptEdits \
    --allowedTools "Read,Edit,Write,Glob,Grep,Bash" \
    --disallowedTools "Task" >>"$LOG_FILE" 2>&1
  CLAUDE_STATUS=$?
fi

# On success: resync the baseline to the current tree and clear the marker so
# the Stop hook stops flagging this state. On failure: leave both untouched so a
# later Stop retries. The lock is released by the EXIT trap either way.
if [ "$CLAUDE_STATUS" -eq 0 ]; then
  BASELINE_FILE=$(baseline_path "$DIR") && \
    write_atomic "$BASELINE_FILE" "$(working_tree_signature "$DIR")"
  NEEDS_POPULATE_FILE=$(needs_populate_path "$DIR") && rm -f "$NEEDS_POPULATE_FILE"
  cache_log "$DIR" "claude exit $CLAUDE_STATUS ok: baseline advanced, marker cleared"
else
  cache_log "$DIR" "claude exit $CLAUDE_STATUS failed: left for retry"
fi

exit 0
