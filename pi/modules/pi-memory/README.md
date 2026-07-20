# @isaaclins/pi-memory

Governed, structured local memory for the Pi coding-agent harness.

## What it does

Provides a `MemoryAuthority` that manages durable memory records in JSONL files with:

- Atomic writes (fsync + rename)
- File permissions locked to 0600
- System-prompt injection with untrusted-data framing
- Conflict resolution (project scope wins over global)
- Record expiration and retirement

The Pi extension (`extensions/index.ts`) wires this into the agent lifecycle: injecting active memory on session start, exposing the notes UX (`remember` tool, `/remember`, `/memory`, `/forget`), and exposing the keyed `pi_memory_upsert` / `pi_memory_retire` tools.

## Notes UX

Notes are an append-only journal built on `MemoryAuthority.appendNote`, which assigns a fresh unique key per call so repeated notes never overwrite each other (unlike `upsert`, which is a keyed overwrite store).

- `remember` tool: params `note` (required) and `scope` (`project` default, or `global`). Global notes are stored as kind `preference`, project notes as kind `fact`, matching injection eligibility.
- `/remember [-g|--global] <note>`: same behavior as a slash command.
- `/memory`: lists every active (non-retired) note across both scopes with stable display indices (`g1`, `g2`, ... for global; `p1`, `p2`, ... for project), formatted `{index}: [{date}] {value}`. Indices are recomputed each time from current sorted-by-`createdAt` order. Empty scopes show `(none)`.
- `/forget <g2|p3>` or `/forget <text>`: retires the matching active record (never physically deletes). A free-text search that matches more than one active record retires nothing and lists the candidates instead.

### Staleness annotation

Records older than `staleDays` (default 90) get ` (old, verify before trusting)` appended in the injected system-prompt copy only. Stored values on disk are never mutated by this aging check.

### Session-end nudge

After a long session (10+ turns or 15+ minutes) in which the `remember` tool was never used, a single reminder is shown on `agent_end`: `Anything worth remembering? /remember [-g] <note>`. It fires at most once per session and costs zero LLM calls.

## Migrating legacy dated-journal notes

`scripts/migrate-legacy-notes.mjs` is a one-time, manually invoked tool (never run by the extension or any import side effect). It imports legacy `- [YYYY-MM-DD] text` lines into a governed store, preserving each note's original date as `createdAt` (midnight UTC) and stripping the dated prefix from the value:

```bash
node scripts/migrate-legacy-notes.mjs <legacy-file> \
  --scope=<global|project> --kind=<preference|fact> --store=<jsonl-path>
```

## Memory contract

### Kinds

| Kind | Description |
|------|-------------|
| `preference` | Stable user preferences (injected from global scope) |
| `fact` | Verified facts about a repo or environment (injected from project scope) |
| `runbook` | Operational procedures (stored but not auto-injected; retrieval-only) |

### Scopes

| Scope | Store path | Injection rule |
|-------|-----------|----------------|
| `global` | `~/.pi/agent/memory/global.jsonl` | Only `preference` kind records |
| `project` | `<project-root>/.pi/memory.jsonl` | Only `fact` kind records |

### Precedence

When the same key exists in both global and project scope, the project-scope record wins and the global record is shadowed (reported in `conflicts`).

### Retirement

`retire(scope, key)` marks a record's status as `"retired"`. Retired records:
- Are excluded from `buildInjection()` output
- Are NOT deleted from disk (append-only history is preserved)
- Can be found by reading the JSONL file directly

### Size cap

The `maxRecordChars` option enforces a hard limit on `value.length` at upsert time. The extension defaults to 2000 characters.

## Hard policy: no automatic Aside injection

This module never reads, references, or injects content from the Aside memory system (`~/.aside/`), `USER.md`, `MEMORY.md`, or episodic briefings. That content is retrieval-only per harness policy and belongs to the separate `aside-memory` extension. A regression test enforces this guarantee.

## Installation

Add this package to your Pi configuration:

```json
{
  "pi": {
    "extensions": ["./extensions/index.ts"]
  }
}
```

The project-local store file (`.pi/memory.jsonl`) should typically be added to `.gitignore` since it contains governed local memory, not repo-committed configuration.

## Development

```bash
npm install
npm test          # node:test runner
npm run typecheck # tsc --noEmit
npm run pack-check
```

## License

MIT
