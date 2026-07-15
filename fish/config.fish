# ~/.config/fish/config.fish
# Purpose: Interactive shell bootstrap for session-only behavior.
# Usage: Auto-loaded by fish at startup; edit values here, then run `exec fish` to fully reload.
if status is-interactive
    # Auto-jump to projects directory if a fresh top-level shell starts in $HOME.
    # Nested/exec'd shells inherit the guard variable and are left where they are.
    if not set -q __projects_autocd; and test (pwd) = $HOME; and test -d ~/Projects/
        cd ~/Projects/
    end
    set -gx __projects_autocd 1
end
fish_add_path $HOME/.local/bin

# External editor (e.g. ctrl+g in pi/claude): Zed Preview, blocking until the file is closed.
set -gx EDITOR "zed-preview --wait"
set -gx VISUAL "zed-preview --wait"

# bun
set --export BUN_INSTALL "$HOME/.bun"
fish_add_path $BUN_INSTALL/bin

# pnpm
set -gx PNPM_HOME "$HOME/.config/pnpm"
fish_add_path $PNPM_HOME/bin
