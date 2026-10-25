# Friday

Friday is a voice-first personal assistant for India. You talk to it in Hindi, English, Hinglish or another Indian language, and it gets things done on your own PC. It searches and works on websites in a real browser window you can watch, opens desktop apps, and sends WhatsApp messages or starts WhatsApp calls once you say yes. It talks you through what it's doing as it goes.

Built for the Gnani AI #GreatIndianAIInternshipChallenge on top of [OpenDots](https://github.com/CopilotKit/OpenDots) by CopilotKit (MIT).

## The Dots

OpenDots calls each agent a **Dot**. Friday uses three:

| Dot           | What it does                                                                                                                                                                     | Its tools (from `friday/services`)                                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Friday**    | The one you talk to. Does one-step jobs itself at once, hands bigger jobs to the helpers.                                                                                        | Quick actions: `open_app`, `open_website`, `play_youtube`, `web_search`, `look_at_screen`, `snap_window`; `delegate_to_dot`; WhatsApp: find a chat, send a message, start a call |
| **Navigator** | Drives a real Chrome window on your screen. Multi-step jobs go to its browser agent ([browser-use](https://github.com/browser-use/browser-use)), which plans and acts by itself. | `browser_task`, `browser_search`, `browser_open`, `browser_click`, `browser_type`, …                                                                                             |
| **Operator**  | Opens and works Windows apps like Notepad or Calculator through Windows UI Automation.                                                                                           | `list_apps`, `open_app`, `window_snapshot`, `window_click`, `window_type`, `press_keys`                                                                                          |

When you ask for something, Friday says what it is handing over and calls `delegate_to_dot`. The helper then works in its own "Tasks from Friday" conversation. Each action it takes streams to the voice screen with a screenshot, Friday narrates the important ones out loud, and when the helper finishes, Friday sums up.

`friday/scripts/setup-friday-dot.mjs` creates all three Dots, gives each its persona (`friday/persona.md`, `friday/dots/*.md`) and connects its tools. Docker and OpenDots' "Dot computers" are not needed, because everything runs on your PC.

## Where the Gnani models are used

| Model           | Job in Friday                                         | Code                                                                                                                                 |
| --------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Evon v3.3**   | The brain of all three Dots                           | App model via `EVON_*` ([config.ts](../src/friday/server/config.ts))                                                                 |
| **Prisma v2.5** | Speech-to-text for everything you say                 | [gnani.ts](../src/friday/server/gnani.ts), fed by the hands-free listener ([handsFree.ts](../src/friday/client/stage/handsFree.ts))  |
| **Timbre v2.5** | Every word Friday says: replies, narration, approvals | [gnani.ts](../src/friday/server/gnani.ts), played by the voice stage ([FridayStage.tsx](../src/friday/client/stage/FridayStage.tsx)) |

## What you need

| Item                                                                        | Goes in `.env`                                |
| --------------------------------------------------------------------------- | --------------------------------------------- |
| Gnani API key                                                               | `GNANI_API_KEY`                               |
| Evon endpoint, key, model id (challenge dashboard)                          | `EVON_BASE_URL`, `EVON_API_KEY`, `EVON_MODEL` |
| CopilotKit account (free): `npx copilotkit@latest login` + `project select` | Written for you                               |
| Your name, for "sent by Friday, …'s AI assistant"                           | `FRIDAY_OWNER_NAME`                           |
| `FRIDAY_SERVICES_TOKEN`                                                     | Already generated in your `.env`              |
| Google Chrome, and WhatsApp Desktop signed in to your account               | Nothing to set                                |

## Setup and run

Use Node.js 24, npm and [uv](https://docs.astral.sh/uv/) (`python -m pip install uv`). Keep the project outside OneDrive.

```sh
npm ci
cd friday/services; python -m uv sync; cd ../..
cd friday/browser-agent; python -m uv sync; cd ../..   # Navigator's browser agent
```

Two terminals:

```sh
npm run dev               # the app
npm run friday:services   # browser, apps, WhatsApp, live activity (from the repo root)
```

Then, once:

```sh
npm run friday:setup    # creates Friday, Navigator, Operator; run again after updating Friday
node --env-file-if-exists=.env friday/scripts/check-services.mjs      # lists their tools as OpenDots sees them
node --env-file-if-exists=.env friday/scripts/test-evon-tools.mjs     # Evon tool calling (a few Evon tokens)
```

Open http://127.0.0.1:5173. The voice stage is the home screen.

- Tap the orb and talk.
- Tap it again to stop listening.
- The square button at the top right opens the classic chat view.
- `#/friday-demo` plays every animation without any keys.

Try saying:

- "Search for dentists near Indiranagar open this evening."
- "Open Notepad and write my shopping list: milk, eggs, bread."
- "WhatsApp Priya that I'm running ten minutes late." Friday reads the message back; you say yes.
- "Call Rahul on WhatsApp." Friday starts the call after your yes, and you talk.

## Pages and ports

| What                                                             | Address                              |
| ---------------------------------------------------------------- | ------------------------------------ |
| Main page: your details, Google account, permissions, shortcuts  | http://localhost:5173/ (or `#/home`) |
| Voice screen (the orb)                                           | http://localhost:5173/#/friday       |
| Desktop notch page (shown by `friday/desktop`)                   | http://localhost:5173/#/notch        |
| Dots (the OpenDots dashboard underneath)                         | http://localhost:5173/#/chat         |
| App server (API only; the pages above come through port 5173)    | http://127.0.0.1:4310                |
| Friday services (tools, live voice; `/health`, demo `/calendar`) | http://127.0.0.1:8765                |
| Friday's Chrome debugging port (for Friday's own tools only)     | 127.0.0.1:9333                       |

## Desktop notch

`friday/desktop` is a small Electron shell: a thin black pill just above the taskbar, like Wispr Flow. Hold Caps Lock anywhere to talk: the pill widens with bars that follow your voice, and again while Friday answers out loud. Clicking it opens the main page; its tray icon has Start with Windows and Quit.

```sh
cd friday/desktop; npm install; npm run install-shortcuts
```

This adds "Friday" to the Start menu and the desktop. The shell shows Friday from this folder's dev server, so changes to the folder appear at once, and it restarts itself when its own files change: there is nothing to reinstall. If the app or the services are not running, it starts them (logs in `data/desktop-*.log`). Only one voice window answers Caps Lock at a time, the newest: close the browser's voice screen and the notch takes over.

## Call Friday

Call the Sarvam number Friday calls you from, and Friday picks up and does what you say: "set a timer for 20 minutes", "what's my battery", "email Ravi that I'm late". Sarvam carries the call (the number, hearing and the voice), but Friday does the thinking: Sarvam's agent is set up as a relay that sends everything the caller says to its `ask_friday` tool and says Friday's answer word for word. The tool reaches `POST /phone/ask` on the services through a fixed ngrok address.

Who answers depends on who is calling. Sarvam sends the caller as a code (SHA-256 of the number), which Friday matches against your number and your contacts:

- **You** (`FRIDAY_OWNER_PHONE` or Your details) get the **Friday** Dot itself, in its own "Friday phone" conversation: everything Friday can do on the desktop, it can do on a call. Something that needs your OK is read back, and a "yes" or "haan" on the same call approves it. A request that takes longer than about 20 s keeps running; ask "is it done?" to hear the result.
- **Anyone else** gets the **Reception** Dot: no tools, no memory, only its own empty "Phone callers" Space, and none of your details or contacts. It says it is Friday, your AI assistant, answers general questions, shares nothing about you and takes a message. Every word they say is saved to your notes under their contact name.
- On a call **Friday placed**, the reason (`reason`) goes along, so Friday or Reception stays on why it called.

Once:

1. **ngrok:** sign up free at dashboard.ngrok.com, copy your authtoken, and claim your free static domain (Domains). Put them in `.env` as `NGROK_AUTHTOKEN` and `NGROK_DOMAIN`, then restart the services. They print `Phone: Friday answers at https://<your domain>`.
2. **Reception:** run the setup script again (`node --env-file-if-exists=.env friday/scripts/setup-friday-dot.mjs`); it creates the Reception Dot and its Space.
3. **The agent's tool:** in indus.sarvam.ai, open Friday's agent → Tools → add an API tool:
   - Name `ask_friday`; description "Friday's answer to what the caller just said".
   - `POST https://<your domain>/phone/ask`; Auth: bearer token = `FRIDAY_PHONE_TOKEN` from `.env`.
   - Body (type `@` to insert the variables): `{"transcript": "@Call Transcript", "caller": "@User Identifier", "call_id": "@Interaction ID", "reason": "@reason"}`.
   - Max wait 30 s; response template: say `@reply` exactly; if it fails: "Sorry, I couldn't reach Friday. Please try again."
4. **The agent's greeting and instructions:** the greeting (the agent's first message) must be only the variable `opening_line` (type `@` and pick it), not fixed text: calls Friday places fill it with "Hi, I'm Friday…" and why it called. Give `opening_line` the default value "Hi, I'm Friday. How can I help you?", which is what someone calling the number hears, and give `reason` an empty default. Replace the instructions with the relay instructions below. Commit a new version.
5. **Inbound:** Deploy → Inbounds → Create Inbound with that agent version, your Sarvam connection and number (`SARVAM_AGENT_NUMBER`), every day, calls allowed 00:00–23:59. If Sarvam does not allow the same number for inbound, rent a second number for it.

The relay instructions for the Sarvam agent:

```text
You are only the voice of Friday. Friday thinks; you never answer by yourself.
After your first message, every time the caller says anything, call tool:ask_friday right away, then say its reply exactly, word for word, in the caller's language. Do not add, shorten or change anything, and do not greet again.
If the reply is long to come, do not fill the silence.
If the tool fails, say: Sorry, I couldn't reach Friday. Please try again.
When the caller says bye, or the reply says goodbye, say a short goodbye and end the call.
```

## How the voice stage works

- **Fast turns:** the voice stage runs Friday directly on the app server and keeps its own short conversation (the circular-arrow button starts a new one). The hosted conversation service is skipped there because it added 4–6 s per turn; the classic dashboard still uses it. Helper Dots also run directly.
- **Live voice:** the voice screen talks to `friday/services` over WebRTC, where a Pipecat pipeline hears you with **Gnani streaming speech-to-text** (with Silero voice detection) and speaks with **Gnani streaming text-to-speech**, so Friday's voice starts as it is made and stops the moment you talk over it. Friday's thinking is unchanged: the screen sends what was heard to the Friday Dot, which uses its quick actions or the helper Dots. Mic audio reaches Gnani only while Caps Lock is held (plus a second of silence), so idle time costs no credits. If the services are not running, the screen falls back to sending recorded clips to Gnani.
- **Talking:** Friday hears you **only while Caps Lock is held**, in any app (a quick tap is still ordinary Caps Lock). **Clap twice** to open the voice screen if it is closed. Caps Lock and claps are handled by `friday/services` (a keyboard hook that acts on Caps Lock alone, and a clap detector that looks only at loudness peaks; no audio is kept or sent). Turn them off with `FRIDAY_PUSH_TO_TALK=false` or `FRIDAY_CLAP_WAKE=false`; lower `FRIDAY_CLAP_LEVEL` (default 0.25) if your claps are not noticed.
- **Quick actions:** one-step requests ("open Notepad", "play Arijit Singh", "what's on my screen", "put Chrome on the left") run as Friday's own tools, with no helper hand-off. Each returns the sentence to speak, which ends the turn without another model call: "Open Notepad" takes about 1.5 s instead of 17 s. "Look at my screen" and window snapping come from Julian Ivanov's jarvis-voice-assistant (MIT), rebuilt on Win32 and the EVON_* model. A screenshot goes to that model only when you ask Friday to look.
- **Gemini speed:** with Gemini as the brain, `FRIDAY_MODEL_OPTIONS='{"reasoning_effort":"none"}'` skips its thinking step and halves the wait.
- **Paused:** if the dashboard's Pause button is on, Friday shows "Friday is paused" with a Resume button; nothing runs while paused.
- **Timings:** each turn logs `[Friday] heard … · answered … · voice …` in the browser console.

- **Hands-free:** the mic stays open, but a voice-activity detector records only while you speak (with half a second of pre-roll so your first word is kept, ending 0.7 s after you stop), so silence never spends Gnani credits. Each stretch of speech (up to 20 s) goes to Prisma.
- **Talking back:** Timbre speaks the reply sentence by sentence, starting while the rest is still being made. While Friday is speaking, only "stop", "yes" or "no" count, so its own voice coming back through the mic is ignored; "stop", "ruko", "bas" or the red button stops the task and every on-screen action.
- **Narration:** helper actions arrive live and Friday speaks the important ones, at most one line every few seconds. Small steps like clicks are shown but not spoken.
- **Approvals:** a WhatsApp send or call shows OpenDots' approval card, and Friday asks out loud. Short answers like "yes", "haan" or "theek hai", or "no" and "nahin", press the real Approve or Decline button. You can also tap them.
- **The orb:** it reacts to your voice while listening, swirls while thinking, pulses with Friday's voice, and shows each busy helper Dot orbiting it.

## Safety

- **WhatsApp:** messages and calls always need your yes. Friday checks that the chat it opened is the person you named, stops if a name matches several chats, and signs messages as sent by Friday, your AI assistant.
- **Browser and apps:** Navigator and Operator refuse password, card and OTP fields, never pay or accept terms, and can't touch WhatsApp windows.
- **Your Chrome profile:** Friday's browser has its own profile, so your personal logins are untouched.
- **Stop switch:** the stop button blocks every on-screen action until the task has ended.

## What lives where

| Path                                             | What it is                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| `friday/persona.md`, `friday/dots/`              | Personas for Friday, Navigator and Operator                                   |
| `friday/services/`                               | Python service: browser, desktop apps, WhatsApp, activity feed, demo calendar |
| `src/friday/client/stage/`                       | The voice stage: orb, hands-free listener, narration, approvals               |
| `src/friday/server/`                             | Evon settings, Gnani voice, `delegate_to_dot`, activity relay                 |
| `tests/friday/`, `friday/services/tests/`        | Tests (Gnani, Evon and WhatsApp are faked; the browser test uses real Chrome) |
| [CHANGES-TO-OPENDOTS.md](CHANGES-TO-OPENDOTS.md) | Every OpenDots file Friday edits, and why                                     |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)     | The design                                                                    |

