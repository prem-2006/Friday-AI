// Friday: how Friday is with the owner (friend, caretaker, advisor, twin), from
// friday/personality.md. It is added to the Friday Dot's instructions on each
// turn, because the persona itself must fit OpenDots' 2,000-character limit.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FRIDAY_DOT_NAME } from './delegate.js';

export function fridayPersonality(
  dotName: string,
  path = resolve('friday/personality.md'),
) {
  if (dotName !== FRIDAY_DOT_NAME) return '';
  try {
    return `\n\n${readFileSync(path, 'utf8').trim()}`;
  } catch {
    return '';
  }
}
