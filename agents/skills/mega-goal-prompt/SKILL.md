---
name: mega-goal-prompt
description: "Interview the user one question at a time, then emit a paste-ready /goal mega prompt (outcome, context, success criteria, constraints, char-budget enforced). Use when the user wants to author a goal for an autonomous run and says 'write a goal', 'set a /goal', or 'run this autonomously'. It produces the prompt text for the user to paste, not an executed task."
---

# Mega-Goal Prompt Generator

Interview the user about their task, one question at a time, until you have everything needed to fill in the `/goal` mega prompt template. Then output the completed prompt.

## The Mega Prompt Template

Read `references/mega-prompt-template.md` to internalize the full template structure before starting. You will fill this in at the end.

## Interview Protocol

Ask **one question at a time**. Wait for the answer before continuing. For each question, offer your own recommended answer based on what you know so far — the user can accept, tweak, or override it.

Work through these branches in order, but skip questions that are already answered from context:

### Branch 1 — The Outcome
What is the single final outcome? What does "done" look like in one sentence?

This becomes the `/goal` line. It must be falsifiable — something the evaluator model can confirm from the transcript.

### Branch 2 — Context
Fill in the CONTEXT block:
- **Project**: what are you building?
- **Stack**: languages, frameworks, infra?
- **Current state**: what exists today — is this greenfield, or modifying existing code?
- **Working dir**: path or repo name?
- **Constraints**: anything off-limits, budget or time constraints?
- **Audience**: who is this for?

Ask about context fields that are missing or ambiguous. If the user has described the project already, confirm rather than re-ask.

### Branch 3 — Success Criteria
What are the 3–5 measurable conditions that must ALL be true for the goal to be met?

Each criterion must map to something the agent can produce as proof in the transcript (command output, file count, test result, URL). Push back on vague criteria like "it works" — ask what command proves it.

### Branch 4 — Constraints and Off-Limits
What must the agent NOT do or touch?
- Files or directories that must stay unchanged
- Actions that require human approval (commits, deploys, etc.)
- Any tool restrictions (no internet, no DB writes, etc.)

### Branch 5 — Quality Bar
Adjust the quality bar to fit the task:
- Is there a UI? (if no, drop the design line)
- What coding conventions matter?
- Is this internal tooling or production-facing?

### Branch 6 — Final Deliverable Proof
What should the agent produce at the end to confirm completion?
- Default: test output + file list + how to run
- Ask if a screenshot, URL, or specific artifact is needed

## NEVER

- NEVER ask multiple questions in one turn — one question, then wait.
- NEVER accept "I'll figure that out later" — require a decision or explicitly mark it as an open question before moving on.
- NEVER let the user redirect to implementation details before all branches are resolved.
- NEVER output the mega prompt until all blocking branches (1, 2, 3) are resolved. Branches 4–6 can use sensible defaults if the user wants to move fast.
- NEVER output a prompt without first verifying its character count fits the length budget (see below). Going over is a hard failure.

## Length budget

The `/goal` prompt has to be paste-able into a single Claude Code / Codex message and stay readable. Hard cap: **4,000 characters by default** (counting every character inside the code block, including newlines). If the user specifies a different cap (e.g. "below 3000 chars"), use theirs.

Before outputting, you MUST verify the count. Don't eyeball it — actually measure. Two ways:

1. Bash check (preferred): write the draft prompt to a tmp file and `wc -c` it.

   ```bash
   wc -c <<'EOF'
   <paste full prompt body here, including the /goal line through "execute end-to-end">
   EOF
   ```

2. Mental check (only for short prompts): sum the line lengths.

If the count exceeds the cap, trim before outputting. Trimming priority order:
1. Tighten verbose CONTEXT bullets (drop redundant phrasing).
2. Compress SUCCESS CRITERIA — keep the measurable assertion, drop the explanation.
3. Drop the FINAL DELIVERABLE block down to one line per icon.
4. Inline the QUALITY BAR bullets into the FINAL DELIVERABLE line if needed.
5. Only as a last resort: drop a success criterion. If you do, flag it in the post-output summary.

After outputting the prompt, state the verified char count in the summary line (e.g. "3,847 chars, fits the 4000 budget").

## When to Stop Interviewing

Stop and output the prompt when:
- Branches 1–3 are fully resolved, AND
- The user says "go" / "looks good" / "that's enough", OR
- You've asked about all branches and have reasonable answers for everything

## Output

Once done interviewing, output the completed mega prompt as a code block, ready to paste directly into Claude Code or Codex CLI.

After the code block, add a one-line summary of any open questions or assumptions you made.

---

## References

- `references/mega-prompt-template.md` — the full template to fill in