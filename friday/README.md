# Friday

Friday is a voice-first personal assistant for India. You talk to it in Hindi, English, Hinglish or another Indian language, and it does real tasks for you: it researches, phones businesses, texts your contacts and works on simple websites, then tells you what happened out loud.

Built for the Gnani AI #GreatIndianAIInternshipChallenge on top of [OpenDots](https://github.com/CopilotKit/OpenDots) by CopilotKit (MIT).

## Gnani models

| Model           | Job in Friday                                                         | Status                                                                                                             |
| --------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Evon v3.3**   | The planner: reads your request, picks tools, chains the steps        | Wired as the app's model (`EVON_*` in `.env`). Tool-call check: [test-evon-tools.mjs](scripts/test-evon-tools.mjs) |
| **Prisma v2.5** | Speech-to-text for your voice and for the other person on phone calls | Phase 4 (your voice), Phase 3 (calls)                                                                              |
| **Timbre v2.5** | Every word Friday speaks, to you and on phone calls                   | Phase 4 (your voice), Phase 3 (calls)                                                                              |

## Setup

Use Node.js 24 and npm. Keep the project outside OneDrive or other synced folders.

```sh
npm ci
cp .env.example .env
```

1. Fill in the Friday block of `.env`: `EVON_BASE_URL`, `EVON_API_KEY`, `EVON_MODEL`. When `EVON_BASE_URL` is set, these replace `OPENAI_*`. The setup screen still names `OPENAI_API_KEY` and `OPENAI_MODEL` as missing until the Evon values are in.
2. Check Evon's tool calling: `node --env-file-if-exists=.env friday/scripts/test-evon-tools.mjs`
3. Connect hosted CopilotKit Intelligence, which OpenDots needs for conversations. Its local version does not run on Windows.
   ```sh
   npx copilotkit@latest login
   npx copilotkit@latest project select
   ```
4. Start the app with `npm run dev` and open http://127.0.0.1:5173.
5. With the app running, create the Friday Dot: `node --env-file-if-exists=.env friday/scripts/setup-friday-dot.mjs`

## What lives where

| Path                                             | What it is                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `friday/`                                        | Friday's docs, persona, standalone check scripts and (later) the Python services |
| `src/friday/`                                    | TypeScript that runs inside the OpenDots app                                     |
| `tests/friday/`                                  | Tests for `src/friday/`                                                          |
| [CHANGES-TO-OPENDOTS.md](CHANGES-TO-OPENDOTS.md) | Every OpenDots file Friday edits, and why                                        |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)     | The design                                                                       |

Everything else is OpenDots. The `main` branch tracks upstream OpenDots and the `friday` branch holds this work, so `git diff main..friday` shows exactly what Friday adds.

## Check scripts

| Script                                                       | Checks                                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| [scripts/test-evon-tools.mjs](scripts/test-evon-tools.mjs)   | Evon returns OpenAI-style tool calls, streamed and not, including Hinglish |
| [scripts/setup-friday-dot.mjs](scripts/setup-friday-dot.mjs) | Creates or updates the Friday Dot with [persona.md](persona.md)            |

## Credit and license

Friday is built on [OpenDots](https://github.com/CopilotKit/OpenDots), an open-source template by CopilotKit released under the MIT license. The OpenDots license is kept in [LICENSE](../LICENSE). Friday's additions are released under the same MIT license.
