---
name: better-animate
description: Apply a specific, named animation pattern to a UI element instead of inventing motion. Use when the user says "animate it", "/better-animate", "add motion", "make it animated", or any vague animation request; also use when the user names a specific pattern (fade in, slide, pop, stagger, parallax, shimmer, ripple, spring, etc.) or when adding/refining motion in a UI you're already building. Framework-agnostic — works with CSS, Tailwind, Framer Motion, GSAP, SwiftUI, Jetpack Compose, or any UI runtime.
---

# better-animate

Pick a named animation pattern from the vocabulary below and implement it. Do **not** invent freeform motion when a named pattern fits.

## How to choose a pattern

Three cases:

1. **User names a term** ("add a stagger", "give it a pop", "scroll reveal these cards") → use that exact pattern, even if you'd have picked something else.
2. **User is vague** ("animate it", "make it nicer", "add some motion") → silently pick the single best-fit pattern based on the element's role, then name it in your reply so the user learns what you applied (e.g. "Used **pop in** with `back.out(1.8)` — felt right for a success badge.").
3. **You're building UI and motion would help** → reach for a vocab term proactively when one of the listed *Use cases* matches. Don't decorate; motion should serve a function (see **Purposeful animation**).

When multiple terms fit, prefer:
- The simpler one (fade in over reveal, scale over morph)
- The one matching the element's *frequency of use* — high-frequency = quieter
- The one respecting `prefers-reduced-motion` for non-essential motion

## How to implement

- Detect the stack first (package.json, imports, file extensions). Use what's already there. Don't add a dependency unless the user asks.
- Default UI durations: **0.18s–0.6s**. Default easing: **ease-out** for entrances/responses, **ease-in-out** for state-to-state.
- Prefer `transform` and `opacity` over layout properties (width/top/left) — see **Compositing** and **Layout thrashing**.
- Always respect `prefers-reduced-motion` for non-essential motion. In CSS use `@media (prefers-reduced-motion: reduce)`; in JS use `matchMedia('(prefers-reduced-motion: reduce)')`.
- Name the pattern you used in your reply, in **bold**, so the user can ask for it again by name.

---

## Vocabulary

### Entrances & Exits

- **Fade in / Fade out** — Opacity in/out. Gentle, never abrupt. *Modals, hints, list items, page reveals.* GSAP: `autoAlpha`.
- **Slide in** — From outside the viewport/container edge; direction matches spatial relationship. *Drawers, notifications, sections.* GSAP: use `x`/`y`, not `left`/`top`.
- **Scale in** — Grows into place, usually with a fade. *Menus, cards, avatars, badges.* Watch transform-origin.
- **Pop in** — Snappy with small overshoot. *Button feedback, badges, success states.* GSAP: `back.out(1.8)`.
- **Reveal** — Uncovered by a mask, clip-path, or cover moving away. *Headlines, images, charts, loaders.*
- **Enter / Exit** — Paired add/remove animations, often mirrored.

### Sequencing & Timing

- **Keyframes** — Defined states at 0% / mid / 100%; browser fills the gaps. *Complex button feedback, staged actions.*
- **Interpolation / Tween** — Continuous values between start and end. *Most UI movement.* GSAP: `fromTo` for explicit endpoints.
- **Stagger** — Items animate one after another in a cascade. *Lists, grids, menus, onboarding.* GSAP: `stagger: { each, from }`.
- **Orchestration** — Multiple parts arranged into one coherent sequence. *Page transitions, component openings.* GSAP timeline positions.
- **Delay** — Wait before start. Clarifies sequence — don't make responses feel slow.
- **Duration** — How long. UI usually 0.18–0.6s. Longer = heavier.
- **Fill mode** — Whether element keeps first/last frame before/after. CSS `forwards`.
- **Stepped animation** — Discrete ticks rather than sliding. *Timers, pixel art, counters.* GSAP: `ease: steps(n)`.

### Movement & Transforms

