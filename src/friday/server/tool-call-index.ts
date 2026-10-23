// Friday: two gaps between Gemini's OpenAI-compatible endpoint and the model
// adapter, filled in on the way through.
//
// 1. Gemini streams tool calls without the `index` field. The adapter keys
//    calls in progress by index, so two calls in one reply ("call me and set
//    a timer") were merged into one and the run failed with "Cannot send
//    'TOOL_CALL_ARGS' event: No active tool call found". Each call gets its
//    index (one per call id) as the stream arrives.
// 2. Newer Gemini models sign each tool call (extra_content.google.
//    thought_signature) and refuse the next request ("Function call is
//    missing a thought_signature") unless the signature comes back with that
//    call in the history. The adapter drops it, so signatures are kept here
//    by call id and put back; a call with none known (made by another model)
//    gets Gemini's documented placeholder that skips the check.

type Fetch = typeof fetch;

interface ToolCallDelta {
  index?: number;
  id?: string;
  extra_content?: { google?: { thought_signature?: string } };
}

const CR = String.fromCharCode(13);
const NO_SIGNATURE = 'skip_thought_signature_validator';
const KEEP_SIGNATURES = 500;
const signatures = new Map<string, string>();

function remember(id: string, signature: string) {
  signatures.set(id, signature);
  if (signatures.size > KEEP_SIGNATURES)
    signatures.delete(signatures.keys().next().value!);
}

/** Puts each tool call's signature back into a request for Gemini. */
function withSignatures(url: string, init?: RequestInit) {
  if (!url.includes('generativelanguage.googleapis.com')) return init;
  if (typeof init?.body !== 'string' || !init.body.includes('"tool_calls"'))
    return init;
  try {
    const body = JSON.parse(init.body) as {
      messages?: { tool_calls?: ToolCallDelta[] }[];
    };
    for (const message of body.messages ?? [])
      for (const call of message.tool_calls ?? [])
        if (call.id && !call.extra_content?.google?.thought_signature)
          call.extra_content = {
            google: {
              thought_signature: signatures.get(call.id) ?? NO_SIGNATURE,
            },
          };
    return { ...init, body: JSON.stringify(body) };
  } catch {
    return init;
  }
}

export function withToolCallIndexes(baseFetch: Fetch = fetch): Fetch {
  return async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const response = await baseFetch(input, withSignatures(url, init));
    const type = response.headers.get('content-type') ?? '';
    if (!response.body || !type.includes('text/event-stream')) return response;
    const indexes = new Map<string, number>();
    let last = -1;
    const fix = (raw: string) => {
      const end = raw.endsWith(CR) ? CR : '';
      const line = end ? raw.slice(0, -1) : raw;
      if (!line.startsWith('data:') || !line.includes('"tool_calls"'))
        return raw;
      try {
        const chunk = JSON.parse(line.slice(5)) as {
          choices?: { delta?: { tool_calls?: ToolCallDelta[] } }[];
        };
        let changed = false;
        for (const choice of chunk.choices ?? [])
          for (const call of choice.delta?.tool_calls ?? []) {
            const signature = call.extra_content?.google?.thought_signature;
            if (call.id && signature) remember(call.id, signature);
            if (typeof call.index === 'number') continue;
            if (call.id && !indexes.has(call.id))
              indexes.set(call.id, indexes.size);
            call.index = call.id ? indexes.get(call.id)! : Math.max(last, 0);
            last = call.index;
            changed = true;
          }
        return changed ? `data: ${JSON.stringify(chunk)}${end}` : raw;
      } catch {
        return raw;
      }
    };
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pending = '';
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(bytes, controller) {
          pending += decoder.decode(bytes, { stream: true });
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          if (lines.length)
            controller.enqueue(
              encoder.encode(lines.map(fix).join('\n') + '\n'),
            );
        },
        flush(controller) {
          pending += decoder.decode();
          if (pending) controller.enqueue(encoder.encode(fix(pending)));
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
