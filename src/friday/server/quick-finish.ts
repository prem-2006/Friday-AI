// Friday: end a voice turn as soon as a quick action has said what happened.
//
// Quick tools (friday/services/friday_services/mcp_quick.py) return a
// "friday_say" sentence. When every tool result in the latest batch has one,
// the agent loop stops and Friday speaks it, saving a model round trip
// (about 1.5 s). When the model ends a turn without words after a helper's
// report, Friday speaks the report instead of staying silent.
import type { AgentLoopStrategy } from '@tanstack/ai';

interface MessageLike {
  role: string;
  content?: unknown;
}

const MAX_DEPTH = 4;

// Tool results arrive as JSON text, sometimes wrapped again by the MCP layer
// ({"text": "{...}"}), so look a few levels deep.
function field(content: unknown, names: string[], depth = 0): string | null {
  if (depth > MAX_DEPTH || content == null) return null;
  if (typeof content === 'string') {
    const text = content.trim();
    if (!text.startsWith('{')) return null;
    try {
      return field(JSON.parse(text), names, depth + 1);
    } catch {
      return null;
    }
  }
  if (typeof content !== 'object' || Array.isArray(content)) return null;
  const record = content as Record<string, unknown>;
  if (record.isError === true) return null;
  for (const name of names) {
    const value = record[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return typeof record.text === 'string'
    ? field(record.text, names, depth + 1)
    : null;
}

export const spokenResult = (content: unknown) =>
  field(content, ['friday_say']);

function trailingToolResults(messages: readonly MessageLike[]) {
  const results: MessageLike[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'tool') break;
    results.unshift(messages[i]);
  }
  return results;
}

export function fridayLoopStrategy(base: AgentLoopStrategy): AgentLoopStrategy {
  return (state) => {
    if (!base(state)) return false;
    const results = trailingToolResults(state.messages as MessageLike[]);
    return !(
      results.length > 0 &&
      results.every((result) => spokenResult(result.content))
    );
  };
}

// What to say when the turn ended on tool results with no reply from the model.
export function fallbackReply(messages: readonly MessageLike[]) {
  const results = trailingToolResults(messages);
  const said = results
    .map((result) => field(result.content, ['friday_say', 'report', 'answer']))
    .filter((text): text is string => Boolean(text));
  return said.join(' ').slice(0, 600);
}
