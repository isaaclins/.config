# ~/.config/fish/conf.d/aliases.fish
# Purpose: Defines interactive abbreviations for common commands.
# Usage: Auto-loaded in new fish shells; use `abbr --show` to inspect and edit this file to add more.
abbr -a conf 'cursor ~/.config '
abbr -a r 'clear && exec fish && clear'
abbr -a cls 'clear && clear'

abbr -a fmt "prettier . --write"

abbr -a cc 'caffeinate -dis claude --dangerously-skip-permissions'
abbr -a oc 'ollama launch claude '
abbr -a checkup 'command ls -lt ~/.claude/sleep-log/ | head'

abbr -a code 'zed-preview'

abbr -a tmp 'cd (mktemp -d)'

# Modern CLI replacements (only applied if the tool is installed)
if type -q eza
    alias ls  'eza --icons --group-directories-first'
    alias ll  'eza -l  --icons --group-directories-first --git'
    alias la  'eza -la --icons --group-directories-first --git'
    alias lt  'eza --tree --level=2 --icons --group-directories-first'
end
if type -q bat
    alias cat 'bat --paging=never'
end

abbr -a lg  'lazygit'
abbr -a zj  'zellij'
abbr -a zja 'zellij attach'
