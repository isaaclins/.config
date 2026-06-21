# ~/.config/fish/functions/fish_prompt.fish
# Purpose: Two-line box prompt in Tokyo Night colors with nerd-font icons.
# Usage: Autoloaded by fish; reload with `functions -e fish_prompt; exec fish`.
#
# Tokyo Night palette:
#   blue   #7aa2f7   purple #bb9af7   cyan   #7dcfff   green  #9ece6a
#   yellow #e0af68   orange #ff9e64   red    #f7768e   fg     #c0caf5
function fish_prompt
    set -l last_status $status
    set -l host (hostname -s 2>/dev/null)
    set -l branch (__git_branch)
    set -l gstat (__git_status)

    set -l c_border 7aa2f7
    set -l c_user   e0af68
    set -l c_host   f7768e
    set -l c_pwd    bb9af7
    set -l c_branch 9ece6a
    set -l c_time   c0caf5
    set -l c_dur    ff9e64
    set -l c_err    f7768e
    set -l c_arrow  bb9af7

    set_color -o $c_border
    echo -n "┌─["

    set_color -o $c_user
    echo -n $USER
    set_color -o $c_border
    echo -n "@"
    set_color -o $c_host
    echo -n $host

    set_color -o $c_border
    echo -n "]─["
    set_color -o $c_pwd
    echo -n " "(prompt_pwd)
    set_color -o $c_border
    echo -n "]"

    if test -n "$branch"
        set_color -o $c_border
        echo -n "─["
        set_color -o $c_branch
        echo -n " $branch"
        if test -n "$gstat"
            echo -n " $gstat"
        end
        set_color -o $c_border
        echo -n "]"
    end

    set_color -o $c_border
    echo -n "─["
    set_color -o $c_time
    echo -n " "(date "+%H:%M:%S")
    set_color -o $c_border
    echo -n "]"

    if test $CMD_DURATION -gt 100
        set_color -o $c_border
        echo -n "─["
        set_color -o $c_dur
        printf " %dms" $CMD_DURATION
        set_color -o $c_border
        echo -n "]"
    end

    if test $last_status -ne 0
        set_color -o $c_border
        echo -n "─["
        set_color -o $c_err
        echo -n "✘ $last_status"
        set_color -o $c_border
        echo -n "]"
    end

    echo
    set_color -o $c_border
    echo -n "└─"
    if test $last_status -ne 0
        set_color -o $c_err
    else
        set_color -o $c_arrow
    end
    echo -n "❯ "
    set_color normal
end
