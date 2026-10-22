// Friday: the live voice connection. The mic goes to friday/services over
// WebRTC, where Gnani streaming speech-to-text hears it, and Friday's voice
// comes back the same way from Gnani streaming text-to-speech. A data channel
// carries what was heard and what to say (see live_voice.py for the messages).
// The browser's echo cancellation keeps Friday from hearing itself.
import { ownerHeaders } from './activity';

export type LiveEvent =
  | { event: 'heard'; text: string }
  | { event: 'speech_start' }
  | { event: 'speaking'; on: boolean }
  | { event: 'error'; message: string };

export interface LiveVoiceOptions {
  language: string;
  onEvent: (event: LiveEvent) => void;
  onClosed: () => void;
}

const BINS = 64;

export class LiveVoice {
  private pc?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private stream?: MediaStream;
  private context?: AudioContext;
  private micAnalyser?: AnalyserNode;
  private voiceAnalyser?: AnalyserNode;
  private player?: HTMLAudioElement;
  private bins = new Uint8Array(BINS) as Uint8Array<ArrayBuffer>;
  speaking = false;

  constructor(private options: LiveVoiceOptions) {}

  get connected() {
    return this.pc?.connectionState === 'connected';
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
    const pc = new RTCPeerConnection();
    this.pc = pc;
    for (const track of this.stream.getAudioTracks())
      pc.addTrack(track, this.stream);
    const channel = pc.createDataChannel('friday');
    this.channel = channel;
    channel.onmessage = (message) => {
      try {
        const data = JSON.parse(String(message.data));
        if (data?.type !== 'friday-live') return;
        if (data.event === 'speaking') this.speaking = !!data.on;
        this.options.onEvent(data as LiveEvent);
      } catch {
        // not one of ours
      }
    };
    this.context = new AudioContext();
    this.micAnalyser = this.analyser(
      this.context.createMediaStreamSource(this.stream),
    );
    pc.ontrack = (event) => {
      const [remote] = event.streams;
      if (!remote || !this.context) return;
      this.player = new Audio();
      this.player.srcObject = remote;
      void this.player.play().catch(() => {});
      this.voiceAnalyser = this.analyser(
        this.context.createMediaStreamSource(remote),
      );
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState))
        this.options.onClosed();
    };

    await pc.setLocalDescription(await pc.createOffer());
    // Send the offer once every local address is in it (no trickle ICE).
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const done = () => {
        if (pc.iceGatheringState === 'complete') resolve();
      };
      pc.addEventListener('icegatheringstatechange', done);
      setTimeout(resolve, 2000);
    });
    const response = await fetch('/api/friday/voice/offer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ownerHeaders() },
      body: JSON.stringify({
        sdp: pc.localDescription?.sdp,
        type: pc.localDescription?.type,
        request_data: { language: this.options.language },
      }),
    });
    const answer = (await response.json().catch(() => ({}))) as {
      sdp?: string;
      type?: RTCSdpType;
      detail?: string;
      error?: string;
    };
    if (!response.ok || !answer.sdp)
      throw new Error(
        answer.detail ??
          answer.error ??
          'Friday’s live voice is not reachable.',
      );
    await pc.setRemoteDescription({
      sdp: answer.sdp,
      type: answer.type ?? 'answer',
    });
    await new Promise<void>((resolve, reject) => {
      if (channel.readyState === 'open') return resolve();
      channel.onopen = () => resolve();
      setTimeout(
        () => reject(new Error('Friday’s live voice did not connect.')),
        8000,
      );
    });
  }

  private analyser(source: AudioNode) {
    const analyser = this.context!.createAnalyser();
    analyser.fftSize = BINS * 2;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    return analyser;
  }

  private send(message: Record<string, unknown>) {
    if (this.channel?.readyState === 'open')
      this.channel.send(JSON.stringify(message));
  }

  pushToTalk(down: boolean) {
    this.send({ type: 'ptt', down });
  }

  handsFree(on: boolean) {
    this.send({ type: 'hands_free', on });
  }

  say(text: string) {
    this.send({ type: 'speak', text });
  }

  interrupt() {
    this.speaking = false;
    this.send({ type: 'interrupt' });
  }

  /** 0..1 loudness of Friday's voice while it speaks, else of the mic. */
  level() {
    const analyser = this.speaking ? this.voiceAnalyser : this.micAnalyser;
    if (!analyser) return 0;
    analyser.getByteFrequencyData(this.bins);
    let sum = 0;
    for (const value of this.bins) sum += value;
    return Math.min(1, (sum / this.bins.length / 255) * 3);
  }

  /** Frequency bars for the orb, from whichever voice is active. */
  spectrum() {
    const analyser = this.speaking ? this.voiceAnalyser : this.micAnalyser;
    if (!analyser) return null;
    analyser.getByteFrequencyData(this.bins);
    return this.bins;
  }

  stop() {
    this.channel?.close();
    this.pc?.close();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.player?.pause();
    void this.context?.close().catch(() => {});
    this.pc = this.channel = this.stream = this.context = undefined;
  }
}
