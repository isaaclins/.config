# ~/.config/fish/functions/__brew_record_version.fish
# Purpose: Records formula/cask versions into ~/.config/.versions.
# Usage: Internal helper used by the `brew` function wrapper.
function __brew_record_version --description "Record brew package version into ~/.config/.versions"
    set -l pkg $argv[1]
    set -l is_cask $argv[2]
    test -n "$pkg"; or return 1

    if test "$is_cask" = "1"
        if command brew list --cask "$pkg" >/dev/null 2>&1
            set -l version_line (command brew list --cask --versions "$pkg" 2>/dev/null | awk '{$1=""; sub(/^ /,""); print}')
            test -n "$version_line"; or set version_line "installed (version unavailable)"
            set -l key (string upper (string replace -a "-" "_" -- "$pkg"))
            __versions_upsert "$key" "$version_line"
        end
        return
    end

    if command brew list --versions "$pkg" >/dev/null 2>&1
        set -l version_line (command brew list --versions "$pkg" 2>/dev/null | awk '{$1=""; sub(/^ /,""); print}')
        if test -z "$version_line"; and command -q "$pkg"
            set version_line (command "$pkg" --version 2>/dev/null | head -n1)
        end
        test -n "$version_line"; or set version_line "installed (version unavailable)"
        set -l key (string upper -- "$pkg")
        __versions_upsert "$key" "$version_line"
    end
end
