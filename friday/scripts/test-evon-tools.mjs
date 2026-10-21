#!/usr/bin/env node
// Friday: checks whether Gnani Evon returns OpenAI-style tool calls the way
// OpenDots will ask for them (chat completions, streamed, with tools).
//
// Run from the repo root:
//   node --env-file-if-exists=.env friday/scripts/test-evon-tools.mjs
//
// Needs EVON_BASE_URL (ending in /v1), EVON_API_KEY and optionally EVON_MODEL.

const BASE_URL = (process.env.EVON_BASE_URL ?? '').trim().replace(/\/+$/, '');
const API_KEY = (process.env.EVON_API_KEY ?? '').trim();
const MODEL = (process.env.EVON_MODEL ?? '').trim() || 'gnani-evon-v3.3';
const TIMEOUT_MS = 60_000;

if (!BASE_URL) {
  console.error(
    'Set EVON_BASE_URL (for example https://host/v1) and EVON_API_KEY in .env, then rerun.',
  );
  process.exit(2);
}

const weatherTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: 'City name, for example Bengaluru',
        },
        unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
      },
      required: ['city'],
      additionalProperties: false,
    },
  },
};
const system = {
  role: 'system',
  content:
    'You are Friday, a helpful assistant. Use the get_weather tool whenever the user asks about weather.',
};

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

async function post(body) {
  const started = performance.now();
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({ model: MODEL, temperature: 0.6, ...body }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new HttpError(response.status, await response.text());
  return { response, started };
}

async function complete(body) {
  const { response, started } = await post(body);
  const json = await response.json();
  const choice = json.choices?.[0] ?? {};
  const message = choice.message ?? {};
  return {
    ms: Math.round(performance.now() - started),
    content: message.content ?? '',
    reasoning: message.reasoning_content ?? message.reasoning ?? '',
    calls: (message.tool_calls ?? []).map((call) => ({
      id: call.id ?? '',
      name: call.function?.name ?? '',
      arguments: call.function?.arguments ?? '',
    })),
    finish: choice.finish_reason,
    raw: message,
  };
}

// Server-sent events, assembled the way an OpenAI client does it.
async function stream(body) {
  const { response, started } = await post({ ...body, stream: true });
  const decoder = new TextDecoder();
  const calls = [];
  let buffer = '';
  let content = '';
  let reasoning = '';
  let finish;
  let firstTokenMs;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      const choice = JSON.parse(data).choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      const thinking = delta.reasoning_content ?? delta.reasoning ?? '';
      if (
        firstTokenMs === undefined &&
        (delta.content || delta.tool_calls?.length || thinking)
      )
        firstTokenMs = Math.round(performance.now() - started);
      content += delta.content ?? '';
      reasoning += thinking;
      for (const part of delta.tool_calls ?? []) {
        const call = (calls[part.index ?? 0] ??= {
          id: '',
          name: '',
          arguments: '',
        });
        if (part.id) call.id = part.id;
        if (part.function?.name) call.name += part.function.name;
        if (part.function?.arguments) call.arguments += part.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  return {
    ms: Math.round(performance.now() - started),
    firstTokenMs,
    content,
    reasoning,
    calls: calls.filter(Boolean),
    finish,
  };
}

function parseArgs(call) {
  try {
    return JSON.parse(call.arguments || '{}');
  } catch {
    return undefined;
  }
}

// A model that writes the call as text means the server is not parsing tool
// calls (for vLLM: --enable-auto-tool-choice / --tool-call-parser missing).
function textLeak(content) {
  return /<tool_call>|<function=|"name"\s*:\s*"get_weather"/.test(content)
    ? ' The tool call came back as plain text, so the server is not parsing tool calls.'
    : '';
}

function thinkingNote(result) {
  if (/<think>/.test(result.content))
    return ' Reasoning leaked into the reply text (<think>).';
  return result.reasoning
    ? ` Reasoning: ${result.reasoning.length} chars.`
    : '';
}

function expectWeatherCall(result, city) {
  const call = result.calls.find((item) => item.name === 'get_weather');
  if (!call)
    return {
      pass: false,
      note: `No get_weather tool call (finish_reason=${result.finish}).${textLeak(result.content)} Reply: ${JSON.stringify(result.content.slice(0, 160))}`,
    };
  const args = parseArgs(call);
  if (!args)
    return {
      pass: false,
      note: `Arguments are not valid JSON: ${call.arguments.slice(0, 160)}`,
    };
  if (!city.test(String(args.city ?? '')))
    return { pass: false, note: `Unexpected city: ${JSON.stringify(args)}` };
  return {
    pass: true,
    note: `get_weather(${JSON.stringify(args)}), finish_reason=${result.finish}.${thinkingNote(result)}`,
  };
}

const weatherQuestion = [
  system,
  { role: 'user', content: 'What is the weather in Bengaluru right now?' },
];

const tests = [
  {
    name: 'Plain reply',
    core: true,
    run: async () => {
      const result = await complete({
        messages: [
          { role: 'user', content: 'Reply with the single word: ready' },
        ],
        max_tokens: 400,
      });
      return {
        ms: result.ms,
        pass: /ready/i.test(result.content),
        note: `Reply: ${JSON.stringify(result.content.slice(0, 80))}.${thinkingNote(result)}`,
      };
    },
  },
  {
    name: 'Tool call',
    core: true,
    run: async () => {
      const result = await complete({
        messages: weatherQuestion,
        tools: [weatherTool],
        tool_choice: 'auto',
        max_tokens: 800,
      });
      return { ms: result.ms, ...expectWeatherCall(result, /bengal|bangal/i) };
    },
  },
  {
    name: 'Tool result round trip',
    core: true,
    run: async () => {
      const result = await complete({
        messages: [
          ...weatherQuestion,
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_weather_1',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: JSON.stringify({ city: 'Bengaluru' }),
                },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'call_weather_1',
            content: JSON.stringify({
              city: 'Bengaluru',
              temperature_c: 24,
              condition: 'light rain',
            }),
          },
        ],
        tools: [weatherTool],
        max_tokens: 800,
      });
      return {
        ms: result.ms,
        pass: /24/.test(result.content) && result.calls.length === 0,
        note: `Reply: ${JSON.stringify(result.content.slice(0, 160))}.${thinkingNote(result)}`,
      };
    },
  },
  {
    // Mirrors OpenDots: streamed chat completions with max_completion_tokens.
    name: 'Streamed tool call (OpenDots style)',
    core: true,
    run: async () => {
      const body = {
        messages: weatherQuestion,
        tools: [weatherTool],
        tool_choice: 'auto',
      };
      let note = '';
      let result;
      try {
        result = await stream({ ...body, max_completion_tokens: 2200 });
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 400) throw error;
        note =
          ' Endpoint rejected max_completion_tokens (OpenDots sends it), so this retried with max_tokens.';
        result = await stream({ ...body, max_tokens: 2200 });
      }
      const verdict = expectWeatherCall(result, /bengal|bangal/i);
      return {
        ms: result.ms,
        pass: verdict.pass,
        note: `${verdict.note} First token ${result.firstTokenMs ?? '-'} ms.${note}`,
      };
    },
  },
  {
    name: 'Hinglish request',
    core: false,
    run: async () => {
      const result = await complete({
        messages: [
          system,
          { role: 'user', content: 'Kal Mumbai mein mausam kaisa rahega?' },
        ],
        tools: [weatherTool],
        tool_choice: 'auto',
        max_tokens: 800,
      });
      return { ms: result.ms, ...expectWeatherCall(result, /mumbai|bombay/i) };
    },
  },
  {
    name: 'No tool when not needed',
    core: false,
    run: async () => {
      const result = await complete({
        messages: [
          system,
          {
            role: 'user',
            content: 'What is 2 + 2? Answer with just the number.',
          },
        ],
        tools: [weatherTool],
        tool_choice: 'auto',
        max_tokens: 400,
      });
      return {
        ms: result.ms,
        pass: result.calls.length === 0 && /4/.test(result.content),
        note: result.calls.length
          ? `Called ${result.calls.map((call) => call.name).join(', ')} for a maths question.`
          : `Reply: ${JSON.stringify(result.content.slice(0, 80))}.${thinkingNote(result)}`,
      };
    },
  },
  {
    // Evon reasons by default; voice and phone turns need it off for speed.
    name: 'Tool call with thinking off',
    core: false,
    run: async () => {
      try {
        const result = await stream({
          messages: weatherQuestion,
          tools: [weatherTool],
          tool_choice: 'auto',
          max_tokens: 800,
          chat_template_kwargs: { enable_thinking: false },
        });
        const verdict = expectWeatherCall(result, /bengal|bangal/i);
        return {
          ms: result.ms,
          pass: verdict.pass,
          note: `${verdict.note} First token ${result.firstTokenMs ?? '-'} ms.`,
        };
      } catch (error) {
        if (error instanceof HttpError && error.status === 400)
          return {
            pass: false,
            note: 'Endpoint rejected chat_template_kwargs, so thinking cannot be switched off this way.',
          };
        throw error;
      }
    },
  },
];

