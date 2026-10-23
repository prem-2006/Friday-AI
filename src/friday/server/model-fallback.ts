// Friday: more models for when the main one is rate limited.
//
// Free model keys run out quickly (Gemini answers 429 after a few requests a
// minute, and each model has its own small daily allowance). A 429 or 503
// from the main endpoint is answered at once, rather than retrying and making
// the owner wait, by trying in turn:
//   1. the same endpoint with each key in FRIDAY_PRIMARY_KEYS and each model
//      in FRIDAY_PRIMARY_MODELS (comma-separated; each model and key has its
//      own quota), then
//   2. the backup, FRIDAY_FALLBACK_*.
// A model and key that ran out rest for a while, so later requests skip the
// refusal round trip and go straight to one that still answers.
import { voiceLog } from './voice-log.js';

type Fetch = typeof fetch;

const trim = (url: string) => url.replace(/\/+$/, '');
const list = (value?: string) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
const COOL_DOWN_MS = 60_000;
const OUT_OF_QUOTA_MS = 10 * 60_000;

export function fallbackFromEnv(env: Record<string, string | undefined>) {
  const baseUrl = env.FRIDAY_FALLBACK_BASE_URL?.trim();
  const apiKey = env.FRIDAY_FALLBACK_API_KEY?.trim();
  const model = env.FRIDAY_FALLBACK_MODEL?.trim();
  return baseUrl && apiKey && model
    ? { baseUrl: trim(baseUrl), apiKey, model }
    : undefined;
}

const limited = (response: Response) =>
  response.status === 429 || response.status === 503;

export function fridayFallbackFetch(
  primaryBaseUrl: string | undefined,
  env: Record<string, string | undefined> = process.env,
  baseFetch: Fetch = fetch,
  now: () => number = Date.now,
): Fetch | undefined {
  const backup = fallbackFromEnv(env);
  const extraModels = list(env.FRIDAY_PRIMARY_MODELS);
  const extraKeys = list(env.FRIDAY_PRIMARY_KEYS);
  if (!primaryBaseUrl || (!backup && !extraModels.length && !extraKeys.length))
    return undefined;
  const primary = trim(primaryBaseUrl);
  // When each model and key may be tried again.
  const resting = new Map<string, number>();
  return async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    let body: Record<string, unknown> | undefined;
    if (url.startsWith(primary) && typeof init?.body === 'string')
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = undefined;
      }
    if (!body) return baseFetch(input, init);
    const ownKey =
      new Headers(init?.headers)
        .get('authorization')
        ?.replace(/^Bearer\s+/i, '') ?? '';
    const ownModel = String(body.model ?? '');
    const keys = [...new Set([ownKey, ...extraKeys])];
    const models = [...new Set([ownModel, ...extraModels])];
    let refused: Response | undefined;
    for (const key of keys)
      for (const model of models) {
        const id = `${key.slice(-8)}:${model}`;
        if ((resting.get(id) ?? 0) > now()) continue;
        const own = key === ownKey && model === ownModel;
        const headers = new Headers(init?.headers);
        headers.set('authorization', `Bearer ${key}`);
        // Options tuned for the main model may be rejected by another one
        // (gemini-flash-lite-latest refuses reasoning_effort "none").
        const plain = { ...body };
        delete plain.reasoning_effort;
        const response = await baseFetch(
          input,
          own
            ? init
            : {
                ...init,
                headers,
                body: JSON.stringify(
                  model === ownModel ? { ...body, model } : { ...plain, model },
                ),
              },
        );
        // Another model that refuses the request is skipped, not fatal.
        if (!limited(response) && (own || response.status !== 400))
          return response;
        if (response.status === 400)
          voiceLog('model_refused', {
            model,
            error: (
              await response
                .clone()
                .text()
                .catch(() => '')
            ).slice(0, 300),
          });
        resting.set(
          id,
          now() + (response.status === 429 ? OUT_OF_QUOTA_MS : COOL_DOWN_MS),
        );
        void refused?.body?.cancel().catch(() => {});
        refused = response;
      }
    if (!backup) return refused ?? new Response(null, { status: 429 });
    // Options meant for the main provider may be rejected by the backup.
    delete body.reasoning_effort;
    body.model = backup.model;
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${backup.apiKey}`);
    if (refused)
      voiceLog('model_fallback', {
        status: refused.status,
        model: backup.model,
      });
    void refused?.body?.cancel().catch(() => {});
    return baseFetch(backup.baseUrl + url.slice(primary.length), {
      ...init,
      headers,
      body: JSON.stringify(body),
    });
  };
}
