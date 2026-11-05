// Friday: helper Dots working in the background. The owner's turn ends at once
// and they can keep talking; Friday says the report when the helper is done.
// Dots that share Friday's Chrome take turns, so they never fight over the
// page, while a Dot with its own lane (Operator) runs alongside them.
import { randomUUID } from 'node:crypto';
import type { Dot } from '../../shared/types.js';
import type { Delegate } from './delegate.js';

// Spoken reports stay short; the helper's conversation keeps all of it.
const REPORT_CHARS = 500;
const FINISHED_KEPT = 10;

export type BackgroundState =
  'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface BackgroundTask {
  id: string;
  dot: string;
  task: string;
  state: BackgroundState;
  startedAt: number;
  finishedAt?: number;
}

interface Job extends BackgroundTask {
  helper: Dot;
  controller: AbortController;
}

/** Only Operator works outside the browser; every other helper needs Chrome. */
export const laneOf = (dotName: string) =>
  dotName === 'Operator' ? 'desktop' : 'browser';

const sameTask = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

export function spokenReport(dot: string, report: string) {
  const text = report.replace(/\s+/g, ' ').trim();
  if (!text) return `${dot} has finished.`;
  if (text.length <= REPORT_CHARS) return text;
  const cut = text.slice(0, REPORT_CHARS);
  const end = Math.max(
    cut.lastIndexOf('. '),
    cut.lastIndexOf('? '),
    cut.lastIndexOf('। '),
  );
  return end > 100 ? cut.slice(0, end + 1) : `${cut}…`;
}

export class BackgroundDots {
  private jobs: Job[] = [];

  constructor(
    private readonly delegate: Delegate,
    private readonly announce: (text: string) => unknown,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Starts the task, or queues it behind its lane. The same task still
   * running is not started twice. */
  start(helper: Dot, task: string): { state: BackgroundState; id: string } {
    const running = this.jobs.find(
      (job) =>
        job.helper.id === helper.id &&
        (job.state === 'queued' || job.state === 'running') &&
        sameTask(job.task, task),
    );
    if (running) return { state: running.state, id: running.id };
    const job: Job = {
      id: randomUUID(),
      dot: helper.name,
      task,
      helper,
      state: 'queued',
      startedAt: this.clock(),
      controller: new AbortController(),
    };
    this.jobs.push(job);
    this.next(laneOf(helper.name));
    return { state: job.state, id: job.id };
  }

  private next(lane: string) {
    const inLane = this.jobs.filter((job) => laneOf(job.dot) === lane);
    if (inLane.some((job) => job.state === 'running')) return;
    const job = inLane.find((item) => item.state === 'queued');
    if (job) void this.run(job, lane);
  }

  private async run(job: Job, lane: string) {
    job.state = 'running';
    try {
      const report = await this.delegate(
        job.helper,
        job.task,
        job.controller.signal,
      );
      if (job.controller.signal.aborted) return;
      job.state = 'done';
      await this.say(spokenReport(job.dot, report));
    } catch (error) {
      if (job.controller.signal.aborted) return;
      job.state = 'failed';
      const why = error instanceof Error ? error.message : '';
      await this.say(
        `${job.dot} could not finish that.${why ? ` ${why.slice(0, 160)}` : ''}`,
      );
    } finally {
      if (job.controller.signal.aborted) job.state = 'cancelled';
      job.finishedAt = this.clock();
      this.trim();
      this.next(lane);
    }
  }

  private async say(text: string) {
    try {
      await this.announce(text);
    } catch {
      // Friday could not say it; the helper's conversation still has it.
    }
  }

  private trim() {
    const finished = this.jobs.filter((job) => job.finishedAt !== undefined);
    const over = new Set(finished.slice(0, -FINISHED_KEPT));
    this.jobs = this.jobs.filter((job) => !over.has(job));
  }

  /** Drops everything running or waiting; returns how many were dropped. */
  cancelAll() {
    let dropped = 0;
    for (const job of this.jobs) {
      if (job.state !== 'queued' && job.state !== 'running') continue;
      dropped += 1;
      if (job.state === 'queued') {
        job.state = 'cancelled';
        job.finishedAt = this.clock();
      }
      job.controller.abort();
    }
    return dropped;
  }

  list(): BackgroundTask[] {
    return this.jobs.map(({ id, dot, task, state, startedAt, finishedAt }) => ({
      id,
      dot,
      task,
      state,
      startedAt,
      finishedAt,
    }));
  }
}

/** Says a finished report through friday-services, like a reminder coming due. */
export const announceThroughServices = async (text: string) => {
  const token = process.env.FRIDAY_SERVICES_TOKEN;
  if (!token) return;
  const base =
    process.env.FRIDAY_SERVICES_URL ??
    `http://127.0.0.1:${process.env.FRIDAY_SERVICES_PORT || 8765}`;
  await fetch(`${base.replace(/\/+$/, '')}/activity/announce`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });
};

// One set of background tasks for the server, whichever turn started them.
let shared: BackgroundDots | undefined;

export function backgroundDots(delegate: Delegate) {
  shared ??= new BackgroundDots(delegate, announceThroughServices);
  return shared;
}

export const currentBackground = () => shared;
