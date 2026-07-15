# ~/.config/fish/conf.d/aliases.fish
# Purpose: Defines interactive abbreviations and modern-CLI replacements.
# Usage: Auto-loaded in new fish shells; use `abbr --show` to inspect and edit this file to add more.

# Interactive shells only: without this guard the alias functions (ls->eza,
# cat->bat) would also apply to scripts and `fish -c ...`, breaking anything
# that parses plain ls/cat output.
if not status is-interactive
    exit 0
end

abbr -a conf 'zed-preview ~/.config '
abbr -a r 'clear && exec fish'
abbr -a cls 'clear && clear'

abbr -a fmt "prettier . --write"

abbr -a oc 'ollama launch claude '
abbr -a checkup 'command ls -lt ~/.claude/sleep-log/ | head'

abbr -a code 'zed-preview'

abbr -a tmp 'cd (mktemp -d)'

# `!!` expands inline to the previous command (works mid-line, e.g. `sudo !!`),
# so you review exactly what will run before pressing enter. This replaces the
# old sudo wrapper function that re-executed history through `eval`.
function __abbr_last_command
    echo -- $history[1]
end
abbr -a last_command_bang_bang --regex '!!' --position anywhere --function __abbr_last_command

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

abbr -a sshh 'ssh isaaclins@homeserver'

abbr -a lg  'lazygit'
abbr -a zj  'zellij'
abbr -a zja 'zellij attach'
