// Friday: "remember that I prefer morning meetings". Saves a fact to the
// workspace memories, which every Dot that may use memory reads as the owner's
// preferences on each turn. Only Friday saves them, and only when asked.
import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import type { Dot } from '../../shared/types.js';
import { FRIDAY_DOT_NAME } from './delegate.js';

export interface MemoryStore {
  saveMemory(text: string): { id: string; text: string };
}

export function rememberTool(
  current: Dot,
  store: MemoryStore,
  check: () => void,
): ToolDefinition[] {
  if (current.name !== FRIDAY_DOT_NAME) return [];
  return [
    defineTool({
      name: 'remember',
      description:
        'Save something the owner asks you to remember (a preference, a fact about them or a standing instruction). Never save passwords, OTPs or card numbers.',
      parameters: z.object({
        fact: z
          .string()
          .trim()
          .min(3)
          .max(400)
          .describe(
            'One short sentence, written about the owner, e.g. "The owner prefers morning meetings."',
          ),
      }),
      execute: async ({ fact }) => {
        check();
        const saved = store.saveMemory(fact);
        return {
          remembered: saved.text,
          friday_say: 'Got it, I will remember that.',
        };
      },
    }),
  ];
}
