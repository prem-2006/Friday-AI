// Friday: how each outside API is doing, for the Admin page (#/admin).
//
// Every call Friday makes to a model or to Gnani's speech APIs is counted
// here: today's calls, how many worked, the last error and how long calls
// take. A model key that ran out of quota also says when it may be used
// again. Counts reset at local midnight and survive restarts
// (data/friday-usage.json). Nothing here stores what was said.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type UsageGroup =
  | 'Language models'
  | 'Speech to text'
  | 'Voice'
  | 'Phone calls'
  | 'Connections'
  | 'Tools';

export interface UsageEvent {
  group: UsageGroup;
  /** The service, e.g. Gemini, OpenRouter, Gnani Prisma. */
  api: string;
  /** What within it, e.g. a model and key, or "transcribe". */
  item?: string;
  ok: boolean;
  status?: number;
  ms?: number;
  error?: string;
}

export interface UsageRow {
  group: UsageGroup;
  api: string;
  item: string;
  calls: number;
  ok: number;
  failed: number;
  statuses: Record<string, number>;
  avgMs: number | null;
  lastAt: number | null;
  lastOkAt: number | null;
  lastError: { at: number; status?: number; message: string } | null;
  restingUntil: number | null;
}

interface Saved {
  day: string;
  rows: Record<string, UsageRow & { totalMs: number; timed: number }>;
}

const localDay = (time: number, timeZone: string) => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(time);
  } catch {
    return new Date(time).toISOString().slice(0, 10);
  }
};

export class UsageTracker {
  private saved: Saved;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly file?: string,
    private readonly now: () => number = Date.now,
    private readonly timeZone = process.env.TIMEZONE || 'Asia/Kolkata',
  ) {
    this.saved = { day: this.today(), rows: {} };
    if (!file) return;
    try {
      const loaded = JSON.parse(readFileSync(file, 'utf8')) as Saved;
      if (loaded.day === this.today() && loaded.rows) this.saved = loaded;
    } catch {
      // No counts yet, or an unreadable file: start from zero.
    }
  }

  private today() {
    return localDay(this.now(), this.timeZone);
  }

  private row(group: UsageGroup, api: string, item = '') {
    if (this.saved.day !== this.today())
      this.saved = { day: this.today(), rows: {} };
    const key = `${group}|${api}|${item}`;
    return (this.saved.rows[key] ??= {
      group,
      api,
      item,
      calls: 0,
      ok: 0,
      failed: 0,
      statuses: {},
      avgMs: null,
      lastAt: null,
      lastOkAt: null,
      lastError: null,
      restingUntil: null,
      totalMs: 0,
      timed: 0,
    });
  }

  record(event: UsageEvent) {
    const row = this.row(event.group, event.api, event.item);
    const at = this.now();
    row.calls += 1;
    row.lastAt = at;
    if (event.status !== undefined)
      row.statuses[event.status] = (row.statuses[event.status] ?? 0) + 1;
    if (event.ms !== undefined) {
      row.totalMs += event.ms;
      row.timed += 1;
      row.avgMs = Math.round(row.totalMs / row.timed);
    }
    if (event.ok) {
      row.ok += 1;
      row.lastOkAt = at;
    } else {
      row.failed += 1;
      row.lastError = {
        at,
        status: event.status,
        message: (event.error ?? 'Failed').slice(0, 300),
      };
    }
    this.save();
  }

  /** A model and key out of quota, not tried again until `until`. */
  rest(group: UsageGroup, api: string, item: string, until: number) {
    this.row(group, api, item).restingUntil = until;
    this.save();
  }

  snapshot(): { day: string; rows: UsageRow[] } {
    if (this.saved.day !== this.today())
      this.saved = { day: this.today(), rows: {} };
    return {
      day: this.saved.day,
      rows: Object.values(this.saved.rows).map(
        ({ totalMs: _total, timed: _timed, ...row }) => row,
      ),
    };
  }

  private save() {
    if (!this.file || this.timer) return;
    const file = this.file;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(this.saved));
      } catch {
        // Counting must never break a request.
      }
    }, 2000);
    this.timer.unref?.();
  }
}

// Tests count in memory only, never in the owner's file.
export const usage = new UsageTracker(
  process.env.VITEST ? undefined : resolve('data', 'friday-usage.json'),
);

/** Which service a model URL belongs to, as the Admin page names it. */
export function modelProvider(url: string) {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return 'Model';
  }
  if (host.includes('generativelanguage.googleapis.com')) return 'Gemini';
  if (host.includes('openrouter.ai')) return 'OpenRouter';
  if (host.includes('gnani') || host.includes('vachana')) return 'Gnani Evon';
  if (host.includes('api.openai.com')) return 'OpenAI';
  return host;
}

/** A key shown only by its last four characters. */
export const keyTail = (key: string) => (key ? `key …${key.slice(-4)}` : '');

/** Why a call failed, from the provider's answer (short, no secrets). */
export async function failureText(response: Response) {
  const text = await response
    .clone()
    .text()
    .catch(() => '');
  try {
    const body = JSON.parse(text) as {
      error?: { message?: string } | string;
      message?: string;
    };
    const message =
      typeof body.error === 'string'
        ? body.error
        : (body.error?.message ?? body.message);
    if (message) return `HTTP ${response.status}: ${message}`.slice(0, 300);
  } catch {
    // Not JSON: use the start of the text.
  }
  return `HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`;
}
