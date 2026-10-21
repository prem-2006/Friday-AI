# Changes to OpenDots files

Friday keeps edits to upstream OpenDots files small and marks code edits with `FRIDAY:`. Everything else Friday adds is in new files under `friday/`, `src/friday/` and `tests/friday/`.

| File                      | Change                                                    | Why                                                                            |
| ------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/server/index.ts`     | Model settings come from `fridayModelFromEnv`             | `EVON_*` replaces `OPENAI_*` as a set, so Evon is the app's model              |
| `src/server/dot-agent.ts` | The prompt adds the owner's local time after the UTC time | "Tomorrow at 6 PM" has to mean India time (`TIMEZONE`, default `Asia/Kolkata`) |
| `tsconfig.server.json`    | Compiles `src/friday/server`                              | Friday's server code is built with the app                                     |
| `.env.example`            | A marked Friday block of variables                        | Evon, Gnani, Twilio, Telegram and time zone settings                           |

To see every change: `git diff main..friday -- src tests tsconfig.server.json .env.example`
