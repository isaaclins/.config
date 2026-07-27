---
name: home-excalidraw
description: Explain something visually by drawing it on the home.isaaclins.com Excalidraw board bridge. Use when an architecture, pipeline, flow, state machine, timeline, or relationship between ideas would be clearer as a diagram, when the user says "explain visually", "draw this", "make me a diagram/board", or when they send a home Excalidraw preview/edit/board link and want it read or extended.
---

# Home Excalidraw boards

Draw on the real collaborative editor at `home.isaaclins.com/excalidraw/app` through the
agent bridge. Boards land in the board library at `/excalidraw/` and are live: the user can
open the link and keep editing.

## Tools

| Tool | Use |
|---|---|
| `excalidraw_create_board` | Start a board; becomes the active board |
| `excalidraw_attach_board` | Take over an existing home board from a link |
| `excalidraw_add_elements` | Append (default) or replace elements |
| `excalidraw_describe_board` | Read the scene back before refining |
| `excalidraw_clear_board` | Wipe the scene, keep the links |
| `excalidraw_board_url` | Get preview + edit URLs |
| `excalidraw_list_boards` | See what the bridge already holds |

## Workflow

1. `excalidraw_create_board` with a real title (or `excalidraw_attach_board` for a link the user sent).
2. `excalidraw_add_elements` with shapes first, then arrows referencing those shape ids.
3. `excalidraw_describe_board` to verify overlap, spacing, and that arrows bound correctly.
4. Share the `publicReadOnlyUrl` in the reply, one line, with a sentence of what it shows.

Draw the diagram in one or two batched calls, not one call per shape.

## Element format

The bridge fills in Excalidraw internals (`seed`, `versionNonce`, `roundness`, bindings), so
send only meaning:

```json
[
  { "id": "api",   "type": "rectangle", "x": 0,   "y": 0,   "text": "API",       "backgroundColor": "#e7f0ff" },
  { "id": "db",    "type": "rectangle", "x": 320, "y": 0,   "text": "Postgres",  "backgroundColor": "#e6f5ea" },
  { "id": "cache", "type": "ellipse",   "x": 320, "y": 140, "text": "Redis" },
  { "type": "arrow", "start": { "id": "api" }, "end": { "id": "db" }, "text": "query" },
  { "type": "text", "x": 0, "y": -60, "text": "Request path", "fontSize": 28 }
]
```

- Give every shape an `id` you choose; arrows bind by `start.id` / `end.id` and stay attached when shapes move.
- `text` on a shape becomes a centered bound label; `text` on an arrow becomes an edge label.
- `orthogonal: true` on an arrow gives 90-degree flowchart routing.
- Free-form arrows: `{ "type": "arrow", "x": 0, "y": 0, "points": [[0,0],[160,0]] }`.
- Shapes auto-size to their label if you omit `width`/`height`.

## Layout rules

- Grid it: columns 380px apart, rows 180px apart, boxes ~220px wide. Never let shapes overlap.
- Arrow labels are centered on the arrow and are wider than the gap between boxes: keep them
  under 20 characters, or widen the column pitch to 460 for that row. Check with
  `excalidraw_describe_board`: a label's `x` plus `width` must stay clear of the next box's `x`.
- Flow left-to-right for pipelines, top-to-bottom for hierarchies and decisions.
- 5 to 12 boxes per board. More than that, split into groups with a heading text element per group.
- Headings: `type: "text"` at `fontSize` 28 to 36, sitting above their cluster.
- Color with meaning, muted fills: blue `#e7f0ff` for services, green `#e6f5ea` for data stores,
  amber `#fff4e0` for external systems, red `#ffe6e6` for failure paths, `transparent` for grouping frames.
- Label every arrow that is not obvious. An unlabelled arrow means "then".

## Link rules

Only these links may be shared:

- `https://home.isaaclins.com/excalidraw-preview/...` public read-only preview
- `https://home.isaaclins.com/excalidraw-edit/...` logged-in editing
- `https://home.isaaclins.com/excalidraw/boards/...` saved board library

Never produce `excalidraw.com/#json` links or any other external canvas link. `/excalidraw` is
the canonical library; `/excalidraw/app` is the underlying editor shell.

## Ownership

Boards default to owner `isaaclins`, badged as made by Pi, so they appear in his library
immediately. Building a board for someone else: pass their SSO username as `forUser`
(e.g. `handro`). If unsure which account is meant, ask instead of guessing.

## Transport

Tools call the bridge on the homeserver over SSH (`isaaclins@homeserver`, agent on
`127.0.0.1:8571`, not exposed publicly). If calls fail:

- "not answering on 127.0.0.1:8571" -> `systemctl --user status excalidraw-agent` on the homeserver.
- SSH errors -> check Tailscale connectivity to `homeserver`.

Overrides: `PI_EXCALIDRAW_SSH_TARGET`, `PI_EXCALIDRAW_AGENT_URL`, `PI_EXCALIDRAW_DEFAULT_OWNER`,
`PI_EXCALIDRAW_AGENT_NAME`, `PI_EXCALIDRAW_TIMEOUT_MS`.
