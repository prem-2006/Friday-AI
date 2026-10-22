// Friday: a backup model for when the main one is rate limited.
//
// Free model keys run out quickly (Gemini answers 429 after a few requests a
// minute). When FRIDAY_FALLBACK_* is set, a 429 or 503 from the main endpoint
// is answered by sending the same request to the backup instead, at once,
// rather than retrying and making the owner wait. For a minute after that,
// requests go straight to the backup, skipping a refusal round trip each time.
import { voiceLog } from './voice-log.js';

type Fetch = typeof fetch;

const trim = (url: string) => url.replace(/\/+$/, '');
const COOL_DOWN_MS = 60_000;

export function fallbackFromEnv(env: Record<string, string | undefined>) {
  const baseUrl = env.FRIDAY_FALLBACK_BASE_URL?.trim();
  const apiKey = env.FRIDAY_FALLBACK_API_KEY?.trim();
  const model = env.FRIDAY_FALLBACK_MODEL?.trim();
  return baseUrl && apiKey && model
    ? { baseUrl: trim(baseUrl), apiKey, model }
    : undefined;
}

export function fridayFallbackFetch(
  primaryBaseUrl: string | undefined,
  env: Record<string, string | undefined> = process.env,
  baseFetch: Fetch = fetch,
  now: () => number = Date.now,
): Fetch | undefined {
  const backup = fallbackFromEnv(env);
  if (!backup || !primaryBaseUrl) return undefined;
  const primary = trim(primaryBaseUrl);
  let limitedUntil = 0;
  return async (input, init) => {
    const skip = now() < limitedUntil;
    const response = skip
      ? new Response(null, { status: 429 })
      : await baseFetch(input, init);
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (
      (response.status !== 429 && response.status !== 503) ||
      !url.startsWith(primary) ||
      typeof init?.body !== 'string'
    )
      return response;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return response;
    }
    // Options meant for the main provider may be rejected by the backup.
    delete body.reasoning_effort;
    body.model = backup.model;
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${backup.apiKey}`);
    if (!skip) {
      limitedUntil = now() + COOL_DOWN_MS;
      voiceLog('model_fallback', {
        status: response.status,
        model: backup.model,
      });
    }
    void response.body?.cancel().catch(() => {});
    return baseFetch(backup.baseUrl + url.slice(primary.length), {
      ...init,
      headers,
      body: JSON.stringify(body),
    });
  };
}
