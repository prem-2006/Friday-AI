// Friday: the console at the top of the main page, in the layout of the ARRC
// "J" console: how to talk and system status on the left, Friday's reactor
// and what it is doing in the middle, and the live feed under them.
import { useCallback, useEffect, useState } from 'react';
import { followActivity, ownerHeaders } from '../stage/activity';
import type { ActivityEvent } from '../stage/narration';

async function api<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...ownerHeaders() },
  });
  const data = (await response.json().catch(() => ({}))) as T & {
    detail?: string;
    error?: string;
  };
  if (!response.ok)
    throw new Error(
      data.detail ?? data.error ?? `Request failed (${response.status}).`,
    );
  return data as T;
}

// Which ability lights up for each action Friday or a helper runs.
export const ABILITY_OF: Record<string, string> = {
  open_website: 'web',
  web_search: 'web',
  browser_search: 'web',
  browser_open: 'web',
  browser_task: 'web',
  browser_click: 'web',
  browser_type: 'web',
  browser_read: 'web',
  play_youtube: 'music',
  play_shown_video: 'music',
  media_control: 'music',
  run_mode: 'apps',
  open_app: 'apps',
  write_in_app: 'apps',
  clear_in_app: 'apps',
  press_keys_in_app: 'apps',
  window_type: 'apps',
  window_click: 'apps',
  snap_window: 'apps',
  find_files: 'files',
  open_file: 'files',
  draft_email: 'email',
  send_email: 'email',
  schedule_meeting: 'calendar',
  whatsapp_send_message: 'whatsapp',
  whatsapp_call: 'whatsapp',
  whatsapp_find_chat: 'whatsapp',
  set_timer: 'reminders',
  add_reminder: 'reminders',
  add_deadline: 'reminders',
  finish_reminder: 'reminders',
  reminder: 'reminders',
  focus_session: 'reminders',
  take_note: 'notes',
  read_notes: 'notes',
  show_notes: 'notes',
  look_at_screen: 'screen',
  take_screenshot: 'screen',
  system_status: 'screen',
  lock_screen: 'screen',
  weather: 'weather',
  directions: 'weather',
  code_editor_read: 'coding',
  code_editor_write: 'coding',
};

interface Reminder {
  id: string;
  kind: 'timer' | 'reminder' | 'deadline';
  text: string;
  due: number;
}

const ACTORS: Record<string, string> = {
  friday: 'Friday',
  navigator: 'Navigator',
  operator: 'Operator',
};

const clock = (seconds: number) =>
  new Date(seconds * 1000).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });

function Reactor({
  state,
  word,
}: {
  state: 'idle' | 'fire' | 'deny';
  word: string;
}) {
  return (
    <div className={`reactor ${state}`}>
      <div className="reactor-gyro" aria-hidden>
        <i />
        <i />
        <i />
      </div>
      <div className="reactor-sweep" aria-hidden />
      <svg viewBox="0 0 200 200" aria-hidden>
        <g className="spin">
          <circle
            cx="100"
            cy="100"
            r="92"
            className="ring thin"
            strokeDasharray="2 6"
          />
        </g>
        <g className="spin r">
          <circle
            cx="100"
            cy="100"
            r="80"
            className="ring"
            strokeDasharray="60 18 8 18"
          />
        </g>
        <g className="spin f">
          <circle
            cx="100"
            cy="100"
            r="68"
            className="ring bold"
            strokeDasharray="22 140"
          />
        </g>
        <g className="spin r">
          <circle
            cx="100"
            cy="100"
            r="58"
            className="ring thin"
            strokeDasharray="1 4"
          />
        </g>
        {Array.from({ length: 12 }, (_, i) => (
          <line
            key={i}
            x1="100"
            y1="6"
            x2="100"
            y2="14"
            className="tick"
            transform={`rotate(${i * 30} 100 100)`}
          />
        ))}
      </svg>
      <div className="center">
        <div className="state">
          {state === 'fire'
            ? 'WORKING'
            : state === 'deny'
              ? 'PROBLEM'
              : 'READY'}
        </div>
        <div className="big">{word}</div>
      </div>
    </div>
  );
}

