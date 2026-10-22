// Friday: hands-free listening. The mic stays open and raw audio streams in
// through a small audio worklet; the speech segmenter cuts out each thing you
// say (with a short pre-roll, so the first word is kept) and only those
// stretches go to Prisma, so silence never spends Gnani credits.
import { downsample, encodeWav } from '../wav';
import { SpeechSegmenter } from './segmenter';

export interface HandsFreeOptions {
  onSpeechStart: () => void;
  onUtterance: (wav: Uint8Array, endedAt: number) => void;
  onError: (message: string) => void;
  /** While Friday speaks, a louder voice is needed, so its own audio is ignored. */
  isFridaySpeaking: () => boolean;
  /** Start turns by voice (hands-free). Off: only hold()/release() record. */
  auto?: boolean;
}

export class HandsFree {
  private stream?: MediaStream;
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private segmenter?: SpeechSegmenter;
  private analyser?: AnalyserNode;
  private bins?: Uint8Array<ArrayBuffer>;

  constructor(private options: HandsFreeOptions) {}

  get active() {
    return !!this.stream;
  }

  /** Smoothed mic level, 0..1, for the orb. */
  get level() {
    return this.segmenter?.level ?? 0;
  }

  /** Whether turns start by voice; off when only push-to-talk is wanted. */
  get auto() {
    return this.segmenter?.auto ?? false;
  }
  set auto(on: boolean) {
    if (this.segmenter) this.segmenter.auto = on;
  }

  hold() {
    this.segmenter?.hold();
  }

  release() {
    this.segmenter?.release();
  }

  /** The mic's frequency bars (0..255 each), for the orb's visualiser. */
  spectrum() {
    if (!this.analyser || !this.bins) return null;
    this.analyser.getByteFrequencyData(this.bins);
    return this.bins;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    try {
      this.context = new AudioContext();
      await this.context.audioWorklet.addModule('/friday-capture.js');
      this.node = new AudioWorkletNode(this.context, 'friday-capture');
      const rate = this.context.sampleRate;
      this.segmenter = new SpeechSegmenter(
        rate,
        {
          onStart: this.options.onSpeechStart,
          onSegment: (samples) =>
            this.options.onUtterance(
              encodeWav(downsample(samples, rate)),
              performance.now(),
            ),
        },
        () => (this.options.isFridaySpeaking() ? 2.5 : 1),
      );
      this.segmenter.auto = this.options.auto ?? true;
      this.node.port.onmessage = (event: MessageEvent<Float32Array>) =>
        this.segmenter?.push(event.data);
      // A silent output keeps the worklet running in every browser.
      const mute = this.context.createGain();
      mute.gain.value = 0;
      const source = this.context.createMediaStreamSource(this.stream);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 128;
      this.analyser.smoothingTimeConstant = 0.6;
      this.bins = new Uint8Array(this.analyser.frequencyBinCount);
      source.connect(this.analyser);
      source.connect(this.node).connect(mute).connect(this.context.destination);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop() {
    this.segmenter?.reset();
    this.node?.port.close();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close().catch(() => {});
    this.stream = this.context = this.node = this.segmenter = undefined;
    this.analyser = this.bins = undefined;
  }
}
