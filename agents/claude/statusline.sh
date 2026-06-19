#!/usr/bin/env bash
#
# Custom Claude Code status line.
# Renders one truecolor line: repo/branch, model, session-usage bar, today's
# cost, and context-window usage.
# The usage bar mirrors Claude Code's native "Current session" gauge: it reads
# rate_limits.five_hour from the statusLine stdin JSON, so the bar FILLS and
# REDDENS as the 5-hour session limit is consumed (51% used = ~half-full,
# yellow at 50%, red at 80%) and its label is the percent USED plus the time
# remaining until the 5-hour window resets (resets_at minus now). When the
# client does not send rate_limits (older versions) the bar falls back to the
# ccusage token heuristic so the line still shows something.
# Today's cost is backed by ccusage with an 8s file cache.
#
# Responsive: the line is RESPONSIVE to terminal width. Claude Code exports
# $COLUMNS before running this script; we build the line at the richest level
# that fits and step down a compaction ladder (L0 full .. L7 hero only) as the
# terminal narrows, so the most useful information stays on ONE line at any
# width. When $COLUMNS is unknown we always emit the full L0 line. See the
# `LADDER` section near the bottom for the per-level forms and drop priority
# (cost -> model -> context -> git, with the usage hero always kept).
#
# Design goals: never blank, never error. Every value has a safe default and
# the line always prints, even with no git repo, no ccusage, no active block,
# empty stdin, no network, or unknown width. If width measurement ever fails we
# fall back to emitting the full line.

# Deliberately NOT using `set -e`/`set -u`: a single failing command or unset
# variable must never blank the status line.

# A UTF-8 locale makes bash ${#var} count CHARACTERS not bytes, which the
# visible-width measurement relies on. extglob enables the ANSI-strip pattern.
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
shopt -s extglob

export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# ccusage reads usage JSONL from the Claude config dir. Claude Code normally
# exports CLAUDE_CONFIG_DIR when spawning this script, but default to the known
# active config dir so ccusage still finds data in a stripped environment.
if [ -z "$CLAUDE_CONFIG_DIR" ]; then
  DEFAULT_CLAUDE_DIR="$HOME/.config/agents/claude"
  [ -d "$DEFAULT_CLAUDE_DIR/projects" ] && export CLAUDE_CONFIG_DIR="$DEFAULT_CLAUDE_DIR"
fi

JQ="/usr/bin/jq"
[ -x "$JQ" ] || JQ="jq"

CACHE_FILE="${TMPDIR:-/tmp}/.cc-statusline.cache"
CACHE_MAX_AGE=8

# Token limit the usage bar measures against. Empty = auto (your peak completed
# 5-hour block). Set to a fixed integer (e.g. 19000000) to use your own cap.
USAGE_LIMIT_OVERRIDE=""

# Discover a stable ccusage entrypoint and its matching node binary under the
# fnm node-versions store. We pick an installed version directory (preferring
# the newest) rather than the per-shell fnm_multishells path, since the version
# store survives across shells. We require BOTH a runnable node and a present
# ccusage cli.js from the SAME version so resolve_ccusage() can pair them.
# If nothing matches, these stay empty and resolve_ccusage() falls through to
# `command -v ccusage` then `bunx ccusage`, keeping the fallback chain intact.
CCUSAGE_CLI=""
NODE_BIN=""
FNM_NODE_DIR="$HOME/.local/share/fnm/node-versions"
if [ -d "$FNM_NODE_DIR" ]; then
  # Newest-first ordering is a preference, not a requirement. `sort -rV` is not
  # guaranteed on macOS (BSD), so we feed it the version basenames and fall back
  # to a plain reverse sort if -V is unsupported, never erroring on the sort.
  fnm_versions="$(ls -1 "$FNM_NODE_DIR" 2>/dev/null)"
  fnm_sorted="$(printf '%s\n' "$fnm_versions" | sort -rV 2>/dev/null)"
  [ -n "$fnm_sorted" ] || fnm_sorted="$(printf '%s\n' "$fnm_versions" | sort -r 2>/dev/null)"
  [ -n "$fnm_sorted" ] || fnm_sorted="$fnm_versions"
  while IFS= read -r fnm_ver; do
    [ -n "$fnm_ver" ] || continue
    candidate_node="$FNM_NODE_DIR/$fnm_ver/installation/bin/node"
    candidate_cli="$FNM_NODE_DIR/$fnm_ver/installation/lib/node_modules/ccusage/dist/cli.js"
    if [ -x "$candidate_node" ] && [ -f "$candidate_cli" ]; then
      NODE_BIN="$candidate_node"
      CCUSAGE_CLI="$candidate_cli"
      break
    fi
  done <<EOF
$fnm_sorted
EOF
fi

# Emoji literals (kept here so the rest of the script reads cleanly).
EMOJI_BRANCH="🌿"
EMOJI_MODEL="🤖"
EMOJI_USAGE="🔋"
EMOJI_COST="💰"
EMOJI_CONTEXT="🧠"

