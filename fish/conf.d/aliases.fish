# ~/.config/fish/conf.d/aliases.fish
# Purpose: Defines interactive abbreviations for common commands.
# Usage: Auto-loaded in new fish shells; use `abbr --show` to inspect and edit this file to add more.
abbr -a conf 'cursor ~/.config '
abbr -a r 'clear && exec fish && clear'
abbr -a cls 'clear && clear'

abbr -a fmt "prettier . --write"
