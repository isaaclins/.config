function sync_ai_usage --description 'Send compact local AI usage totals to the homeserver'
    set -l ccusage_command (command -s ccusage)
    if test -z "$ccusage_command"
        echo "ccusage is not installed or not on PATH" >&2
        return 1
    end

    set -l report_file (mktemp -t ai-usage-report.XXXXXX)
    or return 1

    $ccusage_command daily --json | /usr/bin/python3 -c '
import json, socket, sys
from datetime import datetime, timezone
source = json.load(sys.stdin)
daily = [
    {
        "period": row["period"],
        "totalCost": row["totalCost"],
        "totalTokens": row["totalTokens"],
    }
    for row in source.get("daily", [])
]
json.dump(
    {
        "machine": "macbook",
        "hostname": socket.gethostname(),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "daily": daily,
        "totals": {
            "totalCost": source["totals"]["totalCost"],
            "totalTokens": source["totals"]["totalTokens"],
        },
    },
    sys.stdout,
    separators=(",", ":"),
)
' >$report_file

    if test $pipestatus[1] -ne 0 -o $pipestatus[2] -ne 0
        rm -f $report_file
        echo "Failed to generate AI usage report" >&2
        return 1
    end

    ssh -o BatchMode=yes -o ConnectTimeout=20 isaaclins@homeserver "sh -c 'umask 077; mkdir -p ~/.local/state/ccusage-exporter; cat > ~/.local/state/ccusage-exporter/macbook.json.tmp; mv ~/.local/state/ccusage-exporter/macbook.json.tmp ~/.local/state/ccusage-exporter/macbook.json'" <$report_file
    set -l ssh_status $status
    rm -f $report_file

    if test $ssh_status -ne 0
        echo "Failed to upload AI usage report" >&2
        return $ssh_status
    end

    echo "AI usage report synced to homeserver"
end
