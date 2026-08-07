---
name: what-would-apple-do
description: Review or design an Apple-platform UI (iOS, iPadOS, macOS, watchOS) by asking what a first-party Apple app would do instead. Use when an interface "looks custom", "doesn't feel native", or when deciding how to show state, status, progress, or navigation on Apple platforms. For general visual polish use make-interfaces-feel-better; for macOS chrome specifics use macos-native-design.
---

# What would Apple do

A method for turning "this looks off" into a specific, defensible change on Apple platforms.

Most non-native Apple UI is not ugly. It is borrowed: idioms from status pages, dashboards, terminals, and Android drawers, dropped into an iOS app where they read as foreign. This skill finds the borrowed idiom and names the first-party replacement.

## The one test that keeps this honest

**Name the Apple app that does it.**

If you cannot name a shipping first-party app with the same problem and point at how it solves it, you are inventing and calling it Apple. Say so out loud rather than dressing taste up as a guideline.

Good: "Mail marks unread with a single blue dot and no word." Bad: "Apple would use a cleaner indicator."

Check the version too. The HIG moves, and iOS 26's Liquid Glass changed how chrome, materials and floating elements work. A pattern that was right in iOS 16 can be stale now.

## Status and state

This is where borrowed idioms cluster hardest.

**Do not label the resting state.** Apple decorates the exception, never the default. Mail does not mark a read message "read". If every row carries a state label, the rows that matter no longer stand out, which is the opposite of what the labels were for.

**Show what, not what-state.** A Mail row shows the sender and the first line, not "unread message received". Prefer the concrete action, "Editing SessionListView.swift", over the category, "working". The state is then implied, and the user learns something they did not already know.

**Motion is the honest signal for ongoing work.** A static badge cannot distinguish "running right now" from "stuck 40 minutes ago", so it is a claim rather than evidence. An indeterminate `ProgressView`, or an SF Symbol with `.symbolEffect(.variableColor.iterative)` or `.pulse`, is self-evidently live. Podcasts downloading, Mail fetching and Photos syncing all work this way.

**Escalate only the state that wants a human.** Needs-input is the one state that earns a strong marker: an unread-style dot, a badge, a notification. Everything else stays quiet. And it must be actionable, tapping it goes straight to the thing that is waiting.

**Colour carries Apple's meanings, not yours.** Red is destructive, orange is caution, blue or the app tint is actionable, secondary grey is everything else. Borrowing a terminal's green-yellow-red onto iOS reads as a dashboard. "Working" is not caution.

**Colour is never the only channel.** Differentiate Without Color is a system setting people actually use. Pair colour with a symbol, shape, position or text.

**The `·` chain is a web idiom.** `idle · quiet 4h · claude-opus-4` belongs on a status page. Apple's list row is headline, secondary subtitle, trailing metadata, chevron, and it lets typography and position carry the hierarchy instead of punctuation.

## Navigation

**Prefer a platform container over an invented one.** `NavigationSplitView` for a collection plus detail, and it adapts to iPad and Mac for free. A tab bar for a small fixed set of top-level destinations. A menu attached to the navigation title for switching context, which is what Files and Safari do. A sheet with `presentationDetents` for something transient.

**Apple does not ship hamburger drawers on iPhone.** An edge-swipe drawer also fights `interactivePopGestureRecognizer`, so it usually buys convenience with a broken back gesture.

**Never duplicate a surface.** If a drawer lists what the root screen already lists, two surfaces must now agree forever, and one day they will not.

**A gesture that competes with a system gesture is a design smell, not an implementation problem.** Prefer a design where the conflict cannot arise over arbitration logic that has to be right every time.

## Structure and chrome

Reach for the system before drawing your own: inset grouped lists, real section headers, SF Symbols, system separators and insets, materials rather than flat opaque panels, `.foregroundStyle(.secondary)` rather than a hand-picked grey.

Hand-drawn separators, custom bold header rows, and hardcoded greys are the usual tells that a screen was built from scratch when a `List` would have done it.

## Accessibility is part of the answer, not a follow-up

If motion carries the meaning, Reduce Motion must still convey it. If colour carries it, Differentiate Without Color must too. A status dot needs an accessibility label, because VoiceOver reads nothing from a coloured circle. Dynamic Type must not break the row, and a `·` chain is usually the first thing to wrap badly at larger sizes.

## Applying it

1. Get a screenshot of the real surface on a real device, in both colour schemes.
2. For each element, ask what state it asserts, and whether that state is the exception or the default. Delete the defaults.
3. Name the first-party app with the same problem. If you cannot, say you are inventing.
4. Rewrite with system components and system semantics.
5. Verify on device: Dynamic Type at a large size, Reduce Motion, Differentiate Without Color, VoiceOver over the state indicators.

## Worked example

A session list showed, for every row, an orange or grey dot, a lowercase state word, and a middle-dot chain: `working`, `idle · quiet 4h`.

What Apple would do, item by item: drop the label from idle entirely and keep only the trailing relative time, the way Mail and Messages do. Replace `working` with the concrete action as the subtitle plus a small animated indicator, since motion proves liveness and a static dot cannot. Move needs-input to an unread-style dot plus a notification, because it is the only state that wants a human. Stop using orange, which means caution in Apple's palette, for a state that is merely busy.

The result says more with less: three of five rows lose their decoration, and the two that matter become the only marked ones on screen.
