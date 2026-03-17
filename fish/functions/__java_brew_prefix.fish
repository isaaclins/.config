# ~/.config/fish/functions/__java_brew_prefix.fish
# Purpose: Resolve the local Homebrew prefix for architecture-agnostic path handling.
# Usage: Internal helper for Java management functions.
function __java_brew_prefix --description "Print Homebrew prefix"
    if command -q brew
        command brew --prefix 2>/dev/null
        return $status
    end

    if test -d /opt/homebrew
        echo /opt/homebrew
        return 0
    end

    if test -d /usr/local
        echo /usr/local
        return 0
    end

    return 1
end
