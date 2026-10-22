// Friday: the main voice screen. Tap the orb and talk; Friday answers out
// loud, hands browser and desktop work to its helper Dots (Navigator,
// Operator), narrates what they do, and asks for a spoken yes before sending
// or calling on WhatsApp.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Message } from '@ag-ui/core';
import {
  CircleCheck,
  CircleX,
  Loader2,
  MessageSquare,
  OctagonX,
  RotateCcw,
  Send,
} from 'lucide-react';
import type { Dot, WorkspaceState } from '../../../shared/types';
import { FRIDAY_DEFAULT_LANGUAGE, FRIDAY_LANGUAGES } from '../../shared/voices';
import { lastReplyText, speechParts } from '../speech';
import { toBase64 } from '../wav';
import { speechAudio, transcribeClip, voiceConfig } from '../voice-api';
import { followActivity, ownerHeaders, setStopped } from './activity';
import {
  loadHistory,
  pendingApprovalOf,
  runApprovedAction,
  runFriday,
  saveHistory,
  toolAnswer,
} from './conversation';
import { HandsFree } from './handsFree';
import { friendlyError } from './errors';
import { intentOf } from './intent';
import { ACTOR_NAMES, narrate, type ActivityEvent } from './narration';
import { Orb, type OrbMode } from './Orb';
import './stage.css';

export const STAGE_HASH = '#/friday';
// Shows every animation without keys: #/friday-demo
export const STAGE_DEMO_HASH = '#/friday-demo';
const DEMO: {
  mode: OrbMode;
  title: string;
  line: string;
  helpers: string[];
}[] = [
  {
    mode: 'listening',
    title: 'I’m listening…',
    line: 'Go ahead, I’m here.',
    helpers: [],
  },
  {
    mode: 'thinking',
    title: 'Thinking…',
    line: 'Find a dentist near Indiranagar open this evening',
    helpers: [],
  },
  {
    mode: 'working',
    title: 'Working with Navigator…',
    line: 'Navigator is opening google.com.',
    helpers: ['Navigator'],
  },
  {
    mode: 'working',
    title: 'Working with Navigator & Operator…',
    line: 'Operator is opening Notepad.',
    helpers: ['Navigator', 'Operator'],
  },
  {
    mode: 'speaking',
    title: 'Speaking…',
    line: 'Apollo Dental is open till 9 PM. Shall I message Priya?',
    helpers: [],
  },
];

function StageDemo({ onExit }: { onExit: () => void }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const timer = setInterval(
      () => setStep((n) => (n + 1) % DEMO.length),
      4500,
    );
    return () => clearInterval(timer);
  }, []);
  const scene = DEMO[step];
  const level = useCallback(
    () =>
      0.35 +
      0.35 *
        Math.abs(
          Math.sin(performance.now() / 180) * Math.sin(performance.now() / 530),
        ),
    [],
  );
  return (
    <div className={`friday-stage mode-${scene.mode}`}>
      <Orb mode={scene.mode} level={level} helpers={scene.helpers} />
      <Header
        status={{ tone: 'ok', label: 'Demo' }}
        clock={`00:${String(step * 4 + 2).padStart(2, '0')}`}
        language={FRIDAY_DEFAULT_LANGUAGE}
        onLanguage={() => {}}
        onExit={onExit}
      />
      <section className="stage-title" key={step}>
        <h1>{scene.title}</h1>
        <p>{scene.line}</p>
      </section>
      {scene.helpers.length > 0 && (
        <aside
          className="stage-live"
          aria-label="What the helper Dots are doing"
        >
          <header>
            <span className="stage-live-dot" />
            Live · {scene.helpers.join(', ')}
          </header>
          <ol>
            <li className="done">
              <CircleCheck size={13} />
              <b>Navigator</b>
              <span>Opening google.com. Now on: Google</span>
            </li>
            <li className="done">
              <CircleCheck size={13} />
              <b>Navigator</b>
              <span>Typing "dentist Indiranagar open now".</span>
            </li>
            <li className={scene.helpers.length > 1 ? 'done' : 'running'}>
              {scene.helpers.length > 1 ? (
                <CircleCheck size={13} />
              ) : (
                <Loader2 size={13} className="spin" />
              )}
              <b>Navigator</b>
              <span>Reading the page.</span>
            </li>
            {scene.helpers.length > 1 && (
              <li className="running">
                <Loader2 size={13} className="spin" />
                <b>Operator</b>
                <span>Opening Notepad…</span>
              </li>
            )}
          </ol>
        </aside>
      )}
    </div>
  );
}
const LANGUAGE_KEY = 'friday-voice-language';
const NARRATION_GAP_MS = 3500;

