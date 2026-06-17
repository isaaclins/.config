---
name: create-frontend-concepts
description: Generate multiple distinct, production-quality frontend design concepts for a brand or idea in parallel, then publish an A/B-test gallery that links to all of them. Use when the user says "/create-frontend-concepts", wants several different landing-page/storefront/homepage design directions to choose between, wants to A/B test designs, or asks to "spin up agents" to explore design directions for a brand. Each concept is built by a separate agent using a DIFFERENT design skill and a DIFFERENT aesthetic lane, so the outputs are genuinely varied — not the same page recolored.
---

# create-frontend-concepts

Spin up 5–8 parallel agents, each building ONE self-contained frontend concept for the same brand using a **different design skill** and a **different aesthetic lane**, then assemble and (by default) deploy an **A/B-test gallery** that links to every concept.

This skill exists because two cheap mistakes kill design exploration:
1. **Over-constraining the agents** (handing them a fixed palette/type/spacing) → every concept comes out identical.
2. **Under-differentiating the agents** (same skill, or "just avoid the cliché" with no distinct direction) → they all flee to the *same* anti-cliché corner and converge again.

The fix, baked into this skill: feed agents **only the brand + gimmick**, give each a **distinct design skill + distinct lane**, and make each **self-critique and redo once**.

---

## Step 0 — Parse the brief

The user gives a brand or idea, e.g. `/create-frontend-concepts for a brand: a CLI tool that turns receipts into spreadsheets`.

Extract (infer aggressively — do NOT interrogate the user; the whole point is "any idea just works"):
- **name** — the brand name. If none given, coin a short, fitting one.
- **what it is / gimmick** — the one-line hook (what it sells/does + any wordplay in the name).
- **audience** — who it's for. Infer if unstated.
- **page type** — storefront, SaaS landing, app marketing, portfolio, event, etc. Infer from the idea.

Only ask a clarifying question if the brief is empty or unintelligible. Otherwise proceed.

**Flags the user may pass:** `--count N` (5–8, default 6), `--local` / `--no-deploy` (skip GitHub Pages, build the gallery locally only), `--type <page type>`.

Create a working root in the current directory: `./<brand-slug>-concepts/`. Concepts go in `<root>/concept-N-<slug>/index.html`; the gallery is `<root>/index.html`.

Use TaskCreate to track: parse → dispatch agents → build gallery → deploy → report.

---

## Step 1 — Assign skills + lanes (the anti-convergence core)

Pick `count` agents (default 6). Give **each agent a unique row** from the rosters below. Distinct **lanes** are what guarantee variety — never skip them.

**Design skills** (rotate; each agent gets one it invokes via the Skill tool):
`design-taste-frontend`, `high-end-visual-design`, `gpt-taste`, `industrial-brutalist-ui`, `minimalist-ui`, `frontend-design`, `stitch-design-taste`, `design-taste-frontend-v1` (backup).

**Motion skills** (alternate per agent): `better-animate`, `animation-vocabulary`.

**Aesthetic lanes** (assign a DISTINCT one to each agent — pick the `count` that best fit the brand; adapt/replace freely):
| Lane | Flavor |
|---|---|
| Editorial / luxury | premium, refined, magazine-grade, expensive |
| Brutalist / industrial | raw, mechanical, hairline grids, hazard accents |
| Minimal / quiet | restraint, whitespace, one spot color, calm |
| Retro / Y2K / vaporwave | nostalgic computing, chrome, gradients, playful-tech |
| Maximalist / playful | bold, sticker-bomb, big type, fun, springy |
| Organic / handcrafted | warm, textured, human, paper/risograph |
| Futuristic / sci-fi / neon | high-tech, glow, scanlines, dark-energy |
| Swiss / typographic | strict grid, type-led, signage, asymmetry |

A good 6-agent default spread: Editorial-luxury, Brutalist-industrial, Minimal-quiet, Retro/Y2K, Maximalist-playful, Futuristic-neon — each on a different design skill.

> ⚠️ Do NOT give every agent the same "avoid X cliché" instruction without distinct lanes. That is exactly what causes re-convergence. The lane *is* the differentiator.

---

## Step 2 — Dispatch the agents (in parallel)

Send all agents in a SINGLE message (multiple Agent tool calls, `subagent_type: "claude"`) so they run concurrently. Fill the template per agent — substitute `{{...}}`. **Never** add palette, font, spacing, or section-layout constraints; those are the agent's to invent.

```
You are designing ONE {{PAGE_TYPE}} homepage concept for a brand. Build a single, self-contained, production-quality HTML page with a completely original aesthetic that YOU invent.

USE THESE SKILLS — invoke them via the Skill tool as your FIRST actions and genuinely apply them:
1. Skill: {{DESIGN_SKILL}}
2. Skill: {{MOTION_SKILL}}

THE BRAND — "{{NAME}}"
{{WHAT_IT_IS_AND_GIMMICK}}. Audience: {{AUDIENCE}}.

YOUR ASSIGNED LANE: {{LANE}} — "{{LANE_FLAVOR}}".
Commit FULLY to this lane. It is yours alone; other agents own other lanes, so do not drift toward a generic safe look — own this one hard.

YOUR JOB
Invent a BOLD, original creative direction within your lane, derived from the name and the gimmick. The exact palette, typography, layout, mood, copy, and voice are entirely YOUR call. Make it distinctive and memorable. Do NOT default to the single most obvious cliché for this niche — find a fresh, specific angle inside your lane. Commit 100% to one strong point of view.

PROCESS (do it twice)
Do a first pass. Then critique your own work against your design skill's standards — is it generic? templated? is the concept strong and the craft high? — and REDO it to be more distinctive and more polished. Ship the improved version.

FUNCTIONAL REQUIREMENTS (about function, not look — the look is yours)
- One self-contained index.html: inline <style>/<script>; you may <link> web fonts (and a motion lib like GSAP) from a CDN. No build step — it must open directly in a browser. NO external image URLs — render all imagery/graphics as inline SVG or CSS so nothing breaks offline.
- It must read as a real {{PAGE_TYPE}}: a visitor should instantly grasp the brand and be able to act (browse/buy/sign up). Include at least a hero, the core offering/{{OFFERING}}, a clear primary action, and a footer. Structure and layout are up to you.
- Write your own sharp, on-brand copy (taglines, names, microcopy) — you invent the voice.
- Responsive, accessible (semantic HTML, strong contrast), and honor prefers-reduced-motion.

DELIVERABLE
- Write to: {{ROOT}}/concept-{{N}}-{{SLUG}}/index.html
- Return ONLY: (a) the creative direction you chose in 1-2 sentences, (b) the absolute file path, (c) skills used + key motion patterns. Your final message is data for the orchestrator — be concise.
```

