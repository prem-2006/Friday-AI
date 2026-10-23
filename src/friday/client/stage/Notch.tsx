// Friday: the desktop notch (friday/desktop shows this page in a small
// see-through window above the taskbar). A thin black pill that widens while
// you hold Caps Lock, with bars that follow your voice, and again while
// Friday speaks. Clicking it opens Friday's main page.
import { useEffect, useRef } from 'react';
import './notch.css';

export type NotchState =
  'idle' | 'hearing' | 'thinking' | 'speaking' | 'asking' | 'offline';

interface Desktop {
  setInteractive: (on: boolean) => void;
  open: (hash: string) => void;
  toggle: () => void;
}
const desktop = () => (globalThis as { fridayDesktop?: Desktop }).fridayDesktop;

const BARS = 22;

function Bars({
  spectrum,
  level,
  color,
}: {
  spectrum: () => Uint8Array | null;
  level: () => number;
  color: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext('2d');
    if (!element || !ctx) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    element.width = element.clientWidth * ratio;
    element.height = element.clientHeight * ratio;
    ctx.scale(ratio, ratio);
    const heights = new Float32Array(BARS);
    let frame = 0;
    const draw = () => {
      const w = element.clientWidth;
      const h = element.clientHeight;
      const bins = spectrum();
      const loud = level();
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = color;
      const gap = w / BARS;
      for (let i = 0; i < BARS; i++) {
        // Mirror the voice band around the middle, like a waveform.
        const from = Math.abs(i - (BARS - 1) / 2) / (BARS / 2);
        const value = bins
          ? (bins[1 + Math.floor(from * bins.length * 0.45)] ?? 0) / 255
          : loud;
        const target = Math.max(0.12, Math.min(1, value * 1.6));
        heights[i] += (target - heights[i]) * 0.35;
        const bar = Math.max(2, heights[i] * h);
        const x = i * gap + gap * 0.3;
        ctx.beginPath();
        ctx.roundRect(x, (h - bar) / 2, gap * 0.4, bar, gap * 0.2);
        ctx.fill();
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [spectrum, level, color]);
  return <canvas ref={canvas} className="notch-bars" aria-hidden />;
}

export function Notch({
  state,
  level,
  spectrum,
  note,
  onDecide,
}: {
  state: NotchState;
  level: () => number;
  spectrum: () => Uint8Array | null;
  /** A short line above the pill: what needs an OK, or what went wrong. */
  note?: string;
  onDecide?: (approve: boolean) => void;
}) {
  useEffect(() => {
    document.documentElement.classList.add('friday-notch-page');
    return () => document.documentElement.classList.remove('friday-notch-page');
  }, []);
  // The window lets clicks through to the desktop, except over the pill.
  const hover = (on: boolean) => desktop()?.setInteractive(on);
  return (
    <div className={`friday-notch ${state}`}>
      {note && (
        <div
          className="notch-note"
          role={state === 'asking' ? 'dialog' : 'status'}
          onMouseEnter={() => hover(true)}
          onMouseLeave={() => hover(false)}
        >
          <span>{note}</span>
          {state === 'asking' && onDecide && (
            <>
              <button type="button" onClick={() => onDecide(false)}>
                Decline
              </button>
              <button
                type="button"
                className="approve"
                onClick={() => onDecide(true)}
              >
                Approve
              </button>
            </>
          )}
        </div>
      )}
      <button
        type="button"
        className="notch-pill"
        aria-label="Friday. Hold Caps Lock to talk; click to open Friday."
        onMouseEnter={() => hover(true)}
        onMouseLeave={() => hover(false)}
        onClick={() => desktop()?.open('#/home')}
      >
        {state === 'hearing' && (
          <Bars spectrum={spectrum} level={level} color="#ffffff" />
        )}
        {state === 'speaking' && (
          <Bars spectrum={spectrum} level={level} color="#a99bff" />
        )}
        {(state === 'thinking' || state === 'asking') && (
          <span className="notch-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
        )}
        {state === 'idle' && <span className="notch-ready" aria-hidden />}
        {state === 'offline' && <span className="notch-warn" aria-hidden />}
      </button>
    </div>
  );
}
