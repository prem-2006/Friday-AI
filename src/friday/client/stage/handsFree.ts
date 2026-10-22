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
}

export class HandsFree {
  private stream?: MediaStream;
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private segmenter?: SpeechSegmenter;

  constructor(private options: HandsFreeOptions) {}

  get active() {
    return !!this.stream;
  }

  /** Smoothed mic level, 0..1, for the orb. */
  get level() {
    return this.segmenter?.level ?? 0;
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
      this.node.port.onmessage = (event: MessageEvent<Float32Array>) =>
        this.segmenter?.push(event.data);
      // A silent output keeps the worklet running in every browser.
      const mute = this.context.createGain();
      mute.gain.value = 0;
      this.context
        .createMediaStreamSource(this.stream)
        .connect(this.node)
        .connect(mute)
        .connect(this.context.destination);
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
  }
}