type Phase =
  'off' | 'listening' | 'hearing' | 'transcribing' | 'thinking' | 'speaking';
interface Caption {
  who: 'you' | 'friday';
  text: string;
}

function savedLanguage() {
  try {
    return localStorage.getItem(LANGUAGE_KEY) || FRIDAY_DEFAULT_LANGUAGE;
  } catch {
    return FRIDAY_DEFAULT_LANGUAGE;
  }
}

function useClock(running: boolean) {
  const [started, setStarted] = useState<number>();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return setStarted(undefined);
    setStarted(Date.now());
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (!started) return '00:00';
  const seconds = Math.floor((Date.now() - started) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function Header({
  status,
  clock,
  language,
  onLanguage,
  onExit,
  onStop,
  onNewChat,
}: {
  status: { tone: 'ok' | 'warn'; label: string };
  clock: string;
  language: string;
  onLanguage: (code: string) => void;
  onExit: () => void;
  onStop?: () => void;
  onNewChat?: () => void;
}) {
  return (
    <header className="stage-header">
      <div className="stage-brand">
        <span className="stage-bars" aria-hidden>
          {[0, 1, 2, 3, 4].map((i) => (
            <i key={i} style={{ animationDelay: `${i * 0.12}s` }} />
          ))}
        </span>
        <div>
          <strong>Friday</strong>
          <span>Your AI Voice Assistant</span>
        </div>
      </div>
      <div className="stage-controls">
        <select
          aria-label="Language"
          value={language}
          onChange={(e) => onLanguage(e.target.value)}
        >
          {FRIDAY_LANGUAGES.map((option) => (
            <option key={option.code} value={option.code}>
              {option.name}
            </option>
          ))}
        </select>
        <span className={`stage-pill ${status.tone}`}>
          <i />
          {status.label}
        </span>
        <span className="stage-clock">{clock}</span>
        {onStop && (
          <button
            type="button"
            className="stage-icon stop"
            onClick={onStop}
            aria-label="Stop everything"
          >
            <OctagonX size={18} />
          </button>
        )}
        {onNewChat && (
          <button
            type="button"
            className="stage-icon"
            onClick={onNewChat}
            aria-label="Start a new conversation"
            title="New conversation"
          >
            <RotateCcw size={17} />
          </button>
        )}
        <button
          type="button"
          className="stage-icon"
          onClick={onExit}
          aria-label="Open the chat view"
        >
          <MessageSquare size={18} />
        </button>
      </div>
    </header>
  );
}

export function FridayStage({
  workspace,
  configured,
  paused = false,
  onResume = () => {},
  onExit,
}: {
  workspace?: WorkspaceState;
  configured: boolean;
  /** Everything is paused from the dashboard; Friday cannot act until resumed. */
  paused?: boolean;
  onResume?: () => void;
  onExit: () => void;
}) {
  const friday = workspace?.dots.find((dot) => dot.name === 'Friday');
  const [language, setLanguage] = useState(savedLanguage);
  const chooseLanguage = (code: string) => {
    setLanguage(code);
    try {
      localStorage.setItem(LANGUAGE_KEY, code);
    } catch {
      // Applies for this visit.
    }
  };
  if (typeof location !== 'undefined' && location.hash === STAGE_DEMO_HASH)
    return <StageDemo onExit={onExit} />;
  if (configured && friday)
    return (
      <StageSession
        key={friday.id}
        friday={friday}
        language={language}
        onLanguage={chooseLanguage}
        onExit={onExit}
        paused={paused}
        onResume={onResume}
      />
    );

  const missing = !workspace
    ? 'Connecting…'
    : !friday
      ? 'Run friday/scripts/setup-friday-dot.mjs to create Friday and its helper Dots.'
      : `Add to .env, then restart: ${workspace.setup.missing.join(', ')}.`;
  return (
    <div className="friday-stage">
      <Orb mode="idle" level={() => 0} helpers={[]} />
      <Header
        status={{ tone: 'warn', label: 'Setup needed' }}
        clock="00:00"
        language={language}
        onLanguage={chooseLanguage}
        onExit={onExit}
      />
      <section className="stage-title">
        <h1>Almost ready</h1>
        <p>{missing}</p>
      </section>
    </div>
  );
}

function StageSession({
  friday,
  language,
  onLanguage,
  onExit,
  paused,
  onResume,
}: {
  friday: Dot;
  language: string;
  onLanguage: (code: string) => void;
  onExit: () => void;
  paused: boolean;
  onResume: () => void;
}) {
  // Friday's voice conversation lives here and runs directly on the server.
  const [messages, setMessages] = useState<Message[]>(
    () => loadHistory().messages,
  );
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const threadId = useRef<string | undefined>(loadHistory().threadId);
  const turn = useRef<AbortController | null>(null);
  const loaded = !!friday;
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<Phase>('off');
  const [voiceReady, setVoiceReady] = useState<boolean>();
  const [helpersOnline, setHelpersOnline] = useState(false);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [subtitle, setSubtitle] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [events, setEvents] = useState<ActivityEvent[]>([]);

  const handsFree = useRef<HandsFree | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const ttsAnalyser = useRef<AnalyserNode | null>(null);
  const speakingMain = useRef(false);
  const lastNarration = useRef(0);
  const stopping = useRef(false);
  const spokenApproval = useRef('');
  const languageRef = useRef(language);
  languageRef.current = language;
  // How long each step took for the last thing you said, in ms.
  const timing = useRef<{
    endedAt?: number;
    heard?: number;
    reply?: number;
    firstAudio?: number;
  }>({});
  const logTiming = () => {
    const t = timing.current;
    const ms = (value?: number) =>
      value === undefined ? '–' : `${(value / 1000).toFixed(1)} s`;
    const total =
      t.endedAt !== undefined && t.firstAudio !== undefined
        ? (t.heard ?? 0) + (t.reply ?? 0) + t.firstAudio
        : undefined;
    console.info(
      `[Friday] heard ${ms(t.heard)} · answered ${ms(t.reply)} · voice ${ms(t.firstAudio)} · you stopped → Friday spoke ${ms(total)}`,
    );
    void fetch('/api/friday/voice/timing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ownerHeaders() },
      body: JSON.stringify({ ...t, total }),
    }).catch(() => {});
  };

  useEffect(() => {
    void voiceConfig()
      .then((config) => setVoiceReady(config.ready))
      .catch(() => setVoiceReady(false));
    const unfollow = followActivity(
      (event) => setEvents((list) => [...list.slice(-40), event]),
      setHelpersOnline,
    );
    return () => {
      unfollow();
      handsFree.current?.stop();
      audio.current?.pause();
      void audioContext.current?.close();
    };
  }, []);

  const caption = (who: Caption['who'], text: string) =>
    setCaptions((list) => [...list.slice(-3), { who, text }]);

  const level = useCallback(() => {
    if (speakingMain.current || audio.current) {
      const analyser = ttsAnalyser.current;
      if (!analyser) return 0.3;
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (const value of data) sum += value;
      return Math.min(1, (sum / data.length / 255) * 3);
    }
    return handsFree.current?.level ?? 0;
  }, []);

  // Gnani allows one transcription at a time, so clips wait their turn.
  const transcribing = useRef<Promise<unknown>>(Promise.resolve());
  const starting = useRef(false);
  const speechToken = useRef(0);
  const stopSpeaking = () => {
    speechToken.current += 1; // cancels any parts still queued
    audio.current?.pause();
    audio.current = null;
    speakingMain.current = false;
  };

  const playPart = async (blob: Blob, token: number) => {
    if (token !== speechToken.current) return;
    const url = URL.createObjectURL(blob);
    const player = new Audio(url);
    audio.current = player;
    try {
      audioContext.current ??= new AudioContext();
      const analyser = audioContext.current.createAnalyser();
      analyser.fftSize = 256;
      audioContext.current.createMediaElementSource(player).connect(analyser);
      analyser.connect(audioContext.current.destination);
      ttsAnalyser.current = analyser;
    } catch {
      ttsAnalyser.current = null;
    }
    await new Promise<void>((resolve) => {
      player.onended = player.onerror = player.onpause = () => resolve();
      void player.play().catch(() => resolve());
    });
    URL.revokeObjectURL(url);
  };

  // Speaks sentence by sentence: the first part plays while the next ones are
  // still being synthesised, so the first word comes much sooner.
  const speak = async (text: string, main: boolean, startedAt?: number) => {
    if (!text || !voiceReady) return;
    if (!main && (speakingMain.current || audio.current)) return; // never talk over a reply
    stopSpeaking();
    const token = speechToken.current;
    speakingMain.current = main;
    if (main) setPhase('speaking');
    const parts = speechParts(text);
    const clips = parts.map(() => null as Promise<Blob> | null);
    const clip = (index: number) =>
      (clips[index] ??= speechAudio(parts[index], languageRef.current));
    try {
      for (let index = 0; index < parts.length; index++) {
        const next = clip(index);
        if (index + 1 < parts.length) void clip(index + 1).catch(() => {});
        const blob = await next;
        if (token !== speechToken.current) break;
        if (index === 0 && startedAt)
          timing.current.firstAudio = performance.now() - startedAt;
        if (index === 0 && main) logTiming();
        await playPart(blob, token);
      }
    } catch (e) {
      if (main) setError(friendlyError(e, 'Friday could not speak.'));
    } finally {
      if (token === speechToken.current) {
        audio.current = null;
        if (main) {
          speakingMain.current = false;
          setPhase(handsFree.current?.active ? 'listening' : 'off');
        }
      }
    }
  };

  const pendingApproval = useMemo(
    () => pendingApprovalOf(messages),
    [messages],
  );

  useEffect(() => {
    if (
      !pendingApproval ||
      spokenApproval.current === pendingApproval.toolCallId
    )
      return;
    spokenApproval.current = pendingApproval.toolCallId;
    void speak(
      `I need your OK: ${pendingApproval.summary}. Say yes or no.`,
      true,
    );
  }, [pendingApproval]);

  const setHistory = (next: Message[]) => {
    messagesRef.current = next;
    setMessages(next);
    saveHistory(next, threadId.current);
  };

  // One run of Friday on the server; afterwards either speak the reply or
  // wait for the owner's OK on a WhatsApp send or call.
  const runTurn = async (history: Message[]) => {
    setRunning(true);
    setPhase('thinking');
    setError('');
    const controller = new AbortController();
    turn.current = controller;
    try {
      const asked = performance.now();
      const result = await runFriday(history, controller.signal);
      timing.current.reply = performance.now() - asked;
      threadId.current = result.threadId;
      const next = [...history, ...result.newMessages];
      setHistory(next);
      if (pendingApprovalOf(next)) return;
      const reply = lastReplyText(next);
      if (reply) {
        caption('friday', reply);
        setSubtitle(reply);
        await speak(reply, true, performance.now());
      } else logTiming();
    } catch (e) {
      if (!controller.signal.aborted)
        setError(friendlyError(e, 'That did not work. Try again.'));
    } finally {
      turn.current = null;
      setRunning(false);
      if (stopping.current) {
        stopping.current = false;
        await setStopped(false);
      }
      setPhase((current) =>
        current === 'speaking'
          ? current
          : handsFree.current?.active
            ? 'listening'
            : 'off',
      );
    }
  };

  const decide = async (approve: boolean) => {
    const pending = pendingApproval;
    if (!pending || running) return;
    caption('friday', approve ? 'Approved.' : 'Declined.');
    let answer: Record<string, unknown> = {
      approved: false,
      message:
        'The owner declined this action. Do not perform it or try another way.',
    };
    if (approve) {
      if (!threadId.current) {
        setError('That request expired. Please ask again.');
        return;
      }
      setRunning(true);
      setPhase('thinking');
      try {
        answer = {
          approved: true,
          ...(await runApprovedAction(threadId.current, pending)),
        };
      } catch (e) {
        setRunning(false);
        setPhase(handsFree.current?.active ? 'listening' : 'off');
        setError(friendlyError(e, 'Could not do that. Try again.'));
        return;
      }
    }
    await runTurn([...messagesRef.current, toolAnswer(pending, answer)]);
  };

  const send = async (text: string) => {
    if (!text.trim() || running || !loaded) return;
    if (paused) {
      setError('Friday is paused. Tap Resume to continue.');
      return;
    }
    caption('you', text);
    setSubtitle(text);
    const history = [
      ...messagesRef.current,
      {
        id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
        role: 'user',
        content: text,
      } as Message,
    ];
    setHistory(history);
    await runTurn(history);
  };

  const stopEverything = async () => {
    stopSpeaking();
    caption('friday', 'Stopping.');
    if (running) {
      stopping.current = true;
      await setStopped(true);
      turn.current?.abort();
    }
  };

  const newConversation = () => {
    if (running) return;
    stopSpeaking();
    setHistory([]);
    setCaptions([]);
    setSubtitle('');
    setError('');
  };

  const heard = async (
    wav: Uint8Array,
    endedAt: number,
    overFriday: boolean,
  ) => {
    if (!overFriday) setPhase('transcribing');
    timing.current = { endedAt };
    let text = '';
    try {
      const job = transcribing.current.then(() =>
        transcribeClip(toBase64(wav), languageRef.current),
      );
      transcribing.current = job.catch(() => {});
      text = (await job).trim();
      timing.current.heard = performance.now() - endedAt;
    } catch (e) {
      setError(friendlyError(e, 'Could not hear that.'));
    }
    if (!text) {
      if (!overFriday) setPhase(running ? 'thinking' : 'listening');
      return;
    }
    const intent = intentOf(text);
    if (intent === 'stop') return stopEverything();
    // Speech that began while Friday was talking is most likely Friday's own
    // voice coming back through the mic; only stop / yes / no count then.
    if (overFriday && intent === 'request') return;
    if (pendingApproval) {
      caption('you', text);
      if (intent === 'yes' || intent === 'no') return decide(intent === 'yes');
      return speak('Please say yes or no first.', true);
    }
    if (running) {
      caption('you', text);
      return speak('I am still on the last task. Say stop to cancel it.', true);
    }
    await send(text);
  };
  const heardRef = useRef(heard);
  heardRef.current = heard;

  const toggleListening = async () => {
    if (starting.current) return; // a second tap while the mic is opening
    setError('');
    if (handsFree.current?.active) {
      handsFree.current.stop();
      handsFree.current = null;
      setPhase(running ? 'thinking' : 'off');
      return;
    }
    let overFriday = false;
    const next = new HandsFree({
      onSpeechStart: () => {
        overFriday = !!audio.current;
        setPhase((current) => (current === 'listening' ? 'hearing' : current));
      },
      onUtterance: (wav, endedAt) =>
        void heardRef.current(wav, endedAt, overFriday),
      onError: setError,
      isFridaySpeaking: () => !!audio.current,
    });
    starting.current = true;
    try {
      await next.start();
    } catch {
      setError('Allow microphone access so Friday can hear you.');
      return;
    } finally {
      starting.current = false;
    }
    handsFree.current = next;
    setPhase(running ? 'thinking' : 'listening');
  };

  // Narrate helper activity while a task runs.
  const narrated = useRef(0);
  useEffect(() => {
    const latest = events.at(-1);
    if (!latest || latest.id <= narrated.current) return;
    narrated.current = latest.id;
    const line = narrate(latest);
    if (!line) return;
    setSubtitle(line);
    const now = Date.now();
    if (
      latest.state !== 'failed' &&
      now - lastNarration.current < NARRATION_GAP_MS
    )
      return;
    lastNarration.current = now;
    void speak(line, false);
  }, [events]);

  const recent = events.filter(
    (event) => Date.now() - event.at * 1000 < 120_000,
  );
  const busyHelpers = [
    ...new Set(
      recent
        .filter((event) => event.actor !== 'friday' && running)
        .map((event) => ACTOR_NAMES[event.actor] ?? event.actor),
    ),
  ];
  const screenshot = [...recent].reverse().find((event) => event.image)?.image;
  const listening = !!handsFree.current?.active;
  const clock = useClock(listening || running);

  const mode: OrbMode =
    phase === 'speaking'
      ? 'speaking'
      : running && busyHelpers.length
        ? 'working'
        : phase === 'thinking' || phase === 'transcribing'
          ? 'thinking'
          : phase === 'listening' || phase === 'hearing'
            ? 'listening'
            : 'idle';
  const title = paused
    ? 'Friday is paused'
    : pendingApproval
      ? 'I need your OK'
      : phase === 'speaking'
        ? 'Speaking…'
        : running && busyHelpers.length
          ? `Working with ${busyHelpers.join(' & ')}…`
          : phase === 'thinking'
            ? 'Thinking…'
            : phase === 'transcribing'
              ? 'Got it…'
              : listening
                ? 'I’m listening…'
                : 'Tap the orb to talk';
  const line =
    error ||
    (paused
      ? 'Nothing runs while paused. Tap Resume to continue.'
      : pendingApproval
        ? 'Say yes or no, or use the buttons.'
        : subtitle ||
          (listening ? 'Go ahead, I’m here.' : 'Or type a task below.'));
  const status =
    voiceReady === false
      ? { tone: 'warn' as const, label: 'Voice needs GNANI_API_KEY' }
      : !helpersOnline
        ? { tone: 'warn' as const, label: 'Helpers offline' }
        : { tone: 'ok' as const, label: 'Connected' };

  return (
    <div className={`friday-stage mode-${mode}`}>
      <Orb mode={mode} level={level} helpers={busyHelpers} />
      <Header
        status={status}
        clock={clock}
        language={language}
        onLanguage={onLanguage}
        onExit={onExit}
        onStop={
          running || phase === 'speaking'
            ? () => void stopEverything()
            : undefined
        }
        onNewChat={messages.length && !running ? newConversation : undefined}
      />
      <section className="stage-title" aria-live="polite">
        <h1>{title}</h1>
        <p className={error ? 'error' : ''}>{line}</p>
        {paused && (
          <button
            type="button"
            className="stage-resume"
            onClick={() => {
              setError('');
              onResume();
            }}
          >
            Resume
          </button>
        )}
      </section>
      <button
        type="button"
        className={`stage-orb-hit ${listening ? 'on' : ''}`}
        aria-label={listening ? 'Stop listening' : 'Start talking to Friday'}
        aria-pressed={listening}
        disabled={!loaded || voiceReady === false}
        onClick={() => void toggleListening()}
      />
      {recent.length > 0 && (
        <aside
          className="stage-live"
          aria-label="What the helper Dots are doing"
        >
          <header>
            <span className="stage-live-dot" />
            Live{busyHelpers.length ? ` · ${busyHelpers.join(', ')}` : ''}
          </header>
          {screenshot && (
            <img
              src={`data:image/jpeg;base64,${screenshot}`}
              alt="The helper's screen right now"
            />
          )}
          <ol>
            {recent
              .filter(
                (event) => event.state !== 'running' || event === recent.at(-1),
              )
              .slice(-6)
              .map((event) => (
                <li key={event.id} className={event.state}>
                  {event.state === 'running' ? (
                    <Loader2 size={13} className="spin" />
                  ) : event.state === 'done' ? (
                    <CircleCheck size={13} />
                  ) : (
                    <CircleX size={13} />
                  )}
                  <b>{ACTOR_NAMES[event.actor] ?? event.actor}</b>
                  <span>{event.detail}</span>
                </li>
              ))}
          </ol>
        </aside>
      )}
      {pendingApproval && (
        <div
          className="stage-approval"
          role="dialog"
          aria-label="Friday needs your OK"
        >
          <p className="stage-approval-title">Friday needs your OK</p>
          <p className="stage-approval-text">{pendingApproval.summary}</p>
          <div className="stage-approval-actions">
            <button
              type="button"
              disabled={running}
              onClick={() => void decide(false)}
            >
              Decline
            </button>
            <button
              type="button"
              className="approve"
              disabled={running}
              onClick={() => void decide(true)}
            >
              Approve
            </button>
          </div>
        </div>
      )}
      <footer className="stage-footer">
        <div className="stage-captions">
          {captions.map((item, index) => (
            <p key={index} className={item.who}>
              <b>{item.who === 'you' ? 'You' : 'Friday'}</b> {item.text}
            </p>
          ))}
        </div>
        <form
          className="stage-input"
          onSubmit={(e) => {
            e.preventDefault();
            const text = draft;
            setDraft('');
            void send(text);
          }}
        >
          <input
            aria-label="Type a task for Friday"
            placeholder={
              loaded
                ? 'Type a task, e.g. “Open Notepad and write a shopping list”'
                : 'Connecting…'
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={!loaded || running}
          />
          <button
            type="submit"
            aria-label="Send"
            disabled={!draft.trim() || !loaded || running}
          >
            <Send size={16} />
          </button>
        </form>
      </footer>
    </div>
  );
}