# -----------------------------------------------------------------------------
# ccusage resolver: print a command prefix that runs ccusage, or empty if none.
# Tries, in order: stable node+cli.js, ccusage on PATH, bunx ccusage.
# -----------------------------------------------------------------------------
resolve_ccusage() {
  if [ -x "$NODE_BIN" ] && [ -f "$CCUSAGE_CLI" ]; then
    printf '%s\n' "$NODE_BIN $CCUSAGE_CLI"
    return 0
  fi
  local on_path
  on_path="$(command -v ccusage 2>/dev/null)"
  if [ -n "$on_path" ] && [ -x "$on_path" ]; then
    printf '%s\n' "$on_path"
    return 0
  fi
  if [ -x "$HOME/.bun/bin/bunx" ]; then
    printf '%s\n' "$HOME/.bun/bin/bunx ccusage"
    return 0
  fi
  printf '%s\n' ""
  return 1
}

# -----------------------------------------------------------------------------
# Refresh the cache by calling ccusage twice (blocks + daily) and writing
# shell-sourceable primitives. Falls back to safe defaults on any failure.
#
# The single `blocks --json` call carries the active block's token usage plus
# every completed block (used to derive the peak baseline).
# -----------------------------------------------------------------------------
refresh_cache() {
  local cc has_block used_tokens peak_tokens reset_epoch today blocks_json daily_json today_date

  cc="$(resolve_ccusage)"
  has_block=0
  used_tokens=0
  peak_tokens=0
  reset_epoch=0
  today="--"

  if [ -n "$cc" ]; then
    today_date="$(date +%Y-%m-%d)"

    blocks_json="$($cc blocks --json 2>/dev/null)"
    if [ -n "$blocks_json" ]; then
      local parsed
      parsed="$(printf '%s' "$blocks_json" | "$JQ" -r '
        (.blocks // []) as $b
        | ([ $b[] | select(.isActive == true) ][0]) as $a
        | ([ $b[] | select((.isActive != true) and (.isGap != true)) | (.totalTokens // 0) ] | max // 0) as $peak
        | if ($a != null) then
            [ 1, ($a.totalTokens // 0), $peak,
              ($a.endTime | try (sub("\\.[0-9]+Z$";"Z") | fromdateiso8601) catch 0) ] | @tsv
          else
            [ 0, 0, $peak, 0 ] | @tsv
          end
      ' 2>/dev/null)"
      if [ -n "$parsed" ]; then
        IFS=$'\t' read -r has_block used_tokens peak_tokens reset_epoch <<< "$parsed"
      fi
    fi

    daily_json="$($cc daily --json 2>/dev/null)"
    if [ -n "$daily_json" ]; then
      local t
      t="$(printf '%s' "$daily_json" | "$JQ" -r --arg today "$today_date" '
        [ (.daily // [])[] | select(.period == $today) | .totalCost ] | add // 0
      ' 2>/dev/null)"
      [ -n "$t" ] && today="$t"
    fi
  fi

  # Guard against any empty primitives before persisting.
  [ -n "$has_block" ]   || has_block=0
  [ -n "$used_tokens" ] || used_tokens=0
  [ -n "$peak_tokens" ] || peak_tokens=0
  [ -n "$reset_epoch" ] || reset_epoch=0
  [ -n "$today" ]       || today="--"

  {
    printf 'HAS_BLOCK=%s\n'    "$has_block"
    printf 'USED_TOKENS=%s\n'  "$used_tokens"
    printf 'PEAK_TOKENS=%s\n'  "$peak_tokens"
    printf 'RESET_EPOCH=%s\n'  "$reset_epoch"
    printf 'TODAY=%s\n'        "$today"
  } > "$CACHE_FILE" 2>/dev/null
}

# Cache age in seconds via stat (BSD first, GNU fallback). Large number = stale.
cache_age() {
  local mtime now
  mtime="$(stat -f %m "$CACHE_FILE" 2>/dev/null || stat -c %Y "$CACHE_FILE" 2>/dev/null)"
  [ -n "$mtime" ] || { printf '%s\n' 999999; return; }
  now="$(date +%s)"
  printf '%s\n' "$(( now - mtime ))"
}

# -----------------------------------------------------------------------------
# Load cache primitives, refreshing first if missing or stale.
# -----------------------------------------------------------------------------
HAS_BLOCK=0
USED_TOKENS=0
PEAK_TOKENS=0
RESET_EPOCH=0
TODAY="--"

if [ ! -f "$CACHE_FILE" ] || [ "$(cache_age)" -ge "$CACHE_MAX_AGE" ]; then
  refresh_cache
fi
# shellcheck disable=SC1090
[ -f "$CACHE_FILE" ] && . "$CACHE_FILE" 2>/dev/null

# -----------------------------------------------------------------------------
# Read stdin JSON (model + workspace dir). Tolerate empty / malformed input.
# -----------------------------------------------------------------------------
STDIN_JSON=""
if [ ! -t 0 ]; then
  STDIN_JSON="$(cat 2>/dev/null)"
fi

MODEL="Claude"
CUR_DIR=""
CONTEXT_PCT=-1
SESSION_USED_PCT=-1
SESSION_RESET_EPOCH=0
if [ -n "$STDIN_JSON" ]; then
  # Single jq call returns model, dir, context %, and the live 5-hour session
  # rate-limit fields tab-separated; split with the read builtin. Context %
  # falls back to tokens/size, then a -1 sentinel.
  #
  # SESSION_USED_PCT  rate_limits.five_hour.used_percentage (-1 if absent)
  # SESSION_RESET_EPOCH  rate_limits.five_hour.resets_at as a UTC unix epoch.
  #   resets_at may be a number (use as-is) or an ISO 8601 string (strip any
  #   fractional seconds, then fromdateiso8601); the whole conversion is wrapped
  #   in try/catch so a bad or missing value yields 0.
  stdin_parsed="$(printf '%s' "$STDIN_JSON" | "$JQ" -r '
    [ (.model.display_name // ""),
      (.workspace.current_dir // .cwd // ""),
      ( .context_window.used_percentage
        // ( if (.context_window.context_window_size // 0) > 0
             then ((.context_window.total_input_tokens // 0) / .context_window.context_window_size * 100)
             else -1 end )
        // -1 ),
      ( .rate_limits.five_hour.used_percentage // -1 ),
      ( (.rate_limits.five_hour.resets_at) as $r
        | if ($r | type) == "number" then $r
          elif ($r | type) == "string"
          then ($r | (sub("\\.[0-9]+";"") | sub("\\.[0-9]+Z$";"Z")) | try fromdateiso8601 catch 0)
          else 0 end ) ] | @tsv
  ' 2>/dev/null)"
  if [ -n "$stdin_parsed" ]; then
    IFS=$'\t' read -r parsed_model CUR_DIR CONTEXT_PCT SESSION_USED_PCT SESSION_RESET_EPOCH <<< "$stdin_parsed"
    [ -n "$parsed_model" ] && MODEL="$parsed_model"
  fi
fi

# Defensive defaults: any empty primitive falls back to a safe sentinel.
[ -n "$SESSION_USED_PCT" ]    || SESSION_USED_PCT=-1
[ -n "$SESSION_RESET_EPOCH" ] || SESSION_RESET_EPOCH=0

# -----------------------------------------------------------------------------
# Color helpers (truecolor). All escapes are emitted as literal bytes so the
# final output needs no %b interpretation, only %s.
# -----------------------------------------------------------------------------
ESC=$'\033'
RESET="${ESC}[0m"
DIM="${ESC}[2m"
BOLD="${ESC}[1m"

col() { printf '%s[38;2;%d;%d;%dm' "$ESC" "$1" "$2" "$3"; }

# Dim gray separator with surrounding spaces: " │ ".
SEP="${ESC}[2;38;2;90;90;90m │ ${RESET}"

# -----------------------------------------------------------------------------
# Visible (display) width of a colored string, in terminal columns.
# Strips ANSI SGR escapes, counts the rest as 1 column each, then adds +1 for
# every wide emoji (each renders as 2 columns). Relies on the UTF-8 locale set
# at the top so ${#var} counts characters not bytes. Subshell-free for speed.
# If the locale is unavailable the count may overestimate slightly, which only
# makes the ladder compact a touch early (safe: it never wraps).
# -----------------------------------------------------------------------------
WIDE_EMOJI=("$EMOJI_BRANCH" "$EMOJI_MODEL" "$EMOJI_USAGE" "$EMOJI_COST" "$EMOJI_CONTEXT")

visible_width() {
  local s="$1" clean tmp e occ width
  # Strip every ESC[ ... m SGR sequence (extglob: zero+ of digits/semicolons).
  clean="${s//$'\033'\[*([0-9;])m/}"
  width=${#clean}
  # Each wide emoji is one character but two columns: add +1 per occurrence.
  for e in "${WIDE_EMOJI[@]}"; do
    tmp="${clean//$e/}"
    occ=$(( ${#clean} - ${#tmp} ))
    width=$(( width + occ ))
  done
  printf '%s' "$width"
}

# -----------------------------------------------------------------------------
# Segment 1: repo + branch (only inside a git repo). Computed once into GIT_SEG;
# it has a single form, so the ladder either includes it (L0..L6) or drops it
# (L7). Empty when not in a git repo.
# -----------------------------------------------------------------------------
GIT_SEG=""
git_segment() {
  [ -n "$CUR_DIR" ] || return 0
  [ -d "$CUR_DIR" ] || return 0

  local toplevel branch repo seg cyan
  toplevel="$(git -C "$CUR_DIR" --no-optional-locks rev-parse --show-toplevel 2>/dev/null)"
  [ -n "$toplevel" ] || return 0

  repo="$(basename "$toplevel")"
  branch="$(git -C "$CUR_DIR" --no-optional-locks symbolic-ref --short HEAD 2>/dev/null)"

  seg="${BOLD}${repo}${RESET}"
  if [ -n "$branch" ]; then
    cyan="$(col 80 220 220)"
    seg="${seg} ${cyan}${EMOJI_BRANCH} ${branch}${RESET}"
  fi
  GIT_SEG="$seg"
}

# -----------------------------------------------------------------------------
# Segment 2: model. Two forms for the ladder: the full display name (L0), and a
# trimmed name with any trailing parenthetical (e.g. " (1M context)") dropped
# (L1+). Both are precomputed; the ladder picks the form per level.
# -----------------------------------------------------------------------------
MODEL_TRIMMED="$MODEL"
model_segment() {
  # Drop a trailing " (...)" suffix, keeping e.g. "Opus 4.8".
  MODEL_TRIMMED="${MODEL%% (*}"
  [ -n "$MODEL_TRIMMED" ] || MODEL_TRIMMED="$MODEL"
}

# Model segment string at a given form: "full" keeps the parenthetical, "trim"
# drops it. Color is unchanged from the original.
model_seg() {
  local name="$MODEL"
  [ "$1" = "trim" ] && name="$MODEL_TRIMMED"
  printf '%s%s %s%s' "$(col 200 120 220)" "$EMOJI_MODEL" "$name" "$RESET"
}

# -----------------------------------------------------------------------------
# Compact token formatter: integer -> short human form (198M, 6.4M, 450K, 12).
# Uses awk for the decimal cases since it is always available. Empty / non-
# numeric input defaults to 0.
# -----------------------------------------------------------------------------
fmt_tokens() {
  local n="$1"
  case "$n" in
    ''|*[!0-9]*) n=0 ;;
  esac

  if [ "$n" -ge 10000000 ]; then
    awk -v n="$n" 'BEGIN { printf "%dM", int(n/1000000 + 0.5) }'
  elif [ "$n" -ge 1000000 ]; then
    awk -v n="$n" 'BEGIN { printf "%.1fM", n/1000000 }'
  elif [ "$n" -ge 1000 ]; then
    awk -v n="$n" 'BEGIN { printf "%dK", int(n/1000 + 0.5) }'
  else
    printf '%d' "$n"
  fi
}

# -----------------------------------------------------------------------------
# Compact duration formatter: non-negative integer SECONDS -> short human form.
# "Xh Ymin" when at least an hour, "Ymin" when at least a minute, else "<1min".
# Empty / non-numeric input defaults to 0.
# -----------------------------------------------------------------------------
fmt_duration() {
  local secs="$1"
  case "$secs" in ''|*[!0-9]*) secs=0 ;; esac
  local total_min=$(( secs / 60 ))
  local h=$(( total_min / 60 ))
  local m=$(( total_min % 60 ))
  if [ "$h" -gt 0 ]; then
    printf '%dh %dmin' "$h" "$m"
  elif [ "$total_min" -gt 0 ]; then
    printf '%dmin' "$m"
  else
    printf '<1min'
  fi
}

# -----------------------------------------------------------------------------
# Minutes-only duration formatter for the compact ladder levels (L4+):
# non-negative integer SECONDS -> "<T>min" total minutes (e.g. 70min). Empty /
# non-numeric input defaults to 0min.
# -----------------------------------------------------------------------------
fmt_minutes() {
  local secs="$1"
  case "$secs" in ''|*[!0-9]*) secs=0 ;; esac
  printf '%dmin' "$(( secs / 60 ))"
}

# -----------------------------------------------------------------------------
# Segment 3: session-usage bar (the hero).
# Solid-fill gauge that mirrors Claude Code's native "Current session" gauge.
# The fill length is how much of the 5-hour session limit is USED
# (rate_limits.five_hour.used_percentage): empty = fresh, full = exhausted, so
# the bar FILLS and REDDENS as the session is consumed. The fill is a single
# solid color set by the caller to match the level (green low, yellow mid, red
# high by used_percentage). The label counts down the time until the 5-hour
# window resets (rate_limits.five_hour.resets_at minus now). Stdin is read fresh
# every render, so both the percent and the countdown stay live without a cache.
# -----------------------------------------------------------------------------
build_bar() {
  # $1 = fill percentage (0..100), $2 $3 $4 = filled-cell color (r g b),
  # $5 = cell count (optional, defaults to 14 so existing callers are unchanged).
  local pct="$1" r="$2" g="$3" b="$4" cells="${5:-14}"
  local i filled out=""
  filled=$(( (pct * cells + 50) / 100 ))
  [ "$filled" -lt 0 ] && filled=0
  [ "$filled" -gt "$cells" ] && filled="$cells"

  for ((i=0; i<cells; i++)); do
    if [ "$i" -lt "$filled" ]; then
      out="${out}$(col "$r" "$g" "$b")█"
    else
      out="${out}$(col 235 235 235)░"
    fi
  done
  printf '%s%s' "$out" "$RESET"
}

# -----------------------------------------------------------------------------
# Gradient bar for context-window usage (distinct from the solid fuel gauge).
# Each cell is tinted by its fixed position along a green->yellow->red ramp.
# Cells fill `█` up to the fill point and stay empty `░` in white beyond it, so
# as context grows more cells light up and the lit tip moves into red. The cell
# count is parameterized (default 10) so the responsive ladder can request a
# shorter 5-cell bar; the ramp still spans the full green->red range.
# -----------------------------------------------------------------------------
build_gradient_bar() {
  # $1 = fill percentage (0..100), $2 = cell count (optional, defaults to 10
  # so existing callers are unchanged).
  local pct="$1" cells="${2:-10}"
  local i filled pos adj r g b out="" span
  filled=$(( (pct * cells + 50) / 100 ))
  [ "$filled" -lt 0 ] && filled=0
  [ "$filled" -gt "$cells" ] && filled="$cells"

  # Spread the ramp across however many cells there are (avoid div-by-zero).
  span=$(( cells - 1 ))
  [ "$span" -lt 1 ] && span=1

  for ((i=0; i<cells; i++)); do
    pos=$(( i * 100 / span ))
    if [ "$pos" -le 50 ]; then
      r=$(( 220 * pos / 50 )); g=200; b=$(( 80 - 80 * pos / 50 ))
    else
      adj=$(( pos - 50 )); r=220; g=$(( 200 - 160 * adj / 50 )); b=$(( 20 * adj / 50 ))
    fi
    if [ "$i" -lt "$filled" ]; then
      out="${out}$(col "$r" "$g" "$b")█"
    else
      out="${out}$(col 235 235 235)░"
    fi
  done
  printf '%s%s' "$out" "$RESET"
}

# Hero state shared across ladder forms, precomputed once by usage_segment().
#   HERO_STATE   "block" usable percent + bar | "noblock" | "nobaseline"
#   HERO_PCT     percentage USED (0..100) when in "block" state; the bar fills
#                to this and the (NN%) label shows it
#   HERO_COL     ANSI color for the level (green/yellow/red by used percentage)
#   HERO_TIME    "1" when a live reset countdown is known, "0" otherwise
#   HERO_SECS    seconds left until the 5-hour window resets (when HERO_TIME=1)
#   HERO_NB_TXT  dim trailing text for the noblock/nobaseline fallback states
HERO_STATE="noblock"
HERO_PCT=0
HERO_COL=""
HERO_COL_R=80; HERO_COL_G=200; HERO_COL_B=80
HERO_TIME=0
HERO_SECS=0
HERO_NB_TXT="no active block"

# -----------------------------------------------------------------------------
# Segment 3: session-usage bar (the hero). Computes the shared state above once;
# the per-level form is rendered by hero_seg(). The hero is NEVER dropped by the
# ladder, only progressively compacted (full label -> parens -> no bar ->
# minutes -> minimal "<T>min (<pct>%)").
#
# PRIMARY source: the live 5-hour session rate limit from the statusLine stdin
# JSON (rate_limits.five_hour). HERO_PCT is used_percentage (how much of the
# session limit is consumed): the bar fills to it and reddens as it climbs, and
# the label counts down to resets_at. Used whenever SESSION_USED_PCT is a valid
# number >= 0 (0 is valid).
#
# FALLBACK source: when the client does not send rate_limits (SESSION_USED_PCT
# is the -1 sentinel, e.g. an older client), reuse the ccusage active-block
# heuristic so the line still shows something. That path's percentage is the
# old token estimate of used share (best effort only). If neither source is
# available the hero collapses to "no active block" / "🔋 --".
# -----------------------------------------------------------------------------
usage_segment() {
  # PRIMARY: authoritative session usage from rate_limits.five_hour.
  if [ "$SESSION_USED_PCT" != "-1" ]; then
    usage_segment_from_rate_limits && return 0
  fi
  # FALLBACK: ccusage active-block heuristic.
  usage_segment_from_ccusage
}

# Color the hero by how much of the session is USED: <50 green, 50-79 yellow,
# >=80 red. The same color fills the bar and tints the label so the two stay
# cohesive. Sets HERO_COL and the HERO_COL_R/G/B triple from $1 (a 0..100 pct).
hero_color_from_used() {
  local used_pct="$1" levelr levelg levelb
  if [ "$used_pct" -lt 50 ]; then
    levelr=80;  levelg=200; levelb=80
  elif [ "$used_pct" -lt 80 ]; then
    levelr=220; levelg=200; levelb=0
  else
    levelr=220; levelg=40;  levelb=20
  fi
  HERO_COL="$(col "$levelr" "$levelg" "$levelb")"
  HERO_COL_R="$levelr"; HERO_COL_G="$levelg"; HERO_COL_B="$levelb"
}

# PRIMARY hero state from rate_limits.five_hour. Returns non-zero (so the caller
# falls back) only when the percentage is not a usable number.
usage_segment_from_rate_limits() {
  local used_pct now_epoch secs_left

  # Round the (possibly fractional) used_percentage and clamp to 0..100.
  used_pct="$(printf '%.0f' "$SESSION_USED_PCT" 2>/dev/null)"
  case "$used_pct" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$used_pct" -lt 0 ] && used_pct=0
  [ "$used_pct" -gt 100 ] && used_pct=100

  HERO_STATE="block"
  HERO_PCT="$used_pct"
  hero_color_from_used "$used_pct"

  # Live countdown to the 5-hour window reset (resets_at minus now), clamped to
  # >= 0. The -gt test is guarded so a non-numeric epoch can never error out.
  if [ "$SESSION_RESET_EPOCH" -gt 0 ] 2>/dev/null; then
    now_epoch="$(date +%s)"
    secs_left=$(( SESSION_RESET_EPOCH - now_epoch ))
    [ "$secs_left" -lt 0 ] && secs_left=0
    HERO_TIME=1
    HERO_SECS="$secs_left"
  else
    HERO_TIME=0
  fi
  return 0
}

# FALLBACK hero state from the ccusage active-block heuristic (older clients
# that do not send rate_limits). The percentage here is a best-effort estimate
# of the USED share of the active block, so the bar still fills and reddens with
# consumption to match the primary path. The label counts down to the block's
# cached reset epoch.
usage_segment_from_ccusage() {
  local limit used pct_used

  if [ "$HAS_BLOCK" != "1" ]; then
    HERO_STATE="noblock"
    HERO_NB_TXT="no active block"
    return 0
  fi

  # Effective limit: a valid positive override wins, else the auto peak.
  limit="$PEAK_TOKENS"
  case "$USAGE_LIMIT_OVERRIDE" in
    ''|*[!0-9]*) : ;;
    *) [ "$USAGE_LIMIT_OVERRIDE" -gt 0 ] && limit="$USAGE_LIMIT_OVERRIDE" ;;
  esac

  used="$USED_TOKENS"
  case "$used" in
    ''|*[!0-9]*) used=0 ;;
  esac
  case "$limit" in
    ''|*[!0-9]*) limit=0 ;;
  esac

  # No baseline yet (brand-new user): honest fallback, no fake percentage.
  if [ "$limit" -le 0 ]; then
    HERO_STATE="nobaseline"
    HERO_NB_TXT="$(fmt_tokens "$used") used"
    return 0
  fi

  HERO_STATE="block"

  pct_used=$(( used * 100 / limit ))
  [ "$pct_used" -lt 0 ] && pct_used=0
  [ "$pct_used" -gt 100 ] && pct_used=100
  HERO_PCT="$pct_used"
  hero_color_from_used "$pct_used"

  # Live countdown to the active block's reset. If no reset epoch is known
  # (corrupt or missing cache) the hero forms omit the time entirely rather than
  # show a bogus value. The -gt test is guarded so a non-numeric RESET_EPOCH can
  # never error out and blank the line.
  if [ "$RESET_EPOCH" -gt 0 ] 2>/dev/null; then
    local now_epoch secs_left
    now_epoch="$(date +%s)"
    secs_left=$(( RESET_EPOCH - now_epoch ))
    [ "$secs_left" -lt 0 ] && secs_left=0
    HERO_TIME=1
    HERO_SECS="$secs_left"
  else
    HERO_TIME=0
  fi
}

# Build the hero string for a ladder form. All forms show SESSION USAGE: the bar
# fills to HERO_PCT (percent used) and reddens with it, the (NN%) label is that
# same percent used, and the time counts down to the 5-hour window reset.
#   $1 form:
#     full        🔋 <bar(14)> <Hh Mmin> (<pct>%)   (L0)
#     paren       🔋 <bar(cells)> <Hh Mmin> (<pct>%)  (L1, L2)
#     paren_nobar 🔋 <Hh Mmin> (<pct>%)             (L3)
#     min_paren   🔋 <T>min (<pct>%)                (L4, L5)
#     minimal     🔋 <T>min (<pct>%)                (L6, L7)
#   $2 bar cell count for the paren form (default 14).
# When the reset time is unknown the time portion is omitted, never a bogus
# value (e.g. full becomes "🔋 <bar> (<pct>%)", minimal becomes "🔋 (<pct>%)").
# The noblock / nobaseline fallback states keep their dim label and collapse to
# "🔋 --" for the tightest forms.
hero_seg() {
  local form="$1" cells="${2:-14}" bar dur

  if [ "$HERO_STATE" != "block" ]; then
    case "$form" in
      full|paren)
        printf '%s %s %s%s%s' "$EMOJI_USAGE" "$(build_bar 0 60 60 60 "$cells")" \
          "$DIM" "$HERO_NB_TXT" "$RESET"
        ;;
      paren_nobar)
        printf '%s %s%s%s' "$EMOJI_USAGE" "$DIM" "$HERO_NB_TXT" "$RESET"
        ;;
      *)
        printf '%s %s--%s' "$EMOJI_USAGE" "$DIM" "$RESET"
        ;;
    esac
    return 0
  fi

  case "$form" in
    full)
      bar="$(build_bar "$HERO_PCT" "$HERO_COL_R" "$HERO_COL_G" "$HERO_COL_B" 14)"
      if [ "$HERO_TIME" = "1" ]; then
        printf '%s %s %s%s (%s%%)%s' "$EMOJI_USAGE" "$bar" \
          "$HERO_COL" "$(fmt_duration "$HERO_SECS")" "$HERO_PCT" "$RESET"
      else
        printf '%s %s %s(%s%%)%s' "$EMOJI_USAGE" "$bar" "$HERO_COL" "$HERO_PCT" "$RESET"
      fi
      ;;
    paren)
      bar="$(build_bar "$HERO_PCT" "$HERO_COL_R" "$HERO_COL_G" "$HERO_COL_B" "$cells")"
      if [ "$HERO_TIME" = "1" ]; then
        printf '%s %s %s%s (%s%%)%s' "$EMOJI_USAGE" "$bar" \
          "$HERO_COL" "$(fmt_duration "$HERO_SECS")" "$HERO_PCT" "$RESET"
      else
        printf '%s %s %s(%s%%)%s' "$EMOJI_USAGE" "$bar" "$HERO_COL" "$HERO_PCT" "$RESET"
      fi
      ;;
    paren_nobar)
      if [ "$HERO_TIME" = "1" ]; then
        printf '%s %s%s (%s%%)%s' "$EMOJI_USAGE" \
          "$HERO_COL" "$(fmt_duration "$HERO_SECS")" "$HERO_PCT" "$RESET"
      else
        printf '%s %s(%s%%)%s' "$EMOJI_USAGE" "$HERO_COL" "$HERO_PCT" "$RESET"
      fi
      ;;
    min_paren)
      if [ "$HERO_TIME" = "1" ]; then
        printf '%s %s%s (%s%%)%s' "$EMOJI_USAGE" \
          "$HERO_COL" "$(fmt_minutes "$HERO_SECS")" "$HERO_PCT" "$RESET"
      else
        printf '%s %s(%s%%)%s' "$EMOJI_USAGE" "$HERO_COL" "$HERO_PCT" "$RESET"
      fi
      ;;
    pct_only)
      # Tightest form: 🔋 <pct>% (percent used only, drop the time entirely).
      printf '%s %s%s%%%s' "$EMOJI_USAGE" "$HERO_COL" "$HERO_PCT" "$RESET"
      ;;
    *)
      # minimal: 🔋 <T>min (<pct>%) (time then percent used, no bar). When the
      # reset time is unknown it collapses to just 🔋 <pct>%.
      if [ "$HERO_TIME" = "1" ]; then
        dur="$(fmt_minutes "$HERO_SECS")"
        printf '%s %s%s (%s%%)%s' "$EMOJI_USAGE" "$HERO_COL" "$dur" "$HERO_PCT" "$RESET"
      else
        printf '%s %s%s%%%s' "$EMOJI_USAGE" "$HERO_COL" "$HERO_PCT" "$RESET"
      fi
      ;;
  esac
}

