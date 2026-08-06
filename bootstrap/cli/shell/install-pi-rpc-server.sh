#!/usr/bin/env bash
# ~/.config/bootstrap/cli/shell/install-pi-rpc-server.sh
# Purpose: Always-on pi RPC server for the Pi Dev mobile app. Installs the server
#   under bun, generates a per-machine API token into the login Keychain, and
#   registers a launchd job that binds it to this machine's Tailscale address.
#
#   The token is generated locally on every machine and is deliberately NOT part
#   of this repo: the repo is public, and the RPC surface includes a `bash`
#   command, so a committed token would be remote code execution for anyone who
#   cloned it.
# Usage: Idempotent. Run via bootstrap.sh or directly:
#   bash ~/.config/bootstrap/cli/shell/install-pi-rpc-server.sh

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "pi RPC launchd job is only installed on macOS"
  exit 0
fi

label="com.isaaclins.pi-rpc"
keychain_service="pi-rpc-token"
launch_agents_dir="${HOME}/Library/LaunchAgents"
state_dir="${HOME}/.local/state/pi-rpc"
plist_path="${launch_agents_dir}/${label}.plist"
runner="${HOME}/.config/pi/rpc/pi-rpc-server.sh"

mkdir -p "${launch_agents_dir}" "${state_dir}"

if [ ! -f "${runner}" ]; then
  echo "missing ${runner}" >&2
  exit 1
fi

# 1. Server binary. The package ships a bun shebang and declares engines.bun,
# and npx resolves node through a per-shell fnm dir that launchd cannot see.
export PATH="${HOME}/.bun/bin:${PATH}"
if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required first: brew install oven-sh/bun/bun" >&2
  exit 1
fi
if [ ! -x "${HOME}/.bun/bin/pi-rpc-server" ]; then
  bun install -g pi-rpc-server
fi

# 2. Per-machine token, generated locally into the login Keychain.
if security find-generic-password -s "${keychain_service}" -w >/dev/null 2>&1; then
  echo "reusing existing Keychain token (service: ${keychain_service})"
else
  token="$(openssl rand -hex 24)"
  security add-generic-password \
    -a "${USER}" \
    -s "${keychain_service}" \
    -w "${token}" \
    -T /usr/bin/security \
    -U
  echo "generated a new pi RPC token into the login Keychain"
fi

# 3. launchd job. KeepAlive restarts it on crash; ThrottleInterval stops a
# misconfigured exit (no tailnet, no token) from spinning.
cat >"${plist_path}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${runner}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
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
launchctl bootout "gui/$(id -u)/${label}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "${plist_path}"

echo "installed ${label}"
echo "  url:   http://$(scutil --get LocalHostName | tr '[:upper:]' '[:lower:]').$(tailscale status --json 2>/dev/null | sed -n 's/.*"MagicDNSSuffix": *"\([^"]*\)".*/\1/p' | head -1):3000"
echo "  token: security find-generic-password -s ${keychain_service} -w"
