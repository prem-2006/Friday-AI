#!/usr/bin/env node
// Friday: creates the "Friday" Dot, or updates it if it already exists, with
// the persona in friday/persona.md. Research and memory are switched on.
//
// Start the app first (npm run dev), then from the repo root:
//   node --env-file-if-exists=.env friday/scripts/setup-friday-dot.mjs

import { readFile } from 'node:fs/promises';

const NAME = 'Friday';
const APP_URL = (process.env.FRIDAY_APP_URL ?? 'http://127.0.0.1:4310').replace(
  /\/+$/,
  '',
);
const persona = (
  await readFile(new URL('../persona.md', import.meta.url), 'utf8')
).trim();
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
if (workspace.setup.missing.length)
  console.log(
    `Before chatting, OpenDots still needs: ${workspace.setup.missing.join(', ')}.`,
  );