# -----------------------------------------------------------------------------
# Segment 4: today's cost. Computed once into COST_AMOUNT; cost_seg() renders it
# with ("today") or without ("plain") the trailing "today" word.
# -----------------------------------------------------------------------------
COST_AMOUNT="--"
today_segment() {
  if [ "$TODAY" = "--" ] || [ -z "$TODAY" ]; then
    COST_AMOUNT="--"
    return 0
  fi
  COST_AMOUNT="$(printf '%.2f' "$TODAY" 2>/dev/null)"
  [ -n "$COST_AMOUNT" ] || COST_AMOUNT="--"
}

cost_seg() {
  # $1 form: "today" appends a dim " today", "plain" omits it.
  if [ "$1" = "today" ]; then
    printf '%s%s $%s%s%s today%s' "$(col 220 200 0)" "$EMOJI_COST" "$COST_AMOUNT" \
      "$RESET" "$DIM" "$RESET"
    return 0
  fi
  printf '%s%s $%s%s' "$(col 220 200 0)" "$EMOJI_COST" "$COST_AMOUNT" "$RESET"
}

# -----------------------------------------------------------------------------
# Segment 5: context-window usage. Computes the percentage once; context_seg()
# renders it as a gradient bar plus number (forms "bar"/"bar5") or just the
# number (form "num"). Gradient bar fills and reddens as the window fills up.
# -----------------------------------------------------------------------------
CTX_KNOWN=0
CTX_PCT=0
CTX_COL=""
context_segment() {
  local pctint levelr levelg levelb

  # Unknown when empty, the -1 sentinel, or any negative value.
  case "$CONTEXT_PCT" in
    ''|-*) CTX_KNOWN=0; return 0 ;;
  esac

  pctint="$(printf '%.0f' "$CONTEXT_PCT" 2>/dev/null)"
  case "$pctint" in
    ''|*[!0-9]*) CTX_KNOWN=0; return 0 ;;
  esac
  [ "$pctint" -lt 0 ] && pctint=0
  [ "$pctint" -gt 100 ] && pctint=100
  CTX_KNOWN=1
  CTX_PCT="$pctint"

  # Label color from how full the context is: <50 green, 50-79 yellow, >=80 red.
  if [ "$pctint" -lt 50 ]; then
    levelr=80;  levelg=200; levelb=80
  elif [ "$pctint" -lt 80 ]; then
    levelr=220; levelg=200; levelb=0
  else
    levelr=220; levelg=40;  levelb=20
  fi
  CTX_COL="$(col "$levelr" "$levelg" "$levelb")"
}

