#!/usr/bin/env bash
# ~/.config/bootstrap/doctor.sh
# Purpose: Verify setup correctness without installing or modifying anything.
#   Checks symlinks, JSON validity, executables, brew packages, and git config.
#   Useful for pre-flight validation on a new machine or troubleshooting a broken setup.
# Usage: Manual verification (bootstrap.sh does NOT run this automatically).
#   bash ~/.config/bootstrap/doctor.sh

set -euo pipefail

FAILED=0

# Color printing
ok() {
  printf '\033[32m%s\033[0m\n' "OK: $*"
}

fail() {
  printf '\033[31m%s\033[0m\n' "FAIL: $*" >&2
  FAILED=1
}

# Check symlink exists and resolves
check_symlink() {
  local symlink_path="$1"
  local expected_target="$2"
  local symlink_display="${symlink_path/#$HOME/~}"
  local target_display="${expected_target/#$HOME/~}"

  if [[ ! -L "$symlink_path" ]]; then
    fail "Symlink $symlink_display does not exist"
    return
  fi

  local actual_target
  actual_target="$(readlink "$symlink_path")"
  if [[ "$actual_target" != "$expected_target" ]]; then
    fail "Symlink $symlink_display points to $actual_target, expected $expected_target"
    return
  fi

  if [[ ! -e "$symlink_path" ]]; then
    fail "Symlink $symlink_display resolves to nonexistent target $target_display"
    return
  fi

  ok "Symlink $symlink_display -> $target_display"
}

# Check JSON validity
check_json() {
  local file="$1"
  local file_display="${file/#$HOME/~}"

  if [[ ! -f "$file" ]]; then
    fail "File $file_display does not exist"
    return
  fi

  if ! python3 -c "import json; json.load(open('$file'))" 2>/dev/null; then
    fail "File $file_display is not valid JSON"
    return
  fi

  ok "File $file_display is valid JSON"
}

# Check executable exists and is executable
check_executable() {
  local file="$1"
  local file_display="${file/#$HOME/~}"

  if [[ ! -f "$file" ]]; then
    fail "Executable $file_display does not exist"
    return
  fi

  if [[ ! -x "$file" ]]; then
    fail "File $file_display is not executable"
    return
  fi

  ok "Executable $file_display exists and is executable"
}

# Check command is on PATH
check_command() {
  local cmd="$1"

  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail "Command $cmd not found on PATH"
    return
  fi

  ok "Command $cmd found on PATH"
}

# Parse externalEditor value from settings.json, expanding ~ and checking executability
check_external_editor() {
  local settings_file="$HOME/.config/pi/settings.json"
  local editor_value
  local editor_cmd

  if [[ ! -f "$settings_file" ]]; then
    fail "Settings file $settings_file does not exist"
    return
  fi

  editor_value=$(python3 -c "
import json
try:
    data = json.load(open('$settings_file'))
    editor = data.get('externalEditor', '')
    if editor:
        print(editor)
except Exception as e:
    print(f'', file=__import__('sys').stderr)
" 2>/dev/null || echo "")

  if [[ -z "$editor_value" ]]; then
    fail "externalEditor not set in $settings_file"
    return
  fi

  editor_cmd=$(echo "$editor_value" | awk '{print $1}')
  editor_cmd="${editor_cmd/#\~/$HOME}"

  if [[ ! -f "$editor_cmd" ]]; then
    fail "externalEditor command '$editor_cmd' does not exist"
    return
  fi

  if [[ ! -x "$editor_cmd" ]]; then
    fail "externalEditor command '$editor_cmd' is not executable"
    return
  fi

  ok "externalEditor '$editor_value' resolves to executable"
}

# Main checks
echo "Pi setup doctor starting..."
echo

# 1. Symlinks
echo "=== Checking symlinks ==="
check_symlink "$HOME/.pi/agent/settings.json" "$HOME/.config/pi/settings.json"
check_symlink "$HOME/.pi/agent/models.json" "$HOME/.config/pi/models.json"
check_symlink "$HOME/.pi/agent/AGENTS.md" "$HOME/.config/agents/AGENTS.md"
check_symlink "$HOME/.pi/agent/extensions" "$HOME/.config/pi/extensions"
check_symlink "$HOME/.pi/agent/lib" "$HOME/.config/pi/lib"
check_symlink "$HOME/.pi/agent/assets" "$HOME/.config/pi/assets"
echo

# 2. JSON validity
echo "=== Checking JSON validity ==="
check_json "$HOME/.config/pi/settings.json"
check_json "$HOME/.config/pi/models.json"
echo

# 3. External editor
echo "=== Checking external editor ==="
check_external_editor
echo

# 4. Pi-external-editor wrapper and zed-preview
echo "=== Checking editor infrastructure ==="
check_executable "$HOME/.config/pi/pi-external-editor"
check_executable "/opt/homebrew/bin/zed-preview"
echo

# 5. Notifier binary
echo "=== Checking notifier binary ==="
check_executable "$HOME/.config/pi/assets/Claude Notifier.app/Contents/MacOS/terminal-notifier"
echo

# 6. Brew packages
echo "=== Checking brew packages on PATH ==="
check_command "pi"
check_command "fish"
check_command "zed-preview"
echo

# 7. Git config
echo "=== Checking git config ==="
if ! git -C "$HOME/.config" config core.hooksPath | grep -q ".githooks"; then
  fail "Git core.hooksPath not set to .githooks in ~/.config"
else
  ok "Git core.hooksPath set to .githooks"
fi
echo

# Summary
echo "=== Summary ==="
if [[ $FAILED -eq 0 ]]; then
  echo "✓ All checks passed!"
  exit 0
else
  echo "✗ $FAILED check(s) failed. Review above."
  exit 1
fi
