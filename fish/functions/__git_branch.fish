# ~/.config/fish/functions/__git_branch.fish
# Purpose: Returns the current git branch (or short commit in detached HEAD) for prompt/helpers.
# Usage: Autoloaded when called (for example by `fish_prompt`); run `__git_branch` manually inside repos to test.
function __git_branch --description 'Get git branch if inside repo'
    type -q git; or return
    command git rev-parse --is-inside-work-tree >/dev/null 2>&1; or return

    set -l branch (command git symbolic-ref --quiet --short HEAD 2>/dev/null)
    if test -n "$branch"
        echo $branch
        return
    end

    # Detached HEAD fallback.
    set -l commit (command git rev-parse --short HEAD 2>/dev/null)
    test -n "$commit"; and echo "@$commit"
end

