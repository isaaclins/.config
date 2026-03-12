# ~/.config/fish/functions/kp.fish
# Purpose: Kill process(es) listening on one or more ports.
# Usage: kp 1313  or  kp 1212 1313 1414
function kp --description "Kill processes listening on given port(s)"
    if test (count $argv) -eq 0
        echo "Usage: kp <port> [port ...]" >&2
        return 1
    end

    if not command -q lsof
        echo "lsof is required to find listening processes." >&2
        return 127
    end

    set -l had_error 0

    for port in $argv
        if not string match -rq '^[0-9]+$' -- "$port"
            echo "Skipping invalid port '$port' (must be a number)." >&2
            set had_error 1
            continue
        end

        if test "$port" -lt 1 -o "$port" -gt 65535
            echo "Skipping invalid port '$port' (must be 1-65535)." >&2
            set had_error 1
            continue
        end

        set -l pids (command lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null; command lsof -nP -t -iUDP:"$port" 2>/dev/null)

        if test (count $pids) -eq 0
            echo "No process found on port $port."
            continue
        end

        set -l unique_pids (printf '%s\n' $pids | command sort -u)
        echo "Killing PID(s) on port $port: "(string join ", " $unique_pids)

        command kill $unique_pids 2>/dev/null
        if test $status -eq 0
            echo "Port $port cleared."
        else
            echo "Failed to kill one or more PID(s) on port $port." >&2
            set had_error 1
        end
    end

    return $had_error
end
