// Friday: named agents. "Make an agent called Researcher that finds sources"
// saves a new helper Dot; "ask Researcher to..." then works like any helper,
// through delegate_to_dot. The idea comes from Atticus (SaarthurR/atticus-mac,
// MIT). Friday's own Dots cannot be replaced or deleted this way.
import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import { ConnectionService } from '../../server/connections.js';
import type { WorkspaceStore } from '../../server/workspace.js';
import type { Dot } from '../../shared/types.js';
import { FRIDAY_DOT_NAME } from './delegate.js';

const BUILT_IN = new Set([
  FRIDAY_DOT_NAME,
  'Navigator',
  'Operator',
  'Coder',
  'Mail',
  'Reception',
]);
// The same rules Friday's own helpers keep (friday/dots/navigator.md).
const SAFETY =
  ' Never type passwords, card numbers, UPI PINs or OTPs, never solve CAPTCHAs, never buy, pay, accept terms or send anything: stop and say what the owner must do. Finish with a short report in at most four lines.';
const INSTRUCTIONS_LIMIT = 2000;

export const agentInstructions = (name: string, what: string) => {
  const opening = `You are ${name}, a helper the owner made. ${what.trim()}`;
  return `${opening.slice(0, INSTRUCTIONS_LIMIT - SAFETY.length)}${SAFETY}`;
};

export interface AgentStore {
  dots(): Dot[];
  create(name: string, instructions: string): Dot;
  remove(id: string): void;
  connect(dot: Dot, kind: 'browser' | 'desktop'): Promise<unknown>;
}

export function workspaceAgents(workspace: WorkspaceStore): AgentStore {
  const connections = new ConnectionService(workspace.connections);
  const friday = () =>
    workspace.dots().find((dot) => dot.name === FRIDAY_DOT_NAME);
  return {
    dots: () => workspace.dots(),
    create(name, instructions) {
      const spaceId = friday()?.spaceId ?? workspace.spaces()[0].id;
      return workspace.createDot(spaceId, name, instructions, false, false);
    },
    remove: (id) => workspace.deleteDot(id),
    async connect(dot, kind) {
      const base =
        process.env.FRIDAY_SERVICES_URL ??
        `http://127.0.0.1:${process.env.FRIDAY_SERVICES_PORT || 8765}`;
      const connection = await connections.add(dot.id, {
        name: kind,
        url: `${base.replace(/\/+$/, '')}/${kind}/mcp`,
        token: process.env.FRIDAY_SERVICES_TOKEN,
      });
      // Helpers run with no one to approve a step; their rules stop them instead.
      for (const tool of connection.tools)
        if (tool.requiresApproval)
          connections.setTool(connection.id, tool.name, {
            requiresApproval: false,
          });
    },
  };
}

export function agentTools(
  current: Dot,
  agents: AgentStore,
  check: () => void,
): ToolDefinition[] {
  if (current.name !== FRIDAY_DOT_NAME) return [];
  const find = (name: string) =>
    agents
      .dots()
      .find((dot) => dot.name.toLowerCase() === name.trim().toLowerCase());
  return [
    defineTool({
      name: 'create_agent',
      description:
        'Save a new named helper the owner asks for: "make an agent called Researcher that finds sources and writes a short brief". Later, hand it tasks with delegate_to_dot.',
      parameters: z.object({
        name: z
          .string()
          .trim()
          .min(2)
          .max(30)
          .regex(/^[\p{L}\p{N} ]+$/u),
        what: z
          .string()
          .min(5)
          .max(1500)
          .describe('What this agent does, in the owner’s words.'),
        uses: z
          .enum(['browser', 'desktop'])
          .describe('browser for web work, desktop for Windows apps.'),
      }),
      execute: async ({ name, what, uses }) => {
        check();
        if (find(name))
          return { created: false, friday_say: `${name} already exists.` };
        const dot = agents.create(name, agentInstructions(name, what));
        try {
          await agents.connect(dot, uses);
        } catch (error) {
          agents.remove(dot.id);
          throw error;
        }
        return {
          created: true,
          friday_say: `${name} is ready. Just say, ask ${name} to do something.`,
        };
      },
    }),
    defineTool({
      name: 'delete_agent',
      description: 'Delete a named helper the owner made earlier.',
      parameters: z.object({ name: z.string().trim().min(2).max(30) }),
      execute: async ({ name }) => {
        check();
        const dot = find(name);
        if (!dot)
          return {
            deleted: false,
            friday_say: `I have no agent called ${name}.`,
          };
        if (BUILT_IN.has(dot.name))
          return {
            deleted: false,
            friday_say: `${dot.name} is one of my own helpers, so I am keeping it.`,
          };
        agents.remove(dot.id);
        return { deleted: true, friday_say: `${dot.name} is deleted.` };
      },
    }),
  ];
}