context_seg() {
  # $1 form: "bar" (10 cells), "bar5" (5 cells), "num" (number only).
  local form="$1" cells=10
  if [ "$CTX_KNOWN" != "1" ]; then
    case "$form" in
      bar)  printf '%s %s %s--%%%s' "$EMOJI_CONTEXT" "$(build_gradient_bar 0 10)" "$DIM" "$RESET" ;;
      bar5) printf '%s %s %s--%%%s' "$EMOJI_CONTEXT" "$(build_gradient_bar 0 5)" "$DIM" "$RESET" ;;
      *)    printf '%s %s--%%%s' "$EMOJI_CONTEXT" "$DIM" "$RESET" ;;
    esac
    return 0
  fi
  case "$form" in
    num)
      printf '%s %s%s%%%s' "$EMOJI_CONTEXT" "$CTX_COL" "$CTX_PCT" "$RESET"
      return 0
      ;;
    bar5) cells=5 ;;
  esac
  printf '%s %s %s%s%%%s' "$EMOJI_CONTEXT" "$(build_gradient_bar "$CTX_PCT" "$cells")" \
    "$CTX_COL" "$CTX_PCT" "$RESET"
}

# -----------------------------------------------------------------------------
# Join non-empty segment strings with the dim separator " │ ".
# -----------------------------------------------------------------------------
join_segments() {
  local out="" seg
  for seg in "$@"; do
    [ -n "$seg" ] || continue
    if [ -z "$out" ]; then
      out="$seg"
    else
      out="${out}${SEP}${seg}"
    fi
  done
  printf '%s' "$out"
}

