function __pi_settings_guard --description "Strip pi packages that collide with an already-owned tool name"
    # Pi hard-fails at startup when two extensions register the same tool name,
    # and it fails before any extension can run, so nothing inside pi can repair
    # it. A third party that writes such a package into settings.json therefore
    # bricks every new session until a human edits the file by hand.
    #
    # `ollama run pi` does exactly that: it appends npm:@ollama/pi-web-search,
    # whose web_search tool collides with the one pi-web-access already owns.
    # This guard runs before launch and removes only entries on the list below,
    # so recovery is automatic and the blast radius stays small.

    set -l settings "$HOME/.config/pi/settings.json"
    test -f "$settings"; or return 0
    command -q jq; or return 0

    # Package entry -> the tool it duplicates. Keep this list short and specific.
    # Only add an entry when the collision is confirmed, never speculatively.
    set -l blocked "npm:@ollama/pi-web-search"

    if not jq -e . "$settings" >/dev/null 2>&1
        echo "pi: settings.json is not valid JSON ($settings). Leaving it untouched." >&2
        return 0
    end

    for entry in $blocked
        if jq -e --arg p "$entry" '(.packages // []) | index($p) != null' "$settings" >/dev/null 2>&1
            set -l tmp (mktemp)
            if jq --arg p "$entry" '.packages -= [$p]' "$settings" >$tmp
                command mv $tmp "$settings"
                echo "pi: removed \"$entry\" from settings.json; it duplicates a tool pi-web-access already registers." >&2
            else
                command rm -f $tmp
                echo "pi: failed to rewrite settings.json while removing \"$entry\"." >&2
            end
        end
    end
end
