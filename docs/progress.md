# Progress

The full record of Friday, from the start to now: what exists, every decision,
and everything added, changed or removed. Newest history is at the bottom.

Last updated: 2026-10-24, by Claude Code (branch `friday`, base `main`)

---

## 1. What this is

Friday is a voice-first personal assistant for India, built for the Gnani AI
#GreatIndianAIInternshipChallenge. It researches, works in a browser and in
desktop apps on the owner's PC, makes and takes phone calls, sends WhatsApp
messages and email after the owner's OK, and keeps reminders, notes and
deadlines.

It is built on **OpenDots** by CopilotKit (MIT). Friday keeps edits to
OpenDots files small and marks them `FRIDAY:`. The list is in
`friday/CHANGES-TO-OPENDOTS.md`.

Built by premsingh10193, with ruchita44aa as co-author on the early phases.

## 2. Where things are

| Path | What it is |
| --- | --- |
| `friday/README.md` | Start here: setup, pages, ports, what to say |
| `friday/docs/ARCHITECTURE.md` | The design |
| `friday/persona.md` | Friday's instructions (plus Navigator, Operator and Coder personas) |
| `friday/services/friday_services/` | Python 3.12 services (uv): voice, calls, browser, desktop, WhatsApp, reminders |
| `friday/services/friday_services/calls/` | `sarvam.py`, `inya.py`, `twilio.py`, `bot.py`, `prompts.py`, `store.py`, `stt.py` |
| `friday/browser-agent/` | browser-use agent (its own environment, pinned versions) |
| `friday/desktop/` | Electron shell for the notch |
| `friday/dots/`, `friday/scripts/` | Dot setup (`setup-friday-dot.mjs`) and checks |
| `src/friday/` | Friday's web app and server code (TypeScript) |
| `tests/friday/` | Friday's tests (all use fakes, no credits spent) |
| `data/` | Local only, git-ignored: profile, contacts, voice log, modes |

## 3. What Friday has now

