# @isaaclins/pi-codrive

Restart-tolerant tmux delegation module for the [Pi](https://github.com/anthropics/pi) coding-agent harness.

## What it does

Provides a secure, crash-resilient way for an orchestrator Pi session to spawn and manage subagent Pi sessions in tmux panes. Key properties:

- **Authenticated IPC transport** -- child agents report completion over a Unix socket using a length-prefixed frame protocol with a timing-safe nonce check. A wrong nonce is rejected before any state mutation occurs.
- **One-level delegation limit** -- an orchestrator (depth 0) can spawn children (depth 1), but children cannot spawn further agents. This is enforced structurally via `assertCanDelegate`.
- **Restart tolerance** -- `RuntimeStore` persists session state, child records, and reports to disk. If the parent process crashes and restarts, it can reload all prior state including late-arriving reports from children that outlived the crash.
- **HarnessSession identity model** -- session identity is derived exclusively from `createHarnessSession` using `realpathSync` on the project root and an explicit role/depth/trust declaration. It never relies on `$PPID`, directory basenames, or environment credential markers that could be spoofed by a nested process.

## Architecture

```
src/
  session.ts        -- HarnessSession creation and delegation-depth guard
  controller.ts     -- CodriveController orchestrates spawn via a CodriveBackend
  runtime-store.ts  -- Disk-persisted state (sessions, children, reports)
  report-transport.ts -- ReportServer (Unix socket listener) and sendReport (client)
  tmux-backend.ts   -- CodriveBackend implementation using tmux split-window
extension.ts        -- Pi extension entry point (registers spawn_agent, agent_report, agent_pane)
```

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

## Tools exposed

| Tool | Description |
|------|-------------|
| `spawn_agent` | Spawn a subagent in a shared tmux pane. Reports arrive automatically via IPC. |
| `agent_report` | Read report history for a pane (recovery/history API). |
| `agent_pane` | Read output from or send text to a live subagent pane. |

## Security considerations

- Socket paths are created in `0700` directories; socket files are `0600`.
- Nonces are 32 bytes of `base64url`-encoded randomness, compared with `timingSafeEqual`.
- Child IPC credentials (`PI_CODRIVE_SOCKET`, `PI_CODRIVE_NONCE`) should be scrubbed from the environment after capture so nested processes cannot inherit them.
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
