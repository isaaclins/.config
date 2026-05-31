function ccc
    set -l d (pwd)
    set -l claude (command -v claude)
    if test -z "$claude"
        echo "ccc: claude not found in PATH" >&2
        return 1
    end
    set -l cmd "caffeinate -dis $claude --dangerously-skip-permissions"
    osascript \
        -e "tell application \"Ghostty\"" \
        -e "activate" \
        -e "set cfg to new surface configuration" \
        -e "set initial working directory of cfg to \"$d\"" \
        -e "set command of cfg to \"$cmd\"" \
        -e "set win to new window with configuration cfg" \
        -e "set mainPane to terminal 1 of selected tab of win" \
        -e "split mainPane direction right with configuration cfg" \
        -e "end tell"
end
