# ~/.config/fish/functions/copy.fish
# Purpose: Copy piped stdin (or argv) to the macOS clipboard via pbcopy.
# Usage: `echo "hello world" | copy` or `copy hello world`.
function copy --description 'Copy stdin or arguments to the macOS clipboard'
    if isatty stdin
        if test (count $argv) -eq 0
            echo "copy: nothing to copy (pipe input or pass arguments)" >&2
            return 1
        end
        printf '%s' "$argv" | pbcopy
    else
        pbcopy
    end
end
