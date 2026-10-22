// Friday: turn a chat reply into text that sounds right when Timbre reads it.
export const MAX_SPOKEN_CHARS = 700;

export function speakableText(markdown: string, limit = MAX_SPOKEN_CHARS) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\|/g, ' ')
    .replace(/(\*\*|__|\*|_|~~)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/([.!?])\.\s/g, '$1 ')
    .replace(/\s+([.,!?])/g, '$1')
    .trim();
  if (text.length <= limit) return text;
  // Stop at the last full sentence that fits.
  const cut = text.slice(0, limit);
  const end = Math.max(
    cut.lastIndexOf('. '),
    cut.lastIndexOf('? '),
    cut.lastIndexOf('! '),
  );
  return end > limit / 3 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}
