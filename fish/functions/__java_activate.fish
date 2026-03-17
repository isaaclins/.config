# ~/.config/fish/functions/__java_activate.fish
# Purpose: Activate a Homebrew OpenJDK formula in the current fish session.
# Usage: Internal helper for `setjava` and startup re-application.
function __java_activate --description "Set JAVA_HOME and PATH from Homebrew formula"
    argparse 'q/quiet' -- $argv
    or return 2

    if test (count $argv) -ne 1
        if not set -q _flag_quiet
            echo "__java_activate: expected exactly one formula argument" >&2
        end
        return 2
    end

    set -l formula $argv[1]
    set -l brew_prefix (__java_brew_prefix)

    if test $status -ne 0; or test -z "$brew_prefix"
        if not set -q _flag_quiet
            echo "Homebrew is required to manage Java versions." >&2
        end
        return 1
    end

    set -l java_home "$brew_prefix/opt/$formula/libexec/openjdk.jdk/Contents/Home"
    set -l java_bin "$java_home/bin/java"

    if not test -x "$java_bin"
        if not set -q _flag_quiet
            echo "Missing Java binary for $formula at $java_bin" >&2
        end
        return 1
    end

    set -l cleaned_path (__java_clean_path "$brew_prefix")

    set -gx JAVA_HOME "$java_home"
    if test (count $cleaned_path) -gt 0
        set -gx PATH "$JAVA_HOME/bin" $cleaned_path
    else
        set -gx PATH "$JAVA_HOME/bin"
    end

    return 0
end
