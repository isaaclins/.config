# ~/.config/fish/functions/setjava.fish
# Purpose: Manage Java versions installed via Homebrew OpenJDK formulas.
# Usage: setjava <version|openjdk|list|current|system> [--install] [--session]
function setjava --description "Switch and manage Homebrew Java versions"
    argparse 'g/global' 'i/install' 's/session' 'h/help' -- $argv
    or return 2

    set -l cmd
    if test (count $argv) -gt 0
        set cmd (string lower -- "$argv[1]")
    end

    if set -q _flag_help; or test -z "$cmd"
        echo "Usage: setjava <version|openjdk|list|current|system> [--install] [--session]"
        echo "Examples:"
        echo "  setjava 17"
        echo "  setjava 21"
        echo "  setjava 21 --session"
        echo "  setjava openjdk"
        echo "  setjava list"
        echo "  setjava system"
        if set -q _flag_help
            return 0
        end
        return 1
    end

    if not command -q brew
        echo "Homebrew is required for setjava." >&2
        return 127
    end

    if test (count $argv) -gt 1
        echo "Unexpected extra argument(s): "(string join " " $argv[2..-1]) >&2
        return 2
    end

    set -l persist 1
    if set -q _flag_session
        set persist 0
    end

    switch "$cmd"
        case list ls
            set -l formulas (command brew list --formula 2>/dev/null | string match -r '^openjdk(?:@[0-9]+)?$' | command sort)
            set -l brew_prefix (__java_brew_prefix)
            set -l default_file (__java_default_file)
            set -l persisted_default

            if test (count $formulas) -eq 0
                echo "No Homebrew OpenJDK formulas are installed."
            else
                echo "Installed Homebrew OpenJDK formulas:"
                for formula in $formulas
                    set -l java_home "$brew_prefix/opt/$formula/libexec/openjdk.jdk/Contents/Home"
                    set -l marker " "

                    if set -q JAVA_HOME; and test "$JAVA_HOME" = "$java_home"
                        set marker "*"
                    end

                    set -l version_line "version unavailable"
                    if test -x "$java_home/bin/java"
                        set version_line (command "$java_home/bin/java" -version 2>&1 | head -n1 | string trim)
                    end

                    echo "  $marker $formula -> $version_line"
                end
            end

            if set -q __setjava_default_formula
                set persisted_default "$__setjava_default_formula"
            else if test -r "$default_file"
                set persisted_default (head -n1 "$default_file" | string trim)
            end

            if test -n "$persisted_default"
                echo "Default for new shells: $persisted_default"
            else
                echo "Default for new shells: (none)"
            end

            if set -q JAVA_HOME
                echo "Current JAVA_HOME: $JAVA_HOME"
            else
                echo "Current JAVA_HOME: (unset)"
            end

            if command -q java
                echo "Current java path: "(type -p java)
            else
                echo "Current java path: (not found)"
            end
            return 0

        case current
            if set -q JAVA_HOME
                echo "JAVA_HOME=$JAVA_HOME"
            else
                echo "JAVA_HOME is not set."
            end

            if command -q java
                echo "java path: "(type -p java)
                command java -version
                return $status
            end

            echo "java command not found in PATH."
            return 1

        case system
            set -l brew_prefix (__java_brew_prefix 2>/dev/null)
            set -l cleaned_path (__java_clean_path "$brew_prefix")
            set -l default_file (__java_default_file)

            set -e JAVA_HOME
            if test (count $cleaned_path) -gt 0
                set -gx PATH $cleaned_path
            end

            if test "$persist" = "1"
                set -eU __setjava_default_formula
                command rm -f "$default_file"
            end

            if functions -q __versions_upsert
                __versions_upsert "JAVA_ACTIVE" "system"
            end

            echo "Switched to system Java (JAVA_HOME unset)."
            if command -q java
                echo "java path: "(type -p java)
                command java -version
            else
                echo "java command not found in PATH."
            end
            return 0
    end

    set -l formula
    switch "$cmd"
        case openjdk latest
            set formula openjdk
        case 'openjdk@*'
            set formula "$cmd"
        case '*'
            if string match -qr '^[0-9]+$' -- "$cmd"
                set formula "openjdk@$cmd"
            else
                echo "Invalid target '$cmd'. Expected a version number like 17 or a formula like openjdk@21." >&2
                return 1
            end
    end

    if not command brew list --formula "$formula" >/dev/null 2>&1
        set -l should_install 0
        if set -q _flag_install
            set should_install 1
        else
            read -P "$formula is not installed. Install it now? [y/N] " -l response
            switch (string lower -- "$response")
                case y yes
                    set should_install 1
            end
        end

        if test $should_install -ne 1
            echo "Canceled; $formula is not installed."
            return 1
        end

        brew install "$formula"
        if test $status -ne 0
            echo "Failed to install $formula." >&2
            return 1
        end
    end

    __java_activate "$formula"
    if test $status -ne 0
        echo "Failed to activate $formula." >&2
        return 1
    end

    if test "$persist" = "1"
        set -l default_file (__java_default_file)
        set -U __setjava_default_formula "$formula"
        printf '%s\n' "$formula" > "$default_file"
    end

    set -l active_line (command java -version 2>&1 | head -n1 | string trim)
    if functions -q __versions_upsert
        __versions_upsert "JAVA_ACTIVE" "$formula ($active_line)"
    end

    echo "Switched to $formula"
    echo "JAVA_HOME=$JAVA_HOME"
    echo "java path: "(type -p java)
    command java -version
end
