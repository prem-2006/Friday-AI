import { expect, it } from 'vitest';
import {
  SEGMENTER,
  SpeechSegmenter,
} from '../../src/friday/client/stage/segmenter.js';
import { downsample } from '../../src/friday/client/wav.js';
import { speechParts } from '../../src/friday/client/speech.js';

const RATE = 48_000;
const CHUNK = 1024; // what the audio worklet sends, ~21 ms
const chunkMs = (CHUNK / RATE) * 1000;

// A chunk of silence (tiny noise) or "speech" (a loud tone).
function chunk(loud: boolean) {
  const data = new Float32Array(CHUNK);
  for (let i = 0; i < CHUNK; i++)
    data[i] = loud ? 0.3 * Math.sin(i / 3) : 0.001 * Math.sin(i);
  return data;
}

function feed(segmenter: SpeechSegmenter, pattern: [boolean, number][]) {
  for (const [loud, ms] of pattern)
    for (let t = 0; t < ms; t += chunkMs) segmenter.push(chunk(loud));
}

it('cuts out one utterance, keeping the moment before speech started', () => {
  const starts: number[] = [];
  const segments: Float32Array[] = [];
  const segmenter = new SpeechSegmenter(RATE, {
    onStart: () => starts.push(Date.now()),
    onSegment: (samples) => segments.push(samples),
  });
  feed(segmenter, [
    [false, 1000],
    [true, 800],
    [false, 1000],
  ]);
  expect(starts).toHaveLength(1);
  expect(segments).toHaveLength(1);
  const ms = (segments[0].length / RATE) * 1000;
  // Pre-roll + speech + a little closing silence, never the whole second of silence.
  expect(ms).toBeGreaterThan(800 + SEGMENTER.preRollMs - 2 * chunkMs);
  expect(ms).toBeLessThan(
    800 + SEGMENTER.preRollMs + SEGMENTER.keepSilenceMs + 3 * chunkMs,
  );
});

it('ends a turn after a short pause, not a long one', () => {
  const segments: Float32Array[] = [];
  const segmenter = new SpeechSegmenter(RATE, {
    onStart: () => {},
    onSegment: (samples) => segments.push(samples),
  });
  feed(segmenter, [
    [false, 600],
    [true, 500],
    [false, SEGMENTER.endMs - 150], // a mid-sentence breath: same turn
    [true, 500],
    [false, SEGMENTER.endMs + 100],
  ]);
  expect(segments).toHaveLength(1);
});

it('ignores clicks and needs a louder voice while Friday is talking', () => {
  const segments: Float32Array[] = [];
  let fridayTalking = false;
  const segmenter = new SpeechSegmenter(
    RATE,
    { onStart: () => {}, onSegment: (samples) => segments.push(samples) },
    () => (fridayTalking ? 50 : 1),
  );
  feed(segmenter, [
    [false, 600],
    [true, 120], // a click or cough
    [false, 1000],
  ]);
  expect(segments).toHaveLength(0);
  fridayTalking = true;
  feed(segmenter, [
    [true, 800],
    [false, 1000],
  ]);
  expect(segments).toHaveLength(0);
});

function tone(hz: number, amplitude: number, start: number) {
  const data = new Float32Array(CHUNK);
  for (let i = 0; i < CHUNK; i++)
    data[i] = amplitude * Math.sin((2 * Math.PI * hz * (start + i)) / RATE);
  return data;
}

function noise(amplitude: number) {
  let seed = 7;
  const data = new Float32Array(CHUNK);
  for (let i = 0; i < CHUNK; i++) {
    seed = (seed * 16807) % 2147483647;
    // Alternate signs make it mostly high-frequency hiss.
    data[i] = amplitude * (i % 2 ? 1 : -1) * (seed / 2147483647);
  }
  return data;
}

it('only a voice-band sound starts a turn, not hum or hiss', () => {
  for (const [name, make, expected] of [
    ['50 Hz mains hum', (n: number) => tone(50, 0.4, n * CHUNK), 0],
    ['high hiss', () => noise(0.4), 0],
    ['a 300 Hz voice', (n: number) => tone(300, 0.3, n * CHUNK), 1],
  ] as const) {
    const segments: Float32Array[] = [];
    const segmenter = new SpeechSegmenter(RATE, {
      onStart: () => {},
      onSegment: (s) => segments.push(s),
    });
    feed(segmenter, [[false, 300]]);
    for (let n = 0; n * chunkMs < 800; n++) segmenter.push(make(n));
    feed(segmenter, [[false, 1000]]);
    expect(segments.length, name).toBe(expected);
  }
});

it('downsamples 48 kHz to 16 kHz', () => {
  const samples = new Float32Array(4800).fill(0.5);
  const out = downsample(samples, 48_000);
  expect(out.length).toBe(1600);
  expect(out[10]).toBeCloseTo(0.5);
  expect(downsample(samples, 16_000)).toBe(samples);
});

it('splits replies so the first sentence can play early', () => {
  expect(
    speechParts(
      'Apollo Dental is open till 9 PM tonight. It is 1.2 km away on 100 Feet Road. Shall I message Priya?',
    ),
  ).toEqual([
    'Apollo Dental is open till 9 PM tonight.',
    // Short sentences are merged, so there are fewer voice requests.
    'It is 1.2 km away on 100 Feet Road. Shall I message Priya?',
  ]);
  expect(speechParts('Okay. Done. Anything else?')).toEqual([
    'Okay. Done. Anything else?',
  ]);
  expect(speechParts('हाँ, हो गया। प्रिया को मैसेज भेज दिया।')).toHaveLength(1);
});

it('push-to-talk records only while held, whatever the level', () => {
  const segments: Float32Array[] = [];
  let started = 0;
  const segmenter = new SpeechSegmenter(RATE, {
    onStart: () => (started += 1),
    onSegment: (s) => segments.push(s),
  });
  segmenter.auto = false;
  // Loud speech without the key: nothing is recorded.
  feed(segmenter, [
    [false, 300],
    [true, 600],
    [false, 1000],
  ]);
  expect(segments).toHaveLength(0);
  // Held: a pause inside the turn does not end it; letting go sends it.
  segmenter.hold();
  feed(segmenter, [
    [true, 300],
    [false, 1500],
    [true, 300],
  ]);
  expect(segments).toHaveLength(0);
  segmenter.release();
  expect(segments).toHaveLength(1);
  expect(started).toBe(1);
  const ms = (segments[0].length / RATE) * 1000;
  expect(ms).toBeGreaterThan(2000);
  // Held in silence: nothing worth sending.
  segmenter.hold();
  feed(segmenter, [[false, 800]]);
  segmenter.release();
  expect(segments).toHaveLength(1);
});

it('drops a turn that began on Friday’s voice, so the next one starts clean', () => {
  const segments: Float32Array[] = [];
  const segmenter = new SpeechSegmenter(RATE, {
    onStart: () => {},
    onSegment: (s) => segments.push(s),
  });
  feed(segmenter, [
    [false, 300],
    [true, 500], // Friday's voice through the speakers
  ]);
  expect(segmenter.speaking).toBe(true);
  segmenter.drop(); // Friday stopped talking
  expect(segmenter.speaking).toBe(false);
  feed(segmenter, [
    [true, 600], // the owner
    [false, 1000],
  ]);
  expect(segments).toHaveLength(1);
  const ms = (segments[0].length / RATE) * 1000;
  expect(ms).toBeLessThan(1500); // only the owner's words, not Friday's
});
