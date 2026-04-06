# ~/.config/fish/functions/__bootstrap_generate_installer.fish
# Purpose: Creates a categorized bootstrap/**/install-<pkg>.sh from template for a brew package.
# Usage: Internal helper used by the fish `brew` wrapper after successful installs.
function __bootstrap_generate_installer --description "Generate install-<pkg>.sh bootstrap script"
    set -l pkg $argv[1]
    set -l is_cask $argv[2]
    test -n "$pkg"; or return 1

    set -l root "$HOME/.config"
    set -l template "$root/bootstrap/templates/install-template.sh"
    test -f "$template"; or return 1

    set -l safe_name (string lower -- "$pkg")
    set safe_name (string replace -ra '[^a-z0-9._-]' '-' -- "$safe_name")

    # Respect existing custom scripts (anywhere under bootstrap/ now that installers are categorized).
    set -l existing (command find "$root/bootstrap" -type f -name "install-$safe_name.sh" -print -quit 2>/dev/null)
    if test -n "$existing"
        return 0
    end

    set -l target_dir "$root/bootstrap/cli/misc"
    if test "$is_cask" = "1"
        set target_dir "$root/bootstrap/apps/misc"
    end

    command mkdir -p "$target_dir"
    set -l target "$target_dir/install-$safe_name.sh"

    command cp "$template" "$target"

    set -l install_kind "formula"
    if test "$is_cask" = "1"
        set install_kind "cask"
    end

    set -l sed_pkg (string replace -a '&' '\&' -- "$pkg")
    set -l sed_kind (string replace -a '&' '\&' -- "$install_kind")
    command sed -i '' -e "s#^SOFTWARE=.*#SOFTWARE=\"$sed_pkg\"#" "$target"
    command sed -i '' -e "s#^BREW_PACKAGE=.*#BREW_PACKAGE=\"$sed_pkg\"#" "$target"
    command sed -i '' -e "s#^INSTALL_KIND=.*#INSTALL_KIND=\"$sed_kind\"#" "$target"
    command chmod +x "$target"

    __bootstrap_commit_and_push_file "$target" "$pkg"
    echo "Saved bootstrap script: $target"
end

function __bootstrap_commit_and_push_file --description "Commit and push generated bootstrap installer"
    set -l target $argv[1]
    set -l pkg $argv[2]
    test -n "$target"; or return 1

    command -sq git; or return 0

    set -l target_dir (command dirname -- "$target")
    set -l repo_root (command git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null)
    test -n "$repo_root"; or return 0

    set -l escaped_root (string escape --style=regex -- "$repo_root")
    set -l rel_target (string replace -r "^$escaped_root/?" "" -- "$target")
    test -n "$rel_target"; or return 0

    command git -C "$repo_root" diff --quiet -- "$rel_target"
    set -l worktree_clean $status
    command git -C "$repo_root" diff --cached --quiet -- "$rel_target"
    set -l index_clean $status
    if test $worktree_clean -eq 0; and test $index_clean -eq 0
        return 0
    end

    set -l branch (command git -C "$repo_root" symbolic-ref --quiet --short HEAD 2>/dev/null)
    if test -z "$branch"
        echo "Skipping auto-push for $rel_target (detached HEAD)."
        return 0
    end

    command git -C "$repo_root" add -- "$rel_target"; or begin
        echo "Skipping auto-commit for $rel_target (git add failed)."
        return 0
    end

    set -l commit_msg "chore(bootstrap): add installer for $pkg"
    if not command git -C "$repo_root" commit --only -m "$commit_msg" -- "$rel_target" >/dev/null 2>&1
        echo "Skipped auto-commit for $rel_target (nothing to commit or commit blocked)."
        return 0
    end

    if command git -C "$repo_root" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1
        if command git -C "$repo_root" push >/dev/null 2>&1
            echo "Committed and pushed $rel_target."
        else
            echo "Committed $rel_target, but push failed."
        end
        return 0
    end

    if command git -C "$repo_root" remote get-url origin >/dev/null 2>&1
        if command git -C "$repo_root" push -u origin "$branch" >/dev/null 2>&1
            echo "Committed and pushed $rel_target to origin/$branch."
        else
            echo "Committed $rel_target, but push failed."
        end
        return 0
    end

    echo "Committed $rel_target. No remote/upstream configured, skipped push."
end
