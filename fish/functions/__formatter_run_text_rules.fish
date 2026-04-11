# ~/.config/fish/functions/__formatter_run_text_rules.fish
# Purpose: Invoke Node-based global text-rule formatter engine for candidate files.
# Inputs: <config_path> <fix_enabled:0|1> <color_mode> <candidate_files...>
# Outputs: Emits Prettier-style per-file/result lines; returns runner exit code.
# Examples: __formatter_run_text_rules "$HOME/.config/prettier/global.prettier.config.js" 1 auto file1 file2

function __formatter_run_text_rules --description "Run config-driven text transforms via Node runner"
    set -l config_path $argv[1]
    set -l fix_enabled $argv[2]
    set -l color_mode $argv[3]
    set -l candidate_files $argv[4..-1]
    if test (count $candidate_files) -eq 0
        return 0
    end

    set -l runner_path "$HOME/.config/fish/functions/__formatter_text_rules_runner.mjs"
    if not test -f "$runner_path"
        echo "[error] $runner_path: Runner script not found" >&2
        return 1
    end

    if not command -q node
        echo "[error] node: Node.js is required for custom text rules" >&2
        return 127
    end

    # Pass candidate files through stdin to avoid shell argument length limits and
    # to keep path handling predictable for paths containing spaces.
    printf '%s\n' $candidate_files | command node "$runner_path" \
        --config "$config_path" \
        --cwd "$PWD" \
        --fix "$fix_enabled" \
        --color-mode "$color_mode"

    return $status
end
