// Friday: the business dashboard (#/business). The owner's clients across
// India, grouped by region, each called by Friday in their own language with
// one click; the call as it happens (what was said, the language Friday heard)
// and what came of it: outcomes, leads and meetings booked on the phone.
// Not linked from the main page; open it at #/business.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  CalendarCheck,
  Loader2,
  Pencil,
  Phone,
  PhoneCall,
  Plus,
  Trash2,
  UserRound,
} from 'lucide-react';
import { ownerHeaders } from '../stage/activity';
import '../home/home.css';
import './business.css';

export const BUSINESS_HASH = '#/business';

interface CallView {
  id: string;
  phone: string;
  status: string;
  outcome: string | null;
  summary: string | null;
  language: string | null;
  meeting: string | null;
  lines: { who: 'friday' | 'client'; text: string }[];
  at: number | null;
  error: string | null;
}
interface Client {
  id: string;
  name: string;
  phone: string;
  city: string;
  language: string;
  note: string;
  example?: boolean;
  region: string;
  language_name: string;
  last_call: CallView | null;
}
interface Overview {
  business: { ready: boolean; name: string };
  calls_ready: boolean;
  missing: string[];
  busy: string | null;
  clients: Client[];
  calls: CallView[];
  leads: {
    id: string;
    name?: string;
    phone?: string;
    interest?: string;
    budget?: string;
    next_step?: string;
    at: number;
  }[];
  meetings: { id: string; title: string; date: string; time: string }[];
  languages: Record<string, string>;
}

// Each language in its own script, as the client would write it.
const NATIVE: Record<string, string> = {
  'en-IN': 'English',
  'hi-IN': 'हिन्दी',
  'mr-IN': 'मराठी',
  'ta-IN': 'தமிழ்',
  'te-IN': 'తెలుగు',
  'kn-IN': 'ಕನ್ನಡ',
  'ml-IN': 'മലയാളം',
  'bn-IN': 'বাংলা',
  'gu-IN': 'ગુજરાતી',
  'pa-IN': 'ਪੰਜਾਬੀ',
  'or-IN': 'ଓଡ଼ିଆ',
};
const REGIONS = ['North', 'West', 'South', 'East', 'Other'];
const PURPOSES = [
  ['sales', 'Sales pitch'],
  ['follow_up', 'Follow up'],
  ['meeting', 'Book a meeting'],
] as const;
const OUTCOME: Record<string, string> = {
  completed: 'Done',
  alternative_offered: 'Offered another time',
  declined: 'Not interested',
  needs_owner: 'Needs you',
  voicemail: 'Voicemail',
  wrong_number: 'Wrong number',
  other: 'Ended',
};
const LIVE = ['queued', 'ringing', 'in_progress'];

