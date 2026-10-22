// Friday: short spoken answers that control the screen instead of becoming
// chat messages: yes / no for an approval card, and stop.
const YES = [
  'yes',
  'yeah',
  'yep',
  'ok',
  'okay',
  'sure',
  'go ahead',
  'do it',
  'send it',
  'call',
  'haan',
  'han',
  'ha',
  'haa',
  'ji',
  'haan ji',
  'theek hai',
  'thik hai',
  'kar do',
  'bhej do',
  'chalo',
  'approve',
  'confirm',
  'हाँ',
  'हां',
  'ठीक है',
];
const NO = [
  'no',
  'nope',
  'nah',
  "don't",
  'dont',
  'do not',
  'cancel',
  'nahin',
  'nahi',
  'mat karo',
  'rehne do',
  'decline',
  'नहीं',
];
const STOP = [
  'stop',
  'ruko',
  'ruk jao',
  'bas',
  'wait',
  'hold on',
  'रुको',
  'बस',
];

function normalise(text: string) {
  return text
    .toLowerCase()
    .replace(/[.,!?।]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matches(text: string, words: string[]) {
  const said = normalise(text);
  // Only short replies count, so "no, call Rahul instead" stays a request.
  if (!said || said.split(' ').length > 4) return false;
  return words.some(
    (word) =>
      said === word || said.startsWith(`${word} `) || said.endsWith(` ${word}`),
  );
}

export type Intent = 'yes' | 'no' | 'stop' | 'request';

export function intentOf(text: string): Intent {
  if (matches(text, STOP)) return 'stop';
  if (matches(text, NO)) return 'no';
  if (matches(text, YES)) return 'yes';
  return 'request';
}
