#!/usr/bin/env bash
# ~/.config/bootstrap/cli/shell/install-macos-tmux-keys.sh
# Purpose: Free ctrl+arrow keys from macOS Mission Control / Spaces shortcuts
#   so they reach the terminal and drive tmux pane focus (see tmux/tmux.conf).
#   Disables symbolic hotkeys 79-82 (move space left/right) and 32-35
#   (Mission Control / App Windows) including shifted variants.
# Revert: System Settings > Keyboard > Keyboard Shortcuts > Mission Control.
# Usage: Idempotent. Run via bootstrap.sh, or directly:
#   bash ~/.config/bootstrap/cli/shell/install-macos-tmux-keys.sh

set -euo pipefail

python3 <<'EOF'
import plistlib, subprocess

out = subprocess.run(
    ["defaults", "export", "com.apple.symbolichotkeys", "-"],
    capture_output=True, check=True,
)
config = plistlib.loads(out.stdout)
hotkeys = config.setdefault("AppleSymbolicHotKeys", {})

CTRL_ARROW_HOTKEYS = {
    "79": [65535, 123, 8650752],  # move space left (ctrl+left)
    "80": [65535, 123, 8781824],  # shifted variant
    "81": [65535, 124, 8650752],  # move space right (ctrl+right)
    "82": [65535, 124, 8781824],  # shifted variant
    "32": [65535, 126, 8650752],  # mission control (ctrl+up)
    "34": [65535, 126, 8781824],  # shifted variant
    "33": [65535, 125, 8650752],  # app windows (ctrl+down)
    "35": [65535, 125, 8781824],  # shifted variant
}

changed = []
for key, parameters in CTRL_ARROW_HOTKEYS.items():
    entry = hotkeys.get(key)
    if entry is None:
        hotkeys[key] = {"enabled": False, "value": {"type": "standard", "parameters": parameters}}
        changed.append(key)
    elif entry.get("enabled"):
        entry["enabled"] = False
        changed.append(key)

if changed:
    subprocess.run(
        ["defaults", "import", "com.apple.symbolichotkeys", "-"],
        input=plistlib.dumps(config), check=True,
    )
    print(f"disabled hotkeys: {', '.join(changed)}")
else:
    print("already disabled, nothing to do")
EOF

# Apply without logout.
/System/Library/PrivateFrameworks/SystemAdministration.framework/Resources/activateSettings -u
