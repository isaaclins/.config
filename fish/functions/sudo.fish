# ~/.config/fish/functions/sudo.fish
# Purpose: Makes `sudo !!` work in fish (like bash/zsh history expansion).
# Usage: Run `sudo !!` to re-run the previous command with sudo.
function sudo --wraps sudo --description 'sudo wrapper: supports "sudo !!"'
    # Fish doesn’t implement `!!` history expansion; emulate the classic `sudo !!`.
    if test (count $argv) -eq 1; and test "$argv[1]" = "!!"
        set -l recent_cmds (history --max=5)
        set -l last_cmd

        for cmd in $recent_cmds
            if test "$cmd" != "sudo !!"
                set last_cmd "$cmd"
                break
            end
        end

        if test -z "$last_cmd"
            echo "sudo: no previous command in history" >&2
            return 1
        end

        eval command sudo $last_cmd
        return $status
    end

    command sudo $argv
end
