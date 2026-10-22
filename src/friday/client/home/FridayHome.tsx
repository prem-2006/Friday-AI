// Friday: the main page. The owner's details, Friday's Google account and
// shortcuts into it, and what Friday is allowed to do. Talking happens on the
// voice screen or the desktop notch, by holding Caps Lock.
import { useCallback, useEffect, useState } from 'react';
import {
  CalendarDays,
  HardDrive,
  Keyboard,
  LayoutGrid,
  Loader2,
  Mail,
  Mic,
  Play,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import type { Connection } from '../../../shared/connection-types';
import type { WorkspaceState } from '../../../shared/types';
import { ownerHeaders } from '../stage/activity';
import {
  ABILITIES,
  setAbility,
  stateOf,
  toolsOf,
  type AbilityState,
} from './permissions';
import './home.css';

export const HOME_HASH = '#/home';

async function api<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...ownerHeaders(),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    detail?: string;
  };
  if (!response.ok)
    throw new Error(
      data.detail ?? data.error ?? `Request failed (${response.status}).`,
    );
  return data as T;
}

type Profile = Partial<
  Record<'name' | 'email' | 'phone' | 'city' | 'address' | 'notes', string>
>;
const FIELDS: {
  key: keyof Profile;
  label: string;
  type?: string;
  wide?: boolean;
}[] = [
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'phone', label: 'Phone', type: 'tel' },
  { key: 'city', label: 'City' },
  { key: 'address', label: 'Address', wide: true },
];

function ProfileCard() {
  const [saved, setSaved] = useState<Profile>({});
  const [draft, setDraft] = useState<Profile>({});
  const [status, setStatus] = useState('');
  useEffect(() => {
    void api<Profile>('/friday/profile')
      .then((profile) => {
        setSaved(profile);
        setDraft(profile);
      })
      .catch(() => setStatus('Could not load your details.'));
  }, []);
  const changed = FIELDS.concat({ key: 'notes', label: '' }).some(
    ({ key }) => (draft[key] ?? '') !== (saved[key] ?? ''),
  );
  const save = async () => {
    setStatus('');
    try {
      const profile = await api<Profile>('/friday/profile', {
        method: 'PUT',
        body: JSON.stringify(draft),
      });
      setSaved(profile);
      setDraft(profile);
      setStatus('Saved.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not save.');
    }
  };
  return (
    <section className="home-card">
      <header>
        <UserRound size={18} />
        <h2>Your details</h2>
      </header>
      <p className="home-muted">
        Kept on this PC. Friday uses them only when a task needs them, and asks
        before sharing them with anyone.
      </p>
      <form
        className="home-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {FIELDS.map(({ key, label, type, wide }) => (
          <label key={key} className={wide ? 'wide' : ''}>
            <span>{label}</span>
            <input
              type={type ?? 'text'}
              value={draft[key] ?? ''}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  [key]: event.target.value,
                }))
              }
            />
          </label>
        ))}
        <label className="wide">
          <span>Notes for Friday</span>
          <textarea
            rows={4}
            placeholder="Preferences, e.g. “I prefer morning appointments.”"
            value={draft.notes ?? ''}
            onChange={(event) =>
              setDraft((current) => ({ ...current, notes: event.target.value }))
            }
          />
        </label>
        <div className="home-actions wide">
          <span className="home-muted">{status}</span>
          <button type="submit" className="primary" disabled={!changed}>
            Save
          </button>
        </div>
      </form>
    </section>
  );
}

const SHORTCUTS = [
  { label: 'Gmail', url: 'https://mail.google.com/', Icon: Mail },
  {
    label: 'Calendar',
    url: 'https://calendar.google.com/',
    Icon: CalendarDays,
  },
  { label: 'Drive', url: 'https://drive.google.com/', Icon: HardDrive },
  { label: 'YouTube', url: 'https://www.youtube.com/', Icon: Play },
];

type GoogleState = 'checking' | 'signed-in' | 'signed-out' | 'offline';

