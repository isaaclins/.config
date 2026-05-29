# ~/.config/fish/conf.d/claude.fish
# Purpose: Redirect Claude Code's config dir into the dotfiles tree so skills (and
# any other deliberately tracked config) sync across machines and macOS accounts.
# Usage: Auto-loaded by fish; takes effect for new `claude` invocations.
set -gx CLAUDE_CONFIG_DIR $HOME/.config/claude

# Claude Code does NOT propagate $CLAUDE_CONFIG_DIR into the shell subprocesses
# it spawns (e.g. the Bash tool), so any third-party CLI that writes to
# `~/.claude/skills/` from inside an agent session bypasses the sync. We
# mitigate by making `~/.claude/skills` a symlink to `~/.config/claude/skills`
# in `install-claude-skills.sh` (run by bootstrap.sh). The `skills` fish
# function in `functions/skills.fish` is the second line of defence: when a
# human types `skills add ...` in fish, it injects `-g` so the package's
# CLAUDE_CONFIG_DIR-aware path picks the dotfile location directly.
