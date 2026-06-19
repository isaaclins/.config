---
name: deslop
description: "Clean AI-generated slop inside source code on the current branch (diff vs main): redundant or inconsistent comments, defensive try/catch in trusted paths, `any` casts used to dodge types, needless deep nesting. Behavior-preserving, minimal edits. Use when the user says 'deslop', 'clean up the AI code style', or wants the slop removed from code on this branch."
---

# Remove AI code slop

Check the diff against main and remove AI-generated slop introduced in the branch.

## Focus Areas

- Extra comments that are unnecessary or inconsistent with local style
- Defensive checks or try/catch blocks that are abnormal for trusted code paths
- Casts to `any` used only to bypass type issues
- Deeply nested code that should be simplified with early returns
- Other patterns inconsistent with the file and surrounding codebase

## Guardrails

- Keep behavior unchanged unless fixing a clear bug.
- Prefer minimal, focused edits over broad rewrites.
- Keep the final summary concise (1-3 sentences).
