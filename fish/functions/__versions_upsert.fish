# ~/.config/fish/functions/__versions_upsert.fish
# Purpose: Upserts a KEY: VALUE line inside ~/.config/.versions.
# Usage: Internal helper for bootstrap and brew wrapper functions.
function __versions_upsert --description "Upsert KEY: VALUE in ~/.config/.versions"
    set -l key $argv[1]
    set -l value $argv[2]
    set -l versions_file "$HOME/.config/.versions"
    set -l tmp (mktemp)

    test -n "$key"; or return 1
    test -n "$value"; or set value "installed"

    touch "$versions_file"
    awk -v k="$key" -v v="$value" '
        BEGIN { replaced=0 }
        $0 ~ ("^" k ": ") {
            if (!replaced) {
                print k ": " v
                replaced=1
            }
            next
        }
        { print }
        END {
            if (!replaced) {
                print k ": " v
            }
        }
    ' "$versions_file" > "$tmp"

    command mv "$tmp" "$versions_file"
end

