# ~/.config/fish/functions/__initialize_cursor_roadmap_scaffold.fish
# Purpose: Scaffolds Cursor roadmap rule files and commits them.
# Usage: Internal helper for `__new_gh_repo`.
function __initialize_cursor_roadmap_scaffold --description "Scaffold and commit Cursor roadmap rules"
    set -l __cursor_roadmap_content "---
description: Project roadmap, planning gates, and implementation phase boundaries.
alwaysApply: true
---

# ROADMAP.mdc

> **Project:** _[Cursor fills this in after the first planning session: one sentence describing what this software does.]_

## How to use this roadmap

- **Before implementation work**: identify the current approved step. Only one primary step should be \"in progress\" at a time unless a hard dependency forces overlap.
- **When starting an approved step**: read its linked `.mdc` file and follow it as the source of truth for scope.
- **When a step is done**: mark every task checkbox `[x]` in that step's rule file, then mark the step line below as `[x]`.
- **Do not skip or reorder steps** unless the user explicitly changes the roadmap.
- **Do not ship placeholder implementations, TODOs, or \"we'll do this later\" stubs.** Every task must be production-complete before moving on.
- **If anything is ambiguous**: stop, ask the user to clarify, then resume. Never assume.
- **After every code change**: update the checkbox state in this file AND in the relevant step file.

## Behavior rules (always enforced)

- **Roadmap creation is not implementation approval.** Completing or updating roadmap files does not authorize starting Step 1.
- **Continue autonomously only inside the task or step the user explicitly approved.** When that approved scope is complete, stop and report status.
- **Do not deploy or commit unless the user explicitly asks in the current conversation.**
- The stack (language, framework, runtime, hosting, database, auth provider, etc.) must be defined with **zero ambiguity** before application code is written. If the user has not specified something, ask. Do not pick defaults silently.
- When you finish an approved task, summarize what changed, what files were touched, and what the next session should test or verify before continuing.

## First-run instructions (only applies before step index exists)

When the user sends their first message in a new project:

1. **Switch to plan mode** immediately.
2. Treat the first-run task as **roadmap initialization only** unless the user explicitly says to implement a specific step after the roadmap is created.
3. Ask every clarifying question needed to eliminate all ambiguity. Examples of required questions if not already answered:
   - What platform? (web / mobile iOS / mobile Android / desktop / multiple?)
   - Is there a backend? If yes: what kind (REST, GraphQL, realtime)? Self-hosted or managed?
   - Auth? (email/password, OAuth, magic link, none?)
   - Database? (relational, document, none, local-only?)
   - Deployment target? (Vercel, GitHub Pages, App Store, self-hosted, etc.)
   - Are there any third-party APIs or integrations?
   - What does \"done\" look like for the full project — what can a user do when it is finished?
4. Do not write application code, install packages, scaffold app files, or create non-roadmap project files during first-run planning.
5. Once all answers are collected, **create all roadmap `.mdc` files in full detail**:
   - Fill in the project description line at the top of this file.
   - Write the full step index in this file.
   - Create `.cursor/rules/roadmap/NN-step-name.mdc` for every step, each fully detailed (see format below).
6. After writing the roadmap files, **stop**. Summarize the roadmap and ask the user to review it or explicitly approve the next implementation step.
7. Do not begin Step 1 until the user sends a separate, explicit implementation instruction such as \"start Step 1\" or \"implement the first step\".

## Step index (master checklist)

_[Cursor fills this in during the first planning session. Format shown below.]_

<!-- Example format — replace entirely:
- [x] **STEP 1** — Brief step name → [.cursor/rules/roadmap/01-step-name.mdc](.cursor/rules/roadmap/01-step-name.mdc)
- [ ] **STEP 2** — Brief step name → [.cursor/rules/roadmap/02-step-name.mdc](.cursor/rules/roadmap/02-step-name.mdc)
-->
"
    set -l __cursor_template_content "---
description: \"Template — copy this when creating a new step file. Delete this file from the final project.\"
alwaysApply: false
---

# Step NN — [Step name]

## Purpose
[One paragraph. What does this step accomplish, and why does it exist at this point in the build order?]

## Stack / tech locked in this step
[List every library, tool, config, or pattern introduced here. Be exact — include versions if relevant.]

## Tasks

- [ ] **NN.1** — [Task title]
  - [Concrete sub-step with zero ambiguity]
  - [Another sub-step]
  - Expected output: [what exists on disk / in the app when this is done]

- [ ] **NN.2** — [Task title]
  - ...

_(Add as many tasks and sub-steps as needed. Every sub-step must be unambiguous — someone who has never seen this project should be able to execute it without asking a question.)_

## Done criteria
- [ ] [Specific, verifiable thing that is true when this step is 100% complete]
- [ ] [Another verifiable criterion]
- [ ] All checkboxes in Tasks above are `[x]`
- [ ] `ROADMAP.mdc` step index updated to `[x]` for this step
"

    set -l __scaffold_ok 0
    command mkdir -p .cursor/rules/roadmap
    and printf '%s' "$__cursor_roadmap_content" >.cursor/rules/ROADMAP.mdc
    and printf '%s' "$__cursor_template_content" >.cursor/rules/roadmap/00-step-template.mdc
    and test -s .cursor/rules/ROADMAP.mdc
    and test -s .cursor/rules/roadmap/00-step-template.mdc
    and set __scaffold_ok 1

    if test $__scaffold_ok -ne 1
        echo "Warning: could not write Cursor roadmap scaffold files." >&2
        return 0
    end

    if not command git add .cursor/ >/dev/null 2>&1
        echo "Warning: could not stage Cursor roadmap scaffold." >&2
        return 0
    end

    if not command git commit -m "chore: add cursor roadmap scaffold" >/dev/null 2>&1
        echo "Warning: could not commit Cursor roadmap scaffold." >&2
        return 0
    end

    if not command git push --quiet >/dev/null 2>&1
        echo "Warning: could not push Cursor roadmap scaffold." >&2
    end
end
