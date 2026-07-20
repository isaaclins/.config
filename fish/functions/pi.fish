function pi --description "pi wrapper: run in tmux and auto-continue the repo's last session" --wraps pi
    # Any explicit arguments (flags, -p prompts, subcommands) pass through
    # unchanged, so scripted and one-shot invocations behave stock.
    if test (count $argv) -gt 0
        command pi $argv
        return
    end

    # Bare `pi`: continue the last conversation for the current project.
    # Pi owns project/session identity; tmux is only the visible process host.
    if set -q TMUX
        command pi --continue
        return
    end

    # Not in tmux yet: create a fresh host session rooted at the current
    # directory. Do not derive identity from a basename or auto-attach to a
    # different repository with the same directory name.
    tmux new-session -c (pwd) "pi --continue"
end
