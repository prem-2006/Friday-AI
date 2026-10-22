import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  fridayProfileRoutes,
  ownerDetailsPrompt,
  readProfile,
} from '../../src/friday/server/profile.js';

const file = () => join(mkdtempSync(join(tmpdir(), 'friday-')), 'profile.json');
const put = (app: ReturnType<typeof fridayProfileRoutes>, body: unknown) =>
  app.request('/friday/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

it('saves the owner details on this PC and reads them back', async () => {
  const path = file();
  const app = fridayProfileRoutes(path);
  expect(await (await app.request('/friday/profile')).json()).toEqual({});
  const saved = await put(app, {
    name: ' Prem ',
    email: 'prem@example.com',
    city: '',
  });
  expect(await saved.json()).toEqual({
    name: 'Prem',
    email: 'prem@example.com',
  });
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
    name: 'Prem',
    email: 'prem@example.com',
  });
  expect(readProfile(path).name).toBe('Prem');
});

it('refuses unknown fields and overlong details', async () => {
  const app = fridayProfileRoutes(file());
  expect((await put(app, { password: 'x' })).status).toBe(400);
  expect((await put(app, { name: 'x'.repeat(81) })).status).toBe(400);
});

it('only the Friday Dot sees the details, marked private', () => {
  const profile = { name: 'Prem', city: 'Bengaluru' };
  const line = ownerDetailsPrompt('Friday', profile);
  expect(line).toContain('Name: Prem; City: Bengaluru');
  expect(line).toContain('private');
  expect(ownerDetailsPrompt('Navigator', profile)).toBe('');
  expect(ownerDetailsPrompt('Friday', {})).toBe('');
});
