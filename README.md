# .config

My handcrafted & personal dotfiles for macOS.

## Quick start (bootstrap)

1. Clone this repo into `~/.config` (or copy it there).
2. Run:

   ```sh
   bash ~/.config/bootstrap.sh
   ```

This will install Homebrew (if missing) and then run every
`bootstrap/**/install-*.sh` script (recursively).

## Assumptions (macOS)

- macOS machine with GUI (many installs are `brew install --cask ...` apps).
- Homebrew is the package manager used by `bootstrap.sh`.
- Some configs are inherently per-user/per-machine and should not be shared
  verbatim (see below).

## Safe to share vs per-user

**Safe to share (generally):**

- `bootstrap/` install scripts
- `fish/` functions and conf.d scripts (if they don’t embed absolute paths)
- `hammerspoon/` config
- `prettier/` config

**Per-user / do not commit / keep local:**

- `.versions` (generated on each bootstrap run)
- `gh/hosts.yml` (may contain auth tokens depending on `gh` setup)
- App configs that embed absolute home paths (e.g. `spicetify/config-xpui.ini`)

## Checks

- `scripts/check.sh` runs `shellcheck` against `bootstrap/**/*.sh` (if `shellcheck`
  is installed).
