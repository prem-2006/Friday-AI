// Friday: hands-free listening. The mic stays open, a simple voice-activity
// detector notices when you start and stop talking, and only those stretches
// are recorded and sent to Prisma, so silence never spends Gnani credits.
import { blobToWav } from '../recorder';

export interface HandsFreeOptions {
  onSpeechStart: () => void;
  onUtterance: (wav: Uint8Array) => void;
  onError: (message: string) => void;
  /** While Friday speaks, a louder voice is needed, so its own audio is ignored. */
  isFridaySpeaking: () => boolean;
}

const FRAME_MS = 40;
const START_MS = 160; // this much speech starts a recording
const END_MS = 900; // this much silence ends it
const MAX_MS = 20_000; // Prisma clips stay short
const MIN_SPEECH_MS = 350; // ignore coughs and clicks

export class HandsFree {
  private stream?: MediaStream;
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private timer?: ReturnType<typeof setInterval>;
  private recorder?: MediaRecorder;
  private chunks: Blob[] = [];
  private floor = 0.01;
  private loudMs = 0;
  private quietMs = 0;
  private recordedMs = 0;
  private speechMs = 0;
  /** Smoothed mic level, 0..1, for the orb. */
  level = 0;

  constructor(private options: HandsFreeOptions) {}

  get active() {
    return !!this.stream;
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
    this.context = new AudioContext();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.context.createMediaStreamSource(this.stream).connect(this.analyser);
    const samples = new Float32Array(this.analyser.fftSize);
    this.timer = setInterval(() => this.tick(samples), FRAME_MS);
  }

  stop() {
    clearInterval(this.timer);
    if (this.recorder?.state === 'recording') {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.recorder = undefined;
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close();
    this.stream = this.context = this.analyser = undefined;
    this.level = 0;
  }

  private tick(samples: Float32Array<ArrayBuffer>) {
    if (!this.analyser || !this.stream) return;
    this.analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const rms = Math.sqrt(sum / samples.length);
    this.level = this.level * 0.7 + Math.min(1, rms * 8) * 0.3;
    const recording = this.recorder?.state === 'recording';
    if (!recording && rms < this.floor * 2)
      this.floor = this.floor * 0.95 + rms * 0.05; // learn the room's noise
    const threshold =
      Math.max(0.015, this.floor * 3) *
      (this.options.isFridaySpeaking() ? 2.5 : 1);
    const loud = rms > threshold;
    if (!recording) {
      this.loudMs = loud ? this.loudMs + FRAME_MS : 0;
      if (this.loudMs >= START_MS) this.begin();
      return;
    }
    this.recordedMs += FRAME_MS;
    if (loud) {
      this.speechMs += FRAME_MS;
      this.quietMs = 0;
    } else this.quietMs += FRAME_MS;
    if (this.quietMs >= END_MS || this.recordedMs >= MAX_MS) this.finish();
  }

  private begin() {
    if (!this.stream) return;
    this.loudMs = this.quietMs = this.recordedMs = 0;
    this.speechMs = START_MS;
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (event) => {
      if (event.data.size) this.chunks.push(event.data);
    };
    this.recorder.start();
    this.options.onSpeechStart();
  }

  private finish() {
    const recorder = this.recorder;
    if (!recorder) return;
    this.recorder = undefined;
    const enough = this.speechMs >= MIN_SPEECH_MS;
    recorder.onstop = () => {
      if (!enough) return;
      blobToWav(new Blob(this.chunks))
        .then(this.options.onUtterance)
        .catch(() =>
          this.options.onError('Could not read that recording. Try again.'),
        );
    };
    recorder.stop();
  }
}
