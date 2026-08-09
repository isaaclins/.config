# @isaaclins/pi-beeper

Native Pi tools for the local Beeper Desktop Client API. Beeper Desktop must be
running on `127.0.0.1:23373`.

This module is experimental and disabled by default. It is not listed in the
repository Pi settings until its lifecycle, black-box, and upgrade checks have
passed.

## Setup

1. Start Beeper Desktop.
2. Load the module in an interactive Pi session.
3. Run `/beeper-setup`.
4. Open the displayed OAuth URL if it did not open automatically, and manually
   click Beeper's consent button. Pi catches the loopback callback, exchanges
   the PKCE code, stores the access token in macOS Keychain, and reloads.
5. Run `/beeper-status`, then call `beeper_list_accounts` before sending.

The token is read once at extension initialization from macOS Keychain. It is
never written inside this repository, never accepted from an environment
variable, and never returned by a tool. The model has the user's shell, so this
storage choice protects against accidental commits and transcript leakage, not
against the model itself. The extension does not enable Beeper `remote_access`
and does not connect to `/v1/ws`.

## Tools

Read tools:

- `beeper_list_accounts`
- `beeper_list_chats`
- `beeper_search_chats`
- `beeper_resolve_chat`
- `beeper_read_conversation`
- `beeper_search_messages`

Write tools:

- `beeper_send_message`
- `beeper_react`

Read results are JSON only. Message text is framed with a random per-call
nonce, normalized, secret-redacted by default, capped at 2,000 characters per
message, and capped at 50 KB or 2,000 lines per call. Pass `--beeper-no-redaction` only
when the user explicitly accepts unredacted message content. Reads never mark
chats as read. Write tools require a separate human confirmation dialog, an earlier
same-session chat resolution, an append-only audit record outside the repo, a
five-second rate limit, and a session budget of twelve writes across five
chats. `/beeper-kill-switch` disables writes immediately. Spawned Pi subagents
do not receive write tools.

A send result means Beeper accepted a pending message id for delivery. It does
not mean that the network delivered the message.

## Disclosure

"Read every chat" means the user's full cross-network history, including other
people's Signal and iMessage content, is shipped to a model provider and
written to local session transcripts. This is certain, silent, cumulative, and
irreversible, and the counterparties never consented. Page small and pull on
demand. Do not sweep large histories into context because the API allows it.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm pack-check
pnpm upgrade-check
```

Do not run a live send during development. Nominate one target chat and review
its displayed confirmation before the single end-to-end send test.
