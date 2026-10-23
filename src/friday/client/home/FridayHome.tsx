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
  Record<
    'name' | 'email' | 'phone' | 'city' | 'address' | 'notes' | 'friday_google',
    string
  >
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

function ProfileCard({
  saved,
  onSaved,
  loadError,
}: {
  saved: Profile;
  onSaved: (profile: Profile) => void;
  loadError: boolean;
}) {
  const [draft, setDraft] = useState<Profile>(saved);
  const [status, setStatus] = useState('');
  useEffect(() => setDraft(saved), [saved]);
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
      onSaved(profile);
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
          <span className="home-muted">
            {status || (loadError ? 'Could not load your details.' : '')}
          </span>
          <button type="submit" className="primary" disabled={!changed}>
            Save
          </button>
        </div>
      </form>
    </section>
  );
}

// Gmail, Calendar and Drive in the account Friday is signed in to, even if
// more Google accounts get signed in to Friday's Chrome later.
export function googleShortcuts(email?: string | null) {
  const as = email ? `authuser=${encodeURIComponent(email)}` : '';
  return [
    {
      label: 'Gmail',
      url: as
        ? `https://mail.google.com/mail/u/?${as}`
        : 'https://mail.google.com/',
    },
    {
      label: 'Calendar',
      url: as
        ? `https://calendar.google.com/calendar/r?${as}`
        : 'https://calendar.google.com/',
    },
    {
      label: 'Drive',
      url: as
        ? `https://drive.google.com/drive/my-drive?${as}`
        : 'https://drive.google.com/',
    },
    { label: 'YouTube', url: 'https://www.youtube.com/' },
  ];
}
const SHORTCUT_ICONS = {
  Gmail: Mail,
  Calendar: CalendarDays,
  Drive: HardDrive,
  YouTube: Play,
} as const;

interface GoogleAccount {
  signed_in: boolean;
  email?: string | null;
}
type GoogleState = 'checking' | 'signed-in' | 'signed-out' | 'offline';

function GoogleCard({
  profile,
  onSaved,
}: {
  profile: Profile;
  onSaved: (profile: Profile) => void;
}) {
  const [accountDraft, setAccountDraft] = useState(profile.friday_google ?? '');
  useEffect(() => setAccountDraft(profile.friday_google ?? ''), [profile]);
  const saveAccount = async () => {
    try {
      onSaved(
        await api<Profile>('/friday/profile', {
          method: 'PUT',
          body: JSON.stringify({ ...profile, friday_google: accountDraft }),
        }),
      );
      setNote('Saved. Sign in with it below.');
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Could not save.');
    }
  };
  const [state, setState] = useState<GoogleState>('checking');
  const [account, setAccount] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const check = useCallback(async () => {
    setState('checking');
    try {
      const found = await api<GoogleAccount>('/friday/account/google');
      setAccount(found.email ?? null);
      setState(found.signed_in ? 'signed-in' : 'signed-out');
    } catch {
      setState('offline');
    }
  }, []);
  useEffect(() => void check(), [check]);
  // Friday's own account when set, otherwise the owner's email.
  const wanted =
    (profile.friday_google || profile.email)?.trim().toLowerCase() || undefined;
  const otherAccount =
    state === 'signed-in' && !!account && !!wanted && account !== wanted;
  const signIn = async () => {
    try {
      await api('/friday/account/google/connect', {
        method: 'POST',
        body: JSON.stringify(wanted ? { email: wanted } : {}),
      });
      setNote(
        'Finish signing in in Friday’s Chrome window (type your password there yourself), then check again.',
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
  const label =
    state === 'signed-in'
      ? account
        ? `Signed in as ${account}`
        : 'Signed in'
      : {
          checking: 'Checking…',
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
        Friday works in your own Google account (Gmail, Calendar, Drive) in its
        Chrome window. Sign in there once and it stays signed in. Sending an
        email always asks you first.
      </p>
      {otherAccount && (
        <p className="home-note">
          Friday is signed in as {account}, but it should use {wanted}.
        </p>
      )}
      {state === 'signed-out' && !wanted && (
        <p className="home-note">
          Enter the Gmail address Friday should use, then sign in with it.
        </p>
      )}
      <form
        className="home-account"
        onSubmit={(event) => {
          event.preventDefault();
          void saveAccount();
        }}
      >
        <label>
          <span>Google account Friday uses</span>
          <input
            type="email"
            placeholder={profile.email || 'you@gmail.com'}
            value={accountDraft}
            onChange={(event) => setAccountDraft(event.target.value)}
          />
        </label>
        <button
          type="submit"
          disabled={accountDraft === (profile.friday_google ?? '')}
        >
          Save
        </button>
      </form>
      <div className="home-row">
        {(state === 'signed-out' || otherAccount) && (
          <button
            type="button"
            className="primary"
            onClick={() => void signIn()}
          >
            {wanted ? `Sign in as ${wanted}` : 'Sign in to Google'}
          </button>
        )}
        <button type="button" onClick={() => void check()}>
          Check again
        </button>
      </div>
      {note && <p className="home-note">{note}</p>}
      <div className="home-shortcuts">
        {googleShortcuts(account).map(({ label: name, url }) => {
          const Icon = SHORTCUT_ICONS[name as keyof typeof SHORTCUT_ICONS];
          return (
            <button
              key={name}
              type="button"
              disabled={state === 'offline'}
              onClick={() => void open(url)}
            >
              <Icon size={16} />
              {name}
            </button>
          );
        })}
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
  // Your details, shared by the details card and the Google card.
  const [profile, setProfile] = useState<Profile>({});
  const [profileError, setProfileError] = useState(false);
  useEffect(() => {
    void api<Profile>('/friday/profile')
      .then(setProfile)
      .catch(() => setProfileError(true));
  }, []);
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
          <ProfileCard
            saved={profile}
            onSaved={setProfile}
            loadError={profileError}
          />
          <div className="home-column">
            <GoogleCard profile={profile} onSaved={setProfile} />
            <PermissionsCard dots={workspace?.dots ?? []} />
          </div>
        </div>
      </main>
    </div>
  );
}
