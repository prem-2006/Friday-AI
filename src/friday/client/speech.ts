// Friday: which text to read aloud after a turn.
interface MessageLike {
  role: string;
  content?: unknown;
}

export function lastReplyText(messages: readonly MessageLike[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'user') return '';
    if (
      message.role === 'assistant' &&
      typeof message.content === 'string' &&
      message.content.trim()
    )
      return message.content.trim();
  }
  return '';
}

// Split a reply into sentence-sized parts so the first one can be spoken
// while the rest is still being synthesised. Short sentences are merged.
export function speechParts(text: string, maxParts = 4) {
  const sentences = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?।])\s+/)
    .filter(Boolean);
  const parts: string[] = [];
  for (const sentence of sentences) {
    const last = parts.at(-1);
    if (last && (last.length < 40 || parts.length >= maxParts))
      parts[parts.length - 1] = `${last} ${sentence}`;
    else parts.push(sentence);
  }
  return parts;
}
