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
#
# Each session also runs a background clipboard image sync (ccclip-sync). It
# keeps a fixed remote file updated with whatever image is on the local Mac
# clipboard, so pasting an image is as simple as copying it and then typing the
# remote path /tmp/ccclip/clip.png into the chat. An ssh ControlMaster is set
# up for the session so the watcher's scp uploads reuse the live connection.
function ccssh --description 'Run Claude (cc) on the homeserver over SSH, keeping the Mac awake so a closed lid does not drop the session'
    set -l remote isaaclins@homeserver

    # Build the remote command. By default this is the remote `cc`. When the
    # opt-in CCSSH_PASTE env var is set, use the clipboard-shim wrapper instead
    # so Ctrl+V image paste works in the remote TUI. Remote fish expands $HOME.
    set -l base cc
    if set -q CCSSH_PASTE
        set base '$HOME/.ccclip/cc-paste'
    end

    # The base command with each arg safely escaped.
    set -l parts $base
    for arg in $argv
        set -a parts (string escape -- $arg)
    end
    set -l remote_cmd (string join ' ' $parts)

    # Shared ssh ControlMaster socket for this session. The watcher's scp reuses
    # it so uploads multiplex over the live connection instead of reconnecting.
    # Keep the %r@%h:%p tokens literal everywhere so ssh resolves the same path
    # for the session, the watcher, and the teardown.
    mkdir -p "$HOME/.ssh"
    set -l control_path "$HOME/.ssh/cm-ccssh-%r@%h:%p"

    # Start the clipboard image watcher in the background, pointed at the same
    # control path so it multiplexes over the session master. Only launch it if
    # the script is present and executable; otherwise continue silently.
    set -l watcher_pid ""
    set -l watcher "$HOME/.local/bin/ccclip-sync"
    if test -x "$watcher"
        CCCLIP_SSH_CONTROL=$control_path "$watcher" "$remote" /tmp/ccclip/clip.png >/tmp/ccclip-sync.log 2>&1 &
        set watcher_pid $last_pid
    end

    command bash -c '
        remote="$1"
        remote_cmd="$2"
        control_path="$3"
        watcher_pid="$4"

        # macOS lid-closed keep-awake. Always restore on exit, even on Ctrl-C.
        # The same trap also stops the background clipboard watcher and tears
        # down the ssh master connection (both best effort).
        cleanup() {
            sudo pmset -a disablesleep 0 2>/dev/null
            [ -n "$watcher_pid" ] && kill "$watcher_pid" 2>/dev/null
            ssh -o ControlPath="$control_path" -O exit "$remote" 2>/dev/null
        }

        if command -v pmset >/dev/null 2>&1; then
            if sudo pmset -a disablesleep 1; then
                trap cleanup EXIT
            else
                echo "ccssh: could not enable lid-closed keep-awake; continuing" >&2
                trap cleanup EXIT
            fi
        else
            trap cleanup EXIT
        fi

        # -t forces a TTY so the remote claude TUI renders. Do not exec, so the
        # bash EXIT trap still runs to restore sleep when the session ends. The
        # ControlMaster options let the watcher reuse this connection.
        if command -v caffeinate >/dev/null 2>&1; then
            caffeinate -dimsu ssh -o ControlMaster=auto -o ControlPath="$control_path" -o ControlPersist=60 -t "$remote" "$remote_cmd"
        else
            ssh -o ControlMaster=auto -o ControlPath="$control_path" -o ControlPersist=60 -t "$remote" "$remote_cmd"
        fi
    ' ccssh "$remote" "$remote_cmd" "$control_path" "$watcher_pid"
end