console.log(`Evon tool-call check: ${MODEL} at ${BASE_URL}\n`);
const results = [];
for (const test of tests) {
  process.stdout.write(`- ${test.name} ... `);
  try {
    const result = await test.run();
    results.push({ ...test, ...result });
    console.log(
      `${result.pass ? 'PASS' : 'FAIL'}${result.ms ? ` (${result.ms} ms)` : ''}\n    ${result.note}`,
    );
  } catch (error) {
    const note =
      error?.name === 'TimeoutError'
        ? `No response within ${TIMEOUT_MS / 1000} s.`
        : error instanceof Error
          ? error.message
          : String(error);
    results.push({ ...test, pass: false, note });
    console.log(`ERROR\n    ${note}`);
  }
}

const passed = (name) => results.find((item) => item.name === name)?.pass;
const core = results.filter((item) => item.core);
let verdict;
if (core.every((item) => item.pass))
  verdict =
    'YES. Evon returns proper tool calls, including streamed ones. OpenDots can use it as its model through OPENAI_BASE_URL.';
else if (
  passed('Tool call') &&
  passed('Tool result round trip') &&
  !passed('Streamed tool call (OpenDots style)')
)
  verdict =
    'PARTIAL. Tool calls work without streaming but not streamed. OpenDots streams, so Friday would need a small non-streaming shim in front of Evon.';
else if (!passed('Plain reply'))
  verdict =
    'BLOCKED. Evon did not answer a plain request. Check EVON_BASE_URL, EVON_API_KEY and EVON_MODEL.';
else
  verdict =
    'NO. Evon does not return usable tool calls here. Fallbacks: (1) ask Gnani whether tool-call parsing is enabled on this endpoint, (2) a JSON-in-text tool protocol shim in front of Evon, (3) another model for planning while Prisma, Timbre and Evon stay in the voice path.';

console.log(`\nVerdict: ${verdict}`);
// process.exit() with fetch sockets still open aborts Node on Windows.
process.exitCode = core.every((item) => item.pass) ? 0 : 1;