`main` tracks upstream OpenDots and the `friday` branch holds this work, so `git diff main..friday` shows exactly what Friday adds.

## Tests

```sh
npm run typecheck; npx vitest run tests/friday
cd friday/services; python -m uv run pytest; python -m uv run ruff check .; cd ../..
cd friday/browser-agent; python -m uv run pytest
```

## Known limits

- **Not tested live with your keys.** Gnani, Evon, CopilotKit and WhatsApp are faked in tests. The browser code was tested by driving real Chrome through the demo calendar, and app listing was checked on this PC.
- **WhatsApp automation** relies on WhatsApp Desktop's control names ("Search or start a new chat", "Voice call"). A WhatsApp update can change them. Try `whatsapp_find_chat` first, since it sends nothing.
- **Friday doesn't speak on WhatsApp calls;** it starts them and you talk. Speaking on calls would need a virtual audio cable.
- **Operator** depends on how well each app exposes Windows UI Automation. Most standard apps work; some custom-drawn ones don't.
- **Helpers have no approval cards,** because they run in background conversations. Their browser and app tools run without asking. Anything sensitive (WhatsApp) stays with Friday behind your OK.
- **Echo:** echo cancellation and a raised threshold while Friday speaks keep it from hearing itself, but headphones work best.
- **Phone calls over Twilio** (the earlier calling service) are parked; the code remains under `friday/services/friday_services/calls`.
- **The browser agent** (browser-use, `friday/browser-agent`) runs in its own Python environment because it pins exact library versions; it attaches to Navigator's Chrome window through Chrome's debugging port on 127.0.0.1 (`FRIDAY_BROWSER_CDP_PORT`). Every step is one model call, so a free Gemini key runs out quickly; its log is `friday/services/data/browser-agent.log`.
- **Playing on YouTube** takes 4–7 s, mostly YouTube's own page load; the services open Chrome at start (`FRIDAY_BROWSER_PREWARM`) so the first request skips Chrome's startup.
- **Conversations live in CopilotKit's cloud** (its local version is macOS-only). Telegram was dropped.

## Credit and license

Friday is built on [OpenDots](https://github.com/CopilotKit/OpenDots), an open-source template by CopilotKit released under the MIT license; its license is kept in [LICENSE](../LICENSE). The browser uses [Playwright](https://playwright.dev), desktop apps use [pywinauto](https://github.com/pywinauto/pywinauto), and speech uses Gnani's Prisma and Timbre. Friday's additions are released under the same MIT license. Every project Friday is built on, took ideas from or uses, and where each one lives, is listed in [CREDITS.md](CREDITS.md).
