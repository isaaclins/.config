function pi --description "pi wrapper: run in tmux and auto-continue the repo's last session" --wraps pi
    # Any explicit arguments (flags, -p prompts, subcommands) pass through
    # unchanged, so scripted and one-shot invocations behave stock.
    if test (count $argv) -gt 0
        command pi $argv
        return
    end

    # Bare `pi`: always continue the last conversation of this repo
    # (--continue starts a new session when none exists). Use /wipe or
    # /clear inside pi to deliberately start over.
    if set -q TMUX
        command pi --continue
        return
    end

    # Not in tmux yet: wrap in a per-directory tmux session so /spawn can
    # split live subagent panes. -A attaches if it already exists.
    set -l session_name "pi-"(basename (pwd) | string replace -ra '[^a-zA-Z0-9_-]' '-')
    tmux new-session -A -s $session_name "pi --continue"
end