- **Translate** — Move along X/Y. Prefer transform aliases over layout props.
- **Scale** — Grow/shrink. Preserve readability and hit targets.
- **Rotate** — Spin around a chosen point. Match the object's implied hinge.
- **Skew** — Slant for speed/distortion. Keep brief for text.
- **3D tilt / Flip** — `rotateX`/`rotateY` for depth. *Cards, previews, hover.*
- **Perspective** — Set on parent. Smaller value = more dramatic depth.
- **Transform origin** — Anchor for scale/rotation. Changes everything about how the same transform feels.
- **Origin-aware animation** — Overlay grows from its trigger (popover from the button that opened it). Set transform-origin from trigger position.

### Transitions Between States

- **Crossfade** — One out while another in, same spot. *Image swaps, status text.*
- **Continuity transition** — Same object, different state; transform one node instead of replacing. *Expanding cards, compact players.*
- **Morph** — Outline continuous between shapes. *Dynamic Island-style.* Without MorphSVG, `borderRadius` + `scale` can approximate.
- **Shared element transition** — Same element travels and resizes between locations. *Thumbnail → detail page.* Measure start/end rects, animate the transform (FLIP).
- **Layout animation** — Elements animate to new positions after layout changes. *Sorting, filtering, responsive grids.* FLIP: First, Last, Invert, Play.
- **Accordion / Collapse** — Height expand/collapse. Measure target height when going to `auto`.
- **Direction-aware transition** — Forward and back use opposite directions. *Carousels, pagination, route transitions.*

### Scroll

- **Scroll reveal** — Animate in on viewport entry. Trigger near the edge, not too late. `IntersectionObserver` → `gsap.from`.
- **Scroll-driven animation** — Progress maps directly to scroll. Map scroll → `timeline.progress`. *Scrollytelling, product breakdowns.*
- **Parallax** — Layers move at different speeds. Different `y` ratios per layer. Don't fight readability.
- **Page transition** — Plays on route change. Out before in.
- **View transition** — Browser/framework transition connecting shared elements. View Transitions API + CSS/JS.

### Feedback & Interaction

- **Hover effect** — Pointer rests over element. `mouseenter`/`mouseleave`.
- **Press / Tap feedback** — Immediate response while pressed. `pointerdown` scale `.96`, restore on `pointerup`.
- **Hold to confirm** — Progress fills during press. Tween on `pointerdown`, reverse on `pointerup`. *Destructive actions.*
- **Drag** — Element follows pointer; may have inertia. `pointermove` + `quickTo` for smoothness.
- **Drag to reorder** — Dragged item moves, others make room. Pointer events + FLIP.
- **Swipe to dismiss** — Past threshold = offscreen + remove. *Toasts, notifications, email rows.*
- **Rubber-banding** — Resistance past boundary, snap back. Damped pointer-delta function. *iOS overscroll feel.*
- **Shake / Wiggle** — Short, unmistakable side-to-side. *Form errors, invalid drops.*
- **Ripple** — Wave from interaction point. Originate from tap location. *Material-style buttons.*

### Easing

- **Easing** — Curve of speed-over-time. Same distance, different curve = totally different feel.
- **Ease-out** — Fast → slow. **Default for UI and anything responding to the user.** `power3.out`, `expo.out`.
- **Ease-in** — Slow → fast. Usually avoid; reserve for things leaving the screen.
- **Ease-in-out** — Slow → fast → slow. *Panel movement, state transitions.* `power3.inOut`.
- **Linear** — Constant. Only for spinners, marquees, progress bars. `ease: 'none'`.
- **Cubic-bezier** — Custom Bézier curve. CSS `cubic-bezier()`, GSAP `CustomEase`.
- **Asymmetric easing** — In and out curves with different personalities. *Premium transitions, shared element motion.*

### Spring Animations

- **Spring** — Physics: tension, mass, damping. *Drag release, panels, popovers.* GSAP `elastic`/`back` approximate.
- **Stiffness / Tension** — Higher = snappier arrival.
- **Damping** — Lower = more bounce before settling. `elastic.out(1, damping)`.
- **Mass** — Heavier = slower start/stop. Lengthen duration, reduce sharpness.
- **Bounce** — Overshoot + rebound. *Success feedback, badges.* `bounce.out`, `back.out`.
- **Perceptual duration** — When user *feels* it's done. Keep late oscillation small.
- **Momentum** — Carries velocity past release. *Drag, swipe, throw.*
- **Velocity** — Current speed + direction. Drives the next animation; track pointer delta over time.
- **Interruptible animation** — Redirect mid-flight smoothly. `overwrite: 'auto'` or `quickTo`.

