# @isaaclins/pi-context

Session context lifecycle for the Pi coding-agent harness.

## Ownership

This package owns:

- **Compaction/resume** (handover flow): nudge-at-threshold, agent-authored handover summary, exactly-once compaction trigger, and auto-resume after compaction.
- **Usage visualization** (`/context` command): token estimation, category breakdown, grid rendering, compact LLM-visible summary.
- **Interrupt-and-submit** (`ctrl+enter`): abort active generation, capture editor text, wait for idle, send. An empty editor is a plain silent interrupt.
- **Usage polling lifecycle**: generic interval-based session poller with cleanup.
- **Tool capability modes**: lazy tool-family activation and strict `/readonly` session control.

## Guarantees

1. **Configurable nudge threshold** -- the percentage at which the first nudge fires and the repeat step are both configurable, not hardcoded. Defaults: 45% threshold, 10% step.
2. **Actionable diagnostics** -- lifecycle failures (compaction errors, idle timeouts) are surfaced with specific error messages via `ctx.ui.notify`, never swallowed by broad catch blocks.
3. **Exactly-once compaction/resume** -- a `compactRequested` guard prevents double-trigger when multiple `turn_end` events fire before compaction completes.
4. **UI-only status rendering** -- the viz/status code reads and displays session state but never mutates durable session state.
5. **Session isolation** -- all mutable state is scoped to the extension instance (one per session). No module-level mutable globals are shared across concurrent sessions.
6. **Fail-closed read-only mode** -- `/readonly` keeps only `read`, `grep`, `find`, and `ls`, persists on the active branch, reasserts the restriction before every turn, and blocks stale calls to any other tool.

## Read-only mode

Use `/readonly`, `/readonly toggle`, `/readonly on`, or `/readonly off`. `/readonly status` reports the current state. While enabled, the footer shows `readonly`, lazy tool families cannot activate, and the model receives an explicit read-only instruction.

The mode removes the coding agent's mutation-capable tools. It is not an operating-system sandbox: extensions and user-entered `!` commands still run with the host user's permissions.

The extension also registers `--readonly` for starting a session in this mode.

## Installation

```bash
npm install @isaaclins/pi-context
```

Add to your Pi config's extensions list:

```json
{
  "pi": {
    "extensions": ["./node_modules/@isaaclins/pi-context/extensions/index.ts"]
  }
}
```

## Development

```bash
npm test          # run tests
npm run typecheck # type-check without emit
npm run pack-check # dry-run pack to verify files list
```

## License

MIT