export function FridayConsole() {
  const [googleAccount, setGoogleAccount] = useState('');
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [online, setOnline] = useState(false);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [now, setNow] = useState(Date.now());

  const loadReminders = useCallback(async () => {
    try {
      setReminders(await api<Reminder[]>('/friday/reminders'));
    } catch {
      // services offline: the System panel says so
    }
  }, []);

  useEffect(() => {
    void api<{ events: ActivityEvent[] }>('/friday/activity')
      .then((data) =>
        setEvents(data.events.filter((e) => e.actor !== 'control')),
      )
      .catch(() => {});
    void loadReminders();
    void api<{ signed_in: boolean; email?: string | null }>(
      '/friday/account/google',
    )
      .then((account) =>
        setGoogleAccount(account.signed_in ? account.email || 'signed in' : ''),
      )
      .catch(() => {});
    // Not a voice window: the console never takes Caps Lock from the notch.
    const stop = followActivity(
      (event) => {
        if (event.actor === 'control') return;
        setEvents((list) => [...list.slice(-80), event]);
        if (ABILITY_OF[event.action] === 'reminders') void loadReminders();
      },
      setOnline,
      false,
    );
    const ticker = setInterval(() => setNow(Date.now()), 1000);
    const refresh = setInterval(() => void loadReminders(), 20_000);
    return () => {
      stop();
      clearInterval(ticker);
      clearInterval(refresh);
    };
  }, [loadReminders]);

  const latest = events.at(-1);
  const reactorState =
    latest && now - latest.at * 1000 < 8000
      ? latest.state === 'failed'
        ? 'deny'
        : latest.state === 'running'
          ? 'fire'
          : 'idle'
      : 'idle';
  const today = new Date().toDateString();
  const actionsToday = events.filter(
    (event) =>
      event.state === 'done' &&
      new Date(event.at * 1000).toDateString() === today,
  ).length;
  const word = latest
    ? latest.action.replace(/_/g, ' ').replace(/^browser /, '') || 'Friday'
    : 'Friday';

  // FRIDAY: one clear order: who Friday is and how to talk to it, what it is
  // doing, then everything it can do.
  return (
    <div className="console">
      <section className="console-hero">
        <div className="hero-copy">
          <h1>
            F<span>R</span>IDAY
          </h1>
          <div className="tag">Your AI voice assistant, built on Gnani</div>
          <div className="panel talk">
            <div className="label">Talk to Friday</div>
            Hold
            <b>
              <kbd>Caps Lock</kbd>
            </b>
            <div className="hint">
              anywhere and speak; let go when you are done. English, Hindi or
              any mix. Gnani hears you, Friday and its Dots do the work, Gnani
              speaks. Ctrl + Caps Lock hides the notch.
            </div>
          </div>
          <div className="panel system">
            <div className="label">System</div>
            <div className="chips">
              <div className="chip">
                <span>Friday services</span>
                <i className={online ? 'ok' : 'bad'}>
                  <span className="dot" />
                  {online ? 'ONLINE' : 'OFFLINE'}
                </i>
              </div>
              <div className="chip">
                <span>Google account</span>
                <i className={googleAccount ? 'ok' : 'warn'}>
                  {googleAccount ? 'SIGNED IN' : 'NOT YET'}
                </i>
              </div>
              <div className="chip">
                <span>Actions today</span>
                <i>{actionsToday}</i>
              </div>
              <div className="chip">
                <span>Coming up</span>
                <i>{reminders.length}</i>
              </div>
            </div>
          </div>
        </div>
        <div className="console-core">
          <Reactor state={reactorState} word={word} />
          <div className="now">
            <div className="cmd">
              {latest ? (
                <>
                  <b>{ACTORS[latest.actor] ?? latest.actor}</b> {latest.detail}
                </>
              ) : (
                'Waiting for you. Hold Caps Lock to talk.'
              )}
            </div>
            <div className="res">{latest ? clock(latest.at) : ''}</div>
          </div>
        </div>
      </section>

      <h2 className="home-section">Activity</h2>
      <div className="console-row">
        <div className="panel live">
          <div className="label">Live</div>
          <div className="feed">
            {events.length === 0 && (
              <div className="empty">
                Nothing yet. What Friday does shows up here.
              </div>
            )}
            {[...events]
              .reverse()
              .filter((event) => event.state !== 'running')
              .slice(0, 12)
              .map((event) => (
                <div
                  key={event.id}
                  className={`item ${event.state === 'failed' ? 'refused' : ''}`}
                >
                  <div className="top">
                    <span className="act">
                      {event.action.replace(/_/g, ' ')}
                    </span>
                    <span>{clock(event.at)}</span>
                  </div>
                  <div className="in">{event.detail}</div>
                  <div className="out">
                    {ACTORS[event.actor] ?? event.actor}
                  </div>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
