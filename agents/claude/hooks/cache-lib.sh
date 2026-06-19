# shellcheck shell=sh
# Shared helpers for the CLAUDE.local.md repo cache hooks.
# Sourced by cache-on-session-start.sh and cache-on-stop.sh.
# Kept POSIX-ish so it works on the macOS default bash (3.2).

# Decorative marker line written into a fresh placeholder cache file so a
# human can tell at a glance it has not been filled in yet. Nothing greps it;
# populate-state is tracked by the needs-populate marker file instead.
CACHE_SENTINEL='<!-- claude-cache:unpopulated -->'

# Extract a top-level string field from the stdin JSON by key, without jq.
# Splits on JSON structural characters, finds the "key" entry, and strips
# everything around the quoted value. Prints an empty string if not found.
json_str_field() {
  stdin_json=$1
  key=$2
  printf '%s' "$stdin_json" \
    | tr ',{}' '\n\n\n' \
    | grep "\"$key\"" \
    | head -n 1 \
    | sed -e "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"//" -e 's/".*//'
}

# Resolve the project directory.
# Order: CLAUDE_PROJECT_DIR env var, then the cwd field from the stdin JSON
# passed as the first argument, then PWD.
resolve_project_dir() {
  stdin_json=$1
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    printf '%s' "$CLAUDE_PROJECT_DIR"
    return 0
  fi
  cwd_value=$(json_str_field "$stdin_json" cwd)
  if [ -n "$cwd_value" ]; then
    printf '%s' "$cwd_value"
    return 0
  fi
  printf '%s' "$PWD"
}

# True when the directory is inside a git working tree.
is_git_repo() {
  git -C "$1" rev-parse --git-dir >/dev/null 2>&1
}

# Append a timestamped line to the per-repo refresh log under <git-dir>/info.
# The log lives inside .git, so it is never tracked (and **/*.log ignores it
# anyway). Before appending, if the log has grown past ~200 lines, truncate it
# to its last 100 lines so it can never grow unbounded.
cache_log() {
  repo_dir=$1
  message=$2
  log_file=$(info_state_path "$repo_dir" claude-cache-refresh.log) || return 0
  if [ -f "$log_file" ]; then
    line_count=$(wc -l <"$log_file" 2>/dev/null | tr -d ' ')
    case "$line_count" in
      ''|*[!0-9]*) line_count=0 ;;
    esac
    if [ "$line_count" -gt 200 ]; then
      tail_tmp="$log_file.tmp.$$"
      tail -n 100 "$log_file" >"$tail_tmp" 2>/dev/null && mv -f "$tail_tmp" "$log_file"
    fi
  fi
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$message" >>"$log_file" 2>/dev/null
  return 0
}

