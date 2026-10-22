# Changes to OpenDots files

Friday keeps edits to upstream OpenDots files small and marks code edits with `FRIDAY:`. Everything else Friday adds is in new files under `friday/`, `src/friday/` and `tests/friday/`.

| File                      | Change                                                                                    | Why                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/server/index.ts`     | Model settings come from `fridayModelFromEnv`                                             | `EVON_*` replaces `OPENAI_*` as a set, so Evon is the app's model           |
| `src/server/dot-agent.ts` | Local time in the prompt; `fridayToolRounds`; `delegate_to_dot` tool; optional `delegate` | India time; chained tasks; Friday hands work to helper Dots                 |
| `src/server/platform.ts`  | `delegate` runs a helper Dot's turn in its "Tasks from Friday" conversation               | Helper Dots                                                                 |
| `src/server/app.ts`       | Mounts `fridayVoiceRoutes` and `fridayActivityRoutes` under `/api`                        | Gnani speech; live helper activity and the stop switch                      |
| `src/client/App.tsx`      | The voice stage is the home screen (`#/friday`); the classic view gets a Voice button     | Friday's main interface                                                     |
| `src/client/Chat.tsx`     | Adds `<FridayVoice>` to the composer and `<FridaySteps>` above it                         | Push-to-talk and live steps in the classic chat                             |
| `tsconfig.server.json`    | Compiles `src/friday/server` and `src/friday/shared`                                      | Friday's server code is built with the app                                  |
| `.env.example`            | A marked Friday block of variables                                                        | Evon, Gnani, services, time zone and turn limits                            |
| `README.md`               | A short Friday note at the top                                                            | Points readers to `friday/README.md`; the OpenDots README follows unchanged |

To see every change: `git diff main..friday -- src tests tsconfig.server.json .env.example README.md`
