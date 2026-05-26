# ~/.config/fish/functions/__config_git_repo_root.fish
# Purpose: Resolve the ~/.config git repository root.
# Usage: Internal helper used by config git sync functions.
function __config_git_repo_root --description "Resolve the ~/.config git repository root"
    set -l repo_root "$HOME/.config"
    command -sq git; or return 1

    set -l detected (command git -C "$repo_root" rev-parse --show-toplevel 2>/dev/null)
    test -n "$detected"; or return 1
    echo "$detected"
end
