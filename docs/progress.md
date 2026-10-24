# Progress

Last updated: 2026-10-24, by Claude Code (branch `friday`)

## What this is
Friday is a voice-first personal assistant for India, built on OpenDots for the
Gnani AI challenge. Start with `friday/README.md`. The Python services are in
`friday/services/friday_services/`, and the web app is in `src/`.

## Done (recent)
- Shared memory for all AI tools: `AGENTS.md` (rules), `CLAUDE.md` (points
  Claude Code at AGENTS.md), and this file.
- Calls: Friday calls contacts through Sarvam (`calls/sarvam.py`), schedules
  calls to other people, and the main page shows each call with what was said.
  Twilio can be switched off.
- Calls to the owner through Gnani's Inya agent (`calls/inya.py`, `owner_calls.py`).
- Model rotation: goes through Gemini models and keys, skips 403/404 and refused
  models, keeps Gemini thought signatures, then falls back to a backup model.
- Desktop notch: hold Caps Lock to talk; Ctrl + Caps Lock hides or shows it.
- Main page: Contacts, your details, Google account, permissions, shortcuts.

## Decisions
- Sarvam is the main path for calls to other people; Twilio is optional.
- Commit messages say what Friday now does, in plain words ("Friday ...").
- Every tool reads docs/progress.md first and updates it before switching.
  Say "update progress.md" before switching, and "continue" in the next tool.

## Next
- No feature work is open. Ask the owner what to build next.
