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
