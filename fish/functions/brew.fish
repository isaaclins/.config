# ~/.config/fish/functions/brew.fish
# Purpose: Wraps Homebrew, records package/cask versions, auto-generates bootstrap install scripts, and syncs ~/.config.
# Usage: Use `brew ...` normally in fish; successful install/reinstall/upgrade commands update .versions and sync bootstrap/.
function brew --description "brew wrapper with .versions tracking"
    set -l subcmd
    if test (count $argv) -gt 0
        set subcmd $argv[1]
    end

    set -l track_subcmds install reinstall upgrade
    set -l should_track 0
    if contains -- "$subcmd" $track_subcmds
        set should_track 1
    end

    set -l is_cask 0
    set -l pkgs
    if test $should_track -eq 1; and test (count $argv) -gt 1
        for idx in (seq 2 (count $argv))
            set -l arg $argv[$idx]
            switch "$arg"
                case --cask '-c'
                    set is_cask 1
                    continue
                case '--formula'
                    set is_cask 0
                    continue
            end

            if string match -qr '^-' -- "$arg"
                continue
            end

            set -a pkgs "$arg"
        end
    end

    if test $should_track -eq 1; and test (count $pkgs) -gt 0
        __config_git_pull
    end

    command brew $argv
    set -l brew_status $status

    if test $brew_status -eq 0; and test $should_track -eq 1; and test (count $pkgs) -gt 0
        for pkg in $pkgs
            __brew_record_version "$pkg" "$is_cask"
            if test "$subcmd" = "install"; or test "$subcmd" = "reinstall"
                __bootstrap_generate_installer "$pkg" "$is_cask"
            end
        end
        __config_git_commit_and_push_bootstrap $pkgs
    end

    return $brew_status
end
