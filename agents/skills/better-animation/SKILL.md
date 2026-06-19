---
name: better-animation
description: "Web and React motion engineering in code: chooses CSS vs Motion vs GSAP, enforces GPU-safe properties, custom easing, spring orchestration, prefers-reduced-motion, and cleanup, with ready-to-use skeletons (drawers, scroll pinning, magnetic hover). Use when implementing and shipping animation as working web or React code."
---

# Better Animation — Motion Engineering for the Web

Animation is communication, not decoration. Every motion must earn its place. This skill makes interfaces feel alive, physical, and intentional — never busy, never janky, never inaccessible.

## 1. The Prime Directive: motion must be motivated

Before adding ANY animation, answer in one sentence: **what does this communicate?**

Valid reasons:
- **Hierarchy** — draw the eye to the right thing.
- **Feedback** — acknowledge a user action (press, submit, toggle).
- **Continuity / state transition** — show that something changed, moved, or reordered.
- **Storytelling** — reveal content in a sequence that matches a narrative.

Invalid reason: *"it looked cool."* If you can't articulate the reason, cut it. Animation everywhere = amateur. A few perfectly-tuned moments beat scattered effects.

## 2. Pick the right tool

| Need | Use | Why |
|---|---|---|
| Hover, press, focus, simple state changes | **CSS** `transition` / `@keyframes` | Zero JS, runs on compositor, cheapest |
| Enter/exit, list stagger, layout reordering, gesture/spring, mount-unmount | **Motion** (`motion/react`, formerly Framer Motion) | Spring physics, `AnimatePresence`, `layout`, `whileInView`, motion values |
| Scroll pinning, scrubbing, complex timelines, SVG draw, fine sequencing | **GSAP** + `ScrollTrigger` | Best timeline + scroll control |
| Continuous values from input (mouse, scroll progress, magnetic) | **Motion values** (`useMotionValue`/`useTransform`/`useScroll`) | Bypass React render — never `useState` |

**Default to CSS.** Reach for Motion when you need springs / exit animations / layout. Reach for GSAP only for real pin/scrub/timeline work. Don't pull in GSAP to do a fade.

Verify the library is in `package.json` before importing. Lazy-load anything heavy and off the critical path.

## 3. The easing system (use these, not the defaults)

**Never ship `linear` or `ease-in-out`.** They read as robotic.

```css
--ease-out:    cubic-bezier(0.16, 1, 0.3, 1);   /* expo-out: snappy in, soft settle — default for entrances/most UI */
--ease-spring: cubic-bezier(0.32, 0.72, 0, 1);  /* heavier, for drawers/modals/big surfaces */
--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);  /* only when something must leave AND return */
--t-fast: 150ms;  --t-base: 240ms;  --t-slow: 480ms;
```

In Motion, prefer springs: `transition={{ type: "spring", stiffness: 100, damping: 20 }}`. In GSAP: `power2.out` / `power3.inOut` / `back.out(1.7)` / `elastic.out(1, 0.3)`.

## 4. Foundational rules (non-negotiable)

1. **Animate ONLY `transform` and `opacity`** (and `filter`/`color` sparingly). Never animate `top`, `left`, `width`, `height`, `margin` — they trigger layout/paint and kill mobile FPS. Use `transform: translate/scale/rotate` instead.
2. **Honor `prefers-reduced-motion`.** Anything beyond a basic hover MUST collapse to static/instant. This is an accessibility requirement, not a nicety.
3. **Never `window.addEventListener('scroll', ...)`** for animation. It fires every frame, re-renders, and janks. Use `IntersectionObserver`, Motion `useScroll()`, GSAP `ScrollTrigger`, or CSS `animation-timeline: view()`.
4. **Never drive continuous values through React `useState`** (mouse pos, scroll progress, magnetic hover). Use motion values or refs.
5. **Always clean up.** Kill GSAP tweens/ScrollTriggers and disconnect observers on unmount. Use `gsap.context()` + `ctx.revert()` and `useEffect` cleanup.
6. **`will-change: transform` sparingly** — only on elements actively animating; remove after.
7. **`backdrop-blur` only on fixed/sticky overlays** (nav, modal scrim) — never on scrolling content.

## 5. Pattern library

### 5.1 Entry reveal + stagger

CSS (cheap, for static mounts):
```css
@media (prefers-reduced-motion: no-preference) {
  .reveal { opacity: 0; transform: translateY(12px); animation: rise var(--t-slow) var(--ease-out) forwards; }
  .reveal:nth-child(n) { animation-delay: calc(var(--i, 0) * 40ms); } /* set --i per item */
  @keyframes rise { to { opacity: 1; transform: none; } }
}
```