function GoogleCard() {
  const [state, setState] = useState<GoogleState>('checking');
  const [note, setNote] = useState('');
  const check = useCallback(async () => {
    setState('checking');
    try {
      const account = await api<{ signed_in: boolean }>(
        '/friday/account/google',
      );
      setState(account.signed_in ? 'signed-in' : 'signed-out');
    } catch {
      setState('offline');
    }
  }, []);
  useEffect(() => void check(), [check]);
  const signIn = async () => {
    try {
      await api('/friday/account/google/connect', {
        method: 'POST',
        body: '{}',
      });
      setNote(
        'Sign in in Friday’s Chrome window (type your password there yourself), then check again.',
      );
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Could not open it.');
    }
  };
  const open = async (url: string) => {
    try {
      await api('/friday/browser/open', {
        method: 'POST',
        body: JSON.stringify({ url }),
      });
      setNote('');
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Could not open it.');
    }
  };
  const label = {
    checking: 'Checking…',
    'signed-in': 'Signed in',
    'signed-out': 'Not signed in',
    offline: 'Friday’s browser is offline',
  }[state];
  return (
    <section className="home-card">
      <header>
        <Mail size={18} />
        <h2>Google account</h2>
        <span className={`home-pill ${state}`}>{label}</span>
      </header>
      <p className="home-muted">
        Friday’s Chrome window can use one Google account for Gmail, Calendar
        and Drive. Sending an email always asks you first.
      </p>
      <div className="home-row">
        {state !== 'signed-in' && (
          <button
            type="button"
            className="primary"
            disabled={state === 'offline' || state === 'checking'}
            onClick={() => void signIn()}
          >
            Sign in to Google
          </button>
        )}
        <button type="button" onClick={() => void check()}>
          Check again
        </button>
      </div>
      {note && <p className="home-note">{note}</p>}
      <div className="home-shortcuts">
        {SHORTCUTS.map(({ label: name, url, Icon }) => (
          <button
            key={name}
            type="button"
            disabled={state === 'offline'}
            onClick={() => void open(url)}
          >
            <Icon size={16} />
            {name}
          </button>
        ))}
      </div>
    </section>
  );
}

function PermissionsCard({ dots }: { dots: { id: string; name: string }[] }) {
  // The workspace is re-sent often; reload only when the Dots themselves change.
  const dotKey = dots.map((dot) => `${dot.id}:${dot.name}`).join(',');
  const [byDot, setByDot] = useState<Record<string, Connection[]>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const entries = await Promise.all(
        dots
          .filter((dot) =>
            ['Friday', 'Navigator', 'Operator'].includes(dot.name),
          )
          .map(
            async (dot) =>
              [
                dot.name,
                await api<Connection[]>(`/dots/${dot.id}/connections`),
              ] as const,
          ),
      );
      setByDot(Object.fromEntries(entries));
      setError('');
    } catch {
      setError('Could not read Friday’s permissions.');
    }
  }, [dotKey]);
  useEffect(() => void load(), [load]);
  const toggle = async (id: string, on: boolean) => {
    const ability = ABILITIES.find((item) => item.id === id)!;
    setBusy(id);
    try {
      await setAbility(
        toolsOf(ability, byDot),
        on,
        async (connection, tool) => {
          await api(
            `/connections/${connection}/tools/${encodeURIComponent(tool)}`,
            { method: 'PATCH', body: JSON.stringify({ enabled: on }) },
          );
        },
      );
      await load();
    } catch {
      setError('Could not change that permission.');
    } finally {
      setBusy('');
    }
  };
  return (
    <section className="home-card">
      <header>
        <ShieldCheck size={18} />
        <h2>Permissions</h2>
      </header>
      <p className="home-muted">
        Switching something off stops every helper from doing it.
      </p>
      <ul className="home-permissions">
        {ABILITIES.map((ability) => {
          const state: AbilityState = stateOf(toolsOf(ability, byDot));
          const on = state === 'on' || state === 'mixed';
          return (
            <li key={ability.id}>
              <div>
                <strong>{ability.title}</strong>
                <span className="home-muted">
                  {ability.detail}
                  {ability.alwaysAsks && ' Always asks you first.'}
                  {state === 'unavailable' && ' Not set up yet.'}
                </span>
              </div>
              {busy === ability.id ? (
                <Loader2 size={18} className="home-spin" />
              ) : (
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={ability.title}
                  className={`home-switch ${on ? 'on' : ''}`}
                  disabled={state === 'unavailable'}
                  onClick={() => void toggle(ability.id, !on)}
                >
                  <i />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="home-note error">{error}</p>}
    </section>
  );
}

export function FridayHome({
  workspace,
  onVoice,
  onAdvanced,
}: {
  workspace?: WorkspaceState;
  onVoice: () => void;
  onAdvanced: () => void;
}) {
  return (
    <div className="friday-home">
      <header className="home-top">
        <div className="home-brand">
          <span className="home-mark" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          <strong>Friday</strong>
        </div>
        <nav>
          <button type="button" onClick={onVoice}>
            <Mic size={16} />
            Voice screen
          </button>
          <button type="button" onClick={onAdvanced}>
            <LayoutGrid size={16} />
            Dots
          </button>
        </nav>
      </header>
      <main className="home-main">
        <div className="home-hint">
          <Keyboard size={18} />
          <span>
            Hold <kbd>Caps Lock</kbd> anywhere and speak; let go when you are
            done. A quick tap is still ordinary Caps Lock.
          </span>
        </div>
        <div className="home-grid">
          <ProfileCard />
          <div className="home-column">
            <GoogleCard />
            <PermissionsCard dots={workspace?.dots ?? []} />
          </div>
        </div>
      </main>
    </div>
  );
}
