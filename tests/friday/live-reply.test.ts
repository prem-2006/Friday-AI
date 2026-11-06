import type { Message } from '@ag-ui/core';
import { expect, it, vi } from 'vitest';
import {
  holdOnLine,
  readySentences,
} from '../../src/friday/client/stage/conversation.js';
import { fridayRunRoutes } from '../../src/friday/server/run-routes.js';

it('cuts finished sentences off text that is still being written', () => {
  expect(readySentences('Opening Notepad for you')).toEqual([
    [],
    'Opening Notepad for you',
  ]);
  expect(
    readySentences(
      'Opening Notepad for you now, and then your list. I will type the list',
    ),
  ).toEqual([
    ['Opening Notepad for you now, and then your list.'],
    'I will type the list',
  ]);
  // Short sentences join the next one, so each piece of voice keeps one pace;
  // Hindi's danda ends a sentence too.
  expect(
    readySentences('Haan. Main abhi call laga deti hoon, ek minute। Phir'),
  ).toEqual([['Haan. Main abhi call laga deti hoon, ek minute।'], 'Phir']);
  expect(readySentences('Haan. Theek hai. Ok')).toEqual([
    [],
    'Haan. Theek hai. Ok',
  ]);
});

it('starts talking at the first comma once a full clause is in', () => {
  // Never a clipped two-word piece like "Haan Prem,".
  expect(readySentences('Haan Prem, main abhi', true)).toEqual([
    [],
    'Haan Prem, main abhi',
  ]);
  expect(
    readySentences('Main abhi YouTube pe gaana laga rahi hoon, bas ek', true),
  ).toEqual([['Main abhi YouTube pe gaana laga rahi hoon,'], 'bas ek']);
  // After the first piece, whole sentences, as before.
  expect(readySentences('Haan Prem, main abhi', false)).toEqual([
    [],
    'Haan Prem, main abhi',
  ]);
});

it('says one second in the language the owner used', () => {
  expect(holdOnLine('kaisi ho friday', 'en-IN', 0)).toBe('Haan, ek second.');
  expect(holdOnLine('what is the weather', 'en-IN', 0)).toBe('One second.');
  expect(holdOnLine('weather', 'hi-IN', 0.99)).toBe('Ek minute.');
  expect(holdOnLine('मौसम कैसा है', 'en-IN', 0)).toBe('Haan, ek second.');
});

it('streams reply text as it is written, then the whole turn', async () => {
  const run = vi.fn(async (...args: unknown[]) => {
    const options = args[4] as { onText?: (delta: string) => void };
    options.onText?.('Hello ');
    options.onText?.('Prem.');
    return [
      { id: 'a1', role: 'assistant', content: 'Hello Prem.' },
    ] as Message[];
  });
  const platform = {
    workspace: {
      dots: () => [{ id: 'f', name: 'Friday', memoryAllowed: false }],
      conversations: () => [],
      bindThread: (id: string) => ({ id }),
    },
    store: { settings: () => ({ paused: false, memoryAllowed: false }) },
  } as never;
  const app = fridayRunRoutes(platform, run as never, undefined);
  const response = await app.request('/friday/voice/run', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson',
    },
    body: JSON.stringify({
      messages: [{ id: 'u1', role: 'user', content: 'hi' }],
    }),
  });
  const lines = (await response.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(lines.slice(0, 2)).toEqual([
    { type: 'text', delta: 'Hello ' },
    { type: 'text', delta: 'Prem.' },
  ]);
  expect(lines[2].type).toBe('done');
  expect(lines[2].newMessages[0].content).toBe('Hello Prem.');
});
