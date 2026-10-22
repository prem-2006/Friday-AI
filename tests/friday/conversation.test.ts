import type { Message } from '@ag-ui/core';
import { expect, it, vi } from 'vitest';
import {
  pendingApprovalOf,
  toolAnswer,
  trimHistory,
} from '../../src/friday/client/stage/conversation.js';
import { fridayRunRoutes } from '../../src/friday/server/run-routes.js';

const user = (id: string, content: string) =>
  ({ id, role: 'user', content }) as Message;
const reply = (id: string, content: string) =>
  ({ id, role: 'assistant', content }) as Message;
const askOk = (id: string, approvalId: string, summary: string) =>
  ({
    id,
    role: 'assistant',
    toolCalls: [
      {
        id: `call-${id}`,
        type: 'function',
        function: {
          name: 'request_connection_action',
          arguments: JSON.stringify({ approvalId, summary }),
        },
      },
    ],
  }) as Message;

it('keeps recent turns, always starting at something the owner said', () => {
  const history = [
    user('u1', 'first'),
    reply('a1', 'one'),
    { id: 't1', role: 'tool', toolCallId: 'x', content: 'y'.repeat(9000) },
    user('u2', 'second'),
    reply('a2', 'two'),
  ] as Message[];
  expect(trimHistory(history, 3).map((m) => m.id)).toEqual(['u2', 'a2']);
  const full = trimHistory(history, 10);
  expect(full[0].id).toBe('u1');
  expect((full[2].content as string).length).toBeLessThan(4100);
});

it('finds an approval still waiting for the owner', () => {
  const waiting = [
    user('u1', 'WhatsApp Priya I am late'),
    askOk('a1', 'ap_1', 'Send "I am late" to Priya'),
  ];
  const pending = pendingApprovalOf(waiting);
  expect(pending).toEqual({
    toolCallId: 'call-a1',
    approvalId: 'ap_1',
    summary: 'Send "I am late" to Priya',
  });
  const answered = [...waiting, toolAnswer(pending!, { approved: true })];
  expect(pendingApprovalOf(answered)).toBeUndefined();
  expect(
    pendingApprovalOf([...waiting, user('u2', 'never mind')]),
  ).toBeUndefined();
});

function fakePlatform(paused = false) {
  const conversations: { id: string; dotId: string; title: string }[] = [];
  return {
    store: { settings: () => ({ paused }) },
    workspace: {
      dots: () => [{ id: 'f', name: 'Friday' }],
      conversations: () => conversations,
      bindThread: (id: string, dotId: string, title: string) => {
        const thread = { id, dotId, title };
        conversations.push(thread);
        return thread;
      },
    },
    config: {},
    setupTelemetry: undefined,
    delegate: async () => '',
  } as never;
}

const post = (app: ReturnType<typeof fridayRunRoutes>, body: unknown) =>
  app.request('/friday/voice/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

it('runs Friday directly with approvals on, in one local voice thread', async () => {
  const run = vi.fn(async () => [reply('a1', 'Yes, I am ready.')]);
  const app = fridayRunRoutes(fakePlatform(), run);
  const first = await (
    await post(app, { messages: [user('u1', 'ready?')] })
  ).json();
  const second = await (
    await post(app, { messages: [user('u2', 'again?')] })
  ).json();
  expect(first.newMessages[0].content).toBe('Yes, I am ready.');
  expect(second.threadId).toBe(first.threadId);
  const [, dotId, threadId, , options] = run.mock.calls[0] as unknown[];
  expect(dotId).toBe('f');
  expect(threadId).toBe(first.threadId);
  expect(options).toMatchObject({ approvals: true });
});

it('refuses bad input, and says so when Friday is paused', async () => {
  const run = vi.fn();
  expect((await post(fridayRunRoutes(fakePlatform(), run), {})).status).toBe(
    400,
  );
  const paused = await post(fridayRunRoutes(fakePlatform(true), run), {
    messages: [user('u1', 'hi')],
  });
  expect(paused.status).toBe(409);
  expect((await paused.json()).error).toContain('paused');
  expect(run).not.toHaveBeenCalled();
});
