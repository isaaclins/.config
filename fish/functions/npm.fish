# ~/.config/fish/functions/npm.fish
# Purpose: Redirects common `npm` commands to `pnpm` (especially `npm i` / `npm install`).
# Usage: Type `npm install ...` and it will run the `pnpm` equivalent.
function npm --description "Redirect npm to pnpm"
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
                                    # omit from `pnpm install` (no-pkgs case)
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

        case help --help -h
            echo "This shell redirects npm -> pnpm. Try: npm install / npm i / npm run / npm exec / npm dlx / npm ci" >&2
            return 0
    end

    echo "Unsupported npm subcommand '$subcmd' in this shell; use pnpm directly." >&2
    if command -q npm
        command npm $argv
        return $status
    end
    return 127
end