### Looping & Ambient Motion

- **Marquee** — Continuous scroll. Loop seam should be invisible. `repeat: -1`, `ease: 'none'`.
- **Loop** — Repeat for count or forever. Seamless return to start.
- **Alternate (yoyo)** — Each repeat reverses direction. `repeat: -1, yoyo: true`.
- **Orbit** — Revolves around another element. Set `transformOrigin` to the orbit center.
- **Pulse** — Subtle repeating scale/opacity. *Notification dots, current-step indicators.* Restrained.
- **Float** — Small vertical drift. *Illustrations, empty states.* Yoyo `y` tween, small amplitude.
- **Idle animation** — Subtle motion while waiting. Long duration, small values, infinite yoyo.

### Polish & Effects

- **Blur** — Soften or add depth. Usually clears by transition end. `filter: 'blur(12px)'` is tweenable.
- **Clip-path** — Shape-based hide/reveal. Animate `inset(...)` etc.
- **Mask** — Shape/gradient visibility, often soft edges. CSS `mask` or gradient masks.
- **Before / after slider** — Draggable divider between two layers. Animate overlay width.
- **Line drawing** — SVG path drawn by invisible pen. `strokeDasharray` + `strokeDashoffset`.
- **Text morph** — Per-character/word transition between values. Split chars, stagger replacement.
- **Skeleton / Shimmer** — Loading placeholder with light sweep. Animate `backgroundPosition` in a loop. Feels light, not progress-bar-like.
- **Number ticker** — Digits roll to target. `onUpdate` + snap/round.
- **Tabular numbers** — `font-variant-numeric: tabular-nums`. **Always pair with tickers, timers, counters.**
- **Typewriter** — Character-by-character text. Progressive `textContent` updates. *AI responses, command lines.*

### Performance

- **Frame rate (FPS)** — 60 baseline, 120 on newer displays. Even spacing = smooth.
- **Jank** — Visible stutter from missed deadlines. Reduce layout/paint pressure.
- **Dropped frame** — One missed frame breaks rhythm. Keep `rAF` work light.
- **Compositing** — GPU moves layers without repainting. Transform/opacity > layout props.
- **will-change** — Hint that element is about to animate. **Only on elements that will actually move.** Don't leave on indefinitely.
- **Layout thrashing** — Animating `width`/`height`/`top`/`left` forces per-frame layout recalc. **Avoid.** Use transforms.

### Principles to Know

- **Purposeful animation** — Define the *job* before writing the tween. Orient, give feedback, show relationships. Not decoration.
- **Anticipation** — Tiny opposite-direction wind-up before the main move. *Opening drawers, flying cards.*
- **Follow-through** — Parts keep moving and settle after the main motion. Stagger children to finish at different moments.
- **Squash & stretch** — Deform with velocity/impact. `scaleX` + `scaleY` opposite. *Game-like UI, success feedback.*
- **Perceived performance** — Right motion makes the interface *feel* faster. *Loading, submitting, AI generation.*
- **Frequency of use** — High-frequency interactions stay short and quiet. *Toolbars, lists.*
- **Spatial consistency** — Element keeps identity and position across states. Origin and destination should make sense together.
- **Hardware acceleration** — Prefer `x`, `y`, `scale`, `opacity` for smoothness.
- **Reduced motion** — Honor `prefers-reduced-motion`. Core info must not depend on large movement.

---

## Output format

When you apply motion, your reply should:

1. Name the pattern(s) you used, in **bold**.
2. One sentence on *why* it fits (link back to a use case or principle).
3. The code change.

Example: "Used **scale in** with `back.out(1.7)` — fits the badge use case and gives a touch of **anticipation** before settling. Respected `prefers-reduced-motion` by collapsing to a 0.15s fade."
