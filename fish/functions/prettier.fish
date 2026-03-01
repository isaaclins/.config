# ~/.config/fish/functions/prettier.fish
# Purpose: Single entrypoint formatter wrapper with local-precedence and global custom text-rule fallback.
# Usage: Run as `prettier ...` (for example `prettier . --write` or `prettier . --fix`).
# Flow: Parse args -> detect local config -> run Prettier -> optionally run global text rules.

function prettier --description "Config-driven formatter wrapper with --fix and local config precedence"
    # Global fallback config path used only when no repo-local Prettier config exists.
    set -l global_config_path "$HOME/.config/prettier/global.prettier.config.js"

    if not test -f "$global_config_path"
        echo "[error] $global_config_path: global prettier config not found" >&2
        return 1
    end

    # Stage 1: Parse wrapper args and normalize behavior (`--fix` implies `--write`).
    __formatter_parse_args $argv
    if test $status -ne 0
        return $status
    end

    set -l forwarded_args $__formatter_forwarded_args
    set -l targets $__formatter_targets
    set -l fix_enabled $__formatter_fix_enabled
    set -l write_enabled $__formatter_write_enabled

    # Stage 2: Determine local-precedence behavior.
    set -l has_local_config 0
    if __formatter_detect_local_prettier_config
        set has_local_config 1
    end

    # Stage 3: Always run Prettier first with the resolved precedence mode.
    __formatter_run_prettier "$has_local_config" "$global_config_path" $forwarded_args
    set -l prettier_status $status
    if test $prettier_status -ne 0
        # Cleanup exported parser state before leaving.
        set -e __formatter_forwarded_args __formatter_targets __formatter_fix_enabled __formatter_write_enabled
        return $prettier_status
    end

    # If local config exists, skip global custom text rules entirely by design.
    if test "$has_local_config" = "1"
        set -e __formatter_forwarded_args __formatter_targets __formatter_fix_enabled __formatter_write_enabled
        return 0
    end

    # Custom text rules only run in write mode.
    if test "$write_enabled" != "1"
        set -e __formatter_forwarded_args __formatter_targets __formatter_fix_enabled __formatter_write_enabled
        return 0
    end

    # Stage 4: Collect candidate files (git-aware when possible), then run Node rule engine.
    set -l candidate_files (__formatter_collect_git_candidates $targets)

    if test (count $candidate_files) -eq 0
        set -e __formatter_forwarded_args __formatter_targets __formatter_fix_enabled __formatter_write_enabled
        return 0
    end

    __formatter_run_text_rules "$global_config_path" "$fix_enabled" auto $candidate_files
    set -l text_rules_status $status

    # Cleanup exported parser state before returning control to caller.
    set -e __formatter_forwarded_args __formatter_targets __formatter_fix_enabled __formatter_write_enabled

    return $text_rules_status
end
