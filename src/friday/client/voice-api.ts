// Friday: requests to /api/friday/voice. Kept apart from OpenDots' api()
// helper; it sends the same owner token, which src/client/api.ts keeps in
// sessionStorage under 'opendots-token'.
import type { FridayLanguage } from '../shared/voices';

export interface VoiceConfig {
  ready: boolean;
  languages: FridayLanguage[];
  maxClipSeconds: number;
}

function ownerHeaders(): Record<string, string> {
  try {
    const token = sessionStorage.getItem('opendots-token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function request(path: string, body?: unknown) {
  const response = await fetch(`/api/friday/voice${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...ownerHeaders(),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(data.error ?? `Voice request failed (${response.status}).`);
  }
  return response;
}

export async function voiceConfig(): Promise<VoiceConfig> {
  return (await request('')).json();
}

export async function transcribeClip(audio: string, language: string) {
  const { transcript } = (await (
    await request('/stt', { audio, language })
  ).json()) as { transcript: string };
  return transcript;
}

export async function speechAudio(text: string, language: string) {
  return (await request('/tts', { text, language })).blob();
}
