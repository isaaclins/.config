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

    echo "Saved bootstrap script: $target"
end
