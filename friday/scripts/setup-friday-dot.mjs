#!/usr/bin/env node
// Friday: sets up the three Dots and their tools from friday/services.
//
//   Friday     the one you talk to; WhatsApp tools (each send or call asks you
//              first) and delegate_to_dot to hand work to the helpers
//   Navigator  drives a Chrome window on your screen (browser tools)
//   Operator   opens and works desktop apps (desktop tools)
//
// Helpers work in their own conversations without approval cards, so their
// tools run without "Ask first"; WhatsApp stays with Friday, behind your OK.
// Existing Dots are updated and connections refreshed, keeping your choices;
// pass --reconnect after changing FRIDAY_SERVICES_TOKEN or the port.
//
// Start the app (npm run dev) and friday/services first, then from the repo root:
//   node --env-file-if-exists=.env friday/scripts/setup-friday-dot.mjs

import { readFile } from 'node:fs/promises';

const APP_URL = (process.env.FRIDAY_APP_URL ?? 'http://127.0.0.1:4310').replace(
  /\/+$/,
  '',
);
const SERVICES_PORT = process.env.FRIDAY_SERVICES_PORT || 8765;
const SERVICES_URL = (
  process.env.FRIDAY_SERVICES_URL ?? `http://127.0.0.1:${SERVICES_PORT}`
).replace(/\/+$/, '');
const CALENDAR_URL =
  process.env.FRIDAY_CALENDAR_URL || `${SERVICES_URL}/calendar`;
const reconnect = process.argv.includes('--reconnect');

const DOTS = [
  { name: 'Friday', persona: '../persona.md', connections: ['whatsapp'] },
  {
    name: 'Navigator',
    persona: '../dots/navigator.md',
    connections: ['browser'],
  },
  {
    name: 'Operator',
    persona: '../dots/operator.md',
    connections: ['desktop'],
  },
];
// Parked skills that older setups connected to Friday.
const RETIRED = ['phone', 'calendar', 'telegram'];

async function api(path, method = 'GET', body) {
  const response = await fetch(`${APP_URL}/api${path}`, {
    method,
    headers: {
      // OpenDots only accepts JSON for anything but GET, DELETE included.
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      ...(process.env.OWNER_TOKEN
        ? { Authorization: `Bearer ${process.env.OWNER_TOKEN}` }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      `${method} ${path} returned HTTP ${response.status}: ${data.error ?? 'no details'}`,
    );
  return data;
}

async function persona(file) {
  const text = (await readFile(new URL(file, import.meta.url), 'utf8'))
    .trim()
    .replaceAll('{{CALENDAR_URL}}', CALENDAR_URL);
  if (text.length > 2000)
    throw new Error(
      `${file} is ${text.length} characters; OpenDots allows 2000.`,
    );
  return text;
}

async function connect(dot, name, helper) {
  const url = `${SERVICES_URL}/${name}/mcp`;
  const current = await api(`/dots/${dot.id}/connections`);
  const found = current.find((connection) => connection.name === name);
  if (found && (reconnect || found.url !== url))
    await api(`/connections/${found.id}`, 'DELETE');
  let connection =
    found && !reconnect && found.url === url
      ? await api(`/connections/${found.id}/refresh`, 'POST', {})
      : await api(`/dots/${dot.id}/connections`, 'POST', {
          name,
          url,
          token: process.env.FRIDAY_SERVICES_TOKEN,
        });
  if (connection.error) throw new Error(connection.error);
  if (helper)
    for (const tool of connection.tools.filter((t) => t.requiresApproval))
      connection = await api(
        `/connections/${connection.id}/tools/${encodeURIComponent(tool.name)}`,
        'PATCH',
        { requiresApproval: false },
      );
  return connection;
}

let workspace;
try {
  workspace = await api('/workspace');
} catch (error) {
  console.error(
    `Could not reach OpenDots at ${APP_URL}. Start it with "npm run dev" first.\n${error.message}`,
  );
  process.exit(1);
}

for (const spec of DOTS) {
  const settings = {
    name: spec.name,
    instructions: await persona(spec.persona),
    researchAllowed: true,
    memoryAllowed: spec.name === 'Friday',
  };
  const existing = workspace.dots.find((dot) => dot.name === spec.name);
  const dot = existing
    ? await api(`/dots/${existing.id}`, 'PUT', {
        ...settings,
        appsAllowed: existing.appsAllowed,
        composioToolkits: existing.composioToolkits,
        spaceIds: existing.spaceIds,
        spaceId: existing.spaceId,
      })
    : await api('/dots', 'POST', {
        ...settings,
        spaceId: workspace.spaces[0].id,
      });
  console.log(`${existing ? 'Updated' : 'Created'} ${dot.name} (${dot.id}).`);

  if (!process.env.FRIDAY_SERVICES_TOKEN) continue;
  if (spec.name === 'Friday')
    for (const old of (await api(`/dots/${dot.id}/connections`)).filter(
      (connection) => RETIRED.includes(connection.name),
    )) {
      await api(`/connections/${old.id}`, 'DELETE');
      console.log(`  Removed the parked ${old.name} connection.`);
    }
  for (const name of spec.connections)
    try {
      const connection = await connect(dot, name, spec.name !== 'Friday');
      console.log(
        `  Connected ${name}: ${connection.tools.map((tool) => `${tool.name}${tool.requiresApproval ? ' (asks first)' : ''}`).join(', ')}`,
      );
    } catch (error) {
      console.log(
        `  Could not connect ${name} at ${SERVICES_URL}/${name}/mcp: ${error.message}`,
      );
    }
}

if (!process.env.FRIDAY_SERVICES_TOKEN)
  console.log(
    'Skipped tool connections: set FRIDAY_SERVICES_TOKEN in .env and start friday/services.',
  );
if (workspace.setup.missing.length)
  console.log(
    `Before chatting, OpenDots still needs: ${workspace.setup.missing.join(', ')}.`,
  );
