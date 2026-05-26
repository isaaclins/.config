# ~/.config/fish/functions/__config_git_push.fish
# Purpose: Push ~/.config commits to upstream or origin.
# Usage: Internal helper used by __config_git_commit_and_push_bootstrap.
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
