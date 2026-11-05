import { expect, it, vi } from 'vitest';
import { WorkspaceStore } from '../../src/server/workspace.js';
import {
  agentInstructions,
  agentTools,
  type AgentStore,
} from '../../src/friday/server/agents.js';
import type { Dot } from '../../src/shared/types.js';

const dot = (name: string) => ({ id: name, name, instructions: '' }) as Dot;

function store(connect: AgentStore['connect'] = async () => {}) {
  const dots = [dot('Friday'), dot('Navigator')];
  const agents: AgentStore = {
    dots: () => dots,
    create(name, instructions) {
      const made = { ...dot(name), instructions };
      dots.push(made);
      return made;
    },
    remove(id) {
      dots.splice(
        dots.findIndex((item) => item.id === id),
        1,
      );
    },
    connect,
  };
  return { agents, dots };
}
const tools = (agents: AgentStore) =>
  Object.fromEntries(
    agentTools(dot('Friday'), agents, () => {}).map((tool) => [
      tool.name,
      tool,
    ]),
  );

it('is for Friday only', () => {
  expect(agentTools(dot('Mail'), store().agents, () => {})).toEqual([]);
});

it('saves a helper with its tools and the safety rules', async () => {
  const connect = vi.fn(async () => {});
  const { agents, dots } = store(connect);
  const result = (await tools(agents).create_agent.execute!({
    name: 'Researcher',
    what: 'Finds sources and writes a short brief.',
    uses: 'browser',
  })) as Record<string, unknown>;
  expect(result.created).toBe(true);
  expect(dots.at(-1)?.instructions).toContain('Finds sources');
  expect(dots.at(-1)?.instructions).toContain('Never type passwords');
  expect(connect).toHaveBeenCalledWith(dots.at(-1), 'browser');
});

it('does not keep a helper whose tools could not connect', async () => {
  const { agents, dots } = store(async () => {
    throw new Error('Services are off.');
  });
  await expect(
    tools(agents).create_agent.execute!({
      name: 'Researcher',
      what: 'Finds sources.',
      uses: 'browser',
    }),
  ).rejects.toThrow('Services are off.');
  expect(dots.map((item) => item.name)).toEqual(['Friday', 'Navigator']);
});

it('will not replace a name or delete Friday’s own helpers', async () => {
  const { agents, dots } = store();
  const { create_agent: create, delete_agent: remove } = tools(agents);
  const same = (await create.execute!({
    name: 'navigator',
    what: 'Something else.',
    uses: 'browser',
  })) as Record<string, unknown>;
  expect(same.created).toBe(false);
  const kept = (await remove.execute!({ name: 'Navigator' })) as Record<
    string,
    unknown
  >;
  expect(kept.deleted).toBe(false);
  await create.execute!({
    name: 'Researcher',
    what: 'Finds sources.',
    uses: 'browser',
  });
  const gone = (await remove.execute!({ name: 'researcher' })) as Record<
    string,
    unknown
  >;
  expect(gone.deleted).toBe(true);
  expect(dots).toHaveLength(2);
});

it('keeps the safety rules inside the instruction limit', () => {
  const text = agentInstructions('Long', 'x'.repeat(5000));
  expect(text.length).toBeLessThanOrEqual(2000);
  expect(text).toContain('Never type passwords');
});

it('deletes a saved helper with its conversations from the real store', () => {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  try {
    const first = workspace.dots()[0];
    const made = workspace.createDot(
      first.spaceId,
      'Researcher',
      'Finds sources.',
      false,
      false,
    );
    workspace.bindThread('thread-1', made.id, 'Tasks from Friday');
    workspace.deleteDot(made.id);
    expect(workspace.dot(made.id)).toBeUndefined();
    expect(
      workspace.conversations().some((item) => item.dotId === made.id),
    ).toBe(false);
    expect(workspace.dot(first.id)).toBeDefined();
  } finally {
    workspace.close();
  }
});
