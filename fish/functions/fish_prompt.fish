# ~/.config/fish/functions/fish_prompt.fish
# Purpose: Defines the custom two-line `fish_prompt` shown after each command.
# Usage: Autoloaded by fish when rendering the prompt; run `functions -e fish_prompt` and `exec fish` to fully refresh if needed.
function fish_prompt
    # Store early so later commands do not overwrite it.
    set -l last_status $status
    set -l host (hostname -s 2>/dev/null)
    set -l branch (__git_branch)

    set_color -o cyan
    echo -n "┌─["

    # Username@hostname
    set_color -o yellow
    echo -n $USER
    set_color -o white
    echo -n "@"
    set_color -o blue
    echo -n $host

    # Current directory
    set_color -o cyan
    echo -n "]─["
    set_color -o magenta
    echo -n (prompt_pwd)
    set_color -o cyan
    echo -n "]"

    # Git branch if applicable
    if test -n "$branch"
        echo -n "─["
        set_color -o green
        echo -n $branch
        set_color -o cyan
        echo -n "]"
    end

    # Time
    echo -n "─["
    set_color -o white
    echo -n (date "+%H:%M:%S")
    set_color -o cyan
    echo -n "]"

    # Last command duration (CMD_DURATION is already milliseconds)
    echo -n "─["
    set_color -o white
    printf "%dms" $CMD_DURATION
    set_color -o cyan
    echo -n "]"

    # Error code if non-zero
    if test $last_status -ne 0
        set_color -o cyan
        echo -n "─["
        set_color -o red
        echo -n $last_status
        set_color -o cyan
        echo -n "]"
        set_color normal
    end

    echo
    echo -n "└─"
    set_color -o yellow
    echo -n "⫸ "
    set_color normal
end
