import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const persona = readFileSync(
  new URL('../../friday/persona.md', import.meta.url),
  'utf8',
).trim();

it('fits OpenDots instruction limit once the calendar URL is filled in', () => {
  const filled = persona.replaceAll(
    '{{CALENDAR_URL}}',
    'http://host.docker.internal:65535/calendar',
  );
  // OpenDots rejects Dot instructions over 2,000 characters.
  expect(filled.length).toBeLessThanOrEqual(2000);
});

it('keeps the rules Friday must follow', () => {
  for (const rule of [
    'say you are Friday, an AI assistant',
    'Ask the owner first',
    'agree to a price',
    'give their links',
    'get_call_result',
    'Never handle OTPs',
  ])
    expect(persona).toContain(rule);
});
