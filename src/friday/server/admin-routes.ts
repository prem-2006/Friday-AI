// Friday: the Admin page's data (#/admin). It brings together today's counts
// for every outside API (this server's model and Gnani calls, and
// friday/services' calls, voice, tunnel and tools) with live checks that cost
// nothing: whether each Gemini key still works, OpenRouter's credits,
// Sarvam's calls today, Twilio's balance, and whether the public phone
// address answers. Live checks run at most once a minute unless asked.
// No key ever leaves this server; keys are shown by their last 4 characters.
import { Hono } from 'hono';
import { keyTail, modelProvider, usage, type UsageRow } from './usage.js';

type Env = Record<string, string | undefined>;
type Fetch = typeof globalThis.fetch;

const CHECK_EVERY_MS = 60_000;
const TIMEOUT_MS = 8_000;
const list = (value?: string) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

export interface KeyCheck {
  key: string;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface LiveChecks {
  checkedAt: number;
  gemini: KeyCheck[];
  openrouter?: {
    ok: boolean;
    freeTier?: boolean;
    usage?: number;
    usageToday?: number;
    limit?: number | null;
    remaining?: number | null;
    error?: string;
  };
  sarvam?: {
    ok: boolean;
    callsToday?: number;
    minutesToday?: number;
    inbound?: number;
    outbound?: number;
    /** Calls Sarvam accepted but could not connect (phone off, no network). */
    notConnected?: number;
    lastNotConnected?: { to: string; at: string | null } | null;
    error?: string;
  };
  twilio?: {
    ok: boolean;
    balance?: string;
    currency?: string;
    error?: string;
  };
  phoneAddress?: { url: string; ok: boolean; status?: number; error?: string };
}

/** Start of today (owner's time zone) as an ISO time in UTC. */
function startOfToday(timeZone: string, now = new Date()) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
  const offset = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  })
    .formatToParts(now)
    .find((part) => part.type === 'timeZoneName')
    ?.value.replace('GMT', '');
  return new Date(`${day}T00:00:00${offset || 'Z'}`).toISOString().slice(0, 19);
}

