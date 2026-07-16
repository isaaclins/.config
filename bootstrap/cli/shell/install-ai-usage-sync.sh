#!/usr/bin/env bash
# ~/.config/bootstrap/cli/shell/install-ai-usage-sync.sh
# Purpose: Install a launchd job that sends compact ccusage aggregates to the
#   homeserver every six hours. The transfer uses existing SSH key auth and
#   contains no prompts, conversation text, or source files.
# Usage: Idempotent. Run via bootstrap.sh or directly:
#   bash ~/.config/bootstrap/cli/shell/install-ai-usage-sync.sh

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "AI usage sync is only installed on macOS"
  exit 0
fi

fish_path="$(command -v fish)"
launch_agents_dir="${HOME}/Library/LaunchAgents"
state_dir="${HOME}/.local/state/ai-usage-sync"
plist_path="${launch_agents_dir}/com.isaaclins.ai-usage-sync.plist"

mkdir -p "${launch_agents_dir}" "${state_dir}"

cat >"${plist_path}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.isaaclins.ai-usage-sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>${fish_path}</string>
    <string>-lc</string>
    <string>sync_ai_usage</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>21600</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${state_dir}/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${state_dir}/stderr.log</string>
</dict>
</plist>
EOF

plutil -lint "${plist_path}" >/dev/null
launchctl bootout "gui/$(id -u)/com.isaaclins.ai-usage-sync" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "${plist_path}"
echo "installed com.isaaclins.ai-usage-sync (every six hours)"
