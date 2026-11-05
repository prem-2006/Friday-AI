import { expect, it, vi } from 'vitest';
import {
  BackgroundDots,
  laneOf,
  spokenReport,
} from '../../src/friday/server/background.js';
import { delegateTool } from '../../src/friday/server/delegate.js';
import type { Dot } from '../../src/shared/types.js';

const dot = (name: string) =>
  ({ id: name, name, instructions: `You are ${name}.` }) as Dot;
const navigator = dot('Navigator');
const mail = dot('Mail');
const operator = dot('Operator');

function pending() {
  const runs: {
    helper: string;
    task: string;
    signal: AbortSignal;
    finish: (report: string) => void;
    fail: (error: Error) => void;
  }[] = [];
  const delegate = vi.fn(
    (helper: Dot, task: string, signal: AbortSignal) =>
      new Promise<string>((finish, fail) => {
        signal.addEventListener('abort', () => fail(new Error('aborted')));
        runs.push({ helper: helper.name, task, signal, finish, fail });
      }),
  );
  return { delegate, runs };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it('says the report when the helper finishes', async () => {
  const { delegate, runs } = pending();
  const announce = vi.fn();
  const background = new BackgroundDots(delegate, announce);
  expect(background.start(navigator, 'find dentists').state).toBe('running');
  expect(announce).not.toHaveBeenCalled();
  runs[0].finish('Three dentists found.');
  await settle();
  expect(announce).toHaveBeenCalledWith('Three dentists found.');
  expect(background.list()[0].state).toBe('done');
});

it('takes turns in Chrome, while Operator runs alongside', async () => {
  const { delegate, runs } = pending();
  const background = new BackgroundDots(delegate, vi.fn());
  expect(background.start(navigator, 'first').state).toBe('running');
  expect(background.start(mail, 'second').state).toBe('queued');
  expect(background.start(operator, 'third').state).toBe('running');
  expect(runs.map((run) => run.task)).toEqual(['first', 'third']);
  runs[0].finish('done');
  await settle();
  expect(runs.map((run) => run.task)).toEqual(['first', 'third', 'second']);
  expect(laneOf('A new agent')).toBe('browser');
});

it('does not start the same task twice while it runs', async () => {
  const { delegate, runs } = pending();
  const background = new BackgroundDots(delegate, vi.fn());
  const first = background.start(navigator, 'Find dentists');
  expect(background.start(navigator, ' find dentists ').id).toBe(first.id);
  expect(runs).toHaveLength(1);
  runs[0].finish('done');
  await settle();
  expect(background.start(navigator, 'Find dentists').id).not.toBe(first.id);
});

it('cancels everything without a word, and waits for nothing', async () => {
  const { delegate, runs } = pending();
  const announce = vi.fn();
  const background = new BackgroundDots(delegate, announce);
  background.start(navigator, 'first');
  background.start(mail, 'second');
  expect(background.cancelAll()).toBe(2);
  await settle();
  expect(runs[0].signal.aborted).toBe(true);
  expect(runs).toHaveLength(1);
  expect(announce).not.toHaveBeenCalled();
  expect(background.list().map((job) => job.state)).toEqual([
    'cancelled',
    'cancelled',
  ]);
  expect(background.cancelAll()).toBe(0);
});

it('says when a helper fails, and the next one still runs', async () => {
  const { delegate, runs } = pending();
  const announce = vi.fn();
  const background = new BackgroundDots(delegate, announce);
  background.start(navigator, 'first');
  background.start(mail, 'second');
  runs[0].fail(new Error('The site refused.'));
  await settle();
  expect(announce).toHaveBeenCalledWith(
    'Navigator could not finish that. The site refused.',
  );
  expect(runs).toHaveLength(2);
});

it('keeps spoken reports short, ending on a sentence', () => {
  expect(spokenReport('Mail', '  ')).toBe('Mail has finished.');
  const long = `${'First sentence goes on. '.repeat(30)}`;
  const said = spokenReport('Mail', long);
  expect(said.length).toBeLessThanOrEqual(500);
  expect(said.endsWith('on.')).toBe(true);
});

it('delegates in the background unless Friday needs the report', async () => {
  const friday = dot('Friday');
  const delegate = vi.fn(async () => 'The report.');
  const signal = new AbortController().signal;
  const [tool] = delegateTool(
    friday,
    [friday, navigator],
    delegate,
    () => {},
    signal,
  );
  const started = (await tool.execute!({
    dot: 'Navigator',
    task: 'Find three dentists',
    say: 'Navigator dhoondh raha hai.',
  })) as Record<string, unknown>;
  expect(started.started).toBe(true);
  expect(started.friday_say).toBe('Navigator dhoondh raha hai.');
  const waited = (await tool.execute!({
    dot: 'Navigator',
    task: 'Read the page title',
    wait: true,
  })) as Record<string, unknown>;
  expect(waited).toEqual({ dot: 'Navigator', report: 'The report.' });
});
