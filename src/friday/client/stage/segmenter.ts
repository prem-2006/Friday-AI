// Friday: finds where you start and stop speaking in a live audio stream.
// It keeps a short pre-roll so the first word is never clipped, and ends a
// turn after a brief silence. Only sound in the voice band (150 Hz to 3.8 kHz)
// counts, and most of the energy must sit there, so fan hum, hiss and key
// clicks do not start a turn (each false start costs a Gnani call). Pure
// logic, so it can be tested with numbers.
export interface SegmenterEvents {
  onStart: () => void;
  onSegment: (samples: Float32Array) => void;
}

export const SEGMENTER = {
  preRollMs: 450, // audio kept from just before speech is detected
  startMs: 100, // this much speech starts a turn
  endMs: 550, // this much silence ends it
  keepSilenceMs: 250, // trailing silence kept at the end
  maxMs: 20_000, // Prisma clips stay short
  minSpeechMs: 300, // ignore coughs and clicks
  minHeldSpeechMs: 120, // push-to-talk: you meant to speak, so less is enough
  voiceLowHz: 150,
  voiceHighHz: 3800,
  minVoiceShare: 0.4, // of a chunk's energy inside the voice band
};

export class SpeechSegmenter {
  /** Smoothed level 0..1, for the orb. */
  level = 0;
  /** Start turns by voice. Off for push-to-talk only: then hold() starts them. */
  auto = true;
  private held = false;
  private floor = 0.01;
  private preRoll: Float32Array[] = [];
  private preRollMs = 0;
  private segment: Float32Array[] | null = null;
  private loudMs = 0;
  private quietMs = 0;
  private speechMs = 0;
  private totalMs = 0;
  private trailing: Float32Array[] = [];
  // One-pole high-pass then low-pass, kept across chunks.
  private hpIn = 0;
  private hpOut = 0;
  private lpOut = 0;
  private hpA: number;
  private lpB: number;

  constructor(
    private sampleRate: number,
    private events: SegmenterEvents,
    /** Multiplies the threshold, e.g. while Friday's own voice is playing. */
    private boost: () => number = () => 1,
  ) {
    const dt = 1 / sampleRate;
    const rc = (hz: number) => 1 / (2 * Math.PI * hz);
    this.hpA = rc(SEGMENTER.voiceLowHz) / (rc(SEGMENTER.voiceLowHz) + dt);
    this.lpB = dt / (rc(SEGMENTER.voiceHighHz) + dt);
  }

  // Energy of the whole chunk and of its voice band.
  private measure(chunk: Float32Array) {
    let all = 0;
    let band = 0;
    for (const x of chunk) {
      all += x * x;
      this.hpOut = this.hpA * (this.hpOut + x - this.hpIn);
      this.hpIn = x;
      this.lpOut += this.lpB * (this.hpOut - this.lpOut);
      band += this.lpOut * this.lpOut;
    }
    return {
      rms: Math.sqrt(all / chunk.length),
      voice: Math.sqrt(band / chunk.length),
      share: all > 0 ? band / all : 0,
    };
  }

  get speaking() {
    return this.segment !== null;
  }

  push(chunk: Float32Array) {
    const ms = (chunk.length / this.sampleRate) * 1000;
    const { rms, voice, share } = this.measure(chunk);
    this.level = this.level * 0.7 + Math.min(1, rms * 8) * 0.3;
    if (!this.segment && voice < this.floor * 2)
      this.floor = this.floor * 0.95 + voice * 0.05; // learn the room's noise
    const threshold = Math.max(0.012, this.floor * 3) * this.boost();
    const loud = voice > threshold && share >= SEGMENTER.minVoiceShare;

    if (!this.segment) {
      this.preRoll.push(chunk);
      this.preRollMs += ms;
      const msOf = (part: Float32Array) =>
        (part.length / this.sampleRate) * 1000;
      while (
        this.preRoll.length > 1 &&
        this.preRollMs - msOf(this.preRoll[0]) >= SEGMENTER.preRollMs
      )
        this.preRollMs -= msOf(this.preRoll.shift()!);
      this.loudMs = loud ? this.loudMs + ms : 0;
      if (this.auto && this.loudMs >= SEGMENTER.startMs) {
        this.segment = this.preRoll;
        this.totalMs = this.preRollMs;
        this.speechMs = this.loudMs;
        this.quietMs = 0;
        this.trailing = [];
        this.preRoll = [];
        this.preRollMs = 0;
        this.events.onStart();
      }
      return;
    }

    this.totalMs += ms;
    if (this.held) {
      // Push-to-talk: keep everything until the key is let go.
      this.segment.push(...this.trailing, chunk);
      this.trailing = [];
      if (loud) this.speechMs += ms;
      if (this.totalMs >= SEGMENTER.maxMs) {
        this.held = false;
        this.finish(SEGMENTER.minHeldSpeechMs);
      }
      return;
    }
    if (loud) {
      this.segment.push(...this.trailing, chunk);
      this.trailing = [];
      this.speechMs += ms;
      this.quietMs = 0;
    } else {
      this.trailing.push(chunk);
      this.quietMs += ms;
    }
    if (this.quietMs >= SEGMENTER.endMs || this.totalMs >= SEGMENTER.maxMs)
      this.finish();
  }

  /** Push-to-talk pressed: record from now (plus the pre-roll), whatever the level. */
  hold() {
    if (this.held) return;
    this.held = true;
    if (this.segment) return; // already hearing you: keep that start
    this.segment = this.preRoll;
    this.totalMs = this.preRollMs;
    this.speechMs = 0;
    this.quietMs = 0;
    this.trailing = [];
    this.preRoll = [];
    this.preRollMs = 0;
    this.events.onStart();
  }

  /** Push-to-talk let go: send what was said. */
  release() {
    if (!this.held) return;
    this.held = false;
    if (this.segment) this.finish(SEGMENTER.minHeldSpeechMs);
  }

  /**
   * Throw away the turn being heard and listen afresh, e.g. one that began on
   * Friday's own voice, so what the owner says next starts a clean turn.
   * A push-to-talk turn is never dropped.
   */
  drop() {
    if (this.held || !this.segment) return;
    this.segment = null;
    this.trailing = [];
    this.loudMs = 0;
    this.speechMs = 0;
  }

  /** Drop any half-heard turn, e.g. when listening is switched off. */
  reset() {
    this.held = false;
    this.segment = null;
    this.trailing = [];
    this.preRoll = [];
    this.preRollMs = 0;
    this.loudMs = 0;
    this.level = 0;
  }

  private finish(minSpeechMs = SEGMENTER.minSpeechMs) {
    const segment = this.segment!;
    // Keep a little of the closing silence so the last word is not cut.
    let keptMs = 0;
    for (const chunk of this.trailing) {
      if (keptMs >= SEGMENTER.keepSilenceMs) break;
      segment.push(chunk);
      keptMs += (chunk.length / this.sampleRate) * 1000;
    }
    const enough = this.speechMs >= minSpeechMs;
    this.segment = null;
    this.trailing = [];
    this.loudMs = 0;
    if (!enough) return;
    const length = segment.reduce((total, chunk) => total + chunk.length, 0);
    const samples = new Float32Array(length);
    let offset = 0;
    for (const chunk of segment) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    this.events.onSegment(samples);
  }
}
