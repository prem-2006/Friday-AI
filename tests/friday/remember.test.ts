import { expect, it } from 'vitest';
import { rememberTool } from '../../src/friday/server/remember.js';
import type { Dot } from '../../src/shared/types.js';

const dot = (name: string) => ({ id: name, name }) as Dot;

it('only Friday can save a memory, when the owner asks', async () => {
  const saved: string[] = [];
  const store = {
    saveMemory: (text: string) => {
      saved.push(text);
      return { id: '1', text };
    },
  };
  expect(rememberTool(dot('Navigator'), store, () => {})).toEqual([]);
  const [tool] = rememberTool(dot('Friday'), store, () => {});
  expect(tool.name).toBe('remember');
  const result = await (
    tool as unknown as { execute: (args: { fact: string }) => Promise<unknown> }
  ).execute({ fact: 'The owner prefers morning meetings.' });
  expect(result).toEqual({
    remembered: 'The owner prefers morning meetings.',
    friday_say: 'Got it, I will remember that.',
  });
  expect(saved).toEqual(['The owner prefers morning meetings.']);
});
