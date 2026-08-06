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
  deferred.ts       -- DeferredTriggerRegistry: time and condition triggers on the same wake port
  tmux-backend.ts   -- CodriveBackend implementation using tmux split-window
extension.ts        -- Thin Pi adapter (registers spawn_agent, agent_report, agent_pane, agent_resume, defer)
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
  "thinking": "max",
  "fixerModel": "anthropic/claude-haiku-4-5"
}
```

Omit `model` when calling `spawn_agent` to use these defaults. Pass `model` only for an explicit override; append a thinking suffix such as `:high` when that override also needs a different thinking level. `fixerModel` is used only by the papercut repair loop below.

## Papercut self-repair

When an agent hits harness friction it personally experienced, it files a papercut with the `papercut` tool (owned by the tool-audit extension) and keeps working. The record is announced on the shared event bus as `papercut:filed`, and this module reacts to it.

The loop, per papercut:

1. **Gate.** Only `owner: "config"` notes auto-dispatch. A note whose text or suspected paths mention this module is never auto-dispatched, not even manually, because a bad fix must not be able to take out the repair mechanism. At most one repair runs at a time; the rest queue.
2. **Isolate.** `git worktree add -b papercut/<note-id> <tmp> HEAD`. Nothing ever runs in the live checkout.
3. **Fix.** A background junior agent on `fixerModel` is spawned into a detached tmux window with its cwd inside the worktree. Its entire prompt is the repro-shaped note plus hard boundaries: reproduce first, fix the root cause, run the owning module's tests and typecheck, commit on the branch, never leave the worktree, never spawn agents.
4. **Verify blind.** A second agent gets only the branch name and the original note, never the fixer's reasoning, on a detached checkout of the branch. It re-runs the repro and the module's checks and ends with `VERDICT: PASS` or `VERDICT: FAIL`. Anything that is not an explicit PASS counts as FAIL.
5. **Queue.** A pass queues a non-interrupting summary with the branch, the diffstat, and copy-pasteable merge and discard commands. A fail retries the fixer once with the verifier's rejection appended, then hands the papercut to a human with both reports.

Invariants:

- Nothing is ever merged automatically. Fixes exist only as commits on a `papercut/*` branch.
- The user's working tree is never modified and the user is never interrupted: results are delivered with `deliverAs: "nextTurn"`.
- Owners `pi`, `model`, and `env` are recorded and listed, never auto-dispatched.
- Undo is always `git worktree remove --force <path> && git branch -D papercut/<id>`.

Use `/papercuts` to list jobs, `/papercuts show <id>` for full detail including both reports, `/papercuts dispatch <id>` to force one past the owner gate, and `/papercuts cleanup` to remove worktrees for papercut branches git reports as already merged. Cleanup never touches an unmerged branch.

## Deferred triggers

`defer` lets an agent come back to something later without blocking a turn and without delegating. Before it existed, "check back in four minutes" cost either a blocked turn, a detached poller nothing ever read, or a whole `spawn_agent` (a model context, a tmux pane, and the single delegation slot) running a `sleep`. A deferred trigger costs a timer and one JSON record.

Two kinds:

- **`after`** -- `defer({ action: "create", delayMs, note })` fires once the elapsed wall clock passes. The deadline is stored as an absolute timestamp, so a restart can neither shift it nor lose it.
- **`when`** -- `defer({ action: "create", check, note })` polls a shell command every `pollMs` (default 15000, floor 1000) and fires as soon as it exits 0. If it never does, the trigger fires anyway at `timeoutMs` (default one hour, hard cap 24 hours) with a `timeout` outcome. A trigger that gives up silently is the bug this exists to remove.

Both carry a `note`, which is the text delivered back to the agent, and both survive turn end, going idle, context compaction, and a process restart. Pending triggers live in the same private per-session `RuntimeStore` state as child records, never in the conversation, which is why compaction cannot rewrite them away. On the next `session_start` they are restored: an `after` whose deadline passed while the process was down fires immediately, a `when` resumes polling, and a `when` whose deadline already passed fires its timeout. Triggers left behind by an earlier session of the same project are adopted only when the process that armed them is gone, so two live sessions never steal each other's timers.

`defer({ action: "list" })` shows what is pending; `defer({ action: "cancel", id })` drops one and reports an error when the id is unknown or already fired.

### The two delivery behaviors

| `delivery` | `pi.sendMessage` options | Use it when |
|---|---|---|
| `"interrupt"` (default) | `{ triggerTurn: true, deliverAs: "steer" }` | The result changes what you should do next: a build finished, a deploy is live, the four minutes are up. `steer` lands at the next tool call boundary of the running turn, and `triggerTurn` starts a turn when nothing is running, so a fire into an idle session is not lost. |
| `"quiet"` | `{ triggerTurn: false, deliverAs: "nextTurn" }` | The result is background bookkeeping the user should not be interrupted for. It never triggers anything and surfaces at the next natural turn. Same split the supervisor uses for a background child's report. |

`"interrupt"` is the default because a trigger the agent armed is by definition work it intends to return to, and a quiet trigger firing into an idle session waits until the user happens to type again.

Honest limitation: Pi has no supported seam to preempt a turn while a tool is still executing. `deliverAs: "steer"` is delivered after the running assistant turn finishes its current tool calls and before the next LLM call. So `"interrupt"` means the next tool call boundary, which is the earliest point Pi supports, not an immediate stop. A trigger that fires one second into a ten minute `bash` call is delivered when that call returns.

## Tools exposed

| Tool | Description |
|------|-------------|
| `spawn_agent` | Spawn a subagent in a shared tmux pane. Reports arrive automatically via IPC; a transient error no longer looks like completion. |
| `agent_report` | Read lifecycle history for a pane, including interruptions and farewells (recovery/history API). Historical pane ids still resolve after a resume. |
| `agent_pane` | Read output from or send text to a live subagent pane. After a resume the current pane is used even if you pass an old pane id. |
| `agent_resume` | Relaunch a dead or stuck subagent into a fresh pane, resuming its own recorded pi session with the same childId. Refuses a live healthy child unless `force`. |
| `defer` | Arm, list, and cancel deferred triggers: fire after a delay, or as soon as a shell condition holds, with a guaranteed timeout outcome. No model context, no pane, no delegation slot. |

Commands: `/papercuts` (see above).

Spawns can also be requested with `cwd` (run the child in a worktree instead of the project root) and `background` (a detached tmux window instead of a split of the user's view, with completion queued rather than interrupting). The papercut loop uses both; `spawn_agent` itself stays foreground.

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
