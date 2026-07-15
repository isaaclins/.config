# ~/.config/fish/conf.d/claude.fish
# Purpose: Redirect Claude Code's config dir into the shared agents umbrella so
# skills (and any other deliberately tracked config) sync across machines and
# macOS accounts. The Claude home lives under the umbrella alongside the codex
# home and the canonical skills store.
# Usage: Auto-loaded by fish; takes effect for new `claude` invocations.
#
# All skills symlink wiring (~/.config/agents/{claude,codex}/skills,
# ~/.claude/skills, ~/.agents/skills -> canonical ~/.config/agents/skills) is
# owned by bootstrap/cli/shell/install-claude-skills.sh, run via bootstrap.sh.
# It used to also self-heal here on every shell start, but shell startup should
# not mutate the filesystem; on a fresh machine/account, run bootstrap.sh (or
# that script directly) once instead.
#
# Note: Claude Code does NOT propagate $CLAUDE_CONFIG_DIR into the shell
# subprocesses it spawns (e.g. the Bash tool); the ~/.claude/skills symlink and
# the `skills` fish function (functions/skills.fish, injects -g) cover that.
set -gx CLAUDE_CONFIG_DIR $HOME/.config/agents/claude
