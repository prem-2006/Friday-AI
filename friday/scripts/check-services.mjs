#!/usr/bin/env node
// Friday: connects to friday-services the same way OpenDots does (MCP over
// Streamable HTTP with a bearer token) and lists each endpoint's tools.
// Makes no phone call, sends no message and uses no Gnani or Evon credits.
//
// Start the services first, then from the repo root:
//   node --env-file-if-exists=.env friday/scripts/check-services.mjs

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = (
  process.env.FRIDAY_SERVICES_URL ??
  `http://127.0.0.1:${process.env.FRIDAY_SERVICES_PORT || 8765}`
).replace(/\/+$/, '');
const TOKEN = process.env.FRIDAY_SERVICES_TOKEN ?? '';
const ENDPOINTS = (
  process.env.FRIDAY_MCP_ENDPOINTS ?? 'phone,telegram,calendar'
)
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);

let health;
try {
  health = await (
    await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) })
  ).json();
} catch {
  console.error(
    `friday-services is not reachable at ${BASE}. Start it with: cd friday/services && uv run python -m friday_services`,
  );
  process.exit(1);
}
for (const [feature, state] of Object.entries(health)) {
  if (typeof state !== 'object') continue;
  console.log(
    `${feature}: ${state.ready ? 'ready' : `missing ${state.missing.join(', ')}`}`,
  );
}

let failed = false;
for (const name of ENDPOINTS) {
  const url = `${BASE}/${name}/mcp`;
  const client = new Client({ name: 'friday-check', version: '0.1.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const { tools } = await client.listTools();
    console.log(`\n${url}`);
    for (const tool of tools)
      console.log(
        `  ${tool.name.padEnd(24)} ${tool.annotations?.readOnlyHint ? 'runs on its own (read-only)' : 'asks you first (Approve & run)'}`,
      );
  } catch (error) {
    failed = true;
    console.log(`\n${url}\n  could not list tools: ${error.message}`);
  } finally {
    await client.close().catch(() => {});
  }
}
process.exitCode = failed ? 1 : 0;
