# ~/.config/fish/functions/cc.fish
# Run Claude Code while keeping the Mac awake with the lid closed, then always
# restore normal sleep, even on Ctrl-C. The toggle and its guaranteed restore
# live in bash because bash has a reliable EXIT trap. Fish unwinds its functions
# on a foreground Ctrl-C and cannot guarantee the restore runs, which would
# otherwise leave the machine with sleep permanently disabled.
function cc --description 'Run Claude with lid-closed keep-awake (pmset disablesleep), auto-reverted on exit even on Ctrl-C'
    command bash -c '
        if sudo /usr/bin/pmset -a disablesleep 1; then
            trap "sudo /usr/bin/pmset -a disablesleep 0" EXIT
        else
            echo "cc: could not enable lid-closed keep-awake; running claude anyway" >&2
        fi
        caffeinate -dimsu claude --dangerously-skip-permissions "$@"
    ' cc $argv
end
