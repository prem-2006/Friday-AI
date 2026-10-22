// The voice stage speaks as Friday only: errors that name the platform
// underneath are reworded.
export function friendlyError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : '';
  if (!message) return fallback;
  if (/copilotkit|opendots|intelligence|runtime|thread/i.test(message))
    return 'Friday can’t reach its memory right now. Check your internet and try again.';
  if (
    /\b429\b|rate limit|too many requests|quota|resource.?exhausted/i.test(
      message,
    )
  )
    return 'Friday is getting a lot of requests right now. Give it a few seconds and try again.';
  if (/aborted/i.test(message))
    return 'That was interrupted. Please say it again.';
  return message;
}
