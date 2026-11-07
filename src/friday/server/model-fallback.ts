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
import { failureText, keyTail, modelProvider, usage } from './usage.js';

type Fetch = typeof fetch;

const trim = (url: string) => url.replace(/\/+$/, '');
const list = (value?: string) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
const COOL_DOWN_MS = 60_000;
const OUT_OF_QUOTA_MS = 10 * 60_000;
// A voice reply normally starts within 1 to 3 s; past this, ask another model.
const HEDGE_MS = 5000;

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

/** One model request, counted for the Admin page. */
async function counted(
  baseFetch: Fetch,
  input: Parameters<Fetch>[0],
  init: RequestInit | undefined,
  url: string,
  model: string,
  key: string,
) {
  const started = Date.now();
  const item = [model, keyTail(key)].filter(Boolean).join(' · ');
  try {
    const response = await baseFetch(input, init);
    usage.record({
      group: 'Language models',
      api: modelProvider(url),
      item,
      ok: response.ok,
      status: response.status,
      ms: Date.now() - started,
      error: response.ok ? undefined : await failureText(response),
    });
    return response;
  } catch (error) {
    usage.record({
      group: 'Language models',
      api: modelProvider(url),
      item,
      ok: false,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

const requestUrl = (input: Parameters<Fetch>[0]) =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

const requestBody = (init?: RequestInit) => {
  if (typeof init?.body !== 'string') return undefined;
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

const bearer = (init?: RequestInit) =>
  new Headers(init?.headers).get('authorization')?.replace(/^Bearer\s+/i, '') ??
  '';

/** Counts model requests when there is no rotation or backup to manage. */
export function countedModelFetch(baseFetch: Fetch = fetch): Fetch {
  return (input, init) => {
    const body = requestBody(init);
    if (!body?.model) return baseFetch(input, init);
    return counted(
      baseFetch,
      input,
      init,
      requestUrl(input),
      String(body.model),
      bearer(init),
    );
  };
}

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
  // FRIDAY_MODEL_HEDGE_MS: how long a model may take to start answering
  // before the next one is asked as well (0: never).
  const hedge = Number(env.FRIDAY_MODEL_HEDGE_MS ?? HEDGE_MS);
  const hedgeMs = Number.isFinite(hedge) && hedge >= 0 ? hedge : HEDGE_MS;
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
    const tries = keys
      .flatMap((key) => models.map((model) => ({ key, model })))
      .filter(
        ({ key, model }) =>
          (resting.get(`${key.slice(-8)}:${model}`) ?? 0) <= now(),
      );
    let refused: Response | undefined;
    // A model that has not started answering after hedgeMs (Gemini sometimes
    // hangs for 20 s or more before its first byte) gets company: the next
    // model is asked too, the first good answer wins, the other is stopped.
    const outer = init?.signal ?? undefined;
    type Outcome = {
      id: number;
      own: boolean;
      key: string;
      model: string;
      stop: AbortController;
      response?: Response;
      error?: unknown;
    };
    const running = new Map<number, Promise<Outcome>>();
    const stops: AbortController[] = [];
    let next = 0;
    const start = () => {
      const id = next++;
      const { key, model } = tries[id];
      const own = key === ownKey && model === ownModel;
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${key}`);
      // Options tuned for the main model may be rejected by another one
      // (gemini-flash-lite-latest refuses reasoning_effort "none").
      const plain = { ...body };
      delete plain.reasoning_effort;
      const stop = new AbortController();
      stops.push(stop);
      const signal = outer
        ? AbortSignal.any([outer, stop.signal])
        : stop.signal;
      const sent: RequestInit = own
        ? { ...init, signal }
        : {
            ...init,
            signal,
            headers,
            body: JSON.stringify(
              model === ownModel ? { ...body, model } : { ...plain, model },
            ),
          };
      const base = { id, own, key, model, stop };
      running.set(
        id,
        counted(baseFetch, input, sent, url, model, key).then(
          (response): Outcome => ({ ...base, response }),
          (error: unknown): Outcome => ({ ...base, error }),
        ),
      );
    };
    while (next < tries.length || running.size) {
      if (!running.size) start();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const slow =
        hedgeMs > 0 && next < tries.length
          ? new Promise<'slow'>((resolve) => {
              timer = setTimeout(() => resolve('slow'), hedgeMs);
            })
          : undefined;
      const first = await Promise.race([
        ...running.values(),
        ...(slow ? [slow] : []),
      ]);
      clearTimeout(timer);
      if (first === 'slow') {
        voiceLog('model_slow', { waited_ms: hedgeMs, also: tries[next].model });
        start();
        continue;
      }
      running.delete(first.id);
      if (!first.response) {
        if (outer?.aborted || !running.size) throw first.error;
        continue; // the other request may still answer
      }
      const { response, own, key, model } = first;
      const id = `${key.slice(-8)}:${model}`;
      // Another model or key that refuses the request, or does not offer
      // that model (404: new projects lack the older ones), is skipped.
      const refusedHere = [400, 403, 404].includes(response.status);
      if (!limited(response) && (own || !refusedHere)) {
        for (const stop of stops) if (stop !== first.stop) stop.abort();
        return response;
      }
      if (refusedHere)
        voiceLog('model_refused', {
          model,
          error: (
            await response
              .clone()
              .text()
              .catch(() => '')
          ).slice(0, 300),
        });
      const until =
        now() + (response.status === 429 ? OUT_OF_QUOTA_MS : COOL_DOWN_MS);
      resting.set(id, until);
      usage.rest(
        'Language models',
        modelProvider(url),
        [model, keyTail(key)].filter(Boolean).join(' · '),
        until,
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
    const backupUrl = backup.baseUrl + url.slice(primary.length);
    return counted(
      baseFetch,
      backupUrl,
      { ...init, headers, body: JSON.stringify(body) },
      backupUrl,
      backup.model,
      backup.apiKey,
    );
  };
}
