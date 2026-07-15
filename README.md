# .config

My handcrafted & personal dotfiles for macOS.

## Quick start (bootstrap)

1. Clone this repo into `~/.config` (or copy it there).
2. Run:

   ```sh
   bash ~/.config/bootstrap.sh
   ```

This will install Homebrew (if missing), install everything declared in the
`Brewfile` via `brew bundle`, and then run the non-brew config steps under
`bootstrap/**/install-*.sh` (symlinks, editor/tmux setup, etc.).

Packages are declarative: edit `Brewfile` by hand, or just `brew install ...` /
`brew uninstall ...` in fish and the `brew` wrapper re-runs `brew bundle dump`
to keep `Brewfile` in sync and pushes it.

## Assumptions (macOS)

- macOS machine with GUI (many installs are `brew install --cask ...` apps).
- Homebrew is the package manager used by `bootstrap.sh`.
- Some configs are inherently per-user/per-machine and should not be shared
  verbatim (see below).

## Safe to share vs per-user

**Safe to share (generally):**

- `Brewfile` (declarative package manifest)
- `bootstrap/` config/symlink scripts
- `fish/` functions and conf.d scripts (if they don’t embed absolute paths)
- `hammerspoon/` config
- `prettier/` config

**Per-user / do not commit / keep local:**

- `.java-default` (persisted default for `setjava`)
- `gh/hosts.yml` (may contain auth tokens depending on `gh` setup)
- App configs that embed absolute home paths (e.g. `spicetify/config-xpui.ini`)

## Checks

- `configcheck` (fish function) runs `shellcheck` against `bootstrap/**/*.sh`
  and `bootstrap.sh` (if `shellcheck` is installed).

## Fish: Java Version Manager

- `setjava 17` switches to `openjdk@17` for the current shell.
- `setjava 21` persists the selection for new shells by default.
- `setjava 21 --session` switches only for the current shell session.
- `setjava openjdk` switches to the latest `openjdk` formula.
- `setjava list` shows installed Homebrew JDKs and current/default state.
- `setjava system` clears managed `JAVA_HOME` and Java PATH overrides.


## Support

If these dotfiles or bootstrap scripts saved you setup time: [Buy Me a Coffee](https://buymeacoffee.com/isaaclins)
