# ~/.config/fish/conf.d/codex.fish
# Purpose: Redirect Codex CLI's home into the shared agents umbrella so the
# tracked config (config.toml) and the shared rules + skills sync across machines
# and macOS accounts. The Codex home lives under the umbrella alongside the
# Claude home and the canonical skills store.
# Usage: Auto-loaded by fish; takes effect for new `codex` invocations.
set -gx CODEX_HOME $HOME/.config/agents/codex
