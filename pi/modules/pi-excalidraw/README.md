# @isaaclins/pi-excalidraw

Home Excalidraw board tools for Pi. Ports the diagram surface Disclaw uses on the homeserver
into native Pi tools, so Pi can answer "explain this visually" with a real, live, shareable
board instead of ASCII art.

## What it talks to

`compose/excalidraw-agent` on the homeserver (systemd user unit `excalidraw-agent.service`)
bridges an agent to the real Excalidraw editor at `home.isaaclins.com/excalidraw/app` and
registers boards in the library at `/excalidraw/`.

Disclaw reaches it by spawning `compose/excalidraw-agent/src/mcp.js` over stdio, because it
runs on the same host and the bridge only listens on `127.0.0.1:8571` (Caddy exposes the
preview/edit/board routes, never `/api/*`). Pi runs on the laptop, so this package makes the
same HTTP calls through SSH:

```
pi tool -> ssh isaaclins@homeserver -> curl http://127.0.0.1:8571/api/... -> excalidraw-agent
```

SSH connection multiplexing (`ControlMaster` + `ControlPersist=300`) keeps repeat calls at
roughly 100ms. No tunnel daemon, no extra exposed port, same security model as Disclaw.

## Tools

- `excalidraw_create_board` (mirrors `create_excalidraw_room`)
- `excalidraw_attach_board` (mirrors `attach_excalidraw_room`)
- `excalidraw_add_elements` (mirrors `batch_create_elements`)
- `excalidraw_describe_board` (mirrors `describe_scene`)
- `excalidraw_clear_board` (mirrors `clear_canvas`)
- `excalidraw_board_url` (mirrors `export_home_share_url`)
- `excalidraw_list_boards` (bridge room listing, no MCP equivalent)

The active board is remembered per session, so follow-up calls can omit `room`.

## Skill

`skills/home-excalidraw/SKILL.md` carries the drawing guidance: element format, arrow
binding, layout grid, colour semantics, and the rule that only `home.isaaclins.com`
excalidraw links may be shared.

## Configuration

| Env var | Default |
|---|---|
| `PI_EXCALIDRAW_SSH_TARGET` | `isaaclins@homeserver` |
| `PI_EXCALIDRAW_AGENT_URL` | `http://127.0.0.1:8571` |
| `PI_EXCALIDRAW_DEFAULT_OWNER` | `isaaclins` |
| `PI_EXCALIDRAW_AGENT_NAME` | `pi` |
| `PI_EXCALIDRAW_AGENT_LABEL` | `Pi` |
| `PI_EXCALIDRAW_TIMEOUT_MS` | `45000` |
| `PI_EXCALIDRAW_SSH_CONTROL_PATH` | `$XDG_RUNTIME_DIR|/tmp/pi-excalidraw-%r@%h:%p` |

Boards default to owner `isaaclins` with a "made by pi" badge so they show up in his board
library immediately. Set `PI_EXCALIDRAW_DEFAULT_OWNER=""` to file them under the shared
`agent:pi` group instead, which is what Disclaw does by default.

## Install

Already registered in `~/.config/pi/settings.json` as
`~/.config/pi/modules/pi-excalidraw`.

```sh
npm run typecheck
```
