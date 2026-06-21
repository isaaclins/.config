---
name: goodnight
description: "Use ONLY when the user has explicitly signaled this Claude Code session is over: they're going to bed, signing off, want CC to exit, or typed `/goodnight`. Triggering phrases: \"g'night\", \"goodnight\", \"going to sleep\", \"bye claude\", \"we're done for tonight\", \"exit\", \"/goodnight\", \"wrap it up I'm out\", or similar end-of-session cues. Do NOT invoke just because a task or goal is complete; wait for the user's explicit end-of-session signal. Writes a sleep-log resume entry, then triggers a graceful macOS shutdown so the Mac powers off entirely (taking `claude` and any wrapping `caffeinate` with it); if the shutdown request is blocked it falls back to terminating the parent `claude` process."
---

# Goodnight

The user has signaled this CC session is over. Shut the Mac down cleanly; the shutdown also terminates `claude` and any wrapping `caffeinate`.

## What this skill is for

The user's typical invocation is `cc`, which is aliased to:

```
caffeinate -dis claude --dangerously-skip-permissions
```

`caffeinate` only releases its sleep-prevention when `claude` exits, and Claude Code does not auto-exit when a task is done; it sits waiting for the next prompt. This skill is the bridge: when the user explicitly says they're going to sleep, it powers the Mac off, which terminates `claude` and lets `caffeinate` follow it out. (Previously this skill only killed `claude` so the Mac could sleep per Energy Saver; now it shuts the machine down entirely.)

## Steps

1. Send a one-line, low-ceremony goodbye in plain text, no summary, no recap, no question. Examples:
   - "Night. Shutting down."
   - "Goodnight."
   - "👋"
   Match the user's register; if they've been informal all session, keep it informal.

2. Immediately after the text, invoke the Bash tool with this exact block. It (1) writes a sleep-log markdown entry containing the resume command, then (2) triggers a graceful macOS shutdown via `osascript`, which powers the machine off and takes `claude` and `caffeinate` with it. If the shutdown request is blocked (for example missing Automation permission) it (3) falls back to walking *this* bash's process tree and killing only the `claude` ancestor of the calling shell, SIGTERM then SIGKILL.

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

   # 2. Trigger a graceful system shutdown. This powers the Mac off and takes
   #    claude plus any wrapping caffeinate with it, so it supersedes the plain
   #    process-kill below. osascript needs no sudo (unlike `shutdown -h now`).
   if osascript -e 'tell application "System Events" to shut down' 2>/dev/null; then
     echo "Shutdown requested, Mac is powering off."
     exit 0
   fi

   # 3. Fallback: the shutdown request was blocked (e.g. missing Automation
   #    permission), so at least exit this claude session by walking the parent
   #    chain from $$ to find this session's claude ancestor.
   echo "Shutdown request failed, falling back to terminating claude only."
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

   # 3b. SIGTERM → 3s grace → SIGKILL.
   if [ -n "$target" ]; then
     echo "Targeting claude PID $target"
     kill -TERM "$target" 2>/dev/null
     for i in 1 2 3; do
       sleep 1
       kill -0 "$target" 2>/dev/null || { echo "exited on SIGTERM"; exit 0; }
     done
     kill -KILL "$target" 2>/dev/null && echo "force-killed after 3s grace"
   else
     echo "no claude ancestor found, close the terminal manually"
   fi
   ```

   Why this shape:
   - `osascript ... shut down` needs no sudo, unlike `sudo shutdown -h now`, so it works without a NOPASSWD sudoers rule. It asks apps to quit gracefully, then powers the machine off.
   - The fallback kill only runs if the shutdown request fails. `pkill -f` is fragile (matches on command-line substrings, can hit the wrong session if multiple CCs are running), so walking the parent chain from `$$` guarantees we kill *only* the CC session that issued the command. SIGTERM-then-SIGKILL handles CC trapping SIGTERM for graceful shutdown.
   - The sleep-log writes BEFORE anything destructive so it's always preserved; even if shutdown and the kill both misbehave the user has the resume command on disk.

3. That's it. The Bash command shuts the Mac down (or, on fallback, kills the parent `claude`, this very session), so there's no further turn.

## What NOT to do

- Don't ask "are you sure?", the user has already decided.
- Don't propose alternatives ("maybe just close the terminal?"), they specifically built this skill to avoid that.
- Don't recap the session. They saw it; they were there. A short goodbye is enough.
- Don't list "what to verify tomorrow", that belongs in normal end-of-task summaries, not here.
- If a goal/Stop hook complains after the shutdown or kill, that's fine, it gets reaped along with the process.

## Edge cases

- If the user invokes this in the middle of a long-running tool call (e.g. `make test`), still proceed. A clean shutdown asks the subprocess to quit; the user knows what they asked for.
- If the shutdown is blocked and the fallback can't find a `claude` ancestor process, the process tree is unusual (e.g. CC launched via a different wrapper). Tell the user in one line: "Couldn't shut down or find a `claude` ancestor process to terminate, do it manually." Don't try fancier fallbacks.
