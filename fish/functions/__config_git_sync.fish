# ~/.config/fish/functions/__config_git_sync.fish
# Purpose: Pull and push ~/.config when Homebrew installs change bootstrap installers.
# Usage: Internal helper used by the fish `brew` wrapper.
function __config_git_repo_root --description "Resolve the ~/.config git repository root"
    set -l repo_root "$HOME/.config"
    command -sq git; or return 1

    set -l detected (command git -C "$repo_root" rev-parse --show-toplevel 2>/dev/null)
    test -n "$detected"; or return 1
    echo "$detected"
end

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

function __config_git_push --description "Push ~/.config commits to upstream or origin"
    set -l repo_root $argv[1]
    set -l branch $argv[2]
    test -n "$repo_root"; and test -n "$branch"; or return 1

    if command git -C "$repo_root" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1
        command git -C "$repo_root" push >/dev/null 2>&1
        return $status
    end

    if command git -C "$repo_root" remote get-url origin >/dev/null 2>&1
        command git -C "$repo_root" push -u origin "$branch" >/dev/null 2>&1
        return $status
    end

    return 1
end

function __config_git_commit_and_push_bootstrap --description "Commit and push bootstrap installer changes"
    set -l pkgs $argv
    set -l repo_root (__config_git_repo_root); or return 0

    set -l branch (command git -C "$repo_root" symbolic-ref --quiet --short HEAD 2>/dev/null)
    if test -z "$branch"
        echo "Skipping auto-push (detached HEAD)."
        return 0
    end

    command git -C "$repo_root" add --all bootstrap/; or return 0

    command git -C "$repo_root" diff --cached --quiet -- bootstrap/
    and return 0

    set -l pkg_list (string join ", " $pkgs)
    test -n "$pkg_list"; or set pkg_list "packages"

    set -l commit_msg "chore(bootstrap): sync installers after brew ($pkg_list)"
    if not command git -C "$repo_root" commit -m "$commit_msg" >/dev/null 2>&1
        echo "Skipped auto-commit for bootstrap installers (nothing to commit or commit blocked)."
        return 0
    end

    if __config_git_push "$repo_root" "$branch"
        echo "Committed and pushed bootstrap installer changes."
    else
        echo "Committed bootstrap installer changes, but push failed."
    end
end
