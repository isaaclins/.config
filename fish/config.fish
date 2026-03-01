# ~/.config/fish/config.fish
# Purpose: Interactive shell bootstrap for session-only behavior.
# Usage: Auto-loaded by fish at startup; edit values here, then run `exec fish` to fully reload.
if status is-interactive
    # Auto-jump to ~/github if starting in $HOME
    if test (pwd) = $HOME
        cd ~/github
    end
end
