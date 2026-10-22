import { expect, it } from 'vitest';
import {
  fallbackReply,
  fridayLoopStrategy,
  spokenResult,
} from '../../src/friday/server/quick-finish.js';

// How a connected MCP tool result reaches the model: JSON in JSON.
const mcp = (data: object) => JSON.stringify({ text: JSON.stringify(data) });

const state = (messages: { role: string; content?: unknown }[]) =>
  ({
    iterationCount: 1,
    messages,
    finishReason: 'tool_calls',
    toolCallCount: 1,
    lastTurnToolCallCount: 1,
  }) as never;

it('finds the sentence a quick action wants spoken', () => {
  expect(spokenResult(mcp({ friday_say: 'Notepad is open.' }))).toBe(
    'Notepad is open.',
  );
  expect(spokenResult(mcp({ title: 'Example' }))).toBeNull();
  expect(
    spokenResult(JSON.stringify({ isError: true, text: '{"friday_say":"x"}' })),
  ).toBeNull();
  expect(spokenResult('not json')).toBeNull();
});

it('ends the turn only when every latest result was a quick action', () => {
  const strategy = fridayLoopStrategy(() => true);
  const user = { role: 'user', content: 'Open Notepad' };
  const call = { role: 'assistant', content: '' };
  expect(
    strategy(
      state([
        user,
        call,
        { role: 'tool', content: mcp({ friday_say: 'Done.' }) },
      ]),
    ),
  ).toBe(false);
  expect(
    strategy(
      state([
        user,
        call,
        { role: 'tool', content: mcp({ friday_say: 'Done.' }) },
        { role: 'tool', content: mcp({ results: [] }) },
      ]),
    ),
  ).toBe(true);
  expect(strategy(state([user]))).toBe(true);
  expect(fridayLoopStrategy(() => false)(state([user]))).toBe(false);
});

it('speaks the helper report when the model said nothing', () => {
  const report = JSON.stringify({
    dot: 'Operator',
    report: 'Notepad is open.',
  });
  expect(
    fallbackReply([
      { role: 'user', content: 'Open Notepad' },
      { role: 'assistant', content: '' },
      { role: 'tool', content: report },
    ]),
  ).toBe('Notepad is open.');
  expect(fallbackReply([{ role: 'assistant', content: 'All done.' }])).toBe('');
});
