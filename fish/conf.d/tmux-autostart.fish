# ~/.config/fish/conf.d/tmux-autostart.fish
# Purpose: Auto-start tmux for interactive Ghostty shells. Each new Ghostty
#   window gets its own tmux session; existing sessions are untouched.
#   Guards keep ssh, embedded terminals (Zed, pi), and nested tmux unaffected.
# Usage: Autoloaded by fish. Escape hatch: NO_TMUX=1 ghostty, or `set -gx NO_TMUX 1`.

if status is-interactive
    and test "$TERM_PROGRAM" = ghostty
    and not set -q TMUX
    and not set -q NO_TMUX
    and not set -q SSH_TTY
    and command -q tmux
    # exec replaces this fish with tmux, so closing tmux closes the window.
    exec tmux new-session
end
