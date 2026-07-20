# Pi configuration

This directory is the personal deployment of Pi. Reusable behavior is developed and released from [`isaaclins/pi-terminal-kit`](https://github.com/isaaclins/pi-terminal-kit); this directory contains pinned package selections, personal settings, and intentionally local extensions.

## Ownership

| Responsibility | Owner | Deployment |
| --- | --- | --- |
| Visible tmux child sessions, identity, depth, reports, accounting | `@isaaclins/pi-codrive` | Pi package |
| Structured global/project memory and Aside retrieval | `@isaaclins/pi-memory` | Pi package |
| Context usage, handover, and compaction lifecycle | `@isaaclins/pi-context` | Pi package |
| Fish command bridge | `@isaaclins/pi-fish-bridge` | Pi package |
| Arcoiris theme | `@isaaclins/pi-arcoiris-refined` | Pi package |
| Personal notifications, usage display, prompt shortcuts, and macOS session behavior | files under `extensions/` | Local only |

One responsibility has one owner. A local extension must not register a competing tool, command, lifecycle hook, store, or state machine for a packaged responsibility.

## Security defaults

- Unknown projects require an explicit trust decision.
- Repository content is task data, never a trusted system instruction.
- Delegation identity and depth are independent of report credentials.
- Machine-global lid-sleep changes require `PI_ALLOW_GLOBAL_DISABLESLEEP=1`.
- Aside and infrastructure memory are retrieved only when relevant.
- Published packages are pinned in `settings.json`; upgrades are explicit.

## Promotion gate

A reusable module may enter `settings.json` only after all of the following pass in `~/Projects/pi-terminal-kit`:

```sh
pnpm format:check
pnpm typecheck
pnpm test
pnpm pack:check
```

The package must also have a threat model, migration notes, bounded storage and output, lifecycle cleanup, observable failures, and a black-box compatibility test against the supported Pi version. Experimental extensions remain disabled.

## Upgrade procedure

1. Update and test the package in `~/Projects/pi-terminal-kit`.
2. Bump its version according to Semantic Versioning.
3. Push and wait for the macOS/Linux CI matrix.
4. Publish through the repository's trusted-publishing workflow.
5. Verify the registry tarball and provenance.
6. Update the exact package version in `settings.json`.
7. Remove the replaced local extension and run `bash bootstrap/doctor.sh` plus a real Pi smoke session.

Do not edit generated Fish shims or Pi's package cache directly.
