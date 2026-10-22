// Friday: the voice stage's own turn endpoint. It runs the Friday Dot
// directly (see direct-run.ts) with the history the stage sends.
import { Hono } from 'hono';
import { z } from 'zod';
import type { Message } from '@ag-ui/core';
import { FRIDAY_DOT_NAME } from './delegate.js';
import {
  localThread,
  runDotDirectly,
  type DirectPlatform,
} from './direct-run.js';

export const VOICE_THREAD_TITLE = 'Friday voice';
const MAX_MESSAGES = 40;

const message = z
  .object({
    id: z.string().min(1).max(200),
    role: z.enum(['user', 'assistant', 'tool']),
  })
  .passthrough();

type Run = typeof runDotDirectly;

export function fridayRunRoutes(
  platform: DirectPlatform,
  run: Run = runDotDirectly,
) {
  const app = new Hono();
  app.post('/friday/voice/run', async (c) => {
    const input = z
      .object({ messages: z.array(message).min(1).max(MAX_MESSAGES) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      return c.json({ error: 'Send the conversation messages.' }, 400);
    const friday = platform.workspace
      .dots()
      .find((dot) => dot.name === FRIDAY_DOT_NAME);
    if (!friday)
      return c.json(
        { error: 'Friday is not set up yet. Run the setup script.' },
        404,
      );
    if (platform.store.settings().paused)
      return c.json(
        { error: 'Friday is paused. Tap Resume to continue.' },
        409,
      );
    const thread = localThread(platform, friday.id, VOICE_THREAD_TITLE);
    try {
      const newMessages = await run(
        platform,
        friday.id,
        thread.id,
        input.data.messages as unknown as Message[],
        { approvals: true, signal: c.req.raw.signal },
      );
      return c.json({ threadId: thread.id, newMessages });
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error && error.message
              ? error.message
              : 'Friday could not finish that.',
        },
        502,
      );
    }
  });
  return app;
}
