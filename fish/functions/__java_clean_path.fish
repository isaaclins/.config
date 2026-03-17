# ~/.config/fish/functions/__java_clean_path.fish
# Purpose: Remove Java manager-controlled bin directories from PATH.
# Usage: Internal helper for Java management functions.
function __java_clean_path --description "Print PATH without managed Java bins"
    set -l brew_prefix $argv[1]
    set -l cleaned

    for dir in $PATH
        if test -n "$brew_prefix"
            if string match -q "$brew_prefix/opt/openjdk*/libexec/openjdk.jdk/Contents/Home/bin" -- "$dir"
                continue
            end
        end

        if string match -q '/Library/Java/JavaVirtualMachines/*/Contents/Home/bin' -- "$dir"
            continue
        end

        if set -q JAVA_HOME; and test "$dir" = "$JAVA_HOME/bin"
            continue
        end

        set -a cleaned "$dir"
    end

    printf '%s\n' $cleaned
end
