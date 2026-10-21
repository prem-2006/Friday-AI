// Friday: the owner lives in India, so "today", "tomorrow" and "this evening"
// must be read in their time zone, not UTC.
export const FRIDAY_DEFAULT_TIME_ZONE = 'Asia/Kolkata';

export function fridayTimeZone(
  env: Record<string, string | undefined> = process.env,
): string {
  const zone = env.TIMEZONE?.trim() || FRIDAY_DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-IN', { timeZone: zone });
  } catch {
    throw new Error(
      `TIMEZONE must be an IANA time zone such as ${FRIDAY_DEFAULT_TIME_ZONE}.`,
    );
  }
  return zone;
}

export function fridayLocalTime(now: Date, timeZone = fridayTimeZone()) {
  const local = new Intl.DateTimeFormat('en-IN', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(now);
  return `The owner's local time is ${local} (${timeZone}); read "today", "tomorrow" and "this evening" in that time zone.`;
}
