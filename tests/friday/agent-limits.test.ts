import { expect, it } from 'vitest';
import {
  FRIDAY_DEFAULT_TOOL_ROUNDS,
  fridayToolRounds,
} from '../../src/friday/server/agent-limits.js';

it('allows enough tool rounds for a chained Friday task', () => {
  expect(fridayToolRounds(5, {})).toBe(FRIDAY_DEFAULT_TOOL_ROUNDS);
  expect(fridayToolRounds(5, { FRIDAY_MAX_TOOL_ROUNDS: '40' })).toBe(40);
});

it('never goes below the OpenDots default', () => {
  expect(fridayToolRounds(10, { FRIDAY_MAX_TOOL_ROUNDS: '3' })).toBe(10);
});

it('rejects nonsense values', () => {
  for (const value of ['0', '-2', '1.5', 'many', '101'])
    expect(() =>
      fridayToolRounds(5, { FRIDAY_MAX_TOOL_ROUNDS: value }),
    ).toThrow('FRIDAY_MAX_TOOL_ROUNDS');
});
