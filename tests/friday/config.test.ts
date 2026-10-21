import { expect, it } from 'vitest';
import { fridayModelFromEnv } from '../../src/friday/server/config.js';
import {
  FRIDAY_DEFAULT_TIME_ZONE,
  fridayLocalTime,
  fridayTimeZone,
} from '../../src/friday/server/time.js';

it('uses Evon for the model when EVON_BASE_URL is set', () => {
  expect(
    fridayModelFromEnv({
      EVON_BASE_URL: 'https://evon.example/v1',
      EVON_API_KEY: 'evon-key',
      EVON_MODEL: 'gnani-evon-v3.3',
      OPENAI_API_KEY: 'openai-key',
      OPENAI_MODEL: 'gpt-x',
    }),
  ).toEqual({
    baseUrl: 'https://evon.example/v1',
    apiKey: 'evon-key',
    model: 'gnani-evon-v3.3',
  });
});

it('never mixes an OpenAI key with the Evon URL', () => {
  expect(
    fridayModelFromEnv({
      EVON_BASE_URL: 'https://evon.example/v1',
      OPENAI_API_KEY: 'openai-key',
      OPENAI_MODEL: 'gpt-x',
    }),
  ).toEqual({
    baseUrl: 'https://evon.example/v1',
    apiKey: undefined,
    model: undefined,
  });
});

it('falls back to the OpenDots model settings without EVON_BASE_URL', () => {
  expect(
    fridayModelFromEnv({
      EVON_BASE_URL: '  ',
      OPENAI_API_KEY: 'openai-key',
      OPENAI_MODEL: 'gpt-x',
    }),
  ).toEqual({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'openai-key',
    model: 'gpt-x',
  });
});

it('defaults to India time and rejects unknown zones', () => {
  expect(fridayTimeZone({})).toBe(FRIDAY_DEFAULT_TIME_ZONE);
  expect(fridayTimeZone({ TIMEZONE: 'Europe/London' })).toBe('Europe/London');
  expect(() => fridayTimeZone({ TIMEZONE: 'Mars/Olympus' })).toThrow(
    'TIMEZONE must be an IANA time zone',
  );
});

it('describes the local time in the owner time zone', () => {
  // 07:33 UTC is 13:03 in India (UTC+05:30).
  const text = fridayLocalTime(
    new Date('2026-10-04T07:33:12.000Z'),
    'Asia/Kolkata',
  );
  expect(text).toContain('4 October 2026');
  expect(text).toMatch(/1:03\s?pm/i);
  expect(text).toContain('(Asia/Kolkata)');
});
