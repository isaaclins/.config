# pi-tmux-image-preview

Local Pi extension that renders image results from any tool inside tmux when the outer terminal is Ghostty or Kitty. This covers the built-in `read` tool as well as computer-use UI tools (for example `observe_ui`, `act_ui`, `inspect_ui`, `navigate_browser`) whose results attach image blocks, so you can see what the agent sees.

## How it works

Pi intentionally disables its normal image renderer under tmux. This module leaves the underlying tools unchanged and adds a TUI-only preview entry after any successful tool result that carries an image:

1. Capture the first image block from `tool_result` for any tool (skipping error results).
2. Convert supported non-PNG images with Pi's public `convertToPng()` API.
3. Downscale images larger than 1600px with macOS `sips` to keep tmux rendering reliable.
4. Append a TUI-only entry after the matching `message_end`, so no duplicate message enters model context.
5. Upload the PNG through tmux DCS passthrough and place it with Kitty Unicode placeholders, which keeps the image inside its pane.

Pending and rendered previews are bounded to 16. The module deletes its transmitted Kitty image IDs and clears all state on `session_shutdown`.

## Requirements

```tmux
set -g allow-passthrough on
set -ga update-environment TERM
set -ga update-environment TERM_PROGRAM
```

Restart the tmux server after changing those options. The current outer terminal must be Ghostty or Kitty. Native, non-tmux Pi sessions continue to use Pi's built-in renderer.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm pack-check
```

The module is checked against Pi and pi-tui 0.80.6. Large-preview downscaling currently uses the macOS-only `sips` command because these dotfiles target macOS. If conversion or resizing fails, Pi keeps the normal read result and shows a one-time warning instead of emitting a blank preview.

## License

MIT
