// Friday: speech for talking to Friday. The browser records a short clip,
// Prisma turns it into text, and Timbre reads Friday's reply aloud. The
// browser never sees the Gnani key.
import { Hono } from 'hono';
import { z } from 'zod';
import {
  FRIDAY_DEFAULT_LANGUAGE,
  FRIDAY_LANGUAGES,
  fridayLanguage,
} from '../shared/voices.js';
import { GnaniError, synthesize, transcribe } from './gnani.js';
import { speakableText } from './speech-text.js';
import { voiceLog } from './voice-log.js';

// Clips are 16 kHz mono WAV. 20 s is 640 KB, which stays inside OpenDots'
// 1 MB request limit once base64-encoded.
export const MAX_CLIP_SECONDS = 20;
const MAX_AUDIO_BYTES = 16_000 * 2 * MAX_CLIP_SECONDS + 44;
const languageCode = z
  .string()
  .refine((code) => !!fridayLanguage(code), 'Unsupported language.');

// Gnani asks callers to slow down now and then; one short pause usually
// clears it, so the owner never sees the error.
async function retryOnce<T>(job: () => Promise<T>): Promise<T> {
  try {
    return await job();
  } catch (error) {
    if (!(error instanceof GnaniError) || error.status !== 429) throw error;
    await new Promise((resolve) => setTimeout(resolve, 800));
    return job();
  }
}

export function fridayVoiceRoutes({
  apiKey,
  fetch = globalThis.fetch,
}: {
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}) {
  const app = new Hono();
  const key = apiKey?.trim();
  const notReady = () =>
    Response.json(
      { error: 'Friday voice needs GNANI_API_KEY in the server .env.' },
      { status: 503 },
    );
  const failed = (error: unknown) =>
    error instanceof GnaniError
      ? Response.json({ error: error.message }, { status: error.status })
      : Response.json(
          { error: 'Could not reach Gnani. Check the network and try again.' },
          { status: 502 },
        );

  app.get('/friday/voice', (c) =>
    c.json({
      ready: !!key,
      languages: FRIDAY_LANGUAGES,
      defaultLanguage: FRIDAY_DEFAULT_LANGUAGE,
      maxClipSeconds: MAX_CLIP_SECONDS,
    }),
  );

  app.post('/friday/voice/stt', async (c) => {
    if (!key) return notReady();
    const input = z
      .object({ audio: z.string().min(1), language: languageCode })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      return c.json({ error: 'Send base64 WAV audio and a language.' }, 400);
    const audio = Buffer.from(input.data.audio, 'base64');
    if (audio.length > MAX_AUDIO_BYTES)
      return c.json(
        { error: `Keep each recording under ${MAX_CLIP_SECONDS} seconds.` },
        413,
      );
    if (audio.subarray(0, 4).toString('ascii') !== 'RIFF')
      return c.json({ error: 'Audio must be WAV.' }, 400);
    try {
      const started = performance.now();
      const transcript = await retryOnce(() =>
        transcribe({
          apiKey: key,
          audio,
          language: input.data.language,
          fetch,
          signal: AbortSignal.timeout(30_000),
        }),
      );
      voiceLog('heard', {
        language: input.data.language,
        audioSeconds: +((audio.length - 44) / 32_000).toFixed(1),
        prismaMs: Math.round(performance.now() - started),
        text: transcript,
      });
      return c.json({ transcript });
    } catch (error) {
      voiceLog('stt_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return failed(error);
    }
  });

  // The browser reports how long a whole turn took, end to end.
  app.post('/friday/voice/timing', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const ms = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value)
        ? Math.round(value)
        : undefined;
    if (body)
      voiceLog('turn', {
        heardMs: ms(body.heard),
        answeredMs: ms(body.reply),
        firstVoiceMs: ms(body.firstAudio),
        totalMs: ms(body.total),
      });
    return c.json({ ok: true });
  });

  // What the voice screen or notch did with Caps Lock and approvals, so a
  // press that seemed to do nothing can be traced in data/friday-voice.log.
  app.post('/friday/voice/event', async (c) => {
    const input = z
      .object({
        event: z.enum(['ptt', 'heard', 'decide', 'decide_failed']),
        detail: z.record(
          z.string(),
          z.union([z.string(), z.number(), z.boolean()]),
        ),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (input.success)
      voiceLog(`screen_${input.data.event}`, {
        ...Object.fromEntries(
          Object.entries(input.data.detail)
            .slice(0, 8)
            .map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 120) : v]),
        ),
      });
    return c.json({ ok: true });
  });

  app.post('/friday/voice/tts', async (c) => {
    if (!key) return notReady();
    const input = z
      .object({ text: z.string().min(1).max(20_000), language: languageCode })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      return c.json({ error: 'Send text and a language.' }, 400);
    const text = speakableText(input.data.text);
    if (!text) return c.json({ error: 'Nothing to say.' }, 400);
    try {
      const started = performance.now();
      const audio = await retryOnce(() =>
        synthesize({
          apiKey: key,
          text,
          language: input.data.language,
          voice: fridayLanguage(input.data.language)!.voice,
          fetch,
          signal: AbortSignal.timeout(30_000),
        }),
      );
      voiceLog('spoke', {
        timbreMs: Math.round(performance.now() - started),
        chars: text.length,
      });
      return c.body(audio, 200, { 'Content-Type': 'audio/mpeg' });
    } catch (error) {
      voiceLog('tts_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return failed(error);
    }
  });

  return app;
}
