// Friday: turn helper activity into short spoken updates, e.g.
// "Navigator is opening google.com". Quiet steps (looking, clicking,
// scrolling) are shown on screen but not spoken, to keep it calm and cheap.
export interface ActivityEvent {
  id: number;
  actor: 'navigator' | 'operator' | 'friday' | string;
  action: string;
  detail: string;
  state: 'running' | 'done' | 'failed';
  image?: string | null;
  at: number;
}

const SPOKEN = new Set([
  'browser_open',
  'browser_type',
  'browser_read',
  'open_app',
  'window_type',
  'whatsapp_find_chat',
  'whatsapp_send_message',
  'whatsapp_call',
]);

export const ACTOR_NAMES: Record<string, string> = {
  navigator: 'Navigator',
  operator: 'Operator',
  friday: 'Friday',
};

function clause(detail: string) {
  const text = detail.replace(/[.…]+$/, '').trim();
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function narrate(event: ActivityEvent): string | null {
  if (event.state === 'failed') {
    const who =
      event.actor === 'friday' ? 'I' : (ACTOR_NAMES[event.actor] ?? 'A helper');
    return `${who} hit a snag: ${event.detail.replace(/[.…]+$/, '')}.`;
  }
  if (event.state !== 'running' || !SPOKEN.has(event.action)) return null;
  if (event.actor === 'friday') return `I'm ${clause(event.detail)}.`;
  return `${ACTOR_NAMES[event.actor] ?? 'A helper'} is ${clause(event.detail)}.`;
}
