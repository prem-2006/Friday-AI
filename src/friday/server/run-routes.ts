// Friday: the voice stage's own turn endpoint. It runs the Friday Dot
// directly (see direct-run.ts) with the history the stage sends.
import { Hono } from 'hono';
import { z } from 'zod';
import type { Message } from '@ag-ui/core';
import { FRIDAY_DOT_NAME } from './delegate.js';
import { voiceLog } from './voice-log.js';
import { fallbackReply } from './quick-finish.js';
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
    // Other roles (e.g. "reasoning" from models that think out loud) are
    // accepted here and left out below.
    role: z.string().min(1).max(40),
  })
  .passthrough();
const CONVERSATION_ROLES = new Set(['user', 'assistant', 'tool']);
const conversational = <T extends { role: string }>(items: T[]) =>
  items.filter((item) => CONVERSATION_ROLES.has(item.role));

type HistoryItem = {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolCalls?: { id: string }[];
};
// An action that never got an answer (an approval that expired, a run cut
// short) leaves a tool call with no result in the screen's history, and the
// model then ends every later turn at once with nothing to say. Drop those.
const answeredOnly = <T extends HistoryItem>(items: T[]) => {
  const answered = new Set(
    items.flatMap((item) => (item.role === 'tool' ? [item.toolCallId] : [])),
  );
  return items.flatMap((item) => {
    if (item.role !== 'assistant' || !item.toolCalls?.length) return [item];
    const toolCalls = item.toolCalls.filter((call) => answered.has(call.id));
    if (toolCalls.length === item.toolCalls.length) return [item];
    if (!toolCalls.length && !item.content) return [];
    return [{ ...item, toolCalls: toolCalls.length ? toolCalls : undefined }];
  });
};

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
    const started = performance.now();
    try {
      const ran = await run(
        platform,
        friday.id,
        thread.id,
        answeredOnly(
          conversational(input.data.messages) as unknown as HistoryItem[],
        ) as unknown as Message[],
        { approvals: true, signal: c.req.raw.signal },
      );
      // The screen keeps only the conversation itself, not a model's notes.
      const newMessages = conversational(ran);
      let said = newMessages
        .filter((item) => item.role === 'assistant')
        .map((item) => (typeof item.content === 'string' ? item.content : ''))
        .filter(Boolean)
        .at(-1);
      // A quick action ended the turn, or the model went quiet after a
      // helper's report: say what the tool reported.
      const reported = fallbackReply(newMessages);
      if (reported && newMessages.at(-1)?.role === 'tool') {
        newMessages.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: reported,
        } as Message);
        said = reported;
      }
      voiceLog('answered', {
        ms: Math.round(performance.now() - started),
        tools: newMessages.flatMap((item) =>
          item.role === 'assistant'
            ? (item.toolCalls ?? []).map((call) => call.function.name)
            : [],
        ),
        text: said ?? '',
      });
      return c.json({ threadId: thread.id, newMessages });
    } catch (error) {
      voiceLog('run_failed', {
        ms: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : String(error),
      });
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
