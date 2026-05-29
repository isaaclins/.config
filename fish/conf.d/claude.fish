# ~/.config/fish/conf.d/claude.fish
# Purpose: Redirect Claude Code's config dir into the dotfiles tree so skills (and
# any other deliberately tracked config) sync across machines and macOS accounts.
# Usage: Auto-loaded by fish; takes effect for new `claude` invocations.
set -gx CLAUDE_CONFIG_DIR $HOME/.config/claude
