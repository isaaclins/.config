# ~/.config/fish/functions/npm.fish
# Purpose: Prefer pnpm without overriding a repository's declared package manager.
function npm --description "Route npm to the project's package manager"
    # Walk from the current directory to the Git root, or to the filesystem root
    # outside Git. The nearest explicit packageManager wins over every lockfile.
    # Without one, the nearest lockfile wins. Ambiguous lockfiles fail closed, and
    # projects with no marker retain this config's pnpm-first default.
    set -l current (pwd -P)
    set -l boundary /
    if command -q git
        set -l git_root (command git -C "$current" rev-parse --show-toplevel 2>/dev/null)
        if test $status -eq 0; and test -n "$git_root"
            set boundary (string replace -r '/$' '' -- "$git_root")
        end
    end

    set -l manager
    set -l lock_manager
    set -l lock_directory

    while true
        if test -f "$current/package.json"; and command -q node
            set -l declared (command node -e '
                const fs = require("node:fs");
                try {
                    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).packageManager;
                    if (typeof value === "string") process.stdout.write(value);
                } catch {}
            ' "$current/package.json")
            if test -n "$declared"
                set manager (string split -m 1 @ -- "$declared")[1]
                break
            end
        end

        if test -z "$lock_manager"
            set -l has_npm 0
            set -l has_pnpm 0
            if test -f "$current/package-lock.json"; or test -f "$current/npm-shrinkwrap.json"
                set has_npm 1
            end
            if test -f "$current/pnpm-lock.yaml"
                set has_pnpm 1
            end

            if test $has_npm -eq 1; and test $has_pnpm -eq 1
                set lock_manager ambiguous
                set lock_directory "$current"
            else if test $has_npm -eq 1
                set lock_manager npm
                set lock_directory "$current"
            else if test $has_pnpm -eq 1
                set lock_manager pnpm
                set lock_directory "$current"
            end
        end

        if test "$current" = "$boundary"; or test "$current" = /
            break
        end
        set current (path dirname "$current")
    end

    if test -z "$manager"
        set manager "$lock_manager"
    end
    if test -z "$manager"
        set manager pnpm
    end

    switch "$manager"
        case npm
            # `command` bypasses this function and prevents recursion.
            command npm $argv
            return $status
        case ambiguous
            echo "npm: both npm and pnpm lockfiles exist in $lock_directory; declare packageManager in package.json or remove the stale lockfile." >&2
            return 2
        case pnpm
            # Continue below with the pnpm compatibility mappings.
        case '*'
            echo "npm: package.json declares unsupported package manager '$manager'; invoke it directly." >&2
            return 2
    end

    if not command -q pnpm
        echo "pnpm not found; install it first (bootstrap/cli/node/install-pnpm.sh)." >&2
        return 127
    end

    set -l subcmd
    if test (count $argv) -gt 0
        set subcmd $argv[1]
    else
        set subcmd help
    end

    set -l rest
    if test (count $argv) -ge 2
        set rest $argv[2..-1]
    end

    switch "$subcmd"
        case i install
            set -l pkgs
            set -l add_flags
            set -l install_flags

            for arg in $rest
                switch "$arg"
                    case --save-dev
                        set -a add_flags -D
                    case --save-optional
                        set -a add_flags -O
                    case --global
                        set -a add_flags -g
                    case '*'
                        if string match -qr '^-' -- "$arg"
                            set -a add_flags "$arg"
                            switch "$arg"
                                case -D --save-dev -O --save-optional -g --global
                                    # Omit add-only flags from a dependency-free install.
                                case '*'
                                    set -a install_flags "$arg"
                            end
                        else
                            set -a pkgs "$arg"
                        end
                end
            end

            if test (count $pkgs) -eq 0
                command pnpm install $install_flags
                return $status
            end

            command pnpm add $add_flags $pkgs
            return $status

        case ci
            command pnpm install --frozen-lockfile $rest
            return $status

        case run
            command pnpm run $rest
            return $status

        case exec
            command pnpm exec $rest
            return $status

        case dlx
            command pnpm dlx $rest
            return $status

        case init
            command pnpm init $rest
            return $status

        case -v --version version
            command pnpm --version
            return $status

        case help --help -h
            echo "This project uses pnpm. Try: npm install / npm i / npm run / npm exec / npm dlx / npm ci" >&2
            return 0
    end

    echo "Unsupported npm subcommand '$subcmd' for pnpm routing; use pnpm directly." >&2
    return 2
end
