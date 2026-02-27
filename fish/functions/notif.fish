# ~/.config/fish/functions/notif.fish
# Purpose: Sends macOS notification/speech announcing previous command completion status.
# Usage: Autoloaded on first use; append `; notif` after commands (for example `sleep 10; notif`).
function notif --description 'Send macOS notification for previous command status'
    set -l exit_status $status
    set -l cmd "$argv"

    if test (count $cmd) -eq 0
        set cmd (history --max=1)
    end

    set -l message "$cmd finished with status code $exit_status"

    if type -q osascript
        osascript -e "display notification \"$message\" with title \"Terminal\""
    end

    if type -q say
        say "$message"
    end

    echo $message
    return $exit_status
end