For a storefront, set `{{OFFERING}}` to the product range; for SaaS, the feature set; etc.

**After agents return:** verify each file exists, is non-trivial in size, and ends with `</html>`. If an agent was rejected or produced a broken/empty file, either re-dispatch that one slot or drop it from the gallery and note the gap. Don't silently ship a broken concept.

---

## Step 3 — Build the A/B gallery

Write `{{ROOT}}/index.html`. Label options **neutrally as A, B, C…** with the concept's *vibe* name only — NEVER show the skill name or words like "high-end" (that biases the vote). Each card is a live, scaled `<iframe>` thumbnail that links (whole card) to the full concept in a new tab.

Gallery requirements:
- Header with the brand, a one-line explainer, and a "How to vote" box ("send back the letter(s) you'd actually buy from / sign up for").
- Responsive grid of cards: letter badge + vibe name + one-line descriptor + iframe thumbnail + "open →".
- Thumbnails: wrap a large iframe and scale it down, `pointer-events:none`, a transparent scrim over it so clicks hit the card link.
- A footer.

Reference implementation for the thumbnail mechanism and card (adapt styling to taste):
```css
.thumb{position:relative;width:360px;height:264px;overflow:hidden;border-bottom:1px solid var(--line)}
.thumb iframe{position:absolute;top:0;left:0;width:1200px;height:880px;border:0;
  transform:scale(.30);transform-origin:top left;pointer-events:none}
.thumb .scrim{position:absolute;inset:0;z-index:2}
```
```html
<a class="card" href="concept-1-slug/index.html" target="_blank" rel="noopener">
  <div class="thumb"><div class="scrim"></div>
    <iframe src="concept-1-slug/index.html" loading="lazy" tabindex="-1" aria-hidden="true"></iframe></div>
  <div class="meta"><div class="badge">A</div>
    <div><h2>Vibe Name</h2><p>one-line descriptor</p></div><div class="open">open →</div></div>
</a>
```
Add `<iframe loading="lazy">` so six live pages don't all load at once.

---

## Step 4 — Deploy to GitHub Pages (default ON)

Unless `--local`/`--no-deploy`, publish so the user can share one link. This creates a **public** repo — say so in the final report. Run from `{{ROOT}}`:

```bash
OWNER=$(gh auth status >/dev/null 2>&1 && gh api user -q .login)   # bail to --local if empty
REPO="<brand-slug>-concepts"
touch .nojekyll
git init -q -b main
git add -A
git -c user.name="$OWNER" -c user.email="$(gh api user -q '.email // "noreply@users.noreply.github.com"')" \
  commit -q -m "<brand> frontend concept gallery (N directions) for A/B testing"
gh repo create "$REPO" --public --source=. --remote=origin --push
gh api -X POST "repos/$OWNER/$REPO/pages" -f "source[branch]=main" -f "source[path]=/"
```
Then poll the build and confirm it serves (custom domains: trust the API's `html_url`):
```bash
for i in $(seq 1 9); do
  st=$(gh api "repos/$OWNER/$REPO/pages/builds/latest" -q .status 2>/dev/null)
  [ "$st" = "built" ] && break; sleep 10
done
URL=$(gh api "repos/$OWNER/$REPO/pages" -q .html_url)
curl -s -o /dev/null -w "%{http_code}  $URL\n" -L --max-time 15 "$URL"
```
If `gh` isn't authenticated, skip deploy, keep the local gallery, and tell the user how to open it (`open {{ROOT}}/index.html`).

---

## Step 5 — Report

Give the user:
- The **shareable URL** (and the `*.github.io` alias if a custom domain was used).
- A **table** mapping each letter → vibe name → direction → direct link.
- The repo link, noting it's public and that labels are neutral so votes aren't biased.
- A one-line **honest note** if any concepts came out similar, offering to dispatch more divergent lanes as extra options (G/H/I) appended to the same gallery.

---

## Quality bar & guardrails (read every run)

- **Never** hand agents a palette, fonts, spacing, or a fixed section layout. Brand + gimmick + lane only.
- **Always** assign each agent a *distinct* lane and a *distinct* design skill. This is the variety engine.
- **Always** require: single self-contained file, no external images (inline SVG/CSS), responsive, accessible, `prefers-reduced-motion`.
- Run agents **in parallel** (one message, many Agent calls).
- Gallery labels are **neutral (A–F + vibe name)** — never expose the skill used.
- **Verify** each concept file before shipping; re-run or exclude failures, and say so.
- Deploy is **public** — state that plainly in the report.
- Scale the fleet to the ask: quick look → 5; "explore hard" / "lots of options" → 8.
