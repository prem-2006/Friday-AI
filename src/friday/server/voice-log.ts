// Friday: a local log of each voice turn (what Prisma heard, how long each
// step took, what Friday said), so slow or misheard turns can be diagnosed.
// It stays on this machine, next to the app's database.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const LOG_FILE = join(
  dirname(process.env.DATABASE_PATH ?? 'data/opendots.sqlite'),
  'friday-voice.log',
);

export function voiceLog(event: string, fields: Record<string, unknown>) {
  if (process.env.VITEST) return; // tests use fake speech
  const line = `${new Date().toISOString()} ${event} ${JSON.stringify(fields)}`;
  console.info(`[friday] ${event} ${JSON.stringify(fields)}`);
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
  } catch {
    // Logging must never break a voice turn.
  }
}
