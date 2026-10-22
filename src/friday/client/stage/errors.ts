// The voice stage speaks as Friday only: errors that name the platform
// underneath are reworded.
export function friendlyError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : '';
  if (!message) return fallback;
  if (/copilotkit|opendots|intelligence|runtime|thread/i.test(message))
    return 'Friday can’t reach its memory right now. Check your internet and try again.';
  if (/aborted/i.test(message))
    return 'That was interrupted. Please say it again.';
  return message;
}
