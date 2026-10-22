// Friday: the main voice screen. Tap the orb and talk; Friday answers out
// loud, hands browser and desktop work to its helper Dots (Navigator,
// Operator), narrates what they do, and asks for a spoken yes before sending
// or calling on WhatsApp.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CopilotChatToolCallsView,
  useAgent,
  useCopilotKit,
  useHumanInTheLoop,
} from '@copilotkit/react-core/v2';
import {
  CircleCheck,
  CircleX,
  Loader2,
  MessageSquare,
  OctagonX,
  Send,
} from 'lucide-react';
import { api } from '../../../client/api';
import { ConnectionActionCard } from '../../../client/ConnectionActionCard';
import {
  connectionActionSchema,
  connectionActionTool,
} from '../../../shared/connection-types';
import type { Conversation, Dot, WorkspaceState } from '../../../shared/types';
import { FRIDAY_DEFAULT_LANGUAGE, FRIDAY_LANGUAGES } from '../../shared/voices';
import { lastReplyText } from '../speech';
import { toBase64 } from '../wav';
import { speechAudio, transcribeClip, voiceConfig } from '../voice-api';
import { followActivity, setStopped } from './activity';
import { HandsFree } from './handsFree';
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
const THREAD_TITLE = 'Friday voice';
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
}: {
  status: { tone: 'ok' | 'warn'; label: string };
  clock: string;
  language: string;
  onLanguage: (code: string) => void;
  onExit: () => void;
  onStop?: () => void;
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
  refresh,
  onExit,
}: {
  workspace?: WorkspaceState;
  configured: boolean;
  refresh: () => Promise<void> | void;
  onExit: () => void;
}) {
  const friday = workspace?.dots.find((dot) => dot.name === 'Friday');
  const thread = workspace?.conversations.find(
    (item) => item.dotId === friday?.id && item.title === THREAD_TITLE,
  );
  const [language, setLanguage] = useState(savedLanguage);
  const chooseLanguage = (code: string) => {
    setLanguage(code);
    try {
      localStorage.setItem(LANGUAGE_KEY, code);
    } catch {
      // Applies for this visit.
    }
  };
  const creating = useRef(false);
  useEffect(() => {
    if (!configured || !friday || thread || creating.current) return;
    creating.current = true;
    void api<Conversation>('/conversations', 'POST', {
      dotId: friday.id,
      title: THREAD_TITLE,
    })
      .then(() => refresh())
      .finally(() => {
        creating.current = false;
      });
  }, [configured, friday, thread, refresh]);

  if (typeof location !== 'undefined' && location.hash === STAGE_DEMO_HASH)
    return <StageDemo onExit={onExit} />;
  if (configured && friday && thread)
    return (
      <StageSession
        key={thread.id}
        friday={friday}
        thread={thread}
        language={language}
        onLanguage={chooseLanguage}
        onExit={onExit}
      />
    );

  const missing = !workspace
    ? 'Connecting…'
    : !friday
      ? 'Run friday/scripts/setup-friday-dot.mjs to create Friday and its helper Dots.'
      : !configured
        ? `Add to .env, then restart: ${workspace.setup.missing.join(', ')}.`
        : 'Opening Friday’s voice conversation…';
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
  thread,
  language,
  onLanguage,
  onExit,
}: {
  friday: Dot;
  thread: Conversation;
  language: string;
  onLanguage: (code: string) => void;
  onExit: () => void;
}) {
  const { agent, isReady } = useAgent({
    agentId: `stage-${thread.id}`,
    runtimeAgentId: friday.id,
    threadId: thread.id,
  });
  const { copilotkit } = useCopilotKit();
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<Phase>('off');
  const [voiceReady, setVoiceReady] = useState<boolean>();
  const [helpersOnline, setHelpersOnline] = useState(false);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [subtitle, setSubtitle] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [, rerender] = useState(0);

  const handsFree = useRef<HandsFree | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const ttsAnalyser = useRef<AnalyserNode | null>(null);
  const speakingMain = useRef(false);
  const lastNarration = useRef(0);
  const stopping = useRef(false);
  const approvalBox = useRef<HTMLDivElement>(null);
  const spokenApproval = useRef('');
  const languageRef = useRef(language);
  languageRef.current = language;

  useHumanInTheLoop(
    {
      name: connectionActionTool.name,
      description: connectionActionTool.description,
      parameters: connectionActionSchema,
      render: (props) => (
        <ConnectionActionCard {...props} threadId={thread.id} />
      ),
    },
    [thread.id],
  );

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

  useEffect(() => {
    if (!isReady) return;
    let active = true;
    void copilotkit
      .connectAgent({ agent })
      .then(() => active && setLoaded(true))
      .catch(
        (e) =>
          active &&
          setError(e instanceof Error ? e.message : 'Could not connect.'),
      );
    return () => {
      active = false;
    };
  }, [agent, copilotkit, isReady]);

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

  const stopSpeaking = () => {
    audio.current?.pause();
    audio.current = null;
    speakingMain.current = false;
  };

  const speak = async (text: string, main: boolean) => {
    if (!text || !voiceReady) return;
    if (!main && (speakingMain.current || audio.current)) return; // never talk over a reply
    stopSpeaking();
    speakingMain.current = main;
    if (main) setPhase('speaking');
    try {
      const url = URL.createObjectURL(
        await speechAudio(text, languageRef.current),
      );
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
    } catch (e) {
      if (main)
        setError(e instanceof Error ? e.message : 'Friday could not speak.');
    } finally {
      if (audio.current) audio.current = null;
      if (main) {
        speakingMain.current = false;
        setPhase(handsFree.current?.active ? 'listening' : 'off');
      }
    }
  };

  const pendingApproval = useMemo(() => {
    const results = new Set(
      agent.messages
        .filter((message) => message.role === 'tool')
        .map((message) => (message as { toolCallId?: string }).toolCallId),
    );
    for (let i = agent.messages.length - 1; i >= 0; i--) {
      const message = agent.messages[i];
      if (message.role === 'user') break;
      if (message.role !== 'assistant') continue;
      const call = message.toolCalls?.find(
        (item) =>
          item.function.name === connectionActionTool.name &&
          !results.has(item.id),
      );
      if (call) return { message, call };
    }
    return undefined;
    // agent.messages mutates in place; `running` and `events` re-run this.
  }, [agent.messages, agent.messages.length, running, events]);

  useEffect(() => {
    if (!pendingApproval || spokenApproval.current === pendingApproval.call.id)
      return;
    spokenApproval.current = pendingApproval.call.id;
    let summary = 'this action';
    try {
      summary =
        JSON.parse(pendingApproval.call.function.arguments ?? '{}').summary ||
        summary;
    } catch {
      // Keep the generic wording.
    }
    void speak(`I need your OK: ${summary}. Say yes or no.`, true);
  }, [pendingApproval]);

  const pressApproval = (approve: boolean) => {
    const buttons = [
      ...(approvalBox.current?.querySelectorAll('button') ?? []),
    ];
    const button = buttons.find((item) =>
      approve
        ? /approve/i.test(item.textContent ?? '')
        : /decline/i.test(item.textContent ?? ''),
    );
    button?.click();
    caption('friday', approve ? 'Approved.' : 'Declined.');
  };

  const send = async (text: string) => {
    if (!text.trim() || running || !loaded) return;
    caption('you', text);
    setSubtitle(text);
    setError('');
    setRunning(true);
    setPhase('thinking');
    agent.addMessage({
      id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
      role: 'user',
      content: text,
    });
    try {
      await copilotkit.runAgent({ agent });
      const reply = lastReplyText(agent.messages);
      if (reply) {
        caption('friday', reply);
        setSubtitle(reply);
        await speak(reply, true);
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'That did not work. Try again.',
      );
    } finally {
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
      rerender((n) => n + 1);
    }
  };

  const stopEverything = async () => {
    stopSpeaking();
    caption('friday', 'Stopping.');
    if (running) {
      stopping.current = true;
      await setStopped(true);
      copilotkit.stopAgent({ agent });
    }
  };

  const heard = async (wav: Uint8Array) => {
    setPhase('transcribing');
    let text = '';
    try {
      text = (await transcribeClip(toBase64(wav), languageRef.current)).trim();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not hear that.');
    }
    if (!text) {
      setPhase(running ? 'thinking' : 'listening');
      return;
    }
    const intent = intentOf(text);
    if (intent === 'stop') return stopEverything();
    if (pendingApproval) {
      caption('you', text);
      if (intent === 'yes' || intent === 'no')
        return pressApproval(intent === 'yes');
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
    setError('');
    if (handsFree.current?.active) {
      handsFree.current.stop();
      handsFree.current = null;
      setPhase(running ? 'thinking' : 'off');
      return;
    }
    const next = new HandsFree({
      onSpeechStart: () => {
        if (audio.current) stopSpeaking(); // talk over Friday to interrupt
        setPhase((current) => (current === 'listening' ? 'hearing' : current));
      },
      onUtterance: (wav) => void heardRef.current(wav),
      onError: setError,
      isFridaySpeaking: () => !!audio.current,
    });
    try {
      await next.start();
    } catch {
      setError('Allow microphone access so Friday can hear you.');
      return;
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
  const title = pendingApproval
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
    (pendingApproval
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
      />
      <section className="stage-title" aria-live="polite">
        <h1>{title}</h1>
        <p className={error ? 'error' : ''}>{line}</p>
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
        <div className="stage-approval" ref={approvalBox}>
          <CopilotChatToolCallsView
            message={pendingApproval.message}
            messages={agent.messages}
          />
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
