# ~/.config/fish/conf.d/fnm.fish
# Purpose: Initializes fnm (Fast Node Manager, node version manager specialized for fish) for interactive fish shells.
# Usage: Auto-loaded in new fish shells; then use `fnm install --lts` and `fnm default <version>`.
if status is-interactive
    if type -q fnm
        # fnm expects this state dir to exist for multishell symlinks.
        mkdir -p "$HOME/.local/state/fnm_multishells" 2>/dev/null
        # Official fish setup from fnm docs.
        fnm env --use-on-cd --shell fish | source
    end
end