async function attempt<T>(
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T | { ok: false; error: string }> {
  try {
    return await run(AbortSignal.timeout(TIMEOUT_MS));
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function liveChecks(
  env: Env,
  fetch: Fetch,
  ngrokUrl?: string | null,
): Promise<LiveChecks> {
  const checks: LiveChecks = { checkedAt: Date.now(), gemini: [] };
  const mainUrl = env.EVON_BASE_URL || env.OPENAI_BASE_URL || '';
  const mainKey = env.EVON_BASE_URL ? env.EVON_API_KEY : env.OPENAI_API_KEY;
  const geminiKeys =
    modelProvider(mainUrl) === 'Gemini'
      ? [...new Set([mainKey ?? '', ...list(env.FRIDAY_PRIMARY_KEYS)])].filter(
          Boolean,
        )
      : [];
  const jobs: Promise<unknown>[] = [];

  // Listing models costs nothing and says whether a key still works.
  for (const key of geminiKeys)
    jobs.push(
      attempt(async (signal) => {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(key)}`,
          { signal },
        );
        return {
          key: keyTail(key),
          ok: response.ok,
          status: response.status,
          error: response.ok ? undefined : `HTTP ${response.status}`,
        };
      }).then((result) =>
        checks.gemini.push(
          'key' in result ? result : { key: keyTail(key), ...result },
        ),
      ),
    );

  const backupUrl = env.FRIDAY_FALLBACK_BASE_URL ?? '';
  if (modelProvider(backupUrl) === 'OpenRouter' && env.FRIDAY_FALLBACK_API_KEY)
    jobs.push(
      attempt(async (signal) => {
        const response = await fetch('https://openrouter.ai/api/v1/key', {
          headers: { Authorization: `Bearer ${env.FRIDAY_FALLBACK_API_KEY}` },
          signal,
        });
        if (!response.ok)
          return { ok: false, error: `HTTP ${response.status}` } as const;
        const { data } = (await response.json()) as {
          data: {
            usage?: number;
            usage_daily?: number;
            limit?: number | null;
            limit_remaining?: number | null;
            is_free_tier?: boolean;
          };
        };
        return {
          ok: true,
          freeTier: data.is_free_tier,
          usage: data.usage,
          usageToday: data.usage_daily,
          limit: data.limit,
          remaining: data.limit_remaining,
        };
      }).then((result) => (checks.openrouter = result)),
    );

  if (
    env.SARVAM_API_KEY &&
    env.SARVAM_ORG_ID &&
    env.SARVAM_WORKSPACE_ID &&
    env.SARVAM_APP_ID
  )
    jobs.push(
      attempt(async (signal) => {
        const params = new URLSearchParams({
          start_datetime: startOfToday(env.TIMEZONE || 'Asia/Kolkata'),
          end_datetime: new Date().toISOString().slice(0, 19),
          include_transcript: 'false',
          limit: '100',
        });
        const response = await fetch(
          `https://apps.sarvam.ai/api/analytics/v1/${env.SARVAM_ORG_ID}/${env.SARVAM_WORKSPACE_ID}/${env.SARVAM_APP_ID}/interactions?${params}`,
          { headers: { 'X-API-Key': env.SARVAM_API_KEY ?? '' }, signal },
        );
        if (!response.ok)
          return { ok: false, error: `HTTP ${response.status}` } as const;
        const { items = [] } = (await response.json()) as {
          items?: {
            duration_in_seconds?: number;
            channel_direction?: string;
          }[];
        };
        // Attempts include calls that never connected, which have no
        // interaction: Sarvam took the request but the phone did not ring.
        const attempts = await fetch(
          `https://apps.sarvam.ai/api/analytics/v1/${env.SARVAM_ORG_ID}/${env.SARVAM_WORKSPACE_ID}/${env.SARVAM_APP_ID}/attempts?${params}`,
          { headers: { 'X-API-Key': env.SARVAM_API_KEY ?? '' }, signal },
        )
          .then((answer) =>
            answer.ok
              ? (answer.json() as Promise<{
                  items?: {
                    connectivity_status?: string;
                    user_contact_masked?: string;
                    start_datetime?: string | null;
                  }[];
                }>)
              : { items: [] },
          )
          .catch(() => ({ items: [] }));
        const failed = (attempts.items ?? []).filter(
          (attempt) => attempt.connectivity_status === 'failed',
        );
        const seconds = items.reduce(
          (sum, item) => sum + Number(item.duration_in_seconds ?? 0),
          0,
        );
        return {
          ok: true,
          callsToday: items.length,
          minutesToday: Math.round((seconds / 60) * 10) / 10,
          inbound: items.filter((item) => item.channel_direction === 'inbound')
            .length,
          outbound: items.filter(
            (item) => item.channel_direction === 'outbound',
          ).length,
          notConnected: failed.length,
          lastNotConnected: failed[0]
            ? {
                to: failed[0].user_contact_masked ?? 'unknown',
                at: failed[0].start_datetime ?? null,
              }
            : null,
        };
      }).then((result) => (checks.sarvam = result)),
    );

  if (
    env.TWILIO_ACCOUNT_SID &&
    env.TWILIO_AUTH_TOKEN &&
    env.FRIDAY_TWILIO?.toLowerCase() !== 'off'
  )
    jobs.push(
      attempt(async (signal) => {
        const auth = Buffer.from(
          `${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`,
        ).toString('base64');
        const response = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Balance.json`,
          { headers: { Authorization: `Basic ${auth}` }, signal },
        );
        if (!response.ok)
          return { ok: false, error: `HTTP ${response.status}` } as const;
        const body = (await response.json()) as {
          balance?: string;
          currency?: string;
        };
        return { ok: true, balance: body.balance, currency: body.currency };
      }).then((result) => (checks.twilio = result)),
    );

  // Sarvam's agent reaches Friday here; without the token it must say 401.
  if (ngrokUrl)
    jobs.push(
      attempt(async (signal) => {
        const response = await fetch(`${ngrokUrl}/phone/ask`, {
          method: 'POST',
          signal,
        });
        return {
          url: ngrokUrl,
          ok: response.status === 401,
          status: response.status,
          error:
            response.status === 401
              ? undefined
              : `Expected 401, got HTTP ${response.status}`,
        };
      }).then(
        (result) =>
          (checks.phoneAddress =
            'url' in result ? result : { url: ngrokUrl, ...result }),
      ),
    );

  await Promise.all(jobs);
  checks.gemini.sort((a, b) => a.key.localeCompare(b.key));
  return checks;
}

export function fridayAdminRoutes({
  servicesUrl,
  token,
  env = process.env,
  fetch = globalThis.fetch,
}: {
  servicesUrl: string;
  token?: string;
  env?: Env;
  fetch?: Fetch;
}) {
  const app = new Hono();
  const base = servicesUrl.replace(/\/+$/, '');
  let cached: LiveChecks | undefined;
  let running: Promise<LiveChecks> | undefined;

  app.get('/friday/admin/status', async (c) => {
    const services = await fetch(`${base}/usage`, {
      headers: { Authorization: `Bearer ${token ?? ''}` },
      signal: AbortSignal.timeout(4000),
    })
      .then(async (response) =>
        response.ok
          ? {
              reachable: true,
              ...((await response.json()) as {
                day: string;
                rows: UsageRow[];
                live: Record<string, unknown>;
              }),
            }
          : {
              reachable: false,
              error: `Friday services answered HTTP ${response.status}.`,
            },
      )
      .catch(() => ({
        reachable: false,
        error: 'Friday services are not running.',
      }));
    const refresh = c.req.query('refresh') === '1';
    if (refresh || !cached || Date.now() - cached.checkedAt > CHECK_EVERY_MS) {
      const ngrokUrl =
        'live' in services
          ? (services.live.ngrok_url as string | null | undefined)
          : undefined;
      running ??= liveChecks(env, fetch, ngrokUrl).finally(() => {
        running = undefined;
      });
      cached = await running;
    }
    const mine = usage.snapshot();
    return c.json({
      generatedAt: Date.now(),
      day: mine.day,
      rows: [
        ...mine.rows.map((row) => ({ ...row, from: 'app' })),
        ...('rows' in services
          ? services.rows.map((row) => ({ ...row, from: 'services' }))
          : []),
      ],
      services: {
        reachable: services.reachable,
        error: 'error' in services ? services.error : undefined,
        live: 'live' in services ? services.live : undefined,
      },
      checks: cached,
      configured: {
        mainModel: env.EVON_BASE_URL ? env.EVON_MODEL : env.OPENAI_MODEL,
        mainProvider: modelProvider(
          env.EVON_BASE_URL || env.OPENAI_BASE_URL || '',
        ),
        extraModels: list(env.FRIDAY_PRIMARY_MODELS),
        backupModel: env.FRIDAY_FALLBACK_MODEL || null,
        backupProvider: env.FRIDAY_FALLBACK_BASE_URL
          ? modelProvider(env.FRIDAY_FALLBACK_BASE_URL)
          : null,
        gnani: !!env.GNANI_API_KEY,
        parallel: !!env.PARALLEL_API_KEY,
        composio: !!env.COMPOSIO_API_KEY,
        intelligence: !!env.CPK_INTELLIGENCE_API_KEY,
      },
    });
  });
  return app;
}
