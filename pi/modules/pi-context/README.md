# @isaaclins/pi-context

Session context lifecycle for the Pi coding-agent harness.

## Ownership

This package owns:

- **Compaction/resume** (handover flow): nudge-at-threshold, agent-authored handover summary, exactly-once compaction trigger, and auto-resume after compaction.
- **Usage visualization** (`/context` command): token estimation, category breakdown, grid rendering, compact LLM-visible summary.
- **Interrupt-and-submit** (`ctrl+enter`): abort active generation, capture editor text, wait for idle, send.
- **Usage polling lifecycle**: generic interval-based session poller with cleanup.

## Guarantees

1. **Configurable nudge threshold** -- the percentage at which the first nudge fires and the repeat step are both configurable, not hardcoded. Defaults: 45% threshold, 10% step.
2. **Actionable diagnostics** -- lifecycle failures (compaction errors, idle timeouts) are surfaced with specific error messages via `ctx.ui.notify`, never swallowed by broad catch blocks.
3. **Exactly-once compaction/resume** -- a `compactRequested` guard prevents double-trigger when multiple `turn_end` events fire before compaction completes.
4. **UI-only status rendering** -- the viz/status code reads and displays session state but never mutates durable session state.
5. **Session isolation** -- all mutable state is scoped to the extension instance (one per session). No module-level mutable globals are shared across concurrent sessions.

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
