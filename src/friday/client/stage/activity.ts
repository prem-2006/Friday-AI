// Friday: follow the helpers' live activity (Server-Sent Events relayed by
// the app). fetch is used instead of EventSource so the owner token header
// can be sent when OpenDots is protected with OWNER_TOKEN.
import type { ActivityEvent } from './narration';

function ownerHeaders(): Record<string, string> {
  try {
    const token = sessionStorage.getItem('opendots-token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export function followActivity(
  onEvent: (event: ActivityEvent) => void,
  onStatus: (connected: boolean) => void,
) {
  const controller = new AbortController();
  const run = async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch('/api/friday/activity/stream', {
          headers: ownerHeaders(),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error('unavailable');
        onStatus(true);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let split;
          while ((split = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const data = block
              .split('\n')
              .filter((line) => line.startsWith('data: '))
              .map((line) => line.slice(6))
              .join('');
            if (data) onEvent(JSON.parse(data) as ActivityEvent);
          }
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      onStatus(false);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  };
  void run();
  return () => controller.abort();
}

export async function setStopped(stopped: boolean) {
  await fetch(`/api/friday/activity/${stopped ? 'stop' : 'resume'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ownerHeaders() },
    body: '{}',
  }).catch(() => {});
}
