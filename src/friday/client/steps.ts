// Friday: turn the current turn's tool calls into the steps the owner sees
// (research, phone call, browser, calendar), updated as results arrive.
import { connectionActionTool } from '../../shared/connection-types';

export type StepState = 'active' | 'done' | 'failed' | 'waiting';
export interface FridayStep {
  kind: 'research' | 'call' | 'browser' | 'calendar' | 'approval';
  label: string;
  detail: string;
  state: StepState;
}

interface ToolCallLike {
  id: string;
  function: { name: string; arguments?: string };
}
interface MessageLike {
  role: string;
  content?: unknown;
  toolCalls?: ToolCallLike[];
  toolCallId?: string;
}

const LABELS: Record<FridayStep['kind'], string> = {
  research: 'Research',
  call: 'Phone call',
  browser: 'Browser',
  calendar: 'Calendar',
  approval: 'Your OK',
};

function kindOf(tool: string): FridayStep['kind'] | undefined {
  if (tool === 'search_web' || tool === 'read_public_page') return 'research';
  if (tool.endsWith('__start_call') || tool.endsWith('__get_call_result'))
    return 'call';
  if (tool.startsWith('computer_')) return 'browser';
  if (tool.endsWith('__add_event') || tool.endsWith('__list_events'))
    return 'calendar';
  if (tool === connectionActionTool.name) return 'approval';
  return undefined;
}

// Connection results arrive as {"isError", "text"} where text is the MCP
// tool's JSON; other tools return their JSON directly.
function parseResult(content: unknown): {
  isError: boolean;
  data: Record<string, unknown>;
} {
  const parse = (value: unknown) => {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  };
  const outer = parse(content);
  if (!outer || typeof outer !== 'object') return { isError: false, data: {} };
  const record = outer as Record<string, unknown>;
  const inner = parse(record.text);
  return {
    isError: record.isError === true,
    data:
      inner && typeof inner === 'object'
        ? (inner as Record<string, unknown>)
        : record,
  };
}

const CALL_STAGES: Record<string, string> = {
  queued: 'Dialling…',
  ringing: 'Ringing…',
  in_progress: 'On the call…',
};

function describe(
  kind: FridayStep['kind'],
  tool: string,
  result: ReturnType<typeof parseResult> | undefined,
  count: number,
): Pick<FridayStep, 'detail' | 'state'> {
  if (result?.data.status === 'approval_required')
    return { state: 'waiting', detail: 'Waiting for your OK' };
  if (result?.isError)
    return { state: 'failed', detail: 'Something went wrong' };
  switch (kind) {
    case 'research':
      return result
        ? {
            state: 'done',
            detail: `${count} source check${count === 1 ? '' : 's'}`,
          }
        : { state: 'active', detail: 'Searching the web…' };
    case 'call': {
      if (!result) return { state: 'active', detail: 'Dialling…' };
      const status = String(result.data.status ?? '');
      const outcome = result.data.outcome
        ? String(result.data.outcome).replace(/_/g, ' ')
        : '';
      if (status === 'answered')
        return {
          state: 'done',
          detail: outcome ? `Answered: ${outcome}` : 'Answered',
        };
      if (status === 'no_answer')
        return { state: 'failed', detail: 'No answer' };
      if (status === 'failed')
        return { state: 'failed', detail: 'Call failed' };
      return {
        state: 'active',
        detail: CALL_STAGES[String(result.data.stage ?? '')] ?? 'On the call…',
      };
    }
    case 'browser':
      return result
        ? {
            state: 'done',
            detail: `${count} browser action${count === 1 ? '' : 's'}`,
          }
        : { state: 'active', detail: 'Using the browser…' };
    case 'calendar':
      if (!result) return { state: 'active', detail: 'Updating the calendar…' };
      return tool.endsWith('__add_event')
        ? { state: 'done', detail: 'Event added' }
        : { state: 'done', detail: 'Checked the calendar' };
    case 'approval':
      return result
        ? { state: 'done', detail: 'Decided' }
        : { state: 'waiting', detail: 'Waiting for your OK' };
  }
}

export function fridaySteps(messages: readonly MessageLike[]): FridayStep[] {
  const start = messages.findLastIndex((message) => message.role === 'user');
  const turn = messages.slice(start + 1);
  const results = new Map(
    turn
      .filter((message) => message.role === 'tool' && message.toolCallId)
      .map((message) => [message.toolCallId!, parseResult(message.content)]),
  );
  const steps = new Map<FridayStep['kind'], FridayStep>();
  const counts = new Map<FridayStep['kind'], number>();
  for (const message of turn)
    for (const call of message.toolCalls ?? []) {
      const kind = kindOf(call.function.name);
      if (!kind) continue;
      const count = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, count);
      // A step shows its latest call: the newest call result wins.
      steps.set(kind, {
        kind,
        label: LABELS[kind],
        ...describe(kind, call.function.name, results.get(call.id), count),
      });
    }
  return [...steps.values()];
}
