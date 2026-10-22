import { expect, it } from 'vitest';
import { fridaySteps } from '../../src/friday/client/steps.js';

const call = (id: string, name: string) => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ id, function: { name, arguments: '{}' } }],
});
const result = (toolCallId: string, value: unknown) => ({
  role: 'tool',
  toolCallId,
  content: JSON.stringify(value),
});
const connection = (data: unknown) => ({
  isError: false,
  text: JSON.stringify(data),
});

it('shows nothing before any tool runs', () => {
  expect(fridaySteps([{ role: 'user', content: 'hi' }])).toEqual([]);
});

it('follows research, a call, and the calendar through one turn', () => {
  const messages = [
    { role: 'user', content: 'old request' },
    call('old', 'search_web'),
    {
      role: 'user',
      content: 'Find a dentist, call and book, add it to my calendar',
    },
    call('s1', 'search_web'),
    result('s1', { sources: [] }),
    call('c1', 'phone__start_call'),
    result('c1', { status: 'approval_required', approvalId: 'a1' }),
    call('a1', 'request_connection_action'),
    result('a1', { ok: true }),
    call('c2', 'phone__get_call_result'),
    result('c2', connection({ status: 'in_progress', stage: 'ringing' })),
  ];
  expect(fridaySteps(messages)).toEqual([
    {
      kind: 'research',
      label: 'Research',
      state: 'done',
      detail: '1 source check',
    },
    { kind: 'call', label: 'Phone call', state: 'active', detail: 'Ringing…' },
    { kind: 'approval', label: 'Your OK', state: 'done', detail: 'Decided' },
  ]);

  const later = [
    ...messages,
    call('c3', 'phone__get_call_result'),
    result(
      'c3',
      connection({ status: 'answered', outcome: 'alternative_offered' }),
    ),
    call('b1', 'computer_navigate'),
    call('e1', 'calendar__add_event'),
    result('e1', connection({ added: { id: 'evt_1' } })),
  ];
  const steps = fridaySteps(later);
  expect(steps.find((s) => s.kind === 'call')).toMatchObject({
    state: 'done',
    detail: 'Answered: alternative offered',
  });
  expect(steps.find((s) => s.kind === 'browser')).toMatchObject({
    state: 'active',
  });
  expect(steps.find((s) => s.kind === 'calendar')).toMatchObject({
    state: 'done',
    detail: 'Event added',
  });
});

it('marks failures and calls nobody answered', () => {
  const steps = fridaySteps([
    { role: 'user', content: 'call' },
    call('c1', 'phone__get_call_result'),
    result('c1', connection({ status: 'no_answer' })),
    call('e1', 'calendar__add_event'),
    result('e1', { isError: true, text: 'Use a date like 2026-10-23.' }),
  ]);
  expect(steps.map((s) => [s.kind, s.state, s.detail])).toEqual([
    ['call', 'failed', 'No answer'],
    ['calendar', 'failed', 'Something went wrong'],
  ]);
});
