# ~/.config/fish/functions/__formatter_parse_args.fish
# Purpose: Parse wrapper arguments for `prettier`, extracting wrapper-only flags and normalized targets.
# Inputs: Raw argv from the user-facing `prettier` function.
# Outputs: Global vars `__formatter_forwarded_args`, `__formatter_targets`, `__formatter_fix_enabled`, `__formatter_write_enabled`.
# Examples: __formatter_parse_args . --fix ; __formatter_parse_args src/app.js --check

function __formatter_parse_args --description "Parse prettier wrapper args into forwarded args + wrapper flags"
    # Reset exported parsing state on every call so stale values cannot leak
    # from prior invocations in the same interactive shell session.
    set -g __formatter_forwarded_args
    set -g __formatter_targets
    set -g __formatter_fix_enabled 0
    set -g __formatter_write_enabled 0

    set -l saw_double_dash 0

    for arg in $argv
        # `--` terminates option parsing for most CLIs; preserve that behavior.
        if test $saw_double_dash -eq 0; and test "$arg" = "--"
            set saw_double_dash 1
            set -a __formatter_forwarded_args "$arg"
            continue
        end

        # Wrapper-only option. This is intentionally not forwarded to Prettier.
        if test $saw_double_dash -eq 0; and test "$arg" = "--fix"
            set -g __formatter_fix_enabled 1
            continue
        end

        # Track write intent from explicit user args.
        if test "$arg" = "--write"
            set -g __formatter_write_enabled 1
        end

        # Track positional targets when still in regular option parsing mode.
        if test $saw_double_dash -eq 1
            set -a __formatter_targets "$arg"
        else if not string match -q -- '-*' "$arg"
            set -a __formatter_targets "$arg"
        end

        set -a __formatter_forwarded_args "$arg"
    end

    # If `--fix` was passed, force write mode to make behavior explicit.
    if test "$__formatter_fix_enabled" = "1"
        # Remove mutually conflicting read-only flags to avoid confusing CLI combos
        # such as `--check --fix` reaching Prettier simultaneously.
        set -l filtered_args
        for arg in $__formatter_forwarded_args
            if test "$arg" = "--check" -o "$arg" = "--list-different"
                continue
            end
            set -a filtered_args "$arg"
        end
        set -g __formatter_forwarded_args $filtered_args

        if test "$__formatter_write_enabled" != "1"
            set -a __formatter_forwarded_args --write
            set -g __formatter_write_enabled 1
        end
    end

    # Default to repository root-like behavior (`.`) if no explicit targets were supplied.
    if test (count $__formatter_targets) -eq 0
        set -g __formatter_targets .
    end

    return 0
end
