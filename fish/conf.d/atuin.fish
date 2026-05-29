# ~/.config/fish/conf.d/atuin.fish
# Purpose: Initialize atuin for richer shell history search.
# Usage: After install, run `atuin register -u <username> -e <email>` (or `atuin login`) once,
#        then Ctrl-R opens the atuin TUI. Up-arrow keeps the normal fish history behavior.
if type -q atuin
    atuin init fish --disable-up-arrow | source
end