**Models**
- Planning: Gnani Evon (`EVON_*` replaces OpenDots' `OPENAI_*`).
- Rotation: every key in `FRIDAY_PRIMARY_KEYS` with every model in
  `FRIDAY_PRIMARY_MODELS` (Gemini), then the backup `FRIDAY_FALLBACK_*`
  (e.g. OpenRouter). A model that runs out rests for 10 minutes. 400, 403, 404
  and 429/503 move on to the next model instead of failing the turn.
- Gemini fixes: tool-call indexes are filled in, thought signatures are kept.

**Voice**
- Speech: Gnani Prisma (STT) and Timbre v2.5 (TTS), streaming through a
  Pipecat pipeline over WebRTC. Replies use Gnani's SSE stream, one per reply.
- Hold Caps Lock to talk, in any app. Ctrl + Caps Lock hides or shows the notch.
- Talking over Friday interrupts it. Echo of its own voice is ignored.
- Languages: en-IN (default, handles Hinglish), hi, kn, ta, te, ml, mr, bn, gu, pa.
- Common mishearings are fixed before acting ("ei" -> AI, Gmail, WhatsApp...).
- Each turn is logged in `data/friday-voice.log`.

**Screens**
- `#/home` (default): main page with a J-style console, your details, Google
  account, Contacts, Calls (with transcripts), permissions, shortcuts,
  reminders and deadlines.
- `#/friday`: full-screen voice stage (particle orb, HUD rings, 64 voice bars).
- `#/notch`: thin pill above the taskbar, in the Electron shell. It starts
  with Windows, restarts the app and services when they stop, and reconnects
  by itself. It never takes the mouse, except for an approval card.
- `#/chat`: the classic OpenDots view.

**Dots (agents)**
- Friday: the main assistant, with quick actions.
- Navigator: the on-screen Chrome (Playwright and browser-use), searches on
  YouTube and Google, works in Gmail, Calendar and Drive.
- Operator: desktop apps through Windows UI Automation.
- Coder: LeetCode-style practice. It stops on live contests, assessments and
  interviews.

**Quick actions** (a quick action ends the turn at once)
open_app, open_website, play_youtube, media_control, web_search,
look_at_screen, snap_window, write_in_app, clear_in_app, press_keys_in_app,
find_files, open_file, schedule_meeting, send_email, draft_email, remember,
set_timer, add_reminder, add_deadline, list_reminders, finish_reminder,
take_note, read_notes, show_notes, run_mode, focus_session, system_status,
lock_screen, take_screenshot, weather, directions, call_me, start_call,
schedule_call.

**Phone calls**
- To the owner ("call me", "call Prem", deadlines, reminders): Sarvam if
  `SARVAM_*` is set, else Gnani Inya (`INYA_*`), else Twilio. At most one
  call in 10 minutes and 8 a day.
- To contacts (start_call, schedule_call): Sarvam first, Twilio as fallback.
  No OK is needed.
- `FRIDAY_TWILIO=off` keeps the Twilio code but never uses it, and the
  tunnel doesn't open.
- With Twilio on: a Cloudflare quick tunnel opens by itself, and the owner can
  call Friday's number for updates. With Inya, a missed call gets a call back.

**Safety rules**
- Friday asks first before sending email, WhatsApp messages or calls,
  meetings and lock screen.
- Password, card and OTP fields are refused. No CAPTCHA solving.
- Nothing is searched invisibly: background web search is off for all Dots.
- To other people, Friday always says it is an AI assistant. It never pays,
  shares personal details or agrees to a price without asking.

## 4. Decisions (all, still in force unless struck out)

- Gnani is the core: Evon plans, Prisma hears, Timbre speaks.
- Friday is built on OpenDots, with small marked edits and Friday code in new files.
- India time (`TIMEZONE`, default Asia/Kolkata). A time with a zone is
  converted to India time. A time without AM/PM means the next one to come.
- Telegram is out of scope (owner's call, 10-22): focus on voice, research
  and the browser.
- Voice turns run directly on the app server, not through the hosted
  conversation service (4-6 s faster from India).
- Searches happen in the visible browser only.
- Friday listens only while Caps Lock is held. Hands-free mode was removed (10-23).
- Friday's Chrome is an ordinary Chrome with its own profile, so Google
  sign-in works. Only Friday's send_email sends mail; Navigator can't press Send.
- Calls to others need no OK (10-23). This replaced "always ask first".
- Sarvam is the main path for calls. Twilio is optional and can be switched off.
- Commit messages say what Friday now does, in plain words ("Friday ...").
- Every AI tool reads this file first and updates it before switching. Say
  "update progress.md" before switching and "continue" in the next tool.
- This file keeps the full history. Old entries are never deleted. When
  something is removed or replaced, it is logged as Removed or Changed.
- ~~Phone calls left for later~~ (10-23 17:39), reversed the same evening.
- ~~No Sarvam~~ (10-23 17:39), reversed: Sarvam was added at 23:41.

## 5. Removed or replaced (all)

| When | What went | Why / what replaced it |
| --- | --- | --- |
| 10-22 | Telegram skill (`TELEGRAM_BOT_TOKEN`, MCP endpoint, persona lines) | The owner chose voice, research and the browser |
| 10-22 | Parked phone and calendar MCP connections on the Dots | Helper Dots took over the work |
| 10-22 | Background (invisible) web search for all Dots | Searches go through Navigator in the visible Chrome |
| 10-22 | OpenDots inspector, names and branding on the voice stage | Friday's own title, icon and wording |
| 10-22 | Hosted conversation service for voice turns | Direct runs on the app server (`/api/friday/voice/run`) |
| 10-23 | The stage's typing box | Voice only: tap the orb |
| 10-23 | Hands-free mode (VAD listening without a key) | Caps Lock hold only. A clap just opens the voice screen |
| 10-23 | Recorded-clip voice as the main path | Pipecat WebRTC live voice (clips remain the fallback) |
| 10-23 | Gnani WebSocket TTS | SSE stream per reply (WebSocket went silent after idle) |
| 10-23 | RTVI | Switched off, unused |
| 10-23 | Playwright-launched Chrome | Ordinary Chrome on a debugging port (Google refused the other) |
| 10-23 | "Ask first" before calling someone | Calls to others go straight through |
| 10-23 | start_call to the owner | call_me (no OK card) |
| 10-24 | Caps Lock going to the newest voice window | Always goes to the notch when it is open |
| 10-24 | Trusting the keyboard library for Ctrl | Ask Windows whether Ctrl is down |
| 10-24 | Gemini thought signatures dropped by the adapter | Kept and put back |
| 10-24 | Twilio as the only way to call others | Sarvam first. Twilio can be off |

## 6. History (every change, oldest first)

### Before Friday: OpenDots upstream (09-29 to 10-15)
CopilotKit's OpenDots template: Spaces, Threads, per-Dot computers, inline
pages and approvals, a Realtime call screen, TanStack AI, Parallel search,
Automatic Learning, MCP connections per Dot, Composio apps, dark mode, and
many fixes from contributors. Friday branched from here.

### 10-22: Friday is founded
- **Added** architecture doc and an Evon tool-call check script.
- **Changed** the model to Gnani Evon. Prompts now include India time.
- **Added** persona and `setup-friday-dot.mjs`, the README, and the OpenDots change list.
- **Added** phase 3, the calling service: Twilio -> Prisma -> Evon -> Timbre
  on Pipecat, with MCP tools start_call and get_call_result. Versions are
  pinned: pipecat-ai 1.5.x, pipecat-gnani 0.5.12, gnani-vachana <0.8.
- **Added** phase 4, push-to-talk in chat (WAV to Prisma, Timbre reads replies), in 10 languages.
- **Removed** Telegram.
- **Added** research with sources, a demo calendar at `/calendar` with MCP tools, and a live step strip.
- **Added** services for the on-screen browser, desktop apps, WhatsApp, and
  a live activity stream with a stop switch.
- **Added** helper Dots Navigator and Operator (`delegate_to_dot`).
- **Added** the voice stage with an orb, voice approvals and narration of helpers.
- **Changed** voice to be about 3x faster (6.2 s -> 1.5 s): direct runs, the
  watcher ignores services, sentence-by-sentence speech.
- **Added** the per-turn voice log.
- **Changed** searches to the visible browser (YouTube or Google). Retries on Gnani and model 429s.

### 10-23: voice, desktop, Google, calls
- **Added** browser-use agent for multi-step web tasks, and npm scripts to
  start everything.
- **Added** quick actions ("Open Notepad" went from 17 s to 1.7 s) and faster app opening.
- **Changed** the stage to a particle orb. Speech detection counts only the voice band.
- **Added** the backup model for rate limits. **Removed** the stage typing box.
- **Added** hold Caps Lock to talk, double clap, voice bars.
- **Changed** echo handling, so requests are no longer lost and talking over Friday interrupts.
- **Added** Pipecat live voice over WebRTC. Split sentences are joined.
- **Removed** hands-free mode. **Added** write_in_app.
- **Changed** Chrome to an ordinary process, for the owner's Google account.
  **Added** send_email (asks first).
- **Added** the main page `#/home`: details, Google, permissions, shortcuts,
  and Gmail account display.
- **Added** the desktop notch (Electron): it starts with Windows and restarts itself.
- **Changed** TTS from WebSocket to SSE. Errors clear after 6 s.
- **Added** media controls, editing apps, files, meetings, memory and the
  Coder Dot. Ctrl + Caps Lock toggles the notch.
- **Added** everything the ARRC J kit does: timers, reminders, deadlines,
  notes, modes, focus, status, lock, screenshot, weather, directions, drafts,
  the reminder clock and the J console look.
- **Changed** the notch to reconnect by itself. Times convert to India time.
  Mishearings are fixed. The notch ignores the mouse.
- **Added** phone calls: Friday calls you, calls others, you can call it, and
  a Cloudflare tunnel.
- **Changed** reminder calls to use Friday's own words. The mic survives a
  switch. A time without AM/PM means the next one to come.
- **Added** calls to the owner through Gnani Inya, with a missed-call ring-back.
- **Changed** Caps Lock to always go to the notch.
- **Changed** (fix) Gemini tool calls now get their index.
- **Changed** notch Approve to work on press. **Changed** "call Prem" to use call_me.
- **Added** Caps Lock and approval logging.
- **Added** calls to the owner through Sarvam (Sarvam -> Inya -> Twilio).
- **Removed** the OK before calling someone.

### 10-24: reliability, contacts, Sarvam for everyone
- **Changed** "call Prem" to ring at once. Approval cards use the saved approval.
- **Changed** Friday to always answer: orphan tool calls are dropped, and live voice reconnects.
- **Added** Contacts on the main page (`data/friday-contacts.json`, +91 added).
- **Added** Gemini model and key rotation before the backup. Rotation skips
  400, 403 and 404 refusals.
- **Changed** (fix) the notch no longer sticks on "Listening". Ctrl is read from Windows.
- **Changed** call_me to always try (the voice history starts fresh).
- **Added** logging of backup-model refusals. **Changed** Gemini thought signatures to be kept.
- **Added** start_call through Sarvam, and `FRIDAY_TWILIO=off`.
- **Added** a Calls section on the main page with Sarvam transcripts (analytics API).
- **Added** schedule_call: Sarvam phones people at a set time.
- **Added** shared memory for AI tools: `AGENTS.md`, `CLAUDE.md` (-> AGENTS.md), and this file.
- **Changed** this file to keep the full history (it had been short, with old info replaced).

## 7. Next
- No feature work is open. Ask the owner what to build next.
- Known limits (from `friday/README.md`): Pipecat versions are pinned, Twilio
  trial limits, Dot computer networking.
