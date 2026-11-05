import { expect, it, vi } from 'vitest';
import { delegateTool } from '../../src/friday/server/delegate.js';
import { fridayActivityRoutes } from '../../src/friday/server/activity-routes.js';
import type { Dot } from '../../src/shared/types.js';

const dot = (id: string, name: string, instructions: string) =>
  ({ id, name, instructions }) as Dot;
const friday = dot('f', 'Friday', 'You are Friday.');
const navigator = dot('n', 'Navigator', 'You drive the browser. More text.');
const operator = dot('o', 'Operator', 'You work desktop apps.');
const dots = [friday, navigator, operator];
const check = () => {};

it('only Friday can hand work to helpers', () => {
  const delegate = vi.fn();
  const signal = new AbortController().signal;
  expect(delegateTool(navigator, dots, delegate, check, signal)).toEqual([]);
  expect(delegateTool(friday, [friday], delegate, check, signal)).toEqual([]);
  expect(delegateTool(friday, dots, undefined, check, signal)).toEqual([]);
  const [tool] = delegateTool(friday, dots, delegate, check, signal);
  expect(tool.name).toBe('delegate_to_dot');
  expect(tool.description).toContain('Navigator: You drive the browser.');
  expect(tool.description).toContain('Operator: You work desktop apps.');
  expect(tool.description).not.toContain('More text');
});

it('runs the task on the named helper and returns its report', async () => {
  const delegate = vi.fn(
    async () => 'Opened the calendar and added the event.',
  );
  const signal = new AbortController().signal;
  const [tool] = delegateTool(friday, dots, delegate, check, signal);
  const result = await tool.execute!({
    dot: 'navigator',
    task: 'Add dentist 6 PM tomorrow to the calendar',
    wait: true,
  });
  expect(delegate).toHaveBeenCalledWith(
    navigator,
    'Add dentist 6 PM tomorrow to the calendar',
    signal,
  );
  expect(result).toEqual({
    dot: 'Navigator',
    report: 'Opened the calendar and added the event.',
  });
  await expect(
    tool.execute!({ dot: 'Scout', task: 'Search things' }),
  ).rejects.toThrow('Use one of: Navigator, Operator');
});

it('relays activity with the services token kept on the server', async () => {
  const fetch = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response('data: {"actor":"navigator"}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
  );
  const app = fridayActivityRoutes({
    servicesUrl: 'http://127.0.0.1:8765/',
    token: 'secret-token',
    fetch,
  });
  const stream = await app.request('/friday/activity/stream');
  expect(stream.headers.get('content-type')).toBe('text/event-stream');
  expect(await stream.text()).toContain('navigator');
  expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:8765/activity/stream');
  expect(fetch.mock.calls[0][1]?.headers).toEqual({
    Authorization: 'Bearer secret-token',
  });
  await app.request('/friday/activity/stop', { method: 'POST' });
  expect(fetch.mock.calls[1][0]).toBe('http://127.0.0.1:8765/activity/stop');
  expect(fetch.mock.calls[1][1]?.method).toBe('POST');
});

it('explains when the services are not set up or not running', async () => {
  const noToken = await fridayActivityRoutes({
    servicesUrl: 'http://127.0.0.1:8765',
  }).request('/friday/activity');
  expect(noToken.status).toBe(503);
  const down = await fridayActivityRoutes({
    servicesUrl: 'http://127.0.0.1:8765',
    token: 't',
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
  }).request('/friday/activity');
  expect(down.status).toBe(503);
  expect((await down.json()).error).toContain('friday/services');
});
