#!/usr/bin/env bash
# ~/.config/pi/rpc/pi-rpc-server.sh
# Purpose: Run pi-rpc-server on loopback and publish it over the tailnet as HTTPS
#   via `tailscale serve`, with the API token read from the login Keychain.
#
#   The RPC surface includes a `bash` command that reaches session.executeBash(),
#   i.e. arbitrary shell execution as this user. So the agent itself binds only
#   127.0.0.1 and is never reachable directly; Tailscale terminates TLS with a
#   real Let's Encrypt cert for the MagicDNS name and proxies to loopback. That
#   cert is what lets iOS App Transport Security accept the connection.
#
#   Nothing here is machine-specific: the bind address is resolved from tailscale
#   at start, so a fresh `git pull` on another machine works unchanged.
# Usage: Started by launchd (com.isaaclins.pi-rpc). Manual run:
#   bash ~/.config/pi/rpc/pi-rpc-server.sh

set -euo pipefail

PORT="${PI_RPC_PORT:-3000}"
KEYCHAIN_SERVICE="${PI_RPC_KEYCHAIN_SERVICE:-pi-rpc-token}"
export CWD="${PI_RPC_CWD:-${HOME}/Projects}"

# launchd hands us a minimal PATH, and node/npx here resolve to a per-shell fnm
# multishell dir that does not exist outside an interactive session. Use the
# bun-installed binary directly instead.
export PATH="${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

tailscale_bin="$(command -v tailscale || true)"
if [ -z "$tailscale_bin" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  tailscale_bin="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
fi
if [ -z "$tailscale_bin" ]; then
  echo "[pi-rpc] tailscale not found; refusing to start" >&2
  exit 78
fi

server_bin="$(command -v pi-rpc-server || true)"
if [ -z "$server_bin" ]; then
  echo "[pi-rpc] pi-rpc-server missing; run: bun install -g pi-rpc-server" >&2
  exit 78
fi

# At login the tailnet is usually not up yet, and `serve` needs it.
bind_ip=""
for _ in $(seq 1 60); do
  bind_ip="$("$tailscale_bin" ip -4 2>/dev/null | head -n1 || true)"
  [ -n "$bind_ip" ] && break
  sleep 5
done
if [ -z "$bind_ip" ]; then
  echo "[pi-rpc] no Tailscale IPv4 after 5 minutes; refusing to start" >&2
  exit 75
fi

# Publish tailnet :443 -> loopback :PORT over TLS. Idempotent, and re-asserted on
# every start so a `tailscale serve reset` elsewhere cannot silently drop HTTPS.
serve_ok=""
for _ in $(seq 1 5); do
  if "$tailscale_bin" serve --bg --https=443 "http://127.0.0.1:${PORT}" >/dev/null 2>&1; then
    serve_ok=1
    break
  fi
  sleep 5
done
if [ -z "$serve_ok" ]; then
  echo "[pi-rpc] 'tailscale serve' failed. HTTPS certs must be enabled for the" >&2
  echo "[pi-rpc] tailnet: https://login.tailscale.com/admin/dns -> Enable HTTPS." >&2
  exit 78
fi

token="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null || true)"
if [ -z "$token" ]; then
  echo "[pi-rpc] no token in Keychain service '${KEYCHAIN_SERVICE}'" >&2
  echo "[pi-rpc] run: bash ~/.config/bootstrap/cli/shell/install-pi-rpc-server.sh" >&2
  exit 78
fi
export PI_API_TOKEN="$token"

echo "[pi-rpc] $(date '+%F %T') loopback :${PORT} via tailscale serve https, cwd=${CWD}"
exec "$server_bin" --host 127.0.0.1 --port "$PORT"
