import { expect, it } from 'vitest';
import {
  fallbackFromEnv,
  fridayFallbackFetch,
} from '../../src/friday/server/model-fallback.js';

const ENV = {
  FRIDAY_FALLBACK_BASE_URL: 'https://backup.test/api/v1/',
  FRIDAY_FALLBACK_API_KEY: 'backup-key',
  FRIDAY_FALLBACK_MODEL: 'backup-model',
};
const PRIMARY = 'https://main.test/v1beta/openai/';

function recorder(statuses: number[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response('{}', { status: statuses.shift() ?? 200 });
  }) as typeof fetch;
  return { calls, fake };
}

const request = {
  method: 'POST',
  headers: {
    Authorization: 'Bearer main-key',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'gemini',
    reasoning_effort: 'none',
    messages: [{ role: 'user', content: 'hi' }],
  }),
};

it('sends a rate-limited request to the backup model at once', async () => {
  const { calls, fake } = recorder([429, 200]);
  const wrapped = fridayFallbackFetch(PRIMARY, ENV, fake)!;
  const response = await wrapped(`${PRIMARY}chat/completions`, request);
  expect(response.status).toBe(200);
  expect(calls).toHaveLength(2);
  expect(calls[1].url).toBe('https://backup.test/api/v1/chat/completions');
  const headers = new Headers(calls[1].init.headers);
  expect(headers.get('authorization')).toBe('Bearer backup-key');
  expect(JSON.parse(calls[1].init.body as string)).toEqual({
    model: 'backup-model',
    messages: [{ role: 'user', content: 'hi' }],
  });
});

it('leaves answers, other errors and other hosts alone', async () => {
  for (const status of [200, 400, 500]) {
    const { calls, fake } = recorder([status]);
    const wrapped = fridayFallbackFetch(PRIMARY, ENV, fake)!;
    expect((await wrapped(`${PRIMARY}chat/completions`, request)).status).toBe(
      status,
    );
    expect(calls).toHaveLength(1);
  }
  const { calls, fake } = recorder([429]);
  const wrapped = fridayFallbackFetch(PRIMARY, ENV, fake)!;
  await wrapped('https://elsewhere.test/v1/chat/completions', request);
  expect(calls).toHaveLength(1);
});

it('is off unless all three backup settings are present', () => {
  expect(fallbackFromEnv({})).toBeUndefined();
  expect(
    fallbackFromEnv({ ...ENV, FRIDAY_FALLBACK_MODEL: ' ' }),
  ).toBeUndefined();
  expect(fridayFallbackFetch(PRIMARY, {})).toBeUndefined();
});

it('skips the main model for a minute after it was rate limited', async () => {
  let clock = 0;
  const { calls, fake } = recorder([429, 200, 200, 200, 200]);
  const wrapped = fridayFallbackFetch(PRIMARY, ENV, fake, () => clock)!;
  await wrapped(`${PRIMARY}chat/completions`, request); // main 429, backup
  clock = 30_000;
  await wrapped(`${PRIMARY}chat/completions`, request); // backup only
  expect(calls.map((call) => new URL(call.url).host)).toEqual([
    'main.test',
    'backup.test',
    'backup.test',
  ]);
  clock = 61_000;
  await wrapped(`${PRIMARY}chat/completions`, request); // main again
  expect(new URL(calls.at(-1)!.url).host).toBe('main.test');
});
