# ~/.config/fish/functions/__config_git_commit_and_push_brewfile.fish
# Purpose: Commit and push Brewfile changes after a brew command that changed
#   the installed set.
# Usage: Internal helper used by the fish `brew` wrapper.
function __config_git_commit_and_push_brewfile --description "Commit and push Brewfile changes"
    set -l pkgs $argv
    set -l repo_root (__config_git_repo_root); or return 0

    set -l branch (command git -C "$repo_root" symbolic-ref --quiet --short HEAD 2>/dev/null)
    if test -z "$branch"
        echo "Skipping auto-push (detached HEAD)."
        return 0
    end

    command git -C "$repo_root" add Brewfile; or return 0

    command git -C "$repo_root" diff --cached --quiet -- Brewfile
    and return 0

    set -l pkg_list (string join ", " $pkgs)
    test -n "$pkg_list"; or set pkg_list "packages"

    set -l commit_msg "chore(brew): sync Brewfile ($pkg_list)"
    if not command git -C "$repo_root" commit -m "$commit_msg" >/dev/null 2>&1
        echo "Skipped auto-commit for Brewfile (nothing to commit or commit blocked)."
        return 0
    end

    if __config_git_push "$repo_root" "$branch"
        echo "Committed and pushed Brewfile changes."
    else
        echo "Committed Brewfile changes, but push failed."
    end
end
