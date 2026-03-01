# ~/.config/fish/functions/__formatter_collect_git_candidates.fish
# Purpose: Collect candidate files for custom text-rule formatting based on user targets.
# Inputs: Target paths (files, directories, or ".").
# Outputs: Newline-delimited candidate file paths written to stdout.
# Examples: __formatter_collect_git_candidates . ; __formatter_collect_git_candidates src app.py

function __formatter_collect_git_candidates --description "Collect candidate files from git-known scope or filesystem fallback"
    set -l targets $argv
    if test (count $targets) -eq 0
        set targets .
    end

    set -l in_git_repo 0
    command git rev-parse --is-inside-work-tree >/dev/null 2>&1
    if test $status -eq 0
        set in_git_repo 1
    end

    set -l repo_wide 0
    for target in $targets
        if test "$target" = "." -o "$target" = "./" -o -d "$target"
            set repo_wide 1
            break
        end
    end

    set -l results

    # Git-aware mode gives deterministic, ignore-respecting project scope.
    if test $in_git_repo -eq 1; and test $repo_wide -eq 1
        set -l tracked (command git ls-files 2>/dev/null)
        set -l untracked (command git ls-files --others --exclude-standard 2>/dev/null)
        set results $tracked $untracked
    else if test $in_git_repo -eq 1
        # File-target mode inside git: include only explicitly targeted files.
        for target in $targets
            if test -f "$target"
                set -a results "$target"
            else if test -d "$target"
                # If a directory was passed but repo-wide is disabled (rare edge case),
                # include git-known files under that directory only.
                set -l tracked (command git ls-files -- "$target" 2>/dev/null)
                set -l untracked (command git ls-files --others --exclude-standard -- "$target" 2>/dev/null)
                set results $results $tracked $untracked
            end
        end
    else
        # Non-git fallback: best-effort filesystem traversal with conservative excludes.
        for target in $targets
            if test -f "$target"
                set -a results "$target"
            else if test -d "$target"
                set -l discovered (
                    command find "$target" \
                        -type f \
                        ! -path '*/.git/*' \
                        ! -path '*/node_modules/*' \
                        2>/dev/null
                )
                set results $results $discovered
            end
        end
    end

    # Normalize and deduplicate in stable lexical order.
    printf '%s\n' $results \
        | sed -e 's#^\./##' \
        | awk 'NF && !seen[$0]++' \
        | sort
end
