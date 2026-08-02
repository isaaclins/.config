---
name: harness-issue-handoff
description: When the agent harness itself (Pi, its extensions, delegation tooling, memory, UI observation, or any built-in tool) fails, misbehaves, forces a workaround, or clearly could be improved, produce a problem-first handoff prompt for a dedicated fix session and copy it to the user's clipboard. Trigger whenever a workaround for harness behavior is about to be built, whenever a harness tool returns wrong or broken results, or whenever the user asks to report a harness problem.
---

# Harness issue handoff

The harness is fixed at its root, not patched around forever. When harness behavior fails or forces a workaround, hand the problem to a dedicated session that owns the fix. This skill produces that handoff.

## When to trigger

- A built-in tool or extension errors, crashes, or returns provably wrong results
- A workaround for harness behavior is about to be written (the workaround may still proceed, but the handoff is created alongside it)
- Spurious or missing lifecycle signals (false completion reports, lost panes, orphaned children, stale state)
- Any moment of "the harness should really do this better"

## Procedure

1. **Heads up first.** Tell the user in one or two plain sentences: what harness piece misbehaved, what the symptom was, and that a fix handoff is being prepared. Do this before or alongside any workaround.

2. **Apply the minimal workaround** needed to keep the current task moving, if one exists. Mark it clearly as temporary in the conversation. Never silently absorb the failure.

3. **Write the handoff prompt.** Structure, in this order:
   - One opening line: investigate and fix a problem in <the suspected owning area>, starting by locating the owning module and its tests under this config tree. State explicitly that the prompt deliberately contains no proposed fix.
   - **Observed problem**: each failure mode as a numbered item. Concrete symptoms, exact error text where available, the evidence pattern that distinguishes the failure from normal behavior, and how it was reproduced or could be reproduced.
   - **Impact**: what guarantees broke, what manual labor or risk resulted.
   - **What a good outcome looks like**: properties only (invariants that must hold afterwards), never mechanisms. Include: the fix must live in the single owning module, pass its lifecycle tests, and not depend on private APIs or timing; if a supported seam is missing, identify it precisely for upstreaming.
   - Closing discipline line: reproduce first, implement, then prove the fix end to end with the same reproduction.

   Style rules: describe the problem, never the solution. No suggested diffs, no named functions to change, no architecture hints beyond naming the suspected owning area. Never use em dashes.

4. **Copy to clipboard** via `pbcopy` (heredoc the prompt through it), then confirm to the user with the character count and tell them to paste it into a fresh Pi session in `~/.config/`.

5. **Note the workaround for removal.** If a temporary workaround was applied or memorized, say which note or behavior can be deleted once the root fix lands.

## Example invocation shape

```bash
cat << 'EOF' | pbcopy
<handoff prompt>
EOF
echo "copied to clipboard ($(pbpaste | wc -c | tr -d ' ') chars)"
```

## Anti-patterns

- Prescribing the fix ("add a heartbeat", "wrap in retry") in the handoff: the fix session owns the diagnosis
- Building layered permanent workarounds in the working session instead of handing off
- Skipping the user heads up and silently working around a broken tool
- Putting the handoff in a file the user has to find: it goes to the clipboard
