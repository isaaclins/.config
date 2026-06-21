# ~/.config/fish/conf.d/claude.fish
# Purpose: Redirect Claude Code's config dir into the shared agents umbrella so
# skills (and any other deliberately tracked config) sync across machines and
# macOS accounts. The Claude home lives under the umbrella alongside the codex
# home and the canonical skills store.
# Usage: Auto-loaded by fish; takes effect for new `claude` invocations.
set -gx CLAUDE_CONFIG_DIR $HOME/.config/agents/claude

# Claude Code does NOT propagate $CLAUDE_CONFIG_DIR into the shell subprocesses
# it spawns (e.g. the Bash tool), so any third-party CLI that writes to
# `~/.claude/skills/` from inside an agent session bypasses the sync. We
# mitigate by making `~/.claude/skills` a symlink to the canonical store
# `~/.config/agents/skills` in `install-claude-skills.sh` (run by bootstrap.sh).
# The `skills` fish function in `functions/skills.fish` is the second line of
# defence: when a human types `skills add ...` in fish, it injects `-g` so the
# package's CLAUDE_CONFIG_DIR-aware path picks the dotfile location directly
# (which lands in `agents/claude/skills`, a symlink to the canonical store).

# Ensure Claude's skills dir points at the canonical store. Claude loads skills
# from $CLAUDE_CONFIG_DIR/skills; the canonical store is ~/.config/agents/skills.
# Recreate the link on every shell start if it is missing or dangling, so a
# fresh machine/account self-heals.
set -l __claude_skills_link $CLAUDE_CONFIG_DIR/skills
set -l __claude_skills_store $HOME/.config/agents/skills
if test -d $__claude_skills_store
    if not test -e $__claude_skills_link
        rm -f $__claude_skills_link # clears a dangling symlink
        ln -s $__claude_skills_store $__claude_skills_link
    end
end

# The `npx skills` CLI hard-codes its global store to ~/.agents/skills (constant
# AGENTS_DIR, not overridable). Point that path at the canonical store so a raw
# `npx skills add ...` lands where Claude reads. Only auto-fix the missing or
# dangling-link case: never clobber a real, populated directory the CLI may have
# just repopulated (that case is left for the human / bootstrap to migrate).
set -l __agents_skills_link $HOME/.agents/skills
if test -d $__claude_skills_store
    if not test -e $__agents_skills_link
        mkdir -p $HOME/.agents
        rm -f $__agents_skills_link # clears a dangling symlink
        ln -s $__claude_skills_store $__agents_skills_link
    end
end
