import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { fridayPersonality } from '../../src/friday/server/personality.js';

it('gives the personality to Friday only', () => {
  expect(fridayPersonality('Friday')).toContain('Caretaker');
  expect(fridayPersonality('Navigator')).toBe('');
  expect(fridayPersonality('Friday', 'no/such/file.md')).toBe('');
});

it('keeps the lines that stop the personality going wrong', () => {
  const text = readFileSync(
    new URL('../../friday/personality.md', import.meta.url),
    'utf8',
  );
  for (const rule of [
    'you never write or speak as them to anyone else',
    'you are an AI',
    '14416',
    'Do not invent experiences',
    'Do not save passing moods',
  ])
    expect(text).toContain(rule);
});
