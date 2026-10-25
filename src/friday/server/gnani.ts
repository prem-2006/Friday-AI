// Friday: Gnani Prisma (speech-to-text) and Timbre (text-to-speech) over REST.
// API: https://docs.gnani.ai/api/STT/speech-to-text.md and
// https://docs.gnani.ai/api/TTS/tts-inference.md
import { usage } from './usage.js';

export const GNANI_STT_URL = 'https://api.vachana.ai/stt/v3';
export const GNANI_TTS_URL = 'https://api.vachana.ai/api/v1/tts/inference';
export const TIMBRE_MODEL = 'timbre-v2.5';

export class GnaniError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function failure(response: Response, service: string) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  const detail = body?.error?.message;
  const reason =
    response.status === 403
      ? 'rejected the API key, or the account is out of credits'
      : response.status === 429
        ? 'is rate limiting requests; wait a moment and try again'
        : `returned HTTP ${response.status}`;
  return new GnaniError(
    `Gnani ${service} ${reason}${detail ? `: ${detail.slice(0, 200)}` : ''}.`,
    response.status === 429 ? 429 : 502,
  );
}

// Each call to Gnani is counted for the Admin page.
function count(
  group: 'Speech to text' | 'Voice',
  api: string,
  item: string,
  started: number,
  outcome: Response | unknown,
) {
  const response = outcome instanceof Response ? outcome : undefined;
  usage.record({
    group,
    api,
    item,
    ok: !!response?.ok,
    status: response?.status,
    ms: Date.now() - started,
    error: response
      ? response.ok
        ? undefined
        : `HTTP ${response.status}`
      : outcome instanceof Error
        ? outcome.message
        : 'No answer',
  });
}

export async function transcribe({
  apiKey,
  audio,
  language,
  fetch = globalThis.fetch,
  signal,
}: {
  apiKey: string;
  audio: Uint8Array;
  language: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<string> {
  const form = new FormData();
  form.set(
    'audio_file',
    new Blob([audio as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }),
    'speech.wav',
  );
  form.set('language_code', language);
  // Writes numbers, times, amounts and phone numbers as digits.
  form.set('format', 'transcribe');
  const started = Date.now();
  const response = await fetch(GNANI_STT_URL, {
    method: 'POST',
    headers: { 'X-API-Key-ID': apiKey },
    body: form,
    signal,
  }).catch((error: unknown) => {
    count('Speech to text', 'Gnani Prisma', 'recorded clips', started, error);
    throw error;
  });
  count('Speech to text', 'Gnani Prisma', 'recorded clips', started, response);
  if (!response.ok) throw await failure(response, 'speech-to-text');
  const body = (await response.json()) as {
    success?: boolean;
    transcript?: string;
  };
  if (!body.success)
    throw new GnaniError('Gnani could not transcribe that.', 502);
  return (body.transcript ?? '').trim();
}

export async function synthesize({
  apiKey,
  text,
  language,
  voice,
  fetch = globalThis.fetch,
  signal,
}: {
  apiKey: string;
  text: string;
  language: string;
  voice: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<ArrayBuffer> {
  const started = Date.now();
  const response = await fetch(GNANI_TTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key-ID': apiKey },
    body: JSON.stringify({
      text,
      model: TIMBRE_MODEL,
      voice,
      language,
      speed: 1,
      audio_config: {
        sample_rate: 22050,
        num_channels: 1,
        sample_width: 2,
        container: 'mp3',
        bitrate: '64k',
      },
    }),
    signal,
  }).catch((error: unknown) => {
    count('Voice', 'Gnani Timbre', 'spoken replies', started, error);
    throw error;
  });
  count('Voice', 'Gnani Timbre', 'spoken replies', started, response);
  if (!response.ok) throw await failure(response, 'text-to-speech');
  return response.arrayBuffer();
}
