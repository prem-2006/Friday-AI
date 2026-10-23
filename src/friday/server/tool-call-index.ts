// Friday: Gemini's OpenAI-compatible endpoint streams tool calls without the
// `index` field. The model adapter keys calls in progress by index, so two
// calls in one reply ("call me and set a timer") were merged into one and the
// run failed with "Cannot send 'TOOL_CALL_ARGS' event: No active tool call
// found". This fills in each call's index (one per call id) as the stream
// arrives; replies that already carry an index pass through unchanged.

type Fetch = typeof fetch;

interface ToolCallDelta {
  index?: number;
  id?: string;
}

const CR = String.fromCharCode(13);

export function withToolCallIndexes(baseFetch: Fetch = fetch): Fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);
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
