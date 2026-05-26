# ~/.config/fish/functions/__config_git_pull.fish
# Purpose: Pull latest ~/.config changes before brew install.
# Usage: Internal helper used by the fish `brew` wrapper.
function __config_git_pull --description "Pull latest ~/.config changes before brew install"
    set -l repo_root (__config_git_repo_root); or return 0

    set -l branch (command git -C "$repo_root" symbolic-ref --quiet --short HEAD 2>/dev/null)
    if test -z "$branch"
        echo "Skipping auto-pull (detached HEAD)."
        return 0
    end

    if not command git -C "$repo_root" pull --rebase --autostash >/dev/null 2>&1
        echo "Auto-pull failed; continuing without syncing remote changes."
    end
end
