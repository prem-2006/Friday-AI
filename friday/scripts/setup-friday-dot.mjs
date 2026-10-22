#!/usr/bin/env node
// Friday: creates the "Friday" Dot, or updates it if it already exists, with
// the persona in friday/persona.md. Research and memory are switched on, the
// Dot computer's browser is allowed when computers are configured, and
// friday/services is connected over MCP.
//
// Start the app first (npm run dev), then from the repo root:
//   node --env-file-if-exists=.env friday/scripts/setup-friday-dot.mjs

import { readFile } from 'node:fs/promises';

const NAME = 'Friday';
const APP_URL = (process.env.FRIDAY_APP_URL ?? 'http://127.0.0.1:4310').replace(
  /\/+$/,
  '',
);
const SERVICES_PORT = process.env.FRIDAY_SERVICES_PORT || 8765;
// The Dot computer runs in Docker, where the host is host.docker.internal.
const CALENDAR_URL =
  process.env.FRIDAY_CALENDAR_URL ||
  `http://host.docker.internal:${SERVICES_PORT}/calendar`;
const persona = (
  await readFile(new URL('../persona.md', import.meta.url), 'utf8')
)
  .trim()
  .replaceAll('{{CALENDAR_URL}}', CALENDAR_URL);
if (persona.length > 2000) {
  console.error(
    `friday/persona.md is ${persona.length} characters; OpenDots allows 2000.`,
  );
  process.exit(2);
}

async function api(path, method = 'GET', body) {
  const response = await fetch(`${APP_URL}/api${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(process.env.OWNER_TOKEN
        ? { Authorization: `Bearer ${process.env.OWNER_TOKEN}` }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      `${method} ${path} returned HTTP ${response.status}: ${data.error ?? 'no details'}`,
    );
  return data;
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

const settings = {
  name: NAME,
  instructions: persona,
  researchAllowed: true,
  memoryAllowed: true,
};
const existing = workspace.dots.find((dot) => dot.name === NAME);
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

console.log(
  `${existing ? 'Updated' : 'Created'} the ${dot.name} Dot (${dot.id}) with research and memory on.`,
);

// Connect Friday's skills from friday/services as MCP connections. Existing
// connections are refreshed so your per-tool choices stay; pass --reconnect
// after changing FRIDAY_SERVICES_TOKEN or the port.
const SERVICES_URL = (
  process.env.FRIDAY_SERVICES_URL ?? `http://127.0.0.1:${SERVICES_PORT}`
).replace(/\/+$/, '');

// Browser only: Friday needs no file or shell access on its computer.
const computer = await api(`/dots/${dot.id}/computer`);
if (computer.configured) {
  await api(`/dots/${dot.id}/computer/permissions`, 'PATCH', {
    enabled: true,
    browser: true,
    files: false,
    shell: false,
  });
  console.log(
    `Allowed Friday's computer browser (files and shell stay off). Start it from Friday's Computer panel; it fills in ${CALENDAR_URL}.`,
  );
} else
  console.log(
    'Dot computers are not configured (docs/COMPUTERS.md), so Friday adds calendar entries with the add_event tool instead of the browser.',
  );
const reconnect = process.argv.includes('--reconnect');
if (!process.env.FRIDAY_SERVICES_TOKEN)
  console.log(
    'Skipped skill connections: set FRIDAY_SERVICES_TOKEN in .env and start friday/services.',
  );
else {
  const current = await api(`/dots/${dot.id}/connections`);
  for (const name of ['phone', 'calendar']) {
    const url = `${SERVICES_URL}/${name}/mcp`;
    const found = current.find((connection) => connection.name === name);
    try {
      if (found && (reconnect || found.url !== url)) {
        await api(`/connections/${found.id}`, 'DELETE');
      }
      const connection =
        found && !reconnect && found.url === url
          ? await api(`/connections/${found.id}/refresh`, 'POST', {})
          : await api(`/dots/${dot.id}/connections`, 'POST', {
              name,
              url,
              token: process.env.FRIDAY_SERVICES_TOKEN,
            });
      if (connection.error) throw new Error(connection.error);
      console.log(
        `Connected ${name}: ${connection.tools.map((tool) => `${tool.name}${tool.requiresApproval ? ' (asks first)' : ''}`).join(', ')}`,
      );
    } catch (error) {
      console.log(`Could not connect ${name} at ${url}: ${error.message}`);
    }
  }
}

if (workspace.setup.missing.length)
  console.log(
    `Before chatting, OpenDots still needs: ${workspace.setup.missing.join(', ')}.`,
  );
