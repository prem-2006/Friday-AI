# Friday

Friday is a voice-first personal assistant for India. You talk to it in Hindi, English, Hinglish or another Indian language, and it does real tasks for you: it researches the web and answers with sources, phones businesses, and fills in simple websites. Then it tells you, out loud, what happened.

Example: _"Find a good dentist near Indiranagar open this evening, call and book tomorrow 6 PM, and add it to my calendar."_ Friday researches, places the call (after you approve), adds the calendar entry with its browser, and ends with one spoken summary. A live strip above the chat box shows each step as it happens.

Built for the Gnani AI #GreatIndianAIInternshipChallenge on top of [OpenDots](https://github.com/CopilotKit/OpenDots) by CopilotKit (MIT).

## Where the Gnani models are used

| Model           | Job in Friday                                                    | Code                                                                                                                            |
| --------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Evon v3.3**   | The planner in chat, and the voice on phone calls                | App model via `EVON_*` ([config.ts](../src/friday/server/config.ts)); calls via [bot.py](services/friday_services/calls/bot.py) |
| **Prisma v2.5** | Speech-to-text: your push-to-talk voice and the person on a call | [gnani.ts](../src/friday/server/gnani.ts) (REST); [stt.py](services/friday_services/calls/stt.py) (realtime, 8 kHz)             |
| **Timbre v2.5** | Everything Friday says, to you and on calls                      | [gnani.ts](../src/friday/server/gnani.ts) (REST, MP3); [bot.py](services/friday_services/calls/bot.py) (streaming, phone audio) |

No OpenAI speech is used. OpenDots' own OpenAI Realtime call button stays switched off without `VOICE_API_KEY`.

## What you need

