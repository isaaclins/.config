---
name: decruft
description: >-
  Remove AI-generated clutter from a repository - the stray Markdown and scratch
  artifacts an AI drops in but a human dev would never commit: planning docs,
  audits, "prompt" files, handoff/memory dumps, design-token dumps, phase-by-phase
  execution plans, leftover scaffolding. Subtraction-first: keep only what a human
  would keep, in the form a human would keep it. Always proposes a plan and gets
  confirmation before deleting. Use when the user says "decruft", "deslop the repo",
  "remove the AI .md files", "clean up the AI slop / droppings", "tidy this repo",
  or points at stray AI-made docs cluttering the project. (For cleaning up AI slop
  inside CODE, use /deslop instead - this is for repo files/artifacts.)
---

# decruft - strip AI droppings from a repo

After an AI has worked in a repo for a while, it leaves litter: `UI-AUDIT.md`,
`DESIGN.md`, `REDESIGN_PROMPT.md`, `PLAN.md`, `NOTES.md`, `MEMORY.md`, `HANDOFF.md`,
`*-summary.md`, `.goal-*.md`, scratch screenshots, half-baked token dumps. None of
it is wired into the build; all of it screams "a model was here." Your job is to
remove that clutter so the repo looks hand-built again - **without** deleting
anything a human would actually want to keep.

## The test for every file

Two questions, burden of proof on KEEPING:

1. **Would a human developer have committed this file to this repo?**
2. **If yes, is it in the form a human would keep it** (concise, current, not
   addressed to an AI), or is it bloated with model cruft?

Verdicts: **KEEP** / **TRIM** (rewrite to the human version) / **DELETE**.

Default to DELETE for one-off AI scaffolding. Default to KEEP for genuine project
docs. When unsure, KEEP and flag it - never silently destroy.

## Procedure

### 1. Scope it
- Default scope is the whole repo from its root. If the user named a path or
  "this folder / this scope", restrict to that.
- Confirm you're in a git repo (`git rev-parse --is-inside-work-tree`). If not,
  warn that deletions won't be recoverable and be extra conservative.
- Note uncommitted work (`git status --short`). Don't delete a file with
  uncommitted changes the user may still want without calling it out explicitly.

### 2. Inventory candidates (don't act yet)
Cast a wide net, then judge. Useful sweeps:
- Markdown outside the conventional homes:
  `git ls-files '*.md' '*.markdown'` then exclude `README*`, `LICENSE*`,
  `CONTRIBUTING*`, `CHANGELOG*`, `CODE_OF_CONDUCT*`, `SECURITY*`, and a real
  `docs/` tree.
- Untracked litter: `git status --porcelain --untracked-files=all`.
- Name tells (case-insensitive): `AUDIT`, `PROMPT`, `PLAN`, `ROADMAP`, `REDESIGN`,
  `NOTES`, `SCRATCH`, `SUMMARY`, `HANDOFF`, `MEMORY`, `CONTEXT`, `IMPLEMENTATION`,
  `_GUIDE`, `TODO`, `.goal*`, `*.bak`, `*-copy*`, `* 2.*`.
- Stray artifacts: screenshots/`.png`/`.pdf` not referenced anywhere, generated
  output checked in by accident, duplicate configs.

### 3. Classify each candidate
Read it. Apply the test. AI-slop content tells (raise DELETE/TRIM confidence):
- Verdict/decision tables, "per /skill-name", phase-by-phase execution plans,
  giant checklists addressed to an agent, "Generated with", "Co-Authored-By",
  emoji-dense headers, em-dashes used as a tell, design-token dumps that just
  duplicate what the stylesheet already encodes, "MISSION & SCOPE", restated
  prompts, "DO IT IN THIS ORDER".
- A doc that describes work that is now **done** (the plan shipped) has served its
  purpose -> DELETE. A doc that is **reference for the future** may be KEEP/TRIM.

KEEP, untouched: `README`, `LICENSE`, `CONTRIBUTING`, `CHANGELOG`, `SECURITY`,
`CODE_OF_CONDUCT`, real `docs/`, ADRs, and **anything referenced by code, build,
or CI** - grep before deleting any file (imports, `package.json`,
`*.config.*`, CI yml, links from kept docs). Never touch source, configs, lockfiles.

### 4. Propose, then confirm (required)
Present a compact plan before removing anything:

```
DELETE   UI-AUDIT.md          shipped audit, verdict tables, addressed to the agent
DELETE   REDESIGN_PROMPT.md   self-referential prompt; the redesign is done
DELETE   .goal-quick-actions.md  one-off goal file
TRIM     DESIGN.md            real palette, but AI-formatted -> fold into README or keep 6 lines
KEEP     README.md            genuine project doc
```

Then ask for a yes (or per-file adjustments). Honor "keep that one" overrides.

### 5. Execute
- Tracked files -> `git rm <file>` (recoverable from history).
- Untracked files -> delete, but only the ones explicitly in the confirmed plan.
- TRIM -> rewrite the file to the lean human version: strip emoji, "/skill"
  references, agent checklists, restated prompts, em-dashes; keep only the durable
  facts, in normal prose. If a TRIM target is really just a few useful values,
  consider folding them into `README`/`docs` and deleting the standalone file.
- Don't bundle unrelated changes. Don't reformat files you're keeping.

### 6. Report
One short summary: what was deleted, what was trimmed, what was deliberately kept
and why. If anything was ambiguous, say so. Offer to commit (e.g.
`chore: remove AI scaffolding docs`) but only if the user wants - don't auto-commit
or push.

## Hard rules
- **Never delete without showing the plan and getting an explicit yes.**
- Prefer `git rm` so removals are recoverable; flag any untracked (unrecoverable) deletes.
- Never delete a file referenced by code, build, CI, or a kept doc - grep first.
- Never touch source code, configs, lockfiles, or a real `docs/` tree.
- Stay inside the requested scope.
- When unsure whether something is slop or a genuine note, KEEP and ask.
- This skill removes *files/artifacts*. For AI slop *inside code* (dead code,
  defensive cruft, redundant comments), use `/deslop`.
