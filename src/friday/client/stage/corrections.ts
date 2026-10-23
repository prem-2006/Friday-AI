// Friday: fixes words speech recognition reliably mishears before Friday acts
// on them, e.g. Gnani's English (India) model writes the letters "A I" as "ei".
// Only for English: in Bengali, "ei" is a word of its own.

const ENGLISH_FIXES: [RegExp, string][] = [
  [/\b(?:a\.?\s?i\.?|ei|e\.\s?i\.?)(?=\s|[.,!?]|$)/gi, 'AI'],
  [/\bchat\s?g\.?\s?p\.?\s?t\b/gi, 'ChatGPT'],
  [/\bgee\s?mail\b|\bg\s?mail\b/gi, 'Gmail'],
  [/\bleet\s?code\b|\blead\s?code\b/gi, 'LeetCode'],
  [/\bwhat'?s\s?app\b/gi, 'WhatsApp'],
  [/\byou\s?tube\b/gi, 'YouTube'],
];

export function fixMishearings(text: string, language: string) {
  if (!language.startsWith('en')) return text;
  return ENGLISH_FIXES.reduce(
    (fixed, [pattern, word]) => fixed.replace(pattern, word),
    text,
  );
}
