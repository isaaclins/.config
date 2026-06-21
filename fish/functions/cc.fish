# ~/.config/fish/functions/cc.fish
# Run Claude Code while keeping the machine awake (lid closed on macOS), then
# always restore normal sleep, even on Ctrl-C. The toggle and its guaranteed
# restore live in bash because bash has a reliable EXIT trap. Fish unwinds its
# functions on a foreground Ctrl-C and cannot guarantee the restore runs, which
# would otherwise leave the machine with sleep permanently disabled.
#
# The keep-awake bits (pmset, caffeinate) are macOS only. On hosts without them
# (e.g. the Linux homeserver) each step is skipped with a notice and claude runs
# anyway, so the same function works on both Mac and Linux.
function cc --description 'Run Claude with keep-awake when available (macOS pmset/caffeinate), auto-reverted on exit; runs claude anyway elsewhere'
    command bash -c '
        # macOS lid-closed keep-awake. Always restore on exit, even on Ctrl-C.
        if command -v pmset >/dev/null 2>&1; then
            if sudo pmset -a disablesleep 1; then
                trap "sudo pmset -a disablesleep 0" EXIT
            else
                echo "cc: could not enable lid-closed keep-awake; running claude anyway" >&2
            fi
        fi

        # Keep the machine awake via caffeinate (macOS); otherwise run directly.
        if command -v caffeinate >/dev/null 2>&1; then
            caffeinate -dimsu claude --dangerously-skip-permissions "$@"
        else
            echo "cc: caffeinate not found; running claude without keep-awake" >&2
            claude --dangerously-skip-permissions "$@"
        fi
    ' cc $argv
end
