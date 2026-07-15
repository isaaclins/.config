# Global agent conventions (Isaac)

## Prose
- Never use em dashes.

## Language
- Reply in the language of the current conversation.
- I work across Spanish, German, Italian, Galician, French, Swiss German, and English.
- For any German output, replace every "ß" with "ss".

## Code
- Use clear, descriptive variable and function names.
- Prefer early returns over deep nesting.
- Follow DRY; prioritise readability and maintainability over cleverness.

## Versioning
- Use Semantic Versioning 2.0.0.

## Aside browser CLI (aside-browser skill) gotchas
- The Aside Browser app must be running first: `open -a Aside`, otherwise the daemon refuses connections (ECONNREFUSED on 127.0.0.1:21420).
- Each `aside repl` CLI process is its own ephemeral session; tabs it opened close on exit. Do multi-step work in one invocation.
- `fs` writes inside the REPL are jailed to the session dir (`Path escapes agent root`) and that dir is wiped on exit. To extract files: write relative, keep the session alive with `await sleep(...)`, and copy from `~/.aside/u/0/agents/main/sessions/<id>/` in a parallel shell before the session ends.
- REPL stdout is buffered when redirected to a file; poll the sessions directory for artifacts instead of parsing the log.

## Skills: proactive use and self-authorship
- On every task, scan the available skills first. If one plausibly applies, read its SKILL.md and follow it without being asked. If mid-task you hit territory a skill covers, read it before improvising.
- Grow the skill library on your own initiative. Create a skill when a task kind recurs (about the third time) or when you work out a non-obvious workaround, recipe, or gotcha that future sessions would otherwise redo.
- Write skills to `~/.config/agents/skills/<kebab-case-name>/SKILL.md` (canonical store, shared with all agents). Frontmatter name: lowercase a-z, 0-9, hyphens only, matching the directory. Description must say what it does AND when to trigger it. Body: exact commands, paths, gotchas, no filler. Commit to the dotfiles repo.
- When a skill proves wrong or outdated while using it, fix it in the same session and commit.
- Bar for creation: would a future session without this conversation redo real work? One-off trivia and general model knowledge do not qualify.
