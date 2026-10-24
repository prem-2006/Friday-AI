# Project memory

This project is built with several AI tools (Claude Code, Codex and others).
`docs/progress.md` is the shared memory between them.

## Rules for every session
- At the start, read docs/progress.md before doing anything.
- Before the session ends, update docs/progress.md with:
  what was done, decisions made, and what's next.
- Keep progress.md short. Replace old info instead of adding endlessly.
- When the user says "update progress.md", do that now.
- When the user says "continue", read docs/progress.md and pick up the "Next" items.
