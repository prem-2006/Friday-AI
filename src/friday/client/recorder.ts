// Friday: records one push-to-talk clip and returns it as 16 kHz mono WAV.
import { CLIP_SAMPLE_RATE, encodeWav } from './wav';

export class ClipRecorder {
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private chunks: Blob[] = [];

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (event) => {
      if (event.data.size) this.chunks.push(event.data);
    };
    this.recorder.start();
  }

  async stop(): Promise<Uint8Array> {
    const recorder = this.recorder;
    if (!recorder) throw new Error('Recording has not started.');
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.stop();
    await stopped;
    this.release();
    const encoded = await new Blob(this.chunks).arrayBuffer();
    if (!encoded.byteLength) throw new Error('No audio was recorded.');
    const context = new AudioContext();
    try {
      const decoded = await context.decodeAudioData(encoded);
      // Downmix and resample in one offline render.
      const offline = new OfflineAudioContext(
        1,
        Math.ceil(decoded.duration * CLIP_SAMPLE_RATE),
        CLIP_SAMPLE_RATE,
      );
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start();
      const rendered = await offline.startRendering();
      return encodeWav(rendered.getChannelData(0));
    } finally {
      void context.close();
    }
  }

  cancel() {
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.release();
  }

  private release() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.recorder = undefined;
  }
}
