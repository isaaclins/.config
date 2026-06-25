# ~/.config/fish/functions/ccssh.fish
# Run Claude Code on the homeserver over SSH, the same way `cc` runs it locally.
#
# Locally this keeps the Mac awake (caffeinate) and alive with the lid closed
# (pmset disablesleep) so closing the laptop does not drop the SSH session and
# kill the remote claude. Both are macOS only and are skipped elsewhere. The
# keep-awake toggle and its guaranteed restore live in bash because bash has a
# reliable EXIT trap that fires even on Ctrl-C; fish cannot guarantee that.
#
# Remotely it invokes the synced `cc` function on the homeserver, which handles
# skills consolidation and runs `claude --dangerously-skip-permissions`,
# skipping the macOS-only keep-awake steps on Linux. Any args are forwarded to
# the remote claude.
function ccssh --description 'Run Claude (cc) on the homeserver over SSH, keeping the Mac awake so a closed lid does not drop the session'
    set -l remote isaaclins@homeserver

    # Build the remote command: the remote `cc` with each arg safely escaped.
    set -l parts cc
    for arg in $argv
        set -a parts (string escape -- $arg)
    end
    set -l remote_cmd (string join ' ' $parts)

    command bash -c '
        remote="$1"
        remote_cmd="$2"

        # macOS lid-closed keep-awake. Always restore on exit, even on Ctrl-C.
        if command -v pmset >/dev/null 2>&1; then
            if sudo pmset -a disablesleep 1; then
                trap "sudo pmset -a disablesleep 0" EXIT
            else
                echo "ccssh: could not enable lid-closed keep-awake; continuing" >&2
            fi
        fi

        # -t forces a TTY so the remote claude TUI renders. Do not exec, so the
        # bash EXIT trap still runs to restore sleep when the session ends.
        if command -v caffeinate >/dev/null 2>&1; then
            caffeinate -dimsu ssh -t "$remote" "$remote_cmd"
        else
            ssh -t "$remote" "$remote_cmd"
        fi
    ' ccssh "$remote" "$remote_cmd"
end
