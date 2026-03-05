#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Generate new Password
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 🤖
# @raycast.packageName Password Generator

# Documentation:
# @raycast.description This script generates a new password, copies it to clipboard, displays that a new password was generated and pastes it.
# @raycast.author isaaclins
# @raycast.authorURL https://isaaclins.com/

set -euo pipefail

PASSWORD_LENGTH=24

# Customize these two variables to your liking.
# - `ALLOWED_LETTERS` should contain only letters (A-Z, a-z).
# - `ALLOWED_SPECIAL` may contain any printable ASCII characters (no spaces/newlines).
ALLOWED_LETTERS='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
ALLOWED_SPECIAL='!@#$%^&*()_+{}:,./?'

PASTE_DELAY_SECONDS=0.35

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

contains_char() {
  # $1 = set, $2 = single character
  printf %s "$1" | LC_ALL=C grep -Fq -- "$2"
}

random_password() {
  local pool pool_len out byte idx ch

  pool="${ALLOWED_LETTERS}${ALLOWED_SPECIAL}"
  pool_len=${#pool}
  if ((pool_len == 0)); then
    echo "Character pool is empty."
    return 1
  fi

  out=""
  while ((${#out} < PASSWORD_LENGTH)); do
    # Use bytes from /dev/urandom and map them into `pool` via modulo.
    # `od` output example: "  12 255  34 ..."
    while IFS= read -r byte; do
      [[ -n "$byte" ]] || continue
      idx=$((byte % pool_len))
      ch="${pool:idx:1}"
      out+="$ch"
      ((${#out} >= PASSWORD_LENGTH)) && break
    done < <(LC_ALL=C od -An -N 64 -tu1 /dev/urandom | tr -s '[:space:]' '\n')
  done

  printf %s "$out"
}

copy_to_clipboard() {
  if has_cmd pbcopy; then
    printf %s "$password" | pbcopy && return 0
  fi

  if has_cmd osascript; then
    # Fallback path when `pbcopy` isn't available.
    osascript >/dev/null 2>&1 <<APPLESCRIPT
set the clipboard to "$password"
APPLESCRIPT
    return 0
  fi

  return 1
}

schedule_paste() {
  # Run after Raycast closes so the keystroke goes to the previously focused app.
  has_cmd osascript || return 1
  osascript >/dev/null 2>&1 <<APPLESCRIPT &
delay ${PASTE_DELAY_SECONDS}
tell application "System Events"
  keystroke "v" using {command down}
end tell
APPLESCRIPT
  return 0
}

password=""
max_tries=50
try=0
while :; do
  try=$((try + 1))
  password="$(random_password)"

  ((${#password} == PASSWORD_LENGTH)) || {
    ((try >= max_tries)) && { echo "Failed to generate a password"; exit 1; }
    continue
  }

  # Ensure at least one letter AND one special character.
  has_letter=0
  has_special=0
  for ((i = 0; i < ${#password}; i++)); do
    c="${password:i:1}"
    if ((has_letter == 0)) && contains_char "$ALLOWED_LETTERS" "$c"; then
      has_letter=1
    fi
    if ((has_special == 0)) && contains_char "$ALLOWED_SPECIAL" "$c"; then
      has_special=1
    fi
    ((has_letter && has_special)) && break
  done

  if ((has_letter == 0 || has_special == 0)); then
    ((try >= max_tries)) && { echo "Failed to generate a password"; exit 1; }
    continue
  fi

  break
done

if ! copy_to_clipboard; then
  echo "Failed to copy password to clipboard."
  if [[ "${SHOW_PASSWORD_ON_FAILURE:-}" == "1" || "${SHOW_PASSWORD:-}" == "1" ]]; then
    echo "$password"
  fi
  exit 1
fi

if [[ "${NO_PASTE:-}" != "1" && "${RAYCAST_NO_PASTE:-}" != "1" ]]; then
  schedule_paste || true
fi

echo "New password generated and copied to clipboard."
