# ~/.config/fish/config.fish
# Purpose: Interactive shell bootstrap for session-only behavior.
# Usage: Auto-loaded by fish at startup; edit values here, then run `exec fish` to fully reload.
if status is-interactive
    # Auto-jump to projects directory if starting in $HOME
    if test (pwd) = $HOME && test -d ~/Projects/
        cd ~/Projects/
    end
end
fish_add_path $HOME/.local/bin

# bun
set --export BUN_INSTALL "$HOME/.bun"
fish_add_path $BUN_INSTALL/bin

# pnpm
set -gx PNPM_HOME "$HOME/.config/pnpm"
fish_add_path $PNPM_HOME/bin
