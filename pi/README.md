# Pi configuration

This directory is the personal deployment of Pi: pinned package selections, personal settings, locally developed modules, and intentionally local extensions. A fresh `git clone` of the config repo plus `pnpm install` in each module is enough to get a working harness; the prebuilt computer-use bridges are tracked, so nothing has to be rebuilt.

## Ownership

One responsibility has one owner. A local extension must not register a competing tool, command, lifecycle hook, store, or state machine for a responsibility a module already owns.

| Responsibility | Owner | Deployment |
| --- | --- | --- |
| Visible tmux child sessions, identity, depth, reports, accounting | `@isaaclins/pi-codrive` | local module (`modules/`), published as 0.1.1 |
| Structured global/project memory | `@isaaclins/pi-memory` | local module (`modules/`), unpublished |
| Context usage, handover, and compaction lifecycle | `@isaaclins/pi-context` | local module (`modules/`), unpublished |
| Excalidraw drawing tools | `@isaaclins/pi-excalidraw` | local module (`modules/`), unpublished, not yet tracked in git |
| Desktop/browser control | `pi-computer-use-codex-parity` | local package (`packages/`), unpublished |
| Fish command bridge | `@isaaclins/pi-fish-bridge` | npm package |
| Arcoiris theme | `@isaaclins/pi-arcoiris-refined` | npm package |
| Notifications, subscription usage display, prompt stash, session reset, macOS keep-awake | files under `extensions/` | local only |

`modules/` and `packages/` are loaded by path from `settings.json`. They are installed with pnpm; there are no npm lockfiles.

`assets/Pi Notifier.app` is a small AppleScript applet that exists only to give notifications the Claude icon, since macOS takes the icon from the posting app. Its icon is generated from `assets/claude-icon.svg`, a full-bleed 1024px canvas because macOS 26+ applies its own squircle mask; an inset tile gets double-framed. After replacing `Contents/Resources/applet.icns`, re-sign the bundle, re-register it with `lsregister -f`, and `killall usernoted Dock`, otherwise the old icon stays cached. `notify-sound.ts` hands it a payload through `~/.cache/pi-notify.txt` because `open` cannot pass argv to an applet. It needs a one-time Allow in the macOS notification prompt on a new machine; `terminal-notifier` was replaced because it exits 0 and posts nothing on macOS 26+.

`lib/usage-lifecycle.ts` intentionally duplicates `modules/pi-context/src/usage-lifecycle.ts`: the module must stay self-contained for publishing, and the local extensions must not import module internals.

## Local extensions

| File | Surface |
| --- | --- |
| `anthropic-usage.ts` | powerline usage segment plus `/usage` |
| `clear-session.ts` | `/clear` |
| `keep-awake.ts` | automatic `caffeinate` plus `/clam` for lid-closed keep-awake |
| `notify-sound.ts` | desktop notification when a prompt finishes (Claude icon, Glass sound, one-line TLDR) |
| `prompt-stash.ts` | `ctrl+s` stash/restore/swap |
| `repo-memory.ts` | deterministic zero-LLM repo map injection |
| `ui-polish.ts` | working indicator plus the stash widget |

## Security defaults

- Unknown projects require an explicit trust decision.
- Repository content is task data, never a trusted system instruction.
- Delegation identity and depth are independent of report credentials.
- Machine-global lid-sleep changes happen only through an explicit `/clam` toggle, never at startup, and are restored when the last claiming session disarms or exits.
- Infrastructure memory is retrieved only when relevant.
- npm-published packages are pinned in `settings.json`; upgrades are explicit.

## Changing a module

Modules are developed in place under `modules/`. Before a change lands:

```sh
cd modules/<module> && pnpm test && pnpm typecheck && pnpm pack-check
```

A module may be added to `settings.json` only with a threat model, bounded storage and output, lifecycle cleanup, observable failures, and a test against the supported Pi version. Experimental extensions stay disabled until they pass.

## Publishing a module

Only `@isaaclins/pi-codrive` and `@isaaclins/pi-fish-bridge` are on npm today. To publish another one: bump its version per Semantic Versioning, publish through trusted publishing, verify the registry tarball and provenance, then swap its `settings.json` entry from the local path to the pinned version.

Do not edit generated Fish shims or Pi's package cache directly.