# -----------------------------------------------------------------------------
# LADDER: render the whole line at a compaction level (0 richest .. 7 most
# compact). Forms come from the per-segment builders; all values are live, none
# hardcoded. Drop priority (lowest value first): cost -> model -> context ->
# git, with the usage hero always kept.
#   L0 Full: git | model(full) | hero(full,14bar) | cost(today) | ctx(10bar)
#   L1 Trim: git | model(trim) | hero(paren,14bar) | cost(plain) | ctx(10bar)
#   L2 Bars: git | model(trim) | hero(paren,8bar) | cost(plain) | ctx(5bar)
#   L3 NoBar: git | model(trim) | hero(paren_nobar) | cost(plain) | ctx(num)
#   L4 Mins: git | model(trim) | hero(min_paren) | ctx(num)        (cost dropped)
#   L5 NoModel: git | hero(min_paren) | ctx(num)                   (model dropped)
#   L6 MinHero: git | hero(minimal)                                (ctx dropped)
#   L7 HeroOnly: hero(minimal)                                     (git dropped)
#   L8 PctOnly: hero(pct_only)                         (time dropped, 🔋 <pct>%)
# -----------------------------------------------------------------------------
render_level() {
  case "$1" in
    0) join_segments "$GIT_SEG" "$(model_seg full)" "$(hero_seg full)" "$(cost_seg today)" "$(context_seg bar)" ;;
    1) join_segments "$GIT_SEG" "$(model_seg trim)" "$(hero_seg paren 14)" "$(cost_seg plain)" "$(context_seg bar)" ;;
    2) join_segments "$GIT_SEG" "$(model_seg trim)" "$(hero_seg paren 8)" "$(cost_seg plain)" "$(context_seg bar5)" ;;
    3) join_segments "$GIT_SEG" "$(model_seg trim)" "$(hero_seg paren_nobar)" "$(cost_seg plain)" "$(context_seg num)" ;;
    4) join_segments "$GIT_SEG" "$(model_seg trim)" "$(hero_seg min_paren)" "$(context_seg num)" ;;
    5) join_segments "$GIT_SEG" "$(hero_seg min_paren)" "$(context_seg num)" ;;
    6) join_segments "$GIT_SEG" "$(hero_seg minimal)" ;;
    7) hero_seg minimal ;;
    *) hero_seg pct_only ;;
  esac
}

# -----------------------------------------------------------------------------
# Assemble and print exactly one line with a single leading space.
# Precompute each segment's shared state, read the terminal width, then build
# the line at the RICHEST ladder level whose visible width fits COLS - 1. If the
# width is unknown (COLUMNS unset or non-numeric) we always emit the full L0
# line. If none fit we emit the most compact level (CC's `…` handles the rest).
# -----------------------------------------------------------------------------
git_segment
model_segment
usage_segment
today_segment
context_segment

COLS="${COLUMNS}"
case "$COLS" in
  ''|*[!0-9]*) COLS=0 ;;   # unknown width -> treat as unlimited (full line).
esac

line=""
if [ "$COLS" -le 0 ]; then
  line="$(render_level 0)"
else
  budget=$(( COLS - 1 ))   # 1-col safety margin under CC's truncation point.
  level=0
  while [ "$level" -le 8 ]; do
    line="$(render_level "$level")"
    [ "$(visible_width "$line")" -le "$budget" ] && break
    level=$(( level + 1 ))
  done
  # If even L8 (🔋 <pct>%) overflows, `line` holds L8 and CC's ellipsis trims it.
fi

printf ' %s\n' "$line"
