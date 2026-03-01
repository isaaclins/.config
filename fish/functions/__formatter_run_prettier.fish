# ~/.config/fish/functions/__formatter_run_prettier.fish
# Purpose: Execute Prettier with correct precedence (local config vs global fallback config).
# Inputs: <has_local_config:0|1> <global_config_path> <forwarded_prettier_args...>
# Outputs: Mirrors Prettier stdout/stderr; returns Prettier exit code.
# Examples: __formatter_run_prettier 1 "$HOME/.config/prettier/global.prettier.config.js" . --write

function __formatter_run_prettier --description "Run Prettier with local precedence and global fallback"
    set -l has_local_config $argv[1]
    set -l global_config_path $argv[2]
    set -l forwarded_args $argv[3..-1]

    set -l ignore_args
    set -l extra_args --ignore-unknown

    # Keep current ignore behavior: prefer .prettierignore, fallback to .gitignore.
    if test -f .prettierignore
        set ignore_args --ignore-path .prettierignore
    else if test -f .gitignore
        set ignore_args --ignore-path .gitignore
    end

    set -l has_local_binary 0
    if test -x node_modules/.bin/prettier
        set has_local_binary 1
    end

    # Use local binary when available for reproducibility; otherwise use pnpm dlx.
    if test $has_local_binary -eq 1
        if test "$has_local_config" = "1"
            command pnpm exec prettier \
                $ignore_args \
                $extra_args \
                $forwarded_args
            return $status
        end

        command pnpm exec prettier \
            --config "$global_config_path" \
            --config-precedence prefer-file \
            $ignore_args \
            $extra_args \
            $forwarded_args
        return $status
    end

    if test "$has_local_config" = "1"
        echo "⚠️  No project-local Prettier binary found, using pnpm dlx with local config..."
        command pnpm dlx prettier \
            $ignore_args \
            $extra_args \
            $forwarded_args
        return $status
    end

    echo "⚠️  No project-local Prettier found, using global fallback..."
    command pnpm dlx prettier \
        --config "$global_config_path" \
        --config-precedence prefer-file \
        $ignore_args \
        $extra_args \
        $forwarded_args
    return $status
end
