# ~/.config/fish/functions/brew.fish
# Purpose: Wrap Homebrew so that any command changing the installed set syncs
#   ~/.config/Brewfile via `brew bundle dump`, then commits and pushes it.
# Usage: Use `brew ...` normally in fish; successful install/uninstall/tap/untap
#   commands regenerate the Brewfile and push it to ~/.config.
function __brew_load_config_git_helpers --description "Load config git helpers when autoload did not"
    if functions -q __config_git_pull
        return 0
    end

    set -l dir "$__fish_config_dir/functions"
    if test -f "$dir/__config_git_sync.fish"
        source "$dir/__config_git_sync.fish"
        return 0
    end

    for helper in __config_git_repo_root __config_git_pull __config_git_push __config_git_commit_and_push_brewfile
        if test -f "$dir/$helper.fish"
            source "$dir/$helper.fish"
        end
    end
end

function brew --description "brew wrapper that keeps ~/.config/Brewfile in sync"
    set -l subcmd
    if test (count $argv) -gt 0
        set subcmd $argv[1]
    end

    # Subcommands that change which packages are installed -> resync Brewfile.
    set -l sync_subcmds install reinstall uninstall remove rm tap untap
    set -l should_sync 0
    if contains -- "$subcmd" $sync_subcmds
        set should_sync 1
    end

    if test $should_sync -eq 1
        __brew_load_config_git_helpers
        __config_git_pull
    end

    command brew $argv
    set -l brew_status $status

    if test $brew_status -eq 0; and test $should_sync -eq 1
        set -l brewfile "$HOME/.config/Brewfile"
        command brew bundle dump --force --file="$brewfile"
        __brew_load_config_git_helpers
        set -l pkgs
        if test (count $argv) -gt 1
            set pkgs $argv[2..-1]
        end
        __config_git_commit_and_push_brewfile $pkgs
    end

    return $brew_status
end
