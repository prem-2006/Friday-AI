// Friday: one request can chain research, a phone call, a message and the
// calendar, and waiting on a call takes several get_call_result rounds, so
// Friday allows more tool rounds per turn than OpenDots' default.
export const FRIDAY_DEFAULT_TOOL_ROUNDS = 24;

export function fridayToolRounds(
  upstreamDefault: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.FRIDAY_MAX_TOOL_ROUNDS?.trim();
  const value = raw ? Number(raw) : FRIDAY_DEFAULT_TOOL_ROUNDS;
  if (!Number.isInteger(value) || value < 1 || value > 100)
    throw new Error(
      'FRIDAY_MAX_TOOL_ROUNDS must be a whole number from 1 to 100.',
    );
  return Math.max(upstreamDefault, value);
}

// Friday: Navigator's browser agent works through several pages in one tool
// call, which takes longer than OpenDots' 60-second limit for connected tools.
export const FRIDAY_DEFAULT_TOOL_TIMEOUT_MS = 300_000;

export function fridayToolTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.FRIDAY_TOOL_TIMEOUT_MS?.trim();
  const value = raw ? Number(raw) : FRIDAY_DEFAULT_TOOL_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 10_000 || value > 900_000)
    throw new Error(
      'FRIDAY_TOOL_TIMEOUT_MS must be a whole number of milliseconds from 10000 to 900000.',
    );
  return value;
}
