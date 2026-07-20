# ~/.config/fish/functions/sshpi.fish
# Attach to the persistent Pi agent session running on the homeserver.
#
# The homeserver runs a standalone `pi` install (~/.npm-global/bin/pi, since
# isaaclins's login shell there is fish, not bash, so ~/.bashrc PATH additions
# don't apply -- always use the absolute path) inside a detached tmux session
# named `pi-standing`, so it survives SSH disconnects and this laptop sleeping
# or shutting down. `tmux new-session -A` attaches to that session if it is
# already running (the normal case: same conversation continues) or creates it
# fresh with the right cwd/command if it was ever killed -- either way this
# always lands you back in the same standing Pi session.
#
# Modeled on ccssh.fish: same macOS lid-closed keep-awake handling (bash for a
# reliable EXIT trap, fish's isn't guaranteed), same ssh ControlMaster reuse,
# same -t TTY forcing so the remote TUI renders.
function sshpi --description 'Attach to (or start) the persistent Pi session on the homeserver'
    set -l remote isaaclins@homeserver
    set -l session pi-standing
    set -l workdir '$HOME/home.isaaclins.com'
    set -l pi_bin '$HOME/.npm-global/bin/pi'

    # Single string handed to the remote login shell (fish); $HOME expands
    # there, not here.
    set -l remote_cmd "tmux new-session -A -s $session -c $workdir $pi_bin"

    mkdir -p "$HOME/.ssh"
    set -l control_path "$HOME/.ssh/cm-sshpi-%r@%h:%p"

    command bash -c '
        remote="$1"
        remote_cmd="$2"
        control_path="$3"

        cleanup() {
            sudo pmset -a disablesleep 0 2>/dev/null
            ssh -o ControlPath="$control_path" -O exit "$remote" 2>/dev/null
        }

        if command -v pmset >/dev/null 2>&1; then
            if sudo pmset -a disablesleep 1; then
                trap cleanup EXIT
            else
                echo "sshpi: could not enable lid-closed keep-awake; continuing" >&2
                trap cleanup EXIT
            fi
        else
            trap cleanup EXIT
        fi

        if command -v caffeinate >/dev/null 2>&1; then
            caffeinate -dimsu ssh -o ControlMaster=auto -o ControlPath="$control_path" -o ControlPersist=60 -t "$remote" "$remote_cmd"
        else
            ssh -o ControlMaster=auto -o ControlPath="$control_path" -o ControlPersist=60 -t "$remote" "$remote_cmd"
        fi
    ' sshpi "$remote" "$remote_cmd" "$control_path"
end
