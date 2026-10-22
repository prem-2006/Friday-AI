# Changes to OpenDots files

Friday keeps edits to upstream OpenDots files small and marks code edits with `FRIDAY:`. Everything else Friday adds is in new files under `friday/`, `src/friday/` and `tests/friday/`.

| File                      | Change                                                                 | Why                                                                         |
| ------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/server/index.ts`     | Model settings come from `fridayModelFromEnv`                          | `EVON_*` replaces `OPENAI_*` as a set, so Evon is the app's model           |
| `src/server/dot-agent.ts` | Prompt adds the owner's local time; tool rounds use `fridayToolRounds` | "Tomorrow 6 PM" means India time; chained tasks and call waits need rounds  |
| `src/server/app.ts`       | Mounts `fridayVoiceRoutes` under `/api`                                | Prisma and Timbre for push-to-talk, with the key kept on the server         |
| `src/client/Chat.tsx`     | Adds `<FridayVoice>` to the composer and `<FridaySteps>` above it      | Push-to-talk, spoken replies, live step view                                |
| `tsconfig.server.json`    | Compiles `src/friday/server` and `src/friday/shared`                   | Friday's server code is built with the app                                  |
| `.env.example`            | A marked Friday block of variables                                     | Evon, Gnani, Twilio, services, time zone and turn limits                    |
| `README.md`               | A short Friday note at the top                                         | Points readers to `friday/README.md`; the OpenDots README follows unchanged |

To see every change: `git diff main..friday -- src tests tsconfig.server.json .env.example README.md`
