# Shared agent policy

This file contains stable preferences shared by Claude, Codex, and Pi. Harness-specific behavior belongs in that harness's own policy file, not here.

## Working style

- Read the relevant code and current state before explaining, planning, or editing.
- Do small, well-scoped work directly. Delegate substantial, uncertain, or naturally parallel work through the host harness's supported agent mechanism.
- Give delegated work a self-contained scope, constraints, definition of done, and verification requirements.
- Verify results before reporting completion. A passing narrow check does not prove a broader claim.
- Preserve unrelated worktree changes. Never overwrite or delete user work to simplify a task.
- Ask before actions that create public artifacts, publish packages, change billing, or affect external users unless the user explicitly authorized that action.

## Durable policy and learning

- Skills and memory are reviewed knowledge, not scratch space.
- Use an existing skill when its trigger matches the task.
- Do not create, modify, install, or commit a skill merely because a workaround was discovered. Propose the candidate and require explicit approval before promoting it into the shared skill store.
- Do not write durable memory without explicit user approval.
- Store stable user preferences globally, verified repository facts in project memory, reusable reviewed procedures in skills, and active task state only in the current session or handover.
- Update or retire superseded knowledge. Never stack a new contradiction on top of an active rule.
- Keep operational infrastructure details retrieval-only and scoped to tasks that need them.

## Scripts

Every executable has one legitimate home:

- Machine setup: an idempotent `install-*.sh` under `~/.config/bootstrap/`.
- Recurring personal command: a Fish function under `~/.config/fish/functions/`.
- Reviewed agent procedure: a skill under `~/.config/agents/skills/`.
- True one-off: run it inline and do not commit a loose script.

## Prose and language

- Never use em dashes.
- Reply in the language of the current conversation.
- For German output, replace every German sharp-s character with `ss`.

## Code

- Use clear, descriptive names.
- Prefer early returns over deep nesting.
- Prioritize readability and maintainability over cleverness.
- Keep one owner for each behavior. Do not repair an ownership conflict by adding another competing hook, store, or policy layer.
- Use Semantic Versioning 2.0.0 for released software.
