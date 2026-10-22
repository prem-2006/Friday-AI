import { expect, it } from 'vitest';
import type { Connection } from '../../src/shared/connection-types.js';
import {
  ABILITIES,
  setAbility,
  stateOf,
  toolsOf,
} from '../../src/friday/client/home/permissions.js';

const connection = (
  id: string,
  name: string,
  tools: [string, boolean][],
): Connection => ({
  id,
  dotId: 'd',
  name,
  url: '',
  hasToken: true,
  error: null,
  createdAt: 0,
  updatedAt: 0,
  tools: tools.map(([tool, enabled]) => ({
    name: tool,
    title: tool,
    description: '',
    inputSchema: {},
    readOnly: false,
    enabled,
    requiresApproval: false,
  })),
});

const byDot = {
  Friday: [
    connection('q', 'quick', [
      ['open_app', true],
      ['write_in_app', false],
      ['snap_window', true],
      ['open_website', true],
      ['look_at_screen', true],
    ]),
    connection('w', 'whatsapp', [['whatsapp_call', true]]),
  ],
  Operator: [connection('o', 'desktop', [['open_app', true]])],
};
const ability = (id: string) => ABILITIES.find((item) => item.id === id)!;

it('collects each ability’s tools across the Dots', () => {
  const apps = toolsOf(ability('apps'), byDot);
  expect(apps.map((tool) => `${tool.connectionId}/${tool.name}`)).toEqual([
    'o/open_app',
    'q/open_app',
    'q/write_in_app',
    'q/snap_window',
  ]);
  expect(stateOf(apps)).toBe('mixed');
  expect(stateOf(toolsOf(ability('screen'), byDot))).toBe('on');
  expect(stateOf(toolsOf(ability('email'), byDot))).toBe('unavailable');
});

it('switching an ability changes only the tools that differ', async () => {
  const calls: string[] = [];
  const changed = await setAbility(
    toolsOf(ability('apps'), byDot),
    true,
    async (id, tool, enabled) => {
      calls.push(`${id}/${tool}=${enabled}`);
    },
  );
  expect(changed).toBe(1);
  expect(calls).toEqual(['q/write_in_app=true']);
});

it('WhatsApp and email always ask first', () => {
  expect(ability('whatsapp').alwaysAsks).toBe(true);
  expect(ability('email').alwaysAsks).toBe(true);
  expect(ability('web').alwaysAsks).toBeUndefined();
});