| Item                                                                            | Needed for                                    | Goes in `.env`                                                                          |
| ------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| Gnani API key                                                                   | Push-to-talk, spoken replies, calls           | `GNANI_API_KEY`                                                                         |
| Evon endpoint, key, model id (challenge dashboard)                              | Everything Friday thinks                      | `EVON_BASE_URL`, `EVON_API_KEY`, `EVON_MODEL`                                           |
| CopilotKit account (free), via `npx copilotkit@latest login` + `project select` | Conversations (OpenDots requires it)          | Written for you: `CPK_INTELLIGENCE_API_KEY`                                             |
| A random 24+ character secret                                                   | OpenDots ↔ friday-services                    | `FRIDAY_SERVICES_TOKEN`                                                                 |
| Your name                                                                       | "Friday, an AI assistant calling for …"       | `FRIDAY_OWNER_NAME`                                                                     |
| Twilio account, number, verified test phone                                     | Phone calls only                              | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`                         |
| HTTPS tunnel to port 8765 (ngrok or cloudflared)                                | Phone calls only (Twilio webhooks and audio)  | `PUBLIC_URL`                                                                            |
| Docker Desktop running                                                          | Optional: Friday's own browser (Dot computer) | `COMPUTER_*` (see [COMPUTERS.md](../docs/COMPUTERS.md)), `FRIDAY_SERVICES_HOST=0.0.0.0` |
| Parallel API key                                                                | Optional: higher research limits              | `PARALLEL_API_KEY`                                                                      |

## Setup

Use Node.js 24, npm, and [uv](https://docs.astral.sh/uv/) (`python -m pip install uv`). Keep the project outside OneDrive or other synced folders.

```sh
npm ci
cp .env.example .env          # then fill in the table above
cd friday/services && python -m uv sync && cd ../..
```

Check each piece on its own. None of these places a call:

```sh
node --env-file-if-exists=.env friday/scripts/test-evon-tools.mjs        # Evon tool calling (uses a few Evon tokens)
node --env-file-if-exists=.env --import tsx friday/scripts/test-research.ts "dentist Indiranagar open evening"
```

Run it, in three terminals:

```sh
npm run dev                                                              # app: http://127.0.0.1:5173
cd friday/services && python -m uv run python -m friday_services         # services: port 8765
ngrok http 8765                                                          # only for phone calls; put the https URL in PUBLIC_URL
```

Then, with both running:

```sh
node --env-file-if-exists=.env friday/scripts/setup-friday-dot.mjs       # creates Friday, connects phone + calendar tools
node --env-file-if-exists=.env friday/scripts/check-services.mjs         # lists Friday's tools as OpenDots sees them
```

Open http://127.0.0.1:5173, pick **Friday**, and start a chat. Tap the mic to talk, choose the language beside it, and tap again to send.

## How it works

- **Voice:** the browser records a clip and re-encodes it as 16 kHz WAV. Prisma transcribes it, and the text goes in as a normal chat message, so approval cards and tool cards work as usual. Timbre then reads the final reply in the chosen language's voice. Languages: en-IN (default, handles Hinglish), hi-IN, kn-IN, ta-IN, te-IN, ml-IN, mr-IN, bn-IN, gu-IN, pa-IN.
- **Research:** OpenDots' `search_web` and `read_public_page` (Parallel). The persona tells Friday to compare options, check details on the source page, and give links.
- **Calls:** `start_call` always shows an **Approve & run** card first. Then `get_call_result` waits up to 40 s at a time until the call is answered, unanswered, or failed. On the line, Friday introduces itself as an AI assistant, pursues one goal, stops when interrupted, never agrees to prices or payment, and checks back with you on any counter-offer it wasn't told it could accept. Latency (end of their speech → Friday's first audio) is logged for every turn and returned with the result; the target is about 2 s.
- **Browser:** with a Dot computer, Friday opens the demo calendar at `/calendar` and fills in the form. Without one, it uses the `add_event` tool, which also asks first. `list_events` confirms the entry either way.
- **Safety:** Friday asks before paying, sharing personal details, or agreeing to a price. It never handles OTPs, passwords, bank details, or CAPTCHAs, and it always says it is an AI when talking to others.

## What lives where

| Path                                             | What it is                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| `friday/`                                        | Persona, docs, standalone check scripts                          |
| `friday/services/`                               | Python 3.12 service: phone calls, demo calendar, their MCP tools |
| `src/friday/`                                    | TypeScript inside the app: Evon settings, Gnani voice, step view |
| `tests/friday/`, `friday/services/tests/`        | Tests (all external services are faked)                          |
| [CHANGES-TO-OPENDOTS.md](CHANGES-TO-OPENDOTS.md) | Every OpenDots file Friday edits, and why                        |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)     | The design                                                       |

`main` tracks upstream OpenDots and the `friday` branch holds this work, so `git diff main..friday` shows exactly what Friday adds.

## Tests

```sh
npm run typecheck && npx vitest run tests/friday
cd friday/services && python -m uv run pytest && python -m uv run ruff check .
```

## Known limits

- **Not tested live yet.** Every Gnani, Evon, Twilio, and CopilotKit call is faked in tests to save credits. The structure, wiring, and protocols are verified, but real speech quality and call latency are not.
- **Evon tool calling is unconfirmed** until `test-evon-tools.mjs` runs against your endpoint. If the endpoint rejects `chat_template_kwargs`, set `EVON_DISABLE_THINKING=false`.
- **Twilio trial accounts** can only call verified numbers and play a trial notice first. Calling Indian numbers may need a paid account. Exotel (an Indian provider that Pipecat also supports) is a possible swap.
- **Pinned versions:** pipecat-gnani 0.5.12 needs pipecat-ai 1.5.x and gnani-vachana below 0.8, because newer releases break its imports.
- **Push-to-talk, not streaming:** each clip is up to 20 s. Calls do stream.
- **Dot computer setup:** Friday's own browser needs Docker and OpenBot images, plus `FRIDAY_SERVICES_HOST=0.0.0.0` so the container can reach the calendar page. Whether OpenBot's browser opens `host.docker.internal` is untested.
- **Persona length:** the persona is about 1,980 of the 2,000 characters OpenDots allows. A test guards this.
- **Conversations live in CopilotKit's cloud;** the local version is macOS-only.
- **Telegram texting was dropped** at the owner's request.

## Credit and license

Friday is built on [OpenDots](https://github.com/CopilotKit/OpenDots), an open-source template by CopilotKit released under the MIT license; its license is kept in [LICENSE](../LICENSE). Calls use [Pipecat](https://github.com/pipecat-ai/pipecat) and Gnani's [pipecat-gnani](https://docs.gnani.ai/pipecat/introduction.md) plugin. Friday's additions are released under the same MIT license.
