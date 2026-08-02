# @isaaclins/pi-codrive

Restart-tolerant tmux delegation module for the [Pi](https://github.com/anthropics/pi) coding-agent harness.

## What it does

Provides a secure, crash-resilient way for an orchestrator Pi session to spawn and manage subagent Pi sessions in tmux panes. Key properties:

- **Authenticated IPC transport** -- child agents report over a Unix socket using a length-prefixed frame protocol with a timing-safe nonce check. A wrong nonce is rejected before any state mutation occurs.
- **Typed lifecycle envelopes** -- the wire protocol carries a `kind` discriminator: `announce` (verified pane/session binding at startup), `heartbeat` (throttled progress), `interrupt` (a non-terminal error end), `report` (terminal completion), and `farewell` (graceful shutdown). Only terminal reports are persisted; the rest update in-memory and ledger state. An envelope with no `kind` is still accepted as a terminal report (protocol v1).
- **Interruption vs completion** -- an agent loop ending with a provider or stream error (`stopReason` "error") is treated as an interruption, not a completion. The child sends a non-terminal `interrupt` (with any HTTP evidence such as a 429 or 5xx), keeps its pane tracked, and only escalates if it never recovers. The orchestrator is woken exactly once per episode, on real completion or on a genuine failure that needs recovery.
- **Session-scoped resume** -- every fresh child is launched with a pre-assigned pi session id (`--session-id <uuid>`), recorded in its `ChildRecord`. A dead or stuck child is relaunched deterministically and non-interactively with the same id, so the orchestrator's own session can never be resumed by accident.
- **One-level delegation limit** -- an orchestrator (depth 0) can spawn children (depth 1), but children cannot spawn further agents. This is enforced structurally via `assertCanDelegate`.
- **Restart tolerance** -- `RuntimeStore` persists versioned session state, child records, and reports to disk, migrating older records forward. If the parent process crashes and restarts, it can reload all prior state including late-arriving reports from children that outlived the crash.
- **HarnessSession identity model** -- session identity is derived exclusively from `createHarnessSession` using `realpathSync` on the project root and an explicit role/depth/trust declaration. It never relies on `$PPID`, directory basenames, or environment credential markers that could be spoofed by a nested process.

## Architecture

```
src/
  session.ts        -- HarnessSession creation and delegation-depth guard
  controller.ts     -- CodriveController orchestrates spawn/resume via a CodriveBackend
  runtime-store.ts  -- Disk-persisted, versioned state (sessions, children, reports)
  report-transport.ts -- ReportServer (Unix socket listener), sendReport/sendEnvelope (client)
  report-builder.ts -- classifyAgentEnd and interrupt-evidence classification
  child-reporter.ts -- Child-side episode logic (fast-path report vs interrupt + settle window)
  supervisor.ts     -- DelegationSupervisor: parent-side per-child lifecycle state machine
  pane-health.ts    -- Background pane liveness watchdog
  tmux-backend.ts   -- CodriveBackend implementation using tmux split-window
extension.ts        -- Thin Pi adapter (registers spawn_agent, agent_report, agent_pane, agent_resume)
```

The parent-side lifecycle policy lives entirely in `DelegationSupervisor`, and
the child-side episode policy in `ChildReporter`; `extension.ts` only forwards
Pi events and IPC envelopes between them, and registers every listener
synchronously at top level so a child's first `agent_end` can never race an
async `session_start`.

## Installation

```bash
npm install @isaaclins/pi-codrive
```

Then in your Pi configuration, add the package so its extension is loaded:

```json
{
  "pi": {
    "packages": ["@isaaclins/pi-codrive"]
  }
}
```

## Delegation defaults

`spawn_agent` reads model and thinking defaults from `$XDG_CONFIG_HOME/pi-codrive/config.json` (normally `~/.config/pi-codrive/config.json`):

```json
{
  "model": "openai-codex/gpt-5.6-luna",
  "thinking": "max"
}
```

Omit `model` when calling `spawn_agent` to use these defaults. Pass `model` only for an explicit override; append a thinking suffix such as `:high` when that override also needs a different thinking level.

## Tools exposed

| Tool | Description |
|------|-------------|
| `spawn_agent` | Spawn a subagent in a shared tmux pane. Reports arrive automatically via IPC; a transient error no longer looks like completion. |
| `agent_report` | Read lifecycle history for a pane, including interruptions and farewells (recovery/history API). Historical pane ids still resolve after a resume. |
| `agent_pane` | Read output from or send text to a live subagent pane. After a resume the current pane is used even if you pass an old pane id. |
| `agent_resume` | Relaunch a dead or stuck subagent into a fresh pane, resuming its own recorded pi session with the same childId. Refuses a live healthy child unless `force`. |

## Upstream seam note

Pi's extension event union has no retry event: `AgentEndEvent` is `{ type, messages }` only, and the `auto_retry_start`/`auto_retry_end` signals that exist on the internal `AgentSessionEvent` and in the RPC/JSON stream are not exposed to extensions. An extension therefore cannot know whether pi is about to auto-retry and must infer terminality behaviorally (the settle window) with `after_provider_response` HTTP status as corroborating evidence. This is a mitigation, not a replacement: provider headers are provider dependent.

## Security considerations

- Socket paths are created in `0700` directories; socket files are `0600`.
- Nonces are 32 bytes of `base64url`-encoded randomness, compared with `timingSafeEqual`.
- Child IPC credentials (`PI_CODRIVE_SOCKET`, `PI_CODRIVE_NONCE`, and the session/child identity) are scrubbed from the environment after capture so nested processes cannot inherit them or forge reports. On resume, fresh IPC credentials from the live report server are re-injected into the new pane.
- Per-platform Unix socket path length limits (103 on macOS, 107 on Linux) are respected with an automatic `/tmp` fallback.

## Development

```bash
npm install
npm test
npm run typecheck
npm run pack-check
```

## License

MIT
