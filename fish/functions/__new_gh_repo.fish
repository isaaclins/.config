# ~/.config/fish/functions/__new_gh_repo.fish
# Purpose: Creates a local git repo scaffold and publishes it to GitHub.
# Usage: Internal helper for `npr`/`npu`.
function __new_gh_repo --description "Create and publish a new GitHub repo"
    set -l visibility $argv[1]
    set -l repo_spec $argv[2]

    if test -z "$visibility"; or test -z "$repo_spec"
        echo "Usage: __new_gh_repo <private|public> <repo|owner/repo> [gh repo create flags...]" >&2
        return 2
    end

    if test "$visibility" != "private"; and test "$visibility" != "public"
        echo "Invalid visibility '$visibility' (expected private or public)." >&2
        return 2
    end

    if not command -q gh
        echo "gh CLI is required but not installed." >&2
        return 127
    end

    if not command -q git
        echo "git is required but not installed." >&2
        return 127
    end

    command gh auth status >/dev/null 2>&1
    if test $status -ne 0
        echo "gh is not authenticated. Run: gh auth login" >&2
        return 1
    end

    set -l extra_flags
    if test (count $argv) -gt 2
        set extra_flags $argv[3..-1]
    end

    set -l repo_name $repo_spec
    if string match -q '*/*' -- "$repo_spec"
        set repo_name (string split -m 1 '/' -- "$repo_spec")[2]
    end

    if not string match -qr '^[A-Za-z0-9._-]+$' -- "$repo_name"
        echo "Invalid repo name '$repo_name'. Use letters, numbers, dot, underscore, or dash." >&2
        return 2
    end

    if test -e "$repo_name"
        echo "Path already exists: $repo_name" >&2
        return 1
    end

    command mkdir -p -- "$repo_name"; or return 1
    cd -- "$repo_name"; or return 1

    command git init -b main >/dev/null 2>&1
    if test $status -ne 0
        command git init >/dev/null; or return 1
        command git branch -M main >/dev/null 2>&1
    end

    printf '# %s\n\n' "$repo_name" > README.md
    printf '%s\n' '.DS_Store' 'node_modules/' 'build/' 'dist/' 'public/' > .gitignore

    command git add README.md .gitignore; or return 1
    command git commit -m "chore: initial commit" >/dev/null 2>&1
    if test $status -ne 0
        echo "Initial commit failed (check git user.name/user.email)." >&2
        return 1
    end

    command gh repo create "$repo_spec" --$visibility $extra_flags >/dev/null
    set -l gh_status $status
    if test $gh_status -ne 0
        echo "GitHub repo creation failed. Local repo was created at: "(pwd) >&2
        return $gh_status
    end

    set -l repo_full "$repo_spec"
    if not string match -q '*/*' -- "$repo_spec"
        set -l owner (command gh api user -q .login 2>/dev/null)
        if test -n "$owner"
            set repo_full "$owner/$repo_name"
        end
    end
    echo "GitHub repo created: https://github.com/$repo_full"

    set -l ssh_remote "git@github.com:$repo_full.git"
    set -l https_remote "https://github.com/$repo_full.git"
    set -l active_remote "$ssh_remote"

    command git remote add origin "$ssh_remote" >/dev/null 2>&1
    if test $status -ne 0
        command git remote set-url origin "$ssh_remote"; or begin
            echo "Failed to configure git remote origin." >&2
            return 1
        end
    end

    command gh auth setup-git >/dev/null 2>&1
    command git push -u origin main --quiet >/dev/null 2>&1
    if test $status -ne 0
        echo "SSH push failed; falling back to HTTPS."
        command git remote set-url origin "$https_remote"; or begin
            echo "Fallback failed: could not set HTTPS remote." >&2
            return 1
        end

        set active_remote "$https_remote"
        command git push -u origin main --quiet >/dev/null 2>&1
        if test $status -ne 0
            echo "Push failed over SSH and HTTPS." >&2
            echo "Remote is set to: $active_remote" >&2
            echo "Try: gh auth refresh -h github.com -s repo" >&2
            return 1
        end
        echo "Initial push succeeded via HTTPS."
    else
        echo "Initial push succeeded via SSH."
    end

    echo "Created $visibility repo: $repo_spec"
    echo "Remote: $active_remote"
    echo "Working directory: "(pwd)
    __initialize_cursor_roadmap_scaffold
end
