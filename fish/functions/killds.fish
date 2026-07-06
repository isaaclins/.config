# ~/.config/fish/functions/killds.fish
# Purpose: Recursively delete .DS_Store files under a directory.
# Usage: killds  or  killds /path/to/dir
function killds --description 'Recursively delete .DS_Store files'
    set -l target .
    if test (count $argv) -gt 0
        set target $argv[1]
    end

    if not test -d "$target"
        echo "killds: '$target' is not a directory" >&2
        return 1
    end

    # Silence stderr so unreadable system dirs are skipped quietly (no sudo needed).
    set -l found (command find "$target" -type f -name '.DS_Store' -print -delete 2>/dev/null)

    if test (count $found) -eq 0
        echo "killds: no .DS_Store files found under '$target'"
    else
        echo "killds: deleted "(count $found)" .DS_Store file(s) under '$target'"
    end
end