Motion (for scroll-in + exit):
```tsx
import { motion, useReducedMotion } from "motion/react";
function Reveal({ items }) {
  const reduce = useReducedMotion();
  return items.map((it, i) => (
    <motion.li key={it.id}
      initial={reduce ? false : { opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.6, delay: i * 0.06, ease: [0.16, 1, 0.3, 1] }} />
  ));
}
```
Use staggered reveals for lists, grids, cards, menus. **Never mount everything at once.** `from: "center"` / `"random"` (GSAP stagger) adds character.

### 5.2 Hover & press micro-interactions

```css
.btn { transition: transform var(--t-fast) var(--ease-out), background var(--t-fast) var(--ease-out); }
.btn:hover  { transform: translateY(-1px); }
.btn:active { transform: scale(0.98); }            /* tactile press — simulate physical button */
.btn .icon  { transition: transform var(--t-fast) var(--ease-out); }
.btn:hover .icon { transform: translate(2px, -1px); } /* trailing-icon nudge / internal kinetic tension */
```

**Magnetic hover** (continuous, motion values only):
```tsx
import { motion, useMotionValue, useSpring } from "motion/react";
function Magnetic({ children }) {
  const x = useMotionValue(0), y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 150, damping: 15 });
  const sy = useSpring(y, { stiffness: 150, damping: 15 });
  return (
    <motion.div style={{ x: sx, y: sy }}
      onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect();
        x.set((e.clientX - r.left - r.width / 2) * 0.3);
        y.set((e.clientY - r.top - r.height / 2) * 0.3); }}
      onMouseLeave={() => { x.set(0); y.set(0); }}>
      {children}
    </motion.div>
  );
}
```

### 5.3 Drawers, modals, command palettes (exit animations)

```tsx
import { motion, AnimatePresence } from "motion/react";
<AnimatePresence>
  {open && (
    <>
      <motion.div className="scrim"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
      <motion.aside className="drawer"
        initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
        transition={{ type: "spring", stiffness: 260, damping: 30 }} />
    </>
  )}
</AnimatePresence>
```
Modal/palette: `initial={{ opacity: 0, scale: 0.96, y: 8 }}` → `animate={{ opacity: 1, scale: 1, y: 0 }}`. Always animate the exit too — instant disappearance feels broken.

### 5.4 Scroll-driven (GSAP ScrollTrigger)

**Sticky-stack** (cards pin and recede):
```tsx
gsap.registerPlugin(ScrollTrigger);
useEffect(() => {
  if (reduce) return;
  const ctx = gsap.context(() => {
    const cards = gsap.utils.toArray(".stack-card");
    cards.forEach((card, i) => {
      if (i === cards.length - 1) return;
      ScrollTrigger.create({ trigger: card, start: "top top",
        endTrigger: cards.at(-1), end: "top top", pin: true, pinSpacing: false });
      gsap.to(card, { scale: 0.92, opacity: 0.55, ease: "none",
        scrollTrigger: { trigger: cards[i + 1], start: "top bottom", end: "top top", scrub: true } });
    });
  });
  return () => ctx.revert();
}, [reduce]);
```

**Horizontal-pan** (vertical scroll drives sideways travel):
```tsx
useEffect(() => {
  if (reduce) return;
  const ctx = gsap.context(() => {
    const distance = track.current.scrollWidth - window.innerWidth;
    gsap.to(track.current, { x: -distance, ease: "none",
      scrollTrigger: { trigger: wrap.current, start: "top top",
        end: () => `+=${distance}`, pin: true, scrub: 1, invalidateOnRefresh: true } });
  }, wrap);
  return () => ctx.revert();
}, [reduce]);
```
Lightweight alternative without GSAP: Motion `useScroll()` + `useTransform`, or CSS `animation-timeline: scroll()/view()`.

### 5.5 Layout animations (reorder, expand, shared element)

Use Motion's `layout` and `layoutId` — do the FLIP for you:
```tsx
{list.map((i) => <motion.li key={i.id} layout transition={{ type: "spring", stiffness: 500, damping: 40 }} />)}
{/* shared element across states: same layoutId on both */}
```
Don't wrap static content in `layout` "for safety" — it costs measurement every render.

### 5.6 Continuous motion (ration hard)

Pulse / shimmer / float / typewriter / marquee: use ONLY when the section benefits (live status, loading, AI "thinking"). Spring/keyframe, never linear. **Max one marquee per page.** Not every card needs an infinite loop — if a section is informational, leave it still.

