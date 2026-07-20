Windows root-forest bridge and live UIA grounding release.

## Features

- Added a Windows bridge MVP and wired it into the platform-neutral root-forest backend seam.
- Implemented the Windows helper root-forest protocol with live UIA grounding, scoped deltas, and faster UIA reference lookup.
- Restored Windows backend wiring and strip-types compatibility for platform checks.
- Updated documentation to include Windows support and live UIA acceptance notes.

## Changelog

- refactored the platform seam to simplify platform-neutral contracts and preserve freeform delta sources in `ec6395c`.
- fixed CI invariants and bounded the macOS semantic tree walk with a 20s deadline in `ebfc888` and `4cf8b41`.
- renamed the public tools to `find_roots`, `observe_ui`, and `act_ui` in `41b6f5b`.
- chore allowed docs and perf commit types in release commit validation in `c563352`.
- added the Windows bridge MVP, root-forest backend seam wiring, helper protocol, and live UIA grounding in `8f429f3`, `96664eb`, `c903522`, and `c04bb4f`.
- documented Windows bridge acceptance and live UIA acceptance in `b34f987` and `8e8ed9b`.
- fixed Windows occlusion preflight, delta scoping, seam annotations, win32 backend wiring, and strip-types compatibility in `d8d7b41`, `174ad69`, `495b4be`, `0c9ec73`, and `84743d5`.
- scoped Rust target ignores to the bridge-rs tree and included Windows in the README in `8877f00` and `3984f04`.
- chore prepared the v0.4.2 release, added Windows helper build/injection to the release pipeline, and constrained npm package contents to exclude Rust build artifacts.

> "Don't Panic."
