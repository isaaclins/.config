# ~/.config/fish/functions/__git_status.fish
# Purpose: Compact git status summary for the prompt — dirty marker and ahead/behind counts.
# Usage: Autoloaded when called by `fish_prompt`. Prints e.g. "● ↑2 ↓1" or "✓" or nothing if not in a repo.
function __git_status --description 'Compact git dirty / ahead-behind summary for prompt'
    type -q git; or return
    command git rev-parse --is-inside-work-tree >/dev/null 2>&1; or return

    set -l parts

    # Dirty / clean marker
    set -l dirty (command git status --porcelain 2>/dev/null)
    if test -n "$dirty"
        set -a parts '●'
    else
        set -a parts '✓'
    end

    # Ahead / behind counts vs upstream (silent if no upstream)
    set -l ab (command git rev-list --count --left-right '@{upstream}...HEAD' 2>/dev/null | string split \t)
    if test (count $ab) -eq 2
        test $ab[2] -gt 0; and set -a parts "↑$ab[2]"
        test $ab[1] -gt 0; and set -a parts "↓$ab[1]"
    end

    string join ' ' $parts
end
