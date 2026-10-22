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
