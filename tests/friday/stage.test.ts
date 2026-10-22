import { expect, it } from 'vitest';
import { intentOf } from '../../src/friday/client/stage/intent.js';
import {
  narrate,
  type ActivityEvent,
} from '../../src/friday/client/stage/narration.js';

it('hears short yes, no and stop replies in English and Hindi', () => {
  for (const said of ['Yes', 'haan ji', 'theek hai.', 'go ahead', 'हाँ'])
    expect(intentOf(said)).toBe('yes');
  for (const said of ['No.', 'nahin', 'mat karo', 'cancel it', 'नहीं'])
    expect(intentOf(said)).toBe('no');
  for (const said of ['stop', 'ruko', 'bas'])
    expect(intentOf(said)).toBe('stop');
});

it('keeps longer sentences as requests', () => {
  expect(intentOf('No, call Rahul instead of Priya please')).toBe('request');
  expect(intentOf('Yes and also open my calendar for tomorrow')).toBe(
    'request',
  );
  expect(intentOf('Open WhatsApp and message Priya')).toBe('request');
  expect(intentOf('')).toBe('request');
});

const event = (fields: Partial<ActivityEvent>): ActivityEvent => ({
  id: 1,
  actor: 'navigator',
  action: 'browser_open',
  detail: 'Opening google.com.',
  state: 'running',
  at: 0,
  ...fields,
});

it('narrates what the helpers start doing', () => {
  expect(narrate(event({}))).toBe('Navigator is opening google.com.');
  expect(
    narrate(
      event({
        actor: 'operator',
        action: 'open_app',
        detail: 'Opening Notepad…',
      }),
    ),
  ).toBe('Operator is opening Notepad.');
  expect(
    narrate(
      event({
        actor: 'friday',
        action: 'whatsapp_send_message',
        detail: 'Sending a WhatsApp message to Priya…',
      }),
    ),
  ).toBe("I'm sending a WhatsApp message to Priya.");
});

it('stays quiet for small steps and finished steps, but reports problems', () => {
  expect(narrate(event({ action: 'browser_click' }))).toBeNull();
  expect(narrate(event({ state: 'done' }))).toBeNull();
  expect(
    narrate(
      event({
        state: 'failed',
        actor: 'operator',
        detail: 'No app called Paint.',
      }),
    ),
  ).toBe('Operator hit a snag: No app called Paint.');
});

it('never names the platform underneath in voice-screen errors', async () => {
  const { friendlyError } =
    await import('../../src/friday/client/stage/errors.js');
  expect(
    friendlyError(
      new Error(
        'Setup required: CPK_INTELLIGENCE_API_KEY. Conversations require CopilotKit Intelligence.',
      ),
      'x',
    ),
  ).not.toMatch(/copilotkit|opendots|intelligence/i);
  expect(friendlyError(new Error('This operation was aborted'), 'x')).toBe(
    'That was interrupted. Please say it again.',
  );
  expect(friendlyError(new Error('Gnani rate limit'), 'x')).toBe(
    'Gnani rate limit',
  );
  expect(friendlyError('weird', 'Try again.')).toBe('Try again.');
});
