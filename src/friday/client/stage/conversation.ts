// Friday: the voice stage's own conversation. Turns run directly on the app
// server (/api/friday/voice/run) with this short history, so a reply does
// not wait on any remote conversation service.
import type { Message } from '@ag-ui/core';
import { connectionActionTool } from '../../../shared/connection-types';
import { ownerHeaders } from './activity';

// v2: started fresh after calls were set up (old turns said calls fail).
const HISTORY_KEY = 'friday-voice-history-v2';
const KEEP_MESSAGES = 30;
const MAX_TOOL_TEXT = 4000;

export interface PendingApproval {
  toolCallId: string;
  approvalId: string;
  summary: string;
}

export function loadHistory(): { messages: Message[]; threadId?: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '{}');
    return {
      messages: Array.isArray(saved.messages) ? saved.messages : [],
      threadId: typeof saved.threadId === 'string' ? saved.threadId : undefined,
    };
  } catch {
    return { messages: [] };
  }
}

export function saveHistory(messages: Message[], threadId?: string) {
  try {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify({ messages: trimHistory(messages), threadId }),
    );
  } catch {
    // History is a convenience; the conversation still works without it.
  }
}

/**
 * The last turns, starting at something the owner said (a reply or a tool
 * result may not open a conversation), with long tool output shortened.
 */
export function trimHistory(messages: Message[], keep = KEEP_MESSAGES) {
  let start = Math.max(0, messages.length - keep);
  while (start < messages.length && messages[start].role !== 'user') start++;
  if (start >= messages.length) {
    // Never drop the latest request, even in a very long single turn.
    start = messages.findLastIndex((message) => message.role === 'user');
    if (start < 0) return [];
  }
  return messages
    .slice(start)
    .map((message) =>
      message.role === 'tool' &&
      typeof message.content === 'string' &&
      message.content.length > MAX_TOOL_TEXT
        ? { ...message, content: `${message.content.slice(0, MAX_TOOL_TEXT)}…` }
        : message,
    );
}

/** An approval Friday asked for in the latest turn that has no answer yet. */
export function pendingApprovalOf(
  messages: Message[],
): PendingApproval | undefined {
  const answered = new Set(
    messages
      .filter((message) => message.role === 'tool')
      .map((message) => (message as { toolCallId?: string }).toolCallId),
  );
  // The approvals the server saved this turn. Models sometimes ask for the
  // OK in the same step as the action itself, before its approvalId exists,
  // and make one up; the saved one is the one that can run.
  const saved: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'user') break;
    if (message.role !== 'tool' || typeof message.content !== 'string')
      continue;
    try {
      const result = JSON.parse(message.content);
      if (
        result?.status === 'approval_required' &&
        typeof result.approvalId === 'string'
      )
        saved.unshift(result.approvalId);
    } catch {
      // Not JSON: not an approval.
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'user') return undefined;
    if (message.role !== 'assistant') continue;
    const call = message.toolCalls?.find(
      (item) =>
        item.function.name === connectionActionTool.name &&
        !answered.has(item.id),
    );
    if (!call) continue;
    try {
      const args = JSON.parse(call.function.arguments || '{}');
      const approvalId = saved.includes(args.approvalId)
        ? (args.approvalId as string)
        : saved.at(-1);
      if (!approvalId) return undefined;
      return {
        toolCallId: call.id,
        approvalId,
        summary:
          typeof args.summary === 'string' && args.summary
            ? args.summary
            : 'this action',
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal) {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify(body),
    signal,
  });
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok)
    throw new Error(data.error ?? `Request failed (${response.status}).`);
  return data;
}

export function runFriday(messages: Message[], signal?: AbortSignal) {
  return post<{ threadId: string; newMessages: Message[] }>(
    '/friday/voice/run',
    { messages: trimHistory(messages) },
    signal,
  );
}

/** Runs the stored request the owner just approved; returns its result. */
export function runApprovedAction(threadId: string, pending: PendingApproval) {
  return post<{ isError: boolean; text: string }>(
    `/conversations/${encodeURIComponent(threadId)}/connection-actions`,
    { toolCallId: pending.toolCallId, approvalId: pending.approvalId },
  );
}

export function toolAnswer(
  pending: PendingApproval,
  content: Record<string, unknown>,
): Message {
  return {
    id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    role: 'tool',
    toolCallId: pending.toolCallId,
    content: JSON.stringify(content),
  } as Message;
}
