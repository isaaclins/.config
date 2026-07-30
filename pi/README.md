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
| Image preview rendering in tmux via Kitty graphics | `pi-tmux-image-preview` | local module (`modules/`), unpublished |
| Desktop/browser control | `pi-computer-use-codex-parity` | local package (`packages/`), unpublished |
| Fish command bridge | `@isaaclins/pi-fish-bridge` | npm package |
| Arcoiris theme | `@isaaclins/pi-arcoiris-refined` | npm package |
| Notifications, subscription usage display, prompt stash, session reset, macOS keep-awake | files under `extensions/` | local only |

`modules/` and `packages/` are loaded by path from `settings.json`. They are installed with pnpm; there are no npm lockfiles.

`assets/Pi Notifier.app` is a small AppleScript applet that exists only to give notifications the Claude icon, since macOS takes the icon from the posting app. Its icon is generated from `assets/claude-icon.svg`, a full-bleed 1024px canvas because macOS 26+ applies its own squircle mask; an inset tile gets double-framed. After replacing `Contents/Resources/applet.icns`, re-sign the bundle, re-register it with `lsregister -f`, and `killall usernoted Dock`, otherwise the old icon stays cached. `notify-sound.ts` hands it a payload through `~/.cache/pi-notify.txt` because `open` cannot pass argv to an applet. It needs a one-time Allow in the macOS notification prompt on a new machine; `terminal-notifier` was replaced because it exits 0 and posts nothing on macOS 26+.

`anthropic-usage.ts` publishes three status keys (`sub-usage-ok`, `-warn`, `-crit`) and sets exactly one at a time. That is not redundancy: `powerline.customItems` colors are static per item, so three keys are the only way to get a colour that follows the usage level.

`lib/usage-lifecycle.ts` intentionally duplicates `modules/pi-context/src/usage-lifecycle.ts`: the module must stay self-contained for publishing, and the local extensions must not import module internals.

## Local extensions

| File | Surface |
| --- | --- |
| `anthropic-usage.ts` | powerline usage segment plus `/usage` |
| `clear-session.ts` | `/clear` |
| `keep-awake.ts` | automatic `caffeinate` plus `/clam` for lid-closed keep-awake |
| `model-effort.ts` | model-aware `/effort`, Shift+Tab labels, and switch clamping |
| `notify-sound.ts` | desktop notification when a prompt finishes (Claude icon, Glass sound, one-line TLDR) |
| `prompt-stash.ts` | `ctrl+s` stash/restore/swap, held across `/reload` |
| `repo-memory.ts` | deterministic zero-LLM repo map injection |
| `tool-audit.ts` | tool-call audit tracker plus `/toolaudit` |
| `ui-polish.ts` | working indicator plus the stash widget |

## Model-aware reasoning effort

`models.json` defines each model's supported effort set through Pi's documented
`thinkingLevelMap`. GPT-5.6 Sol exposes `low`, `medium`, `high`, `xhigh`, `max`,
and `ultra`; Claude Fable 5 exposes the same set without `ultra`. Pi currently
has six usable internal slots after `off` is hidden, so Sol maps those slots to
the six provider effort names. Fable hides both `off` and `minimal` and maps its
remaining slots directly.

Use `/effort` to show the current value and the model's available set, or
`/effort <level>` to select one. Pi's built-in Shift+Tab action still performs
the cycle; `thinking_level_select` keeps the displayed semantic effort in sync.
When the model changes, `model-effort.ts` preserves the semantic effort where
possible and clamps it to the nearest supported value, such as `ultra` to
`max` when switching to Fable.

The mapping, Shift+Tab order, command behavior, and model-switch clamping are
covered by `tests/model-effort.test.ts`.

## Tool-call audit tracker

`tool-audit.ts` logs every tool call as one JSONL line so it is clear how
many calls happen per directory and per agent, and what each call did. Args
and start time are captured on `tool_execution_start`, then matched by
`toolCallId` on `tool_execution_end` (the end event carries no args).

Each record holds the timestamp, session id, a short agent id (first 8 chars
of the session id), a short stable call id (a hash of Pi's `toolCallId`), the
cwd, the tool name, redacted and truncated args (~2KB), the outcome
(`ok`/`error`), a truncated result or error preview (~2KB), and the duration
in ms. For per-call drill-down it also stores the full redacted args
(`argsFull`) and full result text (`resultFull`), each capped at 256KB so a
context-dumping tool cannot blow up the log; a full field is omitted when it
equals its compact counterpart. Values whose keys match
`/token|secret|password|api[_-]?key/i` are redacted before anything is
written. Old records that predate the call id parse fine and show a
`--------` placeholder in listings.

Logs live outside the repo at `~/.local/share/pi/tool-audit/YYYY-MM-DD.jsonl`
(one file per day), so they are never committed. A failed write warns once at
most and never breaks the session.

Reporting has two surfaces:

- `/toolaudit` in the TUI: summary of counts per directory and per agent,
  error counts and rate, and top tools. Other views:
  - `/toolaudit errors` recent failures with args and response previews.
  - `/toolaudit calls` one line per call, newest first (default 30): call id,
    time, agent id, tool, outcome, duration, and a truncated args summary.
  - `/toolaudit last <n>` the same listing limited to the n most recent calls.
  - `/toolaudit show <call-id>` full detail for one call: every stored field,
    the complete redacted args pretty-printed as JSON, and the complete result
    text.
  - `/toolaudit <agent-id>` that agent's calls in detail.
  Argument completion suggests `calls`, `last`, `show`, and `errors`.
- A dependency-free CLI for use outside the TUI:

  ```sh
  node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts
  node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts errors
  node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts calls
  node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts last 10
  node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts show <call-id>
  node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts <agent-id>
  ```

Core logic lives in `lib/tool-audit.ts` (record shaping, redaction,
truncation, aggregation, formatting) and is covered by `tests/tool-audit.test.ts`.

## Security defaults

- Unknown projects require an explicit trust decision.
- Repository content is task data, never a trusted system instruction.
- Delegation identity and depth are independent of report credentials.
- Machine-global lid-sleep changes happen only through an explicit `/clam` toggle, never at startup, and are restored when the last claiming session disarms or exits.
- Infrastructure memory is retrieved only when relevant.
- npm-published packages are pinned in `settings.json`; upgrades are explicit.

## Changing a module

Modules are developed in place under `modules/` and declare `@earendil-works/pi-coding-agent` as a `^0.80.3` peer, which the installed 0.80.10 satisfies. Before a change lands:

```sh
cd modules/<module> && pnpm test && pnpm typecheck && pnpm pack-check
```

A module may be added to `settings.json` only with a threat model, bounded storage and output, lifecycle cleanup, observable failures, and a test against the supported Pi version. Experimental extensions stay disabled until they pass.

## Publishing a module

Only `@isaaclins/pi-codrive` and `@isaaclins/pi-fish-bridge` are on npm today. To publish another one: bump its version per Semantic Versioning, publish through trusted publishing, verify the registry tarball and provenance, then swap its `settings.json` entry from the local path to the pinned version.

Do not edit generated Fish shims or Pi's package cache directly.
