import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const persona = readFileSync(
  new URL('../../friday/persona.md', import.meta.url),
  'utf8',
).trim();

it('fits OpenDots instruction limit once the calendar URL is filled in', () => {
  const filled = persona.replaceAll(
    '{{CALENDAR_URL}}',
    'http://127.0.0.1:65535/calendar',
  );
  // OpenDots rejects Dot instructions over 2,000 characters.
  expect(filled.length).toBeLessThanOrEqual(2000);
});

it('keeps the rules Friday must follow', () => {
  for (const rule of [
    'say you are Friday, an AI assistant',
    'Ask the owner first',
    'agree to a price',
    'hand it to Navigator',
    'YouTube when the owner mentions YouTube',
    'at most three short sentences',
    'delegate_to_dot',
    'the owner approves each one',
    'Never handle OTPs',
  ])
    expect(persona).toContain(rule);
});

it('keeps every helper persona within the limit', () => {
  for (const name of ['navigator', 'operator', 'coder']) {
    const text = readFileSync(
      new URL(`../../friday/dots/${name}.md`, import.meta.url),
      'utf8',
    ).trim();
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain('Never type passwords');
  }
});