async function api<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(`/api/friday${path}`, {
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

const masked = (phone: string) =>
  phone.length > 7 ? `${phone.slice(0, 5)}•••${phone.slice(-4)}` : phone;
const languageLabel = (code: string | null, names: Record<string, string>) =>
  code ? `${NATIVE[code] ?? code} · ${names[code] ?? code}` : '';
const when = (seconds: number | null) =>
  seconds
    ? new Date(seconds * 1000).toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '';

function CallStatus({ call }: { call: CallView }) {
  if (LIVE.includes(call.status))
    return (
      <span className="biz-pill live">
        <i />
        {call.status === 'in_progress' ? 'On the call' : 'Ringing'}
      </span>
    );
  if (call.status === 'answered')
    return (
      <span className={`biz-pill outcome-${call.outcome ?? 'other'}`}>
        {OUTCOME[call.outcome ?? 'other'] ?? 'Ended'}
      </span>
    );
  return (
    <span className="biz-pill outcome-declined">
      {call.status === 'no_answer' ? 'No answer' : 'Failed'}
    </span>
  );
}

function ClientForm({
  initial,
  languages,
  onSave,
  onCancel,
}: {
  initial?: Partial<Client>;
  languages: Record<string, string>;
  onSave: (fields: Partial<Client>) => Promise<void>;
  onCancel: () => void;
}) {
  const [fields, setFields] = useState<Partial<Client>>({
    name: '',
    phone: '',
    city: '',
    language: 'hi-IN',
    note: '',
    ...initial,
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (key: keyof Client) => (value: string) =>
    setFields((current) => ({ ...current, [key]: value }));
  return (
    <form
      className="biz-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setError('');
        try {
          await onSave(fields);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setSaving(false);
        }
      }}
    >
      <label>
        Name
        <input
          id={`biz-name-${initial?.id ?? 'new'}`}
          value={fields.name ?? ''}
          onChange={(e) => set('name')(e.target.value)}
          required
        />
      </label>
      <label>
        Phone
        <input
          id={`biz-phone-${initial?.id ?? 'new'}`}
          value={fields.phone ?? ''}
          placeholder="+919812345678"
          inputMode="tel"
          onChange={(e) => set('phone')(e.target.value)}
        />
      </label>
      <label>
        City
        <input
          id={`biz-city-${initial?.id ?? 'new'}`}
          value={fields.city ?? ''}
          onChange={(e) => set('city')(e.target.value)}
        />
      </label>
      <label>
        Language
        <select
          id={`biz-language-${initial?.id ?? 'new'}`}
          value={fields.language}
          onChange={(e) => set('language')(e.target.value)}
        >
          {Object.entries(languages).map(([code, name]) => (
            <option key={code} value={code}>
              {NATIVE[code] ?? code} · {name}
            </option>
          ))}
        </select>
      </label>
      <label className="wide">
        About them
        <input
          id={`biz-note-${initial?.id ?? 'new'}`}
          value={fields.note ?? ''}
          placeholder="What they asked about last time"
          onChange={(e) => set('note')(e.target.value)}
        />
      </label>
      {error && <p className="biz-error wide">{error}</p>}
      <div className="biz-form-actions wide">
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={saving}>
          {saving ? <Loader2 size={14} className="spin" /> : null}
          Save
        </button>
      </div>
    </form>
  );
}

function ClientCard({
  client,
  overview,
  calling,
  onCall,
  onEdit,
  onRemove,
}: {
  client: Client;
  overview: Overview;
  calling: boolean;
  onCall: (purpose: string) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [purpose, setPurpose] = useState('sales');
  const last = client.last_call;
  const blocked = !client.phone
    ? 'Add a number to call'
    : !overview.business.ready
      ? 'Fill in the business profile first'
      : !overview.calls_ready
        ? 'Phone line not set up'
        : overview.busy
          ? 'Friday is on another call'
          : '';
  return (
    <article className={`biz-client${client.example ? ' example' : ''}`}>
      <header>
        <span className="biz-avatar" aria-hidden>
          <UserRound size={16} />
        </span>
        <div className="biz-who">
          <strong>{client.name}</strong>
          <span>{client.city || 'City not set'}</span>
        </div>
        <span className="biz-lang" title={client.language_name}>
          {NATIVE[client.language] ?? client.language}
        </span>
      </header>
      {client.note && <p className="biz-note">{client.note}</p>}
      <div className="biz-line">
        <Phone size={13} />
        {client.phone ? (
          masked(client.phone)
        ) : (
          <button type="button" className="link" onClick={onEdit}>
            Add number
          </button>
        )}
        {client.example && <span className="biz-tag">Example</span>}
        {last && <CallStatus call={last} />}
      </div>
      {last?.summary && <p className="biz-summary">{last.summary}</p>}
      <footer>
        <select
          id={`biz-purpose-${client.id}`}
          aria-label="What the call is for"
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
        >
          {PURPOSES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="call"
          disabled={!!blocked || calling}
          title={
            blocked || `Friday calls ${client.name} in ${client.language_name}`
          }
          onClick={() => onCall(purpose)}
        >
          {calling ? (
            <Loader2 size={14} className="spin" />
          ) : (
            <PhoneCall size={14} />
          )}
          Call
        </button>
        <button
          type="button"
          className="icon"
          aria-label={`Edit ${client.name}`}
          onClick={onEdit}
        >
          <Pencil size={14} />
        </button>
        <button
          type="button"
          className="icon"
          aria-label={`Remove ${client.name}`}
          onClick={onRemove}
        >
          <Trash2 size={14} />
        </button>
      </footer>
      {blocked && client.phone && <p className="biz-hint">{blocked}</p>}
    </article>
  );
}

export function BusinessPage({ onBack }: { onBack: () => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [calling, setCalling] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOverview(await api<Overview>('/business'));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const liveCall = overview?.calls.find((call) => LIVE.includes(call.status));
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), liveCall ? 1500 : 4000);
    return () => clearInterval(timer);
  }, [load, liveCall]);

  const byRegion = useMemo(() => {
    const groups = new Map<string, Client[]>();
    for (const client of overview?.clients ?? [])
      groups.set(client.region, [...(groups.get(client.region) ?? []), client]);
    return REGIONS.filter((region) => groups.has(region)).map(
      (region) => [region, groups.get(region)!] as const,
    );
  }, [overview]);

  const save = async (fields: Partial<Client>, id?: string) => {
    await api(id ? `/business/clients/${id}` : '/business/clients', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify({
        name: fields.name,
        phone: fields.phone,
        city: fields.city,
        language: fields.language,
        note: fields.note,
      }),
    });
    setEditing(null);
    await load();
  };
  const call = async (client: Client, purpose: string) => {
    setCalling(client.id);
    try {
      await api(`/business/clients/${client.id}/call`, {
        method: 'POST',
        body: JSON.stringify({ purpose }),
      });
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCalling(null);
      await load();
    }
  };
  const remove = async (client: Client) => {
    await api(`/business/clients/${client.id}`, { method: 'DELETE' });
    await load();
  };

  const names = overview?.languages ?? {};
  const spoken = new Set(overview?.clients.map((c) => c.language));
  const liveClient = liveCall
    ? overview?.clients.find(
        (c) => c.phone && liveCall.phone?.endsWith(c.phone.slice(-10)),
      )
    : undefined;
  const lastCall = liveCall ?? overview?.calls[0];

  return (
    <div className="friday-home friday-business">
      <header className="home-top">
        <div className="home-brand">
          <span className="home-mark" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          <strong>Friday</strong>
          <span className="biz-title">Business · client calls</span>
        </div>
        <nav>
          <button type="button" onClick={() => setEditing('new')}>
            <Plus size={16} />
            Add client
          </button>
          <button type="button" onClick={onBack}>
            <ArrowLeft size={16} />
            Main page
          </button>
        </nav>
      </header>
      <main className="biz-main">
        <section className="biz-hero">
          <div>
            <p className="biz-eyebrow">
              {overview?.business.ready
                ? overview.business.name || 'Your business'
                : 'No business profile yet'}
            </p>
            <h1>Friday calls your clients in their own language.</h1>
            <p className="biz-lede">
              Pick a client and press Call. Friday hears which language they
              speak, answers in it, books meetings into your calendar and saves
              every lead.
            </p>
          </div>
          <dl className="biz-stats">
            <div>
              <dt>Clients</dt>
              <dd>{overview?.clients.length ?? '–'}</dd>
            </div>
            <div>
              <dt>Languages</dt>
              <dd>{overview ? spoken.size : '–'}</dd>
            </div>
            <div>
              <dt>Calls</dt>
              <dd>{overview?.calls.length ?? '–'}</dd>
            </div>
            <div>
              <dt>Meetings</dt>
              <dd>{overview?.meetings.length ?? '–'}</dd>
            </div>
            <div>
              <dt>Leads</dt>
              <dd>{overview?.leads.length ?? '–'}</dd>
            </div>
          </dl>
        </section>

        {error && <p className="biz-banner">{error}</p>}
        {overview && !overview.business.ready && (
          <p className="biz-banner soft">
            Friday needs to know what to tell clients: fill in
            friday/business.md, or set
            FRIDAY_BUSINESS_PROFILE=friday/business.demo.md for the demo.
          </p>
        )}
        {overview && !overview.calls_ready && (
          <p className="biz-banner soft">
            The phone line is not set up. Missing in .env:{' '}
            {overview.missing.join(', ')}.
          </p>
        )}

        {editing === 'new' && (
          <ClientForm
            languages={names}
            onSave={(fields) => save(fields)}
            onCancel={() => setEditing(null)}
          />
        )}

        <div className="biz-layout">
          <div className="biz-regions">
            {!overview && !error && (
              <p className="biz-empty">
                <Loader2 size={16} className="spin" /> Loading clients…
              </p>
            )}
            {byRegion.map(([region, clients]) => (
              <section key={region} className="biz-region">
                <h2>
                  {region}
                  <span>
                    {[...new Set(clients.map((c) => NATIVE[c.language]))]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </h2>
                <div className="biz-grid">
                  {clients.map((client) =>
                    editing === client.id ? (
                      <ClientForm
                        key={client.id}
                        initial={client}
                        languages={names}
                        onSave={(fields) => save(fields, client.id)}
                        onCancel={() => setEditing(null)}
                      />
                    ) : (
                      <ClientCard
                        key={client.id}
                        client={client}
                        overview={overview!}
                        calling={calling === client.id}
                        onCall={(purpose) => void call(client, purpose)}
                        onEdit={() => setEditing(client.id)}
                        onRemove={() => void remove(client)}
                      />
                    ),
                  )}
                </div>
              </section>
            ))}
          </div>

          <aside className="biz-side">
            <section className="biz-panel biz-live">
              <h2>
                {liveCall ? 'On the call now' : 'Latest call'}
                {lastCall && <CallStatus call={lastCall} />}
              </h2>
              {!lastCall ? (
                <p className="biz-empty">
                  No client calls yet. Press Call on a client to start one.
                </p>
              ) : (
                <>
                  <p className="biz-meta">
                    {liveClient?.name ?? masked(lastCall.phone ?? '')}
                    {lastCall.language && (
                      <span className="biz-lang">
                        {languageLabel(lastCall.language, names)}
                      </span>
                    )}
                    <span>{when(lastCall.at)}</span>
                  </p>
                  <ol className="biz-transcript">
                    {lastCall.lines.length === 0 && (
                      <li className="biz-empty">
                        {liveCall
                          ? 'Waiting for them to pick up…'
                          : 'Nothing was said.'}
                      </li>
                    )}
                    {lastCall.lines.map((line, index) => (
                      <li key={index} className={line.who}>
                        <span>
                          {line.who === 'friday' ? 'Friday' : 'Client'}
                        </span>
                        {line.text}
                      </li>
                    ))}
                  </ol>
                  {lastCall.summary && (
                    <p className="biz-summary">{lastCall.summary}</p>
                  )}
                  {lastCall.meeting && (
                    <p className="biz-meeting">
                      <CalendarCheck size={14} /> Meeting booked:{' '}
                      {lastCall.meeting}
                    </p>
                  )}
                </>
              )}
            </section>

            <section className="biz-panel">
              <h2>Meetings booked on calls</h2>
              {overview?.meetings.length ? (
                <ul className="biz-list">
                  {[...overview.meetings].reverse().map((meeting) => (
                    <li key={meeting.id}>
                      <strong>
                        {meeting.date} · {meeting.time}
                      </strong>
                      {meeting.title}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="biz-empty">None yet.</p>
              )}
            </section>

            <section className="biz-panel">
              <h2>Leads</h2>
              {overview?.leads.length ? (
                <ul className="biz-list">
                  {overview.leads.map((lead) => (
                    <li key={lead.id}>
                      <strong>{lead.name || masked(lead.phone ?? '')}</strong>
                      {lead.interest}
                      {lead.next_step && <em>Next: {lead.next_step}</em>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="biz-empty">
                  Every client Friday talks to shows here.
                </p>
              )}
            </section>

            <section className="biz-panel">
              <h2>Recent calls</h2>
              {overview?.calls.length ? (
                <ul className="biz-list">
                  {overview.calls.slice(0, 8).map((item) => (
                    <li key={item.id}>
                      <strong>
                        {masked(item.phone ?? '')} <CallStatus call={item} />
                      </strong>
                      {item.summary ?? item.error ?? ''}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="biz-empty">None yet.</p>
              )}
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}
