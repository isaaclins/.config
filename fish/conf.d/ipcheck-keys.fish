# ~/.config/fish/conf.d/ipcheck-keys.fish
# Purpose: Source the local, gitignored ipcheck API-key file if present.
# Usage: Auto-loaded by fish. Put keys in fish/ipcheck-keys.local.fish (gitignored).
set -l __ipcheck_keys "$__fish_config_dir/ipcheck-keys.local.fish"
if test -f "$__ipcheck_keys"
    source "$__ipcheck_keys"
end
