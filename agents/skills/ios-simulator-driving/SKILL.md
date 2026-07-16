---
name: ios-simulator-driving
description: Drive and verify iOS apps hands-free on this Mac (headless simulator, no Simulator.app UI, no idb). Use when an iOS app must be launched, interacted with, screenshotted, or functionally tested by the agent, e.g. verifying an app phase, reproducing a UI bug, or testing chat/persistence flows in the ODA app.
---

# Driving iOS apps without a visible Simulator

## Environment constraints (this Mac, user taaliis4)
- Xcode beta at /Applications/Xcode-beta.app has NO Simulator.app UI: simulators run headless only.
- Homebrew is owned by another account (isaaclins): `brew install` fails for taaliis4. No idb. User-local tools go in ~/.local/bin (xcodegen lives there).
- "Designed for iPad" builds produce an iOS binary that `open` refuses on macOS ("incorrect executable format"). Do not bother.
- Simulator builds on this Apple Silicon Mac need `ARCHS=arm64` or SwiftPM binary frameworks fail to resolve (x86_64 slice mismatch).

## Passive observation (state, screenshots)
```sh
xcrun simctl list devices available            # find a device, e.g. "iPhone 17 Pro"
xcrun simctl boot "iPhone 17 Pro"              # idempotent; headless
xcrun simctl install "iPhone 17 Pro" path/to/App.app
xcrun simctl launch "iPhone 17 Pro" com.bundle.id
xcrun simctl launch --console-pty "iPhone 17 Pro" com.bundle.id   # stdout/crash logs (dyld errors show here)
xcrun simctl io "iPhone 17 Pro" screenshot /tmp/shot.png          # then Read the png
xcrun simctl terminate / uninstall / erase ...
```
There is NO simctl tap/type. For interaction use XCUITest.

## Active interaction: XCUITest as the computer-use layer
Add a `bundle.ui-testing` target and drive the app with tests run via `xcodebuild test`. Works fully headless, is repeatable, and doubles as a regression suite.

XcodeGen target (project.yml):
```yaml
  AppUITests:
    type: bundle.ui-testing
    platform: iOS
    sources: [AppUITests]
    dependencies: [{ target: App }]
    settings:
      base:
        TEST_TARGET_NAME: App
        PRODUCT_NAME: AppUITests            # REQUIRED: without it the product name is empty and the build fails with "Multiple commands produce -Runner.app"
        PRODUCT_BUNDLE_IDENTIFIER: com.x.app.uitests
        GENERATE_INFOPLIST_FILE: true       # REQUIRED for signing
```
Also add the target to the app scheme's `testTargets`.

Run:
```sh
xcodebuild -project App.xcodeproj -scheme App \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath build/sim ARCHS=arm64 test
```
Filter one test: `-only-testing:AppUITests/ClassName/testName`.

Gotchas learned the hard way:
- Apps restore navigation state; never assume launch lands on the root screen. Write a navigation helper that checks where it is and backs out first.
- `app.terminate()` kills without SwiftData autosave flushing; a missing explicit `modelContext.save()` shows up as a persistence test failure (and is a real app bug, not a test bug).
- LLM streaming replies: assert with `waitForExistence(timeout: 120)` on a predicate match, and prompt the model with "Say exactly: MARKER" so the assertion is deterministic.

## ODA project specifics
- `make test` runs the suite; `make mac` builds+installs+launches in the sim; `make iphone` targets the connected device.
- Never edit ODA.xcodeproj (generated); change project.yml + `xcodegen generate`.
