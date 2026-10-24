# Project memory

This project is built with several AI tools (Claude Code, Codex and others).
`docs/progress.md` is the shared memory between them: the full record of the
project from the start to now.

## Rules for every session
- At the start, read docs/progress.md before doing anything.
- Before the session ends, update docs/progress.md:
  - Add a line under History (today's date) for everything done, marked
    **Added**, **Changed** or **Removed**.
  - Anything removed or replaced also goes in the "Removed or replaced" table,
    with what replaced it and why.
  - New decisions go under Decisions. A reversed decision is struck out
    (~~like this~~) with the date, never deleted.
  - Keep "What Friday has now" true to the current state.
  - Rewrite "Next" to say what's open.
- Never delete history. Old entries stay so any tool can see how things got here.
- When the user says "update progress.md", do that now.
- When the user says "continue", read docs/progress.md and pick up the "Next" items.
