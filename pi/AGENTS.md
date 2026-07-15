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
