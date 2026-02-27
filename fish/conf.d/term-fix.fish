# ~/.config/fish/conf.d/term-fix.fish
# Purpose: Normalizes `TERM` when Ghostty reports `xterm-ghostty`.
# Usage: Auto-loaded in new fish shells; no manual command needed.
if test "$TERM" = "xterm-ghostty"
    set -gx TERM xterm-256color
end