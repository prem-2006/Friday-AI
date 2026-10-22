import { expect, it, vi } from 'vitest';
import { fridayVoiceRoutes } from '../../src/friday/server/voice-routes.js';
import { GNANI_STT_URL, GNANI_TTS_URL } from '../../src/friday/server/gnani.js';
import { encodeWav, toBase64 } from '../../src/friday/client/wav.js';

const clip = toBase64(encodeWav(new Float32Array(1600)));
const post = (
  app: ReturnType<typeof fridayVoiceRoutes>,
  path: string,
  body: unknown,
) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

it('reports whether voice is configured, with every language', async () => {
  const off = await fridayVoiceRoutes({}).request('/friday/voice');
  expect(await off.json()).toMatchObject({
    ready: false,
    defaultLanguage: 'en-IN',
  });
  const on = await (
    await fridayVoiceRoutes({ apiKey: 'k' }).request('/friday/voice')
  ).json();
  expect(on.ready).toBe(true);
  expect(on.languages.map((l: { code: string }) => l.code)).toContain('kn-IN');
});

it('refuses speech requests without a Gnani key', async () => {
  const response = await post(fridayVoiceRoutes({}), '/friday/voice/stt', {
    audio: clip,
    language: 'en-IN',
  });
  expect(response.status).toBe(503);
  expect((await response.json()).error).toContain('GNANI_API_KEY');
});

it('sends the clip to Prisma with the key, language and digit formatting', async () => {
  const fetch = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        success: true,
        transcript: 'Kal 6 baje dentist book karo',
      }),
  );
  const app = fridayVoiceRoutes({ apiKey: 'gnani-key', fetch });
  const response = await post(app, '/friday/voice/stt', {
    audio: clip,
    language: 'hi-IN',
  });
  expect(await response.json()).toEqual({
    transcript: 'Kal 6 baje dentist book karo',
  });
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe(GNANI_STT_URL);
  expect(init?.headers).toEqual({ 'X-API-Key-ID': 'gnani-key' });
  const form = init?.body as FormData;
  expect(form.get('language_code')).toBe('hi-IN');
  expect(form.get('format')).toBe('transcribe');
  expect((form.get('audio_file') as File).type).toBe('audio/wav');
});

it('rejects bad clips before calling Gnani', async () => {
  const fetch = vi.fn();
  const app = fridayVoiceRoutes({ apiKey: 'k', fetch });
  const notWav = await post(app, '/friday/voice/stt', {
    audio: Buffer.from('not audio').toString('base64'),
    language: 'en-IN',
  });
  expect(notWav.status).toBe(400);
  const tooLong = await post(app, '/friday/voice/stt', {
    audio: toBase64(encodeWav(new Float32Array(16_000 * 21))),
    language: 'en-IN',
  });
  expect(tooLong.status).toBe(413);
  const badLanguage = await post(app, '/friday/voice/stt', {
    audio: clip,
    language: 'fr-FR',
  });
  expect(badLanguage.status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});

it('explains when Gnani rejects the key or runs out of credits', async () => {
  const fetch = vi.fn(async () =>
    Response.json(
      { success: false, error: { type: 'forbidden', message: 'No credits' } },
      { status: 403 },
    ),
  );
  const response = await post(
    fridayVoiceRoutes({ apiKey: 'k', fetch }),
    '/friday/voice/stt',
    {
      audio: clip,
      language: 'en-IN',
    },
  );
  expect(response.status).toBe(502);
  expect((await response.json()).error).toMatch(/out of credits: No credits/);
});

it('asks Timbre v2.5 for speech in the chosen language, with clean text', async () => {
  const fetch = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Type': 'audio/mpeg' },
      }),
  );
  const response = await post(
    fridayVoiceRoutes({ apiKey: 'k', fetch }),
    '/friday/voice/tts',
    {
      text: '**Booked!** See [the clinic](https://clinic.example) for directions.',
      language: 'kn-IN',
    },
  );
  expect(response.headers.get('content-type')).toBe('audio/mpeg');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(
    new Uint8Array([1, 2, 3]),
  );
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe(GNANI_TTS_URL);
  const body = JSON.parse(String(init?.body));
  expect(body).toMatchObject({
    model: 'timbre-v2.5',
    voice: 'Saanvi',
    language: 'kn-IN',
    text: 'Booked! See the clinic for directions.',
  });
  expect(body.audio_config.container).toBe('mp3');
});

it('quietly retries once when Gnani asks to slow down', async () => {
  let calls = 0;
  const fetch = vi.fn(async () =>
    ++calls === 1
      ? Response.json({ success: false }, { status: 429 })
      : Response.json({ success: true, transcript: 'hello' }),
  );
  const response = await post(
    fridayVoiceRoutes({ apiKey: 'k', fetch }),
    '/friday/voice/stt',
    { audio: clip, language: 'en-IN' },
  );
  expect(await response.json()).toEqual({ transcript: 'hello' });
  expect(fetch).toHaveBeenCalledTimes(2);
});
