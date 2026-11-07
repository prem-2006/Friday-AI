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

it('rests a model that ran out of quota (429) for ten minutes', async () => {
  let clock = 0;
  const { calls, fake } = recorder([429, 200, 200, 200, 200]);
  const wrapped = fridayFallbackFetch(PRIMARY, ENV, fake, () => clock)!;
  const host = () => new URL(calls.at(-1)!.url).host;
  await wrapped(`${PRIMARY}chat/completions`, request); // main 429, backup
  clock = 30_000;
  await wrapped(`${PRIMARY}chat/completions`, request); // backup only
  expect(calls.map((call) => new URL(call.url).host)).toEqual([
    'main.test',
    'backup.test',
    'backup.test',
  ]);
  // Its daily allowance is gone: a minute later it is still resting.
  clock = 61_000;
  await wrapped(`${PRIMARY}chat/completions`, request);
  expect(host()).toBe('backup.test');
  clock = 10 * 60_000 + 1;
  await wrapped(`${PRIMARY}chat/completions`, request); // main again
  expect(host()).toBe('main.test');
});

it('rests a model that was only busy (503) for a minute', async () => {
  let clock = 0;
  const { calls, fake } = recorder([503, 200, 200, 200]);
  const wrapped = fridayFallbackFetch(PRIMARY, ENV, fake, () => clock)!;
  const host = () => new URL(calls.at(-1)!.url).host;
  await wrapped(`${PRIMARY}chat/completions`, request); // main 503, backup
  clock = 30_000;
  await wrapped(`${PRIMARY}chat/completions`, request);
  expect(host()).toBe('backup.test');
  clock = 61_000;
  await wrapped(`${PRIMARY}chat/completions`, request); // main again
  expect(host()).toBe('main.test');
});

it('asks the next model too when the first has not started after a while', async () => {
  const asked: string[] = [];
  const stopped: string[] = [];
  const fake = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const model = JSON.parse(String(init?.body)).model as string;
    asked.push(model);
    if (model !== 'gemini')
      return new Response('{"from":"second"}', { status: 200 });
    // The main model hangs before its first byte, until it is stopped.
    return new Promise<Response>((_resolve, reject) =>
      init?.signal?.addEventListener('abort', () => {
        stopped.push(model);
        reject(new Error('aborted'));
      }),
    );
  }) as typeof fetch;
  const wrapped = fridayFallbackFetch(
    PRIMARY,
    { FRIDAY_PRIMARY_MODELS: 'gemini-fast', FRIDAY_MODEL_HEDGE_MS: '20' },
    fake,
  )!;
  const response = await wrapped(`${PRIMARY}chat/completions`, request);
  expect(await response.json()).toEqual({ from: 'second' });
  expect(asked).toEqual(['gemini', 'gemini-fast']);
  expect(stopped).toEqual(['gemini']);
});

it('keeps the first model when it answers before the wait is over', async () => {
  const asked: string[] = [];
  const fake = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    asked.push(JSON.parse(String(init?.body)).model as string);
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const wrapped = fridayFallbackFetch(
    PRIMARY,
    { FRIDAY_PRIMARY_MODELS: 'gemini-fast', FRIDAY_MODEL_HEDGE_MS: '5000' },
    fake,
  )!;
  expect((await wrapped(`${PRIMARY}chat/completions`, request)).status).toBe(
    200,
  );
  expect(asked).toEqual(['gemini']);
});
