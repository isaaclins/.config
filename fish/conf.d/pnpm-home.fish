# ~/.config/fish/conf.d/pnpm-home.fish
# Purpose: Sets a fish-native pnpm global binary directory under `~/.config/pnpm`.
# Usage: Auto-loaded in new fish shells; global installs (`pnpm add -g ...`) place executables in `PNPM_HOME`.
if status is-interactive
    set -gx PNPM_HOME "$HOME/.config/pnpm"
    mkdir -p "$PNPM_HOME" 2>/dev/null

    if not contains -- "$PNPM_HOME" $PATH
        set -gx PATH "$PNPM_HOME" $PATH
    end
end

