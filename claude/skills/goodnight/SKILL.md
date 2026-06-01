---
name: goodnight
description: Use ONLY when the user has explicitly signaled this Claude Code session is over — they're going to bed, signing off, want CC to exit, or typed `/goodnight`. Triggering phrases: "g'night", "goodnight", "going to sleep", "bye claude", "we're done for tonight", "exit", "/goodnight", "wrap it up I'm out", or similar end-of-session cues. Do NOT invoke just because a task or goal is complete — wait for the user's explicit end-of-session signal. Sends SIGTERM to the parent `claude` process so a wrapping `caffeinate` (or similar sleep-preventer) releases its hold and the Mac is allowed to sleep per Energy Saver.
---

# Goodnight

The user has signaled this CC session is over. Exit cleanly so any wrapping `caffeinate` releases and the Mac can sleep.

## What this skill is for

The user's typical invocation is `cc`, which is aliased to:

```
caffeinate -dis claude --dangerously-skip-permissions
```

`caffeinate` only releases its sleep-prevention when `claude` exits. Claude Code does not auto-exit when a task is "done" — it sits waiting for the next prompt. This skill is the bridge: when the user explicitly says they're going to sleep, terminate the `claude` process so `caffeinate` follows it out and the Mac is allowed to sleep.

## Steps

1. Send a one-line, low-ceremony goodbye in plain text — no summary, no recap, no question. Examples:
   - "Night. Exiting."
   - "Goodnight."
   - "👋"
   Match the user's register; if they've been informal all session, keep it informal.

2. Immediately after the text, invoke the Bash tool with this exact block. It (1) writes a sleep-log markdown entry containing the resume command, then (2) walks up *this* bash's process tree to find and kill only the `claude` ancestor of the calling shell, falling through to SIGKILL if SIGTERM is trapped.

   ```bash
   # 1. Sleep-log entry so the user can check up tomorrow.
   LOG_DIR="$HOME/.claude/sleep-log"
   mkdir -p "$LOG_DIR"
   TS=$(date +%Y-%m-%d_%H-%M-%S)
   SID="${CLAUDE_CODE_SESSION_ID:-unknown}"
   CWD="$PWD"
   LOG_FILE="$LOG_DIR/${TS}.md"
   cat > "$LOG_FILE" <<EOF
   # Session ${SID%%-*} — $(date '+%Y-%m-%d %H:%M:%S %Z')

   **CWD:** \`${CWD}\`
   **Session ID:** \`${SID}\`

   ## Resume

   \`\`\`fish
   cd ${CWD} && claude --resume ${SID}
   \`\`\`
   EOF
   echo "Sleep log: $LOG_FILE"

   # 2. Walk the parent chain, find this session's claude ancestor.
   pid=$$
   target=""
   while [ "$pid" -gt 1 ] 2>/dev/null; do
     comm=$(ps -p "$pid" -o comm= 2>/dev/null | tr -d ' ')
     comm=$(basename "$comm" 2>/dev/null)
     if [ "$comm" = "claude" ]; then
       target="$pid"
       break
     fi
     pid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ')
     [ -z "$pid" ] && break
   done

   # 3. SIGTERM → 3s grace → SIGKILL.
   if [ -n "$target" ]; then
     echo "Targeting claude PID $target"
     kill -TERM "$target" 2>/dev/null
     for i in 1 2 3; do
       sleep 1
       kill -0 "$target" 2>/dev/null || { echo "exited on SIGTERM"; exit 0; }
     done
     kill -KILL "$target" 2>/dev/null && echo "force-killed after 3s grace"
   else
     echo "no claude ancestor found — close the terminal manually"
   fi
   ```

   Why this shape:
   - `pkill -f` is fragile (matches on command-line substrings, can hit the wrong session if multiple CCs are running). Walking the parent chain from `$$` guarantees we kill *only* the CC session that issued the command.
   - SIGTERM-then-SIGKILL handles CC trapping SIGTERM for graceful shutdown.
   - The sleep-log writes BEFORE the kill so it's always preserved — even if the kill misbehaves the user has the resume command on disk.

3. That's it. The Bash command kills the parent `claude` — this very session — so there's no further turn.

## What NOT to do

- Don't ask "are you sure?" — the user has already decided.
- Don't propose alternatives ("maybe just close the terminal?") — they specifically built this skill to avoid that.
- Don't recap the session. They saw it; they were there. A short goodbye is enough.
- Don't list "what to verify tomorrow" — that belongs in normal end-of-task summaries, not here.
- If a goal/Stop hook complains after the kill, that's fine — it gets reaped along with the process.

## Edge cases

- If the user invokes this in the middle of a long-running tool call (e.g. `make test`), still kill. The tool call's subprocess inherits no parent and may be cleaned up by launchd; the user knows what they asked for.
- If `pkill` reports "no matching processes," the process tree is unusual (e.g. CC launched via a different wrapper). Tell the user in one line: "Couldn't find a `claude` ancestor process to terminate — close the terminal manually." Don't try fancier fallbacks.
