// Friday: hand a task to a helper Dot (Navigator for the on-screen browser,
// Operator for desktop apps). The helper works in its own conversation, in the
// background (background.ts) unless Friday needs the report to go on, while the
// owner watches each action live through the activity feed.
import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import type { Dot } from '../../shared/types.js';
import { backgroundDots } from './background.js';

export const FRIDAY_DOT_NAME = 'Friday';
export const HELPER_THREAD_TITLE = 'Tasks from Friday';

export type Delegate = (
  helper: Dot,
  task: string,
  signal: AbortSignal,
) => Promise<string>;

export function helperDots(dots: Dot[], current: Dot) {
  return dots.filter((dot) => dot.id !== current.id);
}

// Only Friday delegates; helpers never hand work on, so there are no loops.
export function delegateTool(
  current: Dot,
  dots: Dot[],
  delegate: Delegate | undefined,
  check: () => void,
  signal: AbortSignal,
): ToolDefinition[] {
  const helpers = helperDots(dots, current);
  if (!delegate || current.name !== FRIDAY_DOT_NAME || !helpers.length)
    return [];
  const roster = helpers
    .map(
      (dot) =>
        `${dot.name}: ${dot.instructions.split(/(?<=[.!?])\s/)[0].slice(0, 160)}`,
    )
    .join(' | ');
  return [
    defineTool({
      name: 'delegate_to_dot',
      description: `Hand one task to a helper Dot. It runs in the background: your turn ends, the owner can keep talking, and the report is said to them when it is done. Set wait only when your own next step needs the report. Helpers: ${roster}`,
      parameters: z.object({
        dot: z.string().min(1).max(40).describe('The helper Dot name.'),
        task: z
          .string()
          .min(5)
          .max(4000)
          .describe(
            'One clear task with every detail the helper needs, e.g. names, dates and what to report back.',
          ),
        say: z
          .string()
          .max(160)
          .optional()
          .describe(
            "One short sentence to say now, in the owner's language, about what the helper is doing.",
          ),
        wait: z
          .boolean()
          .optional()
          .describe(
            'Wait for the report instead of working in the background.',
          ),
      }),
      execute: async ({ dot: name, task, say, wait }) => {
        check();
        const helper = helpers.find(
          (dot) => dot.name.toLowerCase() === name.trim().toLowerCase(),
        );
        if (!helper)
          throw new Error(
            `No helper Dot called ${name}. Use one of: ${helpers.map((dot) => dot.name).join(', ')}.`,
          );
        if (!wait) {
          const { state, id } = backgroundDots(delegate).start(helper, task);
          return {
            started: true,
            id,
            state,
            friday_say:
              say?.trim() ||
              `${helper.name} is on it. I will tell you when it is done.`,
          };
        }
        const report = await delegate(helper, task, signal);
        check();
        return { dot: helper.name, report };
      },
    }),
  ];
}
