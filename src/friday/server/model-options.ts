// Friday: how often to retry a model request that was rate limited (HTTP
// 429); free plans hit their per-minute limit quickly. FRIDAY_MODEL_RETRIES.
export function fridayModelRetries(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = Number(env.FRIDAY_MODEL_RETRIES ?? 3);
  return Number.isInteger(value) && value >= 0 && value <= 6 ? value : 3;
}

// Friday: extra request options for the model, from FRIDAY_MODEL_OPTIONS
// (JSON). For Gemini, {"reasoning_effort":"none"} skips the thinking step and
// roughly halves the time to the first word, which matters for a voice reply.
export function fridayModelOptions(
  base: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
  const raw = env.FRIDAY_MODEL_OPTIONS?.trim();
  if (!raw) return base;
  let extra: unknown;
  try {
    extra = JSON.parse(raw);
  } catch {
    throw new Error(
      'FRIDAY_MODEL_OPTIONS must be JSON, e.g. {"reasoning_effort":"none"}.',
    );
  }
  if (!extra || typeof extra !== 'object' || Array.isArray(extra))
    throw new Error('FRIDAY_MODEL_OPTIONS must be a JSON object.');
  return { ...base, ...(extra as Record<string, unknown>) };
}