# Print the absolute path to a per-repo state file under <git-dir>/info.
# These files live inside .git, so they are never tracked, never pushed, and
# never collide with the content of any tracked or gitignored file.
info_state_path() {
  repo_dir=$1
  file_name=$2
  git_dir=$(git -C "$repo_dir" rev-parse --git-dir 2>/dev/null) || return 1
  case "$git_dir" in
    /*) : ;;
    *) git_dir="$repo_dir/$git_dir" ;;
  esac
  mkdir -p "$git_dir/info" 2>/dev/null
  printf '%s' "$git_dir/info/$file_name"
}

# Print the absolute path to the baseline working-tree signature file.
baseline_path() {
  info_state_path "$1" claude-cache-baseline
}

# Print the absolute path to the needs-populate marker file. Its existence
# means the cache placeholder still needs to be filled in for the first time.
needs_populate_path() {
  info_state_path "$1" claude-cache-needs-populate
}

# Print the absolute path to the per-session throttle state file for a
# session id. The id is sanitized to a safe filename: only [A-Za-z0-9._-] is
# kept, anything else becomes '_'. An empty session id yields an empty path,
# which callers treat as "no throttle".
session_marker_path() {
  repo_dir=$1
  session_id=$2
  if [ -z "$session_id" ]; then
    return 0
  fi
  safe_id=$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9._-' '_')
  info_state_path "$repo_dir" "claude-cache-session-$safe_id"
}

# Compute the working-tree signature for a repo.
# Hashes the full porcelain status including untracked files. Because
# CLAUDE.local.md is gitignored it never appears here, so cache edits
# never change the signature.
working_tree_signature() {
  status_output=$(git -C "$1" status --porcelain --untracked-files=all 2>/dev/null)
  printf '%s' "$status_output" | git -C "$1" hash-object --stdin 2>/dev/null
}

# Write a value to a file atomically (temp file in the same dir, then mv).
write_atomic() {
  target=$1
  value=$2
  target_dir=$(dirname "$target")
  tmp_file="$target_dir/.claude-cache-baseline.tmp.$$"
  printf '%s' "$value" >"$tmp_file" 2>/dev/null || return 1
  mv -f "$tmp_file" "$target"
}

# Print the absolute path to the cache-refresh lock directory for a repo. A
# single mkdir-based lock under .git/info serializes background workers so only
# one refresh fork runs per repo at a time.
lock_path() {
  info_state_path "$1" claude-cache-refresh.lock
}

# Number of seconds after which a held lock is considered stale and may be
# reclaimed. A crashed or killed worker can leave its lock behind, so a fresh
# worker must be able to take over once enough time has passed.
LOCK_STALE_SECONDS=600

# Try to acquire the refresh lock for a repo. mkdir is atomic, so it doubles as
# a mutex: the first caller that creates the dir wins. If the dir already exists
# but is older than LOCK_STALE_SECONDS, treat it as abandoned, reclaim it, and
# succeed. Returns 0 when the lock is held by the caller, 1 when another live
# worker holds it.
lock_acquire() {
  lock_dir=$(lock_path "$1") || return 1
  if mkdir "$lock_dir" 2>/dev/null; then
    return 0
  fi

  # Lock exists: only reclaim it when it is stale.
  if ! lock_is_stale "$lock_dir"; then
    return 1
  fi
  rmdir "$lock_dir" 2>/dev/null
  if mkdir "$lock_dir" 2>/dev/null; then
    return 0
  fi
  return 1
}

# Print 0/1 staleness by age, used only via the boolean test below. True (0)
# when the lock dir is missing or its mtime is older than LOCK_STALE_SECONDS.
lock_is_stale() {
  lock_dir=$1
  if [ ! -d "$lock_dir" ]; then
    return 0
  fi
  lock_mtime=$(stat -f %m "$lock_dir" 2>/dev/null || stat -c %Y "$lock_dir" 2>/dev/null)
  case "$lock_mtime" in
    ''|*[!0-9]*) return 0 ;;
  esac
  now=$(date +%s)
  if [ "$((now - lock_mtime))" -ge "$LOCK_STALE_SECONDS" ]; then
    return 0
  fi
  return 1
}

# Release the refresh lock for a repo. Safe to call even if the lock is not
# held; rmdir simply fails quietly on a missing dir.
lock_release() {
  lock_dir=$(lock_path "$1") || return 0
  rmdir "$lock_dir" 2>/dev/null
  return 0
}

# True when a live (non-stale) refresh lock is held for a repo. Used by the Stop
# hook to skip spawning a second worker while one is already running.
lock_is_held() {
  lock_dir=$(lock_path "$1") || return 1
  if [ ! -d "$lock_dir" ]; then
    return 1
  fi
  if lock_is_stale "$lock_dir"; then
    return 1
  fi
  return 0
}

# Rolling-window throttle for Stop-hook blocks. Allows up to THROTTLE_LIMIT
# blocks per session within a THROTTLE_WINDOW-second window; the budget refills
# to full once a window elapses from its start.
THROTTLE_LIMIT=5
THROTTLE_WINDOW=3600

# Check and consume one throttle slot for a repo + session.
# Returns 0 (allow) and records the consumption, or 1 (deny) without changing
# state. An empty session id (or empty marker path) always allows. The marker
# stores "window_start_epoch count" on one line; a missing, empty, or malformed
# marker (including the legacy 0-byte once-per-session marker) is treated as a
# fresh window.
throttle_allow() {
  repo_dir=$1
  session_id=$2
  if [ -z "$session_id" ]; then
    return 0
  fi
  marker=$(session_marker_path "$repo_dir" "$session_id")
  if [ -z "$marker" ]; then
    return 0
  fi

  now=$(date +%s)

  window_start=""
  count=""
  if [ -f "$marker" ]; then
    read -r window_start count _rest <"$marker" 2>/dev/null
  fi
  case "$window_start" in
    ''|*[!0-9]*) window_start=""; count="" ;;
  esac
  case "$count" in
    ''|*[!0-9]*) window_start=""; count="" ;;
  esac
  if [ -z "$window_start" ] || [ -z "$count" ]; then
    window_start=$now
    count=0
  fi

  if [ "$((now - window_start))" -ge "$THROTTLE_WINDOW" ]; then
    window_start=$now
    count=0
  fi

  if [ "$count" -ge "$THROTTLE_LIMIT" ]; then
    return 1
  fi

  count=$((count + 1))
  write_atomic "$marker" "$window_start $count"
  return 0
}
