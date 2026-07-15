#!/usr/bin/env bash
# ~/.config/bootstrap/cli/shell/install-claude-computer-use-mcp.sh
# Enable the built-in `computer-use` MCP server for every project in .claude.json.
#
# Claude Code stores built-in MCP server enablement per-project under
# projects.<path>.enabledMcpServers. There is no global toggle, so this script
# adds "computer-use" to every project entry (and is safe to re-run for new ones).
#
# IMPORTANT: run this with all Claude Code sessions closed. The running process
# rewrites .claude.json from memory on exit and would otherwise clobber the edit.
set -euo pipefail

config="${CLAUDE_CONFIG_DIR:-$HOME/.config/agents/claude}/.claude.json"

if [ ! -f "$config" ]; then
  # Fresh machine: Claude Code has not run yet, so there is nothing to patch.
  # Re-run bootstrap (or this script) after the first Claude session.
  echo "skip: $config not found (run again after Claude Code's first start)"
  exit 0
fi

if pgrep -x claude >/dev/null 2>&1; then
  echo "warning: a 'claude' process is running; it may overwrite this edit on exit." >&2
  echo "         close all Claude Code sessions, then re-run this script." >&2
fi

backup="$config.bak.$(date +%Y%m%d%H%M%S)"
cp "$config" "$backup"
echo "backup: $backup"

python3 - "$config" <<'PY'
import json, sys

path = sys.argv[1]
with open(path) as f:
    data = json.load(f)

server = "computer-use"
projects = data.get("projects", {})
changed = 0
for name, cfg in projects.items():
    if not isinstance(cfg, dict):
        continue
    enabled = cfg.get("enabledMcpServers")
    if not isinstance(enabled, list):
        enabled = []
    if server not in enabled:
        enabled.append(server)
        cfg["enabledMcpServers"] = enabled
        changed += 1
    else:
        cfg["enabledMcpServers"] = enabled

with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")

print(f"enabled '{server}' in {changed} project(s); {len(projects)} total.")
PY

echo "done."
