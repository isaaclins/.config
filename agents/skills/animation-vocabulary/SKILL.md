---
name: animation-vocabulary
description: "Cross-platform catalogue of ~90 named motion patterns (fade, stagger, parallax, spring, FLIP, marquee, and more), each with a perceptual cue and use cases, plus a CSS/Motion/SwiftUI/Compose/Flutter translation table. Use to identify and name the right motion pattern for any runtime when choosing or describing an animation rather than writing its code."
---

# animation-vocabulary

A shared motion vocabulary for picking *named* patterns instead of inventing freeform motion. Every entry below has the same three slots:

- **Watch for** — the perceptual cue that tells you the pattern is working (or isn't).
- **GSAP tip** — a concrete implementation hint. Translate the idea to whatever stack is in use (CSS transitions/keyframes, Framer Motion, Reanimated, SwiftUI `withAnimation`, Compose `animate*AsState`, Flutter `AnimationController`, etc.).
- **Use cases** — where the pattern earns its keep.

## How to use this skill

1. **User names a term** ("add a stagger", "give it a pop", "scroll reveal these") → use that exact pattern even if you'd have picked something else.
2. **User is vague** ("animate it", "make it nicer") → silently pick the single best-fit pattern based on the element's role and frequency, then name it in **bold** in your reply so the user learns what you applied.
3. **You're building UI and motion would help** → reach for a vocab term proactively whenever a listed *Use case* matches. Don't decorate — motion must serve a function (see **Purposeful animation**).

When multiple terms fit, prefer:
- The simpler one (fade in over reveal; scale over morph).
- The one matching the element's *frequency of use* — high-frequency surfaces stay quieter and shorter.
- The one that still works under `prefers-reduced-motion` for non-essential motion.

## Implementation defaults

- Detect the stack first (package.json, imports, file extensions, project type). Use what's already there; don't add a dependency unless asked.
- UI durations sit between **0.18s and 0.6s** unless the pattern says otherwise.
- Default ease: **ease-out** for entrances/responses, **ease-in-out** for state-to-state, **ease-in** for exits leaving the screen.
- Prefer `transform` and `opacity` over layout props (`width`, `top`, `left`) — see **Compositing** and **Layout thrashing**.
- Always respect `prefers-reduced-motion` for non-essential motion. CSS: `@media (prefers-reduced-motion: reduce)`. JS: `matchMedia('(prefers-reduced-motion: reduce)')`. Native: equivalent system flags (UIAccessibility.isReduceMotionEnabled, etc.).
- After applying, name the pattern in **bold** in your reply so the user can ask for it again by name.

---

## Vocabulary

### Entrances & Exits

**Fade in / Fade out** — An element appears or disappears through opacity.
- Watch for: opacity makes the element arrive gently instead of popping in abruptly.
- GSAP tip: Use `autoAlpha` to handle both opacity and visibility.
- Use cases: Modals, hints, list item entrances, progressive page reveals.

**Slide in** — Moves in from outside the viewport or container edge.
- Watch for: direction matches the spatial relationship in the UI.
- GSAP tip: Use `x` / `y` instead of `left` / `top`.
- Use cases: Drawers, notifications, section entrances.

**Scale in** — Grows from smaller size into place, often paired with a fade.
- Watch for: transform origin feels natural for where the element comes from.
- GSAP tip: Combine `scale` and `autoAlpha` in a single tween.
- Use cases: Menus, cards, avatars, badges.

**Pop in** — Snappy entrance with small overshoot before settling.
- Watch for: overshoot feels lively without becoming distracting.
- GSAP tip: `back.out(1.8)` is a quick way to make a pop.
- Use cases: Button feedback, badges, success states.

**Reveal** — Content uncovered by a mask, clip, or cover moving away.
- Watch for: reveal direction supports reading direction or visual hierarchy.
- GSAP tip: `clipPath` or a moving cover layer both work well.
- Use cases: Headlines, images, charts, loading reveals.

**Enter / Exit** — Paired animations for added/removed elements.
- Watch for: entrance and exit feel related, often mirrored.
- GSAP tip: Sequence enter and exit in a timeline.
- Use cases: Route changes, toast lifecycles, modal transitions.

### Sequencing & Timing

**Keyframes** — Motion defined by important states at specific moments.
- Watch for: how 0%, middle, and final poses create rhythm.
- GSAP tip: `gsap.to` supports a `keyframes` array.
- Use cases: Complex button feedback, character motion, staged UI actions.

**Interpolation / Tween** — Generated in-between values from start to end.
- Watch for: motion feels continuous rather than jumping.
- GSAP tip: Use `fromTo` for explicit start and end values.
- Use cases: Most UI movement — scale, rotation, opacity.

**Stagger** — Group of elements starts one after another (cascade).
- Watch for: spacing between starts implies a clear order/direction.
- GSAP tip: `stagger: { each, from }` controls timing and origin.
- Use cases: Lists, grids, menus, onboarding steps.

**Orchestration** — Multiple animated parts arranged into one coherent sequence.
- Watch for: different elements feel like phases of the same interaction.
- GSAP tip: Timeline position parameters let actions overlap precisely.
- Use cases: Page transitions, component openings, complex UI choreography.

**Delay** — Planned wait before an animation begins.
- Watch for: delay clarifies sequence, not making feedback feel slow.
- GSAP tip: Prefer timeline positions for readable delay management.
- Use cases: Queued hints, staged tutorials, notification timing.

**Duration** — How long the animation takes start to finish.
- Watch for: longer duration makes same distance feel heavier.
- GSAP tip: UI motion often sits between 0.18 and 0.6 seconds.
- Use cases: Buttons, panels, cards, state changes.

**Fill mode** — Whether animation keeps first or last frame before/after playback.
- Watch for: element remains in intended final visual state.
- GSAP tip: GSAP tweens typically preserve final inline styles.
- Use cases: Explaining CSS animation `forwards` and retained states.

**Stepped animation** — Motion divided into discrete steps.
- Watch for: change feels like ticks or frames rather than sliding.
- GSAP tip: `ease: steps(n)` simulates discrete states.
- Use cases: Timers, pixel art, counters, progress marks.

### Movement & Transforms

**Translate** — Movement along X or Y axis.
- Watch for: element moves visually without forcing layout changes.
- GSAP tip: Prefer `x` and `y` transform aliases.
- Use cases: Cards, menus, drag feedback, panels.

**Scale** — Element grows or shrinks as a whole.
- Watch for: scaling preserves readability and hit-target clarity.
- GSAP tip: Use `scaleX` and `scaleY` for single-axis control.
- Use cases: Emphasis, entrances, press feedback.

**Rotate** — Element turns around a chosen point.
- Watch for: rotation center matches the object's implied hinge.
- GSAP tip: Use `rotation` with degree values.
- Use cases: Loaders, icons, toggles, card flips.

**Skew** — Slanted transform giving speed or distortion.
- Watch for: keep skew brief when text is involved.
- GSAP tip: Use `skewX` / `skewY` and `clearProps` when needed.
- Use cases: Impact transitions, speed accents.

**3D tilt / Flip** — Rotation around X or Y axis to create depth.
- Watch for: perspective visible without causing discomfort.
- GSAP tip: Use `rotationX` / `rotationY` with perspective.
- Use cases: Cards, previews, hover states, flips.

**Perspective** — Depth setting controlling 3D transform strength.
- Watch for: smaller values make depth feel more dramatic.
- GSAP tip: Set perspective on the parent container.
- Use cases: 3D cards, carousels, page-turn effects.

**Transform origin** — Anchor point used for scaling or rotation.
- Watch for: changing origin visibly changes how the same transform behaves.
- GSAP tip: Set `transformOrigin`, e.g. `'left top'`.
- Use cases: Menus, gauges, hinged panels, popovers.

**Origin-aware animation** — Transition expanding from trigger source.
- Watch for: overlay feels as if it grows out of the button that opened it.
- GSAP tip: Set `transformOrigin` based on the trigger position.
- Use cases: Popovers, context menus, dropdowns.

### Transitions Between States

**Crossfade** — One fades out while another fades in in the same space.
- Watch for: layers share space and replace each other smoothly.
- GSAP tip: Animate one `autoAlpha` to 0 while the other goes to 1.
- Use cases: Image swaps, status text, content state changes.

**Continuity transition** — State change preserving visual identity.
- Watch for: object's identity remains readable throughout the change.
- GSAP tip: Transforming one node often feels better than replacing it.
- Use cases: Expanding cards, compact players, detail views.

**Morph** — One shape smoothly turns into another.
- Watch for: outline feels continuous through the transition.
- GSAP tip: Without MorphSVG, `borderRadius` + `scale` can approximate.
- Use cases: Dynamic status pills, island-style UI states.

**Shared element transition** — Same element moves between locations while resizing.
- Watch for: eye can follow the element across views.
- GSAP tip: Measure start and end rects, then animate the transform.
- Use cases: Opening thumbnails into detail pages.

**Layout animation** — Elements animate to new positions after layout changes.
- Watch for: neighboring elements make room smoothly.
- GSAP tip: Use the FLIP idea — First, Last, Invert, Play.
- Use cases: Sorting, filtering, responsive grids, list changes.

**Accordion / Collapse** — Content expands or collapses smoothly.
- Watch for: height change is clear but not sluggish.
- GSAP tip: Measure target height when animating to `auto`.
- Use cases: FAQ panels, settings sections, detail rows.

**Direction-aware transition** — Forward/back use opposite directions.
- Watch for: going back feels like the reverse path.
- GSAP tip: Set `x` direction based on navigation direction.
- Use cases: Carousels, pagination, route transitions.

### Scroll

**Scroll reveal** — Elements animate in when entering the viewport.
- Watch for: reveal happens near the viewport edge, not too late.
- GSAP tip: Use `IntersectionObserver` to trigger `gsap.from`.
- Use cases: Long pages, reports, product stories, articles.

**Scroll-driven animation** — Animation progress maps directly to scroll.
- Watch for: dragging the page scrubs the animation forward and back.
- GSAP tip: Map scroll progress to `timeline.progress`.
- Use cases: Scrollytelling, progress diagrams, product breakdowns.

**Parallax** — Foreground and background layers move at different speeds.
- Watch for: layer speed differences enhance space, not fight readability.
- GSAP tip: Give each layer a different `y` movement ratio.
- Use cases: Covers, illustrations, maps, story pages.

**Page transition** — Plays when moving between pages or routes.
- Watch for: outgoing and incoming views connect cleanly.
- GSAP tip: Use a timeline to manage out before in.
- Use cases: SPA routing, document section changes.

**View transition** — Browser/framework transition connecting two view states.
- Watch for: shared elements feel captured by the same camera.
- GSAP tip: View Transitions API can pair with CSS or JS motion.
- Use cases: Detail pages, galleries, tab switches.

### Feedback & Interaction

**Hover effect** — Visual response when pointer rests over an element.
- Watch for: change clearly signals interactivity.
- GSAP tip: Trigger tweens on `mouseenter` and `mouseleave`.
- Use cases: Buttons, cards, toolbars, navigation.

**Press / Tap feedback** — Quick response while an element is being pressed.
- Watch for: feedback is immediate.
- GSAP tip: `pointerdown` scale `.96`, restore on `pointerup`.
- Use cases: Buttons, icons, list rows, mobile controls.

**Hold to confirm** — Press-and-hold where progress fills before confirming.
- Watch for: progress makes a risky action feel intentional.
- GSAP tip: Play tween on `pointerdown`, reverse on `pointerup`.
- Use cases: Delete, submit, payment, destructive actions.

**Drag** — Element follows pointer; may continue with inertia.
- Watch for: object feels attached to the pointer.
- GSAP tip: Use `pointermove` with `quickTo` for smooth tracking.
- Use cases: Sliders, board cards, maps, handles.

**Drag to reorder** — Dragged item moves; others make room.
- Watch for: target position communicated by spatial movement.
- GSAP tip: Combine pointer events with FLIP-style transforms.
- Use cases: Task lists, queues, kanban boards.

**Swipe to dismiss** — Horizontal swipe moves item offscreen and removes it.
- Watch for: crossing the threshold clearly indicates dismissal.
- GSAP tip: After the `x` threshold, animate offscreen.
- Use cases: Toasts, notifications, email rows, mobile cards.

**Rubber-banding** — Boundary effect: resistance and snap back.
- Watch for: farther past edge, the slower additional movement becomes.
- GSAP tip: Use a damped function to limit pointer delta.
- Use cases: Scroll boundaries, drawers, draggable panels.

**Shake / Wiggle** — Fast side-to-side motion signaling error.
- Watch for: shake is short and unmistakable.
- GSAP tip: Use alternating `x` keyframes.
- Use cases: Form errors, failed passwords, invalid drops.

**Ripple** — Circular wave expands from interaction point.
- Watch for: wave originates from tap/click location.
- GSAP tip: Create a circle, animate `scale` + `autoAlpha`.
- Use cases: Material-style buttons, touch list feedback.

### Easing

**Easing** — Curve describing how speed changes over time.
- Watch for: same distance, different curve completely changes feel.
- GSAP tip: Ease is the tone of motion.
- Use cases: Nearly every UI animation.

**Ease-out** — Starts quickly, slows into the end.
- Watch for: element responds immediately, then settles gently.
- GSAP tip: `power3.out` and `expo.out` are common choices.
- Use cases: Entrances, button responses, panels.

**Ease-in** — Starts slowly, accelerates toward the end.
- Watch for: beginning can feel hesitant — careful for responses.
- GSAP tip: `power2.in` is a straightforward ease-in.
- Use cases: Elements leaving the screen.

**Ease-in-out** — Starts slow, speeds up, slows again.
- Watch for: both ends soft while middle carries motion.
- GSAP tip: `power3.inOut` is a reliable default.
- Use cases: Panel movement, state transitions.

**Linear** — Constant speed start to finish.
- Watch for: feels mechanical and steady.
- GSAP tip: Use `ease: 'none'`.
- Use cases: Progress bars, loading rotations, marquees.

**Cubic-bezier** — Timing curve controlled by Bézier handles.
- Watch for: control points change how velocity rises and falls.
- GSAP tip: CSS uses `cubic-bezier`; GSAP can use `CustomEase`.
- Use cases: Brand motion, bespoke transitions.

**Asymmetric easing** — Acceleration/deceleration use different personalities.
- Watch for: start and finish feel intentionally different.
- GSAP tip: Combine different in/out curves or use custom easing.
- Use cases: Premium transitions, shared element motion.

### Spring Animations

**Spring** — Motion described by tension, mass, damping.
- Watch for: feels pulled toward target by an invisible spring.
- GSAP tip: `elastic` and `back` eases can approximate spring behavior.
- Use cases: Drag release, panels, popovers, card return.

**Stiffness / Tension** — How strongly the spring pulls toward target.
- Watch for: higher tension arrives more quickly and decisively.
- GSAP tip: Increase ease intensity or shorten duration to imply stiffness.
- Use cases: Fast controls, drawers, snappy feedback.

**Damping** — How quickly motion loses energy after overshooting.
- Watch for: lower damping creates more oscillation before settling.
- GSAP tip: `elastic.out(1, damping)` simulates different damping feels.
- Use cases: Playful modals, drag rebound.

**Mass** — How heavy the object feels in motion.
- Watch for: heavier objects start and stop more slowly.
- GSAP tip: Lengthen duration and reduce sharpness.
- Use cases: Large panels, substantial cards.

**Bounce** — Motion overshoots/hits a surface, then rebounds.
- Watch for: bounce supports the emotional tone.
- GSAP tip: Use `bounce.out` or `back.out`.
- Use cases: Success feedback, badges, empty states.

**Perceptual duration** — When users feel the animation is done.
- Watch for: main action finishes before subtle tail motion distracts.
- GSAP tip: Keep late spring oscillation small.
- Use cases: Tuning spring systems, polished UI motion.

**Momentum** — Motion carries existing velocity after release.
- Watch for: object continues in the direction it was moving.
- GSAP tip: Use pointer velocity to set the target or distance.
- Use cases: Dragging, swiping, throw interactions.

**Velocity** — Current speed and direction, often drives next animation.
- Watch for: different release speeds produce different outcomes.
- GSAP tip: Track pointer delta over time.
- Use cases: Gestures, physical motion, drag release.

**Interruptible animation** — Animation can be redirected mid-flight.
- Watch for: changing target while moving still feels smooth.
- GSAP tip: Use `overwrite: 'auto'` or `quickTo` for frequent updates.
- Use cases: Hover changes, drag interactions, live controls.

### Looping & Ambient Motion

**Marquee** — Content scrolls continuously in a loop.
- Watch for: loop seam is hard to notice.
- GSAP tip: Use `repeat: -1` with `ease: 'none'`.
- Use cases: Announcements, brand walls, market tickers.

**Loop** — Animation repeats for a count or indefinitely.
- Watch for: returning to the start feels seamless.
- GSAP tip: Use `repeat: -1` for an infinite loop.
- Use cases: Loaders, ambient background details.

**Alternate (yoyo)** — Each repeat plays in the opposite direction.
- Watch for: back-and-forth avoids a visible jump to the start.
- GSAP tip: Use `repeat: -1` and `yoyo: true`.
- Use cases: Breathing highlights, floating elements, focus cues.

**Orbit** — One element revolves around another.
- Watch for: center point and path are visually clear.
- GSAP tip: Set `transformOrigin` to the orbit center.
- Use cases: Diagrams, data relationships, decorative systems.

**Pulse** — Subtle repeating scale/opacity change.
- Watch for: pulse is restrained enough not to annoy.
- GSAP tip: Combine `scale`, `autoAlpha`, `repeat`, `yoyo`.
- Use cases: Notification dots, current-step indicators.

**Float** — Small vertical drift keeping element from feeling static.
- Watch for: amplitude stays small enough to preserve readability.
- GSAP tip: Use a yoyo tween on `y`.
- Use cases: Illustrations, empty states, cards.

**Idle animation** — Subtle motion shown while not in use.
- Watch for: adds life without stealing focus.
- GSAP tip: Use long duration, small values, infinite yoyo.
- Use cases: Characters, waiting states, background UI.

### Polish & Effects

**Blur** — Filter softening elements or adding depth.
- Watch for: blur usually clears by the end of the transition.
- GSAP tip: `filter: 'blur(12px)'` can be tweened.
- Use cases: Modal backdrops, entrance polish.

**Clip-path** — Clipping shape hides or shows part of an element.
- Watch for: clipping edge matches the content direction.
- GSAP tip: Animate `clipPath` such as `inset(...)`.
- Use cases: Image reveals, mask-like transitions.

**Mask** — Shape/gradient controls visibility, often soft edges.
- Watch for: masking feels softer than a hard clip when needed.
- GSAP tip: Use CSS `mask` or gradient masks.
- Use cases: Image transitions, text fills.

**Before / after slider** — Draggable divider comparing two layers.
- Watch for: split line makes comparison obvious.
- GSAP tip: Animate the overlay width.
- Use cases: Retouching, image comparisons, before/after data.

**Line drawing** — SVG path appears as if drawn by a pen.
- Watch for: path length change resembles writing/tracing.
- GSAP tip: Use `strokeDasharray` and `strokeDashoffset`.
- Use cases: Icons, signatures, routes, path explanations.

**Text morph** — Text changes with per-character or per-word transition.
- Watch for: old and new values feel connected.
- GSAP tip: Split characters and stagger replacement.
- Use cases: Metrics, headings, AI generation states.

**Skeleton / Shimmer** — Placeholder layout with light sweep during loading.
- Watch for: shimmer feels light, not like a progress bar.
- GSAP tip: Animate `backgroundPosition` in a loop.
- Use cases: Tables, cards, media, feed loading.

**Number ticker** — Number increments or rolls toward target.
- Watch for: digits stay aligned while changing.
- GSAP tip: Use `onUpdate` and snap or rounded text updates.
- Use cases: Metrics, countdowns, prices, dashboards.

**Tabular numbers** — Equal-width digits so values don't shift layout.
- Watch for: number block stays stable while values change.
- GSAP tip: `font-variant-numeric: tabular-nums`.
- Use cases: Timers, counters, financial data, stats.

**Typewriter** — Text appears character by character.
- Watch for: typing rhythm matches the tone of the interface.
- GSAP tip: Update `textContent` progressively over time.
- Use cases: Command lines, AI responses, title reveals.

### Performance

**Frame rate (FPS)** — Frames drawn per second; stability feels smooth.
- Watch for: frame spacing is even.
- GSAP tip: Avoid expensive work on every frame.
- Use cases: Performance monitoring, complex motion reviews.

**Jank** — Visible stutter when browser can't draw frames in time.
- Watch for: motion may pause or hitch unexpectedly.
- GSAP tip: Reduce layout and paint pressure.
- Use cases: Performance debugging, demos.

**Dropped frame** — A frame missed its drawing deadline.
- Watch for: a single missed frame can break the rhythm.
- GSAP tip: Keep `requestAnimationFrame` work lightweight.
- Use cases: Animation debugging, profiling.

**Compositing** — GPU moves/fades layers without repainting layout.
- Watch for: transform/opacity feel smoother than layout props.
- GSAP tip: Prefer `transform` and `opacity` for animated properties.
- Use cases: High-frequency UI motion.

**will-change** — CSS hint that an element is about to animate.
- Watch for: layer warm-up reduces initial stutter.
- GSAP tip: Use `will-change` only on elements that will actually move.
- Use cases: Complex cards, draggable items.

**Layout thrashing** — Repeated read/write of layout forces recalculation.
- Watch for: animating `width`/`left` often feels less smooth.
- GSAP tip: Avoid animating `width`/`top`/`left` when transforms work.
- Use cases: Performance anti-pattern demos.

### Principles to Know

**Purposeful animation** — Motion should aid understanding/feedback/navigation.
- Watch for: animation answers a user-facing question.
- GSAP tip: Define the job of the motion before writing the tween.
- Use cases: Product motion reviews, design systems.

**Anticipation** — Small preparatory motion before the main action.
- Watch for: prep move makes the larger action feel expected.
- GSAP tip: Move slightly opposite first, then toward target.
- Use cases: Opening drawers, flying cards, playful controls.

**Follow-through** — Parts continue moving slightly after main body stops.
- Watch for: tail motion adds weight and liveliness.
- GSAP tip: Stagger child elements so they finish at different moments.
- Use cases: Menus, characters, elastic UI components.

**Squash & stretch** — Shape compresses/stretches during movement.
- Watch for: deformation relates to velocity or impact.
- GSAP tip: Pair `scaleX` and `scaleY` in opposite directions.
- Use cases: Game-like UI, success feedback.

**Perceived performance** — Motion makes waiting feel shorter.
- Watch for: wait feels active and controlled.
- GSAP tip: Use short motion to bridge state changes.
- Use cases: Loading, submitting, AI generation.

**Frequency of use** — The more often, the shorter and quieter.
- Watch for: high-frequency interactions stay calm.
- GSAP tip: Shorten duration on common paths.
- Use cases: Toolbars, lists, productivity workflows.

**Spatial consistency** — Motion preserves spatial logic across states.
- Watch for: origin and destination make sense together.
- GSAP tip: Keep direction, source, and destination consistent.
- Use cases: Navigation, routes, detail expansions.

**Hardware acceleration** — Use GPU-friendly properties.
- Watch for: transform/opacity feel steadier than layout animation.
- GSAP tip: Prioritize `x`, `y`, `scale`, and `opacity`.
- Use cases: Large element movement, scroll-linked effects.

**Reduced motion** — Respect system settings requesting less motion.
- Watch for: core information doesn't depend on large movement.
- GSAP tip: Use `matchMedia('(prefers-reduced-motion)')` to reduce or skip.
- Use cases: Accessibility, enterprise interfaces.

---

## Stack translation cheat sheet

| Concept | Web (CSS) | Web (JS / GSAP) | Framer Motion | SwiftUI | Jetpack Compose | Flutter |
|---|---|---|---|---|---|---|
| Tween a transform | `transition: transform .25s ease-out` | `gsap.to(el, {x:40, duration:.25, ease:'power3.out'})` | `animate={{ x: 40 }} transition={{ duration: .25 }}` | `withAnimation(.easeOut(duration: .25)) { offset = 40 }` | `animateDpAsState(40.dp, tween(250, easing = EaseOut))` | `AnimatedContainer(duration: 250ms, curve: Curves.easeOut)` |
| Spring | — | `back.out(1.8)` / `elastic.out(1, .5)` | `transition={{ type: 'spring', stiffness, damping }}` | `withAnimation(.spring(response, dampingFraction))` | `spring<Dp>(dampingRatio, stiffness)` | `SpringSimulation` / `spring` curves |
| Stagger | `animation-delay` on each | `stagger: { each: .04, from: 'start' }` | `staggerChildren` on parent variant | `withAnimation { ... }.delay(i * 0.04)` | `delayMillis = i * 40` in tween | `Interval(start, end)` per child |
| Scroll-driven | `animation-timeline: scroll()` | `ScrollTrigger` mapping to `timeline.progress` | `useScroll` + `useTransform` | `GeometryReader` + scroll offset | `rememberScrollState()` + `derivedStateOf` | `ScrollController` + `Animation` |
| Layout / FLIP | `view-transition-name` | Measure rect → animate transform | `layout` prop on motion components | `matchedGeometryEffect` | `animateContentSize()` / `LookaheadLayout` | `Hero` widget |
| Reduced motion | `@media (prefers-reduced-motion)` | `matchMedia('(prefers-reduced-motion)')` | `useReducedMotion()` | `accessibilityReduceMotion` env | `LocalAccessibilityManager.current` | `MediaQuery.disableAnimations` |

When the stack isn't listed, map the *concept* (entrance, easing, spring, stagger, scroll-driven, layout, reduced motion) to its closest primitive — every UI runtime has one.