```css
@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .4 } }
.thinking { animation: pulse 1.4s var(--ease-in-out) infinite; }
```

## 6. GSAP cheat-sheet

- **Tweens:** `gsap.to/from/fromTo/set(targets, vars)`. camelCase props. Prefer transform aliases: `x, y, xPercent, scale, rotation, rotationX/Y, skewX/Y, transformOrigin`. Use **`autoAlpha`** over `opacity` (also toggles visibility).
- **vars:** `duration, delay, ease, stagger ({ each/amount, from })`, `repeat (-1 = ∞)`, `yoyo`, `overwrite: "auto"`, `immediateRender`, `onComplete`. Relative: `"+=20"`. clearProps: `"all"`.
- **Timelines:** `const tl = gsap.timeline({ defaults: { ease: "power2.out" } })`; sequence with position param `"<"` (with prev start), `">"` (after prev), `"-=0.2"`, labels. Nest with `master.add(child, 0)`. Control: `tl.play/pause/reverse/restart/progress/kill`.
- **Responsive + a11y:** `gsap.matchMedia()` with `(prefers-reduced-motion: reduce)` condition → set `duration: 0`. Auto-reverts.
- **Perf:** `gsap.quickTo(el, "x", { duration: .4 })` for high-frequency updates (mousemove); `stagger` over many delayed tweens; kill off-screen anims.
- **Don't:** animate width/height/top/left when transforms work; create tweens before DOM exists; skip cleanup; mix `svgOrigin` + `transformOrigin`.

## 7. Motion (Framer) cheat-sheet

- `<motion.x>` with `initial / animate / exit / whileHover / whileTap / whileInView / viewport`.
- `AnimatePresence` for unmount/exit. `layout` + `layoutId` for FLIP/shared element.
- Motion values: `useMotionValue`, `useTransform`, `useSpring`, `useScroll` — never `useState` for continuous input.
- `useReducedMotion()` to branch to static. `staggerChildren` via parent `variants` (parent + children in same client tree).
- In Next.js: any component using Motion needs `"use client"` and should be an isolated leaf.

## 8. Performance guardrails

- `transform` + `opacity` only; everything else is suspect.
- Compositor budget: avoid animating > a handful of large blurred/shadowed layers at once.
- Lazy-load Motion/GSAP; they aren't tiny.
- No grain/noise on scrolling containers — fixed `pointer-events-none` overlay only.
- Z-index discipline: a small named scale (base/sticky/overlay/modal/toast), not arbitrary `z-[9999]`.
- Target Core Web Vitals: INP < 200ms, CLS < 0.1 — reserve space so animated mounts don't shift layout.

## 9. Accessibility (mandatory)

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important; animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important; scroll-behavior: auto !important;
  }
}
```
Plus branch in JS (`useReducedMotion()` / `gsap.matchMedia`). Parallax, scroll-hijack, infinite loops, magnetic physics MUST collapse to static. Keep focus order intact; never animate focus away from the user.

## 10. Do NOT

- Ship `linear`/`ease-in-out` as the default easing.
- Animate `top/left/width/height/margin`.
- `window.addEventListener('scroll')` for animation.
- Drive continuous values through `useState`.
- Add motion with no articulable purpose, or GSAP-everywhere.
- More than one marquee per page; infinite loops on informational sections.
- Forget `prefers-reduced-motion` or effect cleanup.
- Instant unmount with no exit animation on drawers/modals.

## 11. Pre-ship checklist

- [ ] Every animation has a one-sentence purpose (hierarchy/feedback/continuity/story).
- [ ] Right tool per job (CSS default, Motion for spring/exit/layout, GSAP for pin/scrub).
- [ ] Custom easing everywhere — no `linear`/`ease-in-out`.
- [ ] Only `transform`/`opacity` animated.
- [ ] `prefers-reduced-motion` honored in CSS AND JS; heavy motion collapses to static.
- [ ] No scroll listeners; `useScroll`/`ScrollTrigger`/`IntersectionObserver`/CSS scroll-timeline only.
- [ ] Continuous values via motion values/refs, not `useState`.
- [ ] All GSAP contexts reverted, observers disconnected, tweens killed on unmount.
- [ ] Entrances stagger; drawers/modals have matching exit animations.
- [ ] No layout-shift on mount (CLS), libraries lazy-loaded, `will-change` cleaned up.
- [ ] Tested with reduced-motion on and on a mid-tier device.
