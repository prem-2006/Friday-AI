// Friday: push-to-talk in the chat composer. Tap the mic, speak, tap again:
// Prisma transcribes the clip, the text is sent as a normal chat message (so
// approval cards and tool cards still work), and Timbre reads the reply.
import { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Square, Volume2, VolumeX } from 'lucide-react';
import { FRIDAY_DEFAULT_LANGUAGE, FRIDAY_LANGUAGES } from '../shared/voices';
import { ClipRecorder } from './recorder';
import {
  speechAudio,
  transcribeClip,
  voiceConfig,
  type VoiceConfig,
} from './voice-api';
import { toBase64 } from './wav';
import './friday.css';

type Phase = 'idle' | 'recording' | 'transcribing' | 'waiting' | 'speaking';
const LANGUAGE_KEY = 'friday-voice-language';

function savedLanguage() {
  try {
    return localStorage.getItem(LANGUAGE_KEY) || FRIDAY_DEFAULT_LANGUAGE;
  } catch {
    return FRIDAY_DEFAULT_LANGUAGE;
  }
}

export function FridayVoice({
  disabled,
  onTranscript,
  lastReply,
}: {
  disabled: boolean;
  onTranscript: (text: string) => Promise<void>;
  lastReply: () => string;
}) {
  const [config, setConfig] = useState<VoiceConfig>();
  const [language, setLanguage] = useState(savedLanguage);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const recorder = useRef<ClipRecorder | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const limit = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    void voiceConfig()
      .then(setConfig)
      .catch(() =>
        setConfig({
          ready: false,
          languages: FRIDAY_LANGUAGES,
          maxClipSeconds: 20,
        }),
      );
    return () => {
      recorder.current?.cancel();
      audio.current?.pause();
      clearTimeout(limit.current);
    };
  }, []);

  const chooseLanguage = (code: string) => {
    setLanguage(code);
    try {
      localStorage.setItem(LANGUAGE_KEY, code);
    } catch {
      // The choice still applies for this visit.
    }
  };

  const stopSpeaking = () => {
    audio.current?.pause();
    audio.current = null;
    setPhase('idle');
  };

  const speak = async (text: string) => {
    if (!text) return setPhase('idle');
    setPhase('speaking');
    const url = URL.createObjectURL(await speechAudio(text, language));
    const player = new Audio(url);
    audio.current = player;
    player.onended = player.onerror = () => {
      URL.revokeObjectURL(url);
      if (audio.current === player) stopSpeaking();
    };
    await player.play();
  };

  const finishRecording = async () => {
    clearTimeout(limit.current);
    const active = recorder.current;
    recorder.current = null;
    if (!active) return;
    try {
      setPhase('transcribing');
      const wav = await active.stop();
      const transcript = await transcribeClip(toBase64(wav), language);
      if (!transcript) throw new Error('Friday did not catch that. Try again.');
      setPhase('waiting');
      await onTranscript(transcript);
      await speak(lastReply());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Voice failed. Try again.');
      setPhase('idle');
    }
  };

  const startRecording = async () => {
    setError('');
    stopSpeaking();
    const next = new ClipRecorder();
    try {
      await next.start();
    } catch {
      setError('Allow microphone access to talk to Friday.');
      return;
    }
    recorder.current = next;
    setPhase('recording');
    limit.current = setTimeout(
      () => void finishRecording(),
      (config?.maxClipSeconds ?? 20) * 1000,
    );
  };

  const ready = !!config?.ready;
  const status =
    phase === 'recording'
      ? 'Listening… tap the mic again to send.'
      : phase === 'transcribing'
        ? 'Turning your voice into text…'
        : phase === 'waiting'
          ? 'Friday is working on it…'
          : phase === 'speaking'
            ? 'Friday is speaking.'
            : '';

  return (
    <div className="friday-voice">
      <div className="friday-voice-row">
        <button
          type="button"
          className={`icon-button friday-mic ${phase === 'recording' ? 'recording' : ''}`}
          aria-label={
            phase === 'recording'
              ? 'Stop and send voice message'
              : 'Talk to Friday'
          }
          title={
            ready
              ? 'Push to talk (Gnani Prisma)'
              : 'Friday voice needs GNANI_API_KEY in .env'
          }
          disabled={
            !ready ||
            (phase === 'recording'
              ? false
              : disabled || ['transcribing', 'waiting'].includes(phase))
          }
          onClick={() =>
            phase === 'recording'
              ? void finishRecording()
              : void startRecording()
          }
        >
          {phase === 'transcribing' || phase === 'waiting' ? (
            <Loader2 size={18} className="friday-spin" />
          ) : phase === 'recording' ? (
            <Square size={16} />
          ) : (
            <Mic size={18} />
          )}
        </button>
        <select
          className="friday-language"
          aria-label="Voice language"
          value={language}
          disabled={phase !== 'idle'}
          onChange={(e) => chooseLanguage(e.target.value)}
        >
          {(config?.languages ?? FRIDAY_LANGUAGES).map((option) => (
            <option key={option.code} value={option.code}>
              {option.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="icon-button"
          aria-label={
            phase === 'speaking' ? 'Stop speaking' : 'Read the last reply aloud'
          }
          title="Read Friday's last reply aloud (Gnani Timbre)"
          disabled={
            !ready || (phase !== 'speaking' && (phase !== 'idle' || disabled))
          }
          onClick={() =>
            phase === 'speaking'
              ? stopSpeaking()
              : void speak(lastReply()).catch((e) => {
                  setError(e instanceof Error ? e.message : 'Could not speak.');
                  setPhase('idle');
                })
          }
        >
          {phase === 'speaking' ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>
      </div>
      {(status || error) && (
        <div
          className={`friday-voice-status ${error ? 'error' : ''}`}
          role="status"
        >
          {error || status}
        </div>
      )}
    </div>
  );
}
