// Friday: the living orb. Glowing rings ripple with the voice level, waves
// flow out to both sides, and busy helper Dots orbit around it.
import { useEffect, useRef } from 'react';

export type OrbMode =
  'idle' | 'listening' | 'thinking' | 'speaking' | 'working';

const HELPER_COLORS: Record<string, string> = {
  Navigator: '#38e1ff',
  Operator: '#ff5ad1',
  Friday: '#8b7bff',
};
const MODE_ENERGY: Record<OrbMode, number> = {
  idle: 0.12,
  listening: 0.28,
  thinking: 0.42,
  speaking: 0.3,
  working: 0.5,
};
const MODE_SPIN: Record<OrbMode, number> = {
  idle: 0.12,
  listening: 0.22,
  thinking: 0.9,
  speaking: 0.35,
  working: 0.6,
};

function paletteGradient(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  angle: number,
  alpha: number,
) {
  const stops: [number, string][] = [
    [0, `rgba(56,225,255,${alpha})`],
    [0.3, `rgba(79,107,255,${alpha})`],
    [0.55, `rgba(139,92,246,${alpha})`],
    [0.75, `rgba(236,72,153,${alpha})`],
    [1, `rgba(56,225,255,${alpha})`],
  ];
  if ('createConicGradient' in ctx) {
    const gradient = ctx.createConicGradient(angle, cx, cy);
    for (const [at, color] of stops) gradient.addColorStop(at, color);
    return gradient;
  }
  const gradient = (ctx as CanvasRenderingContext2D).createLinearGradient(
    cx - 200,
    cy,
    cx + 200,
    cy,
  );
  for (const [at, color] of stops) gradient.addColorStop(at, color);
  return gradient;
}

export function Orb({
  mode,
  level,
  helpers,
}: {
  mode: OrbMode;
  /** 0..1 voice level, read every frame. */
  level: () => number;
  helpers: string[];
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useRef({ mode, helpers, energy: 0.12, spin: 0, voice: 0 });
  state.current.mode = mode;
  state.current.helpers = helpers;

  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext('2d');
    if (!element || !ctx) return;
    const reduced = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    let frame = 0;
    let last = performance.now();
    let t = 0;
    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      element.width = element.clientWidth * ratio;
      element.height = element.clientHeight * ratio;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      t += reduced ? dt * 0.25 : dt;
      const s = state.current;
      const voice = level();
      s.voice += (voice - s.voice) * 0.25;
      const target =
        MODE_ENERGY[s.mode] +
        (s.mode === 'listening' || s.mode === 'speaking' ? s.voice * 1.25 : 0);
      s.energy += (target - s.energy) * 0.08;
      s.spin += dt * MODE_SPIN[s.mode];
      const w = element.clientWidth;
      const h = element.clientHeight;
      const cx = w / 2;
      const cy = h * 0.52;
      const R = Math.max(64, Math.min(170, Math.min(w, h) * 0.15));
      const e = s.energy;
      ctx.clearRect(0, 0, w, h);

      // Halo behind everything.
      ctx.globalCompositeOperation = 'source-over';
      const halo = ctx.createRadialGradient(cx, cy, R * 0.3, cx, cy, R * 3.4);
      halo.addColorStop(0, `rgba(79,107,255,${0.28 + e * 0.35})`);
      halo.addColorStop(0.35, `rgba(124,58,237,${0.1 + e * 0.12})`);
      halo.addColorStop(1, 'rgba(5,8,22,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, w, h);

      ctx.globalCompositeOperation = 'lighter';
      // Waves flowing out of the orb to both edges.
      for (const side of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
          const startX = cx + side * R * 0.85;
          const endX = side < 0 ? 0 : w;
          const span = Math.abs(endX - startX);
          const gradient = ctx.createLinearGradient(startX, 0, endX, 0);
          gradient.addColorStop(0, `rgba(139,92,246,${0.7 - i * 0.12})`);
          gradient.addColorStop(0.35, `rgba(79,107,255,${0.65 - i * 0.12})`);
          gradient.addColorStop(0.7, `rgba(56,225,255,${0.4 - i * 0.08})`);
          gradient.addColorStop(1, 'rgba(56,225,255,0)');
          ctx.beginPath();
          for (let step = 0; step <= span; step += 4) {
            const u = step / span;
            const envelope =
              Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.1)), 1.3) *
              (1 - u * 0.55);
            const amp = R * 0.5 * (0.3 + e * 1.1) * envelope * (1 - i * 0.17);
            const y =
              cy +
              amp *
                Math.sin(
                  step * 0.016 * (1 + i * 0.22) -
                    t * (1.5 + i * 0.35) +
                    i * 1.3,
                ) +
              amp * 0.35 * Math.sin(step * 0.043 - t * 2.4 + i);
            const x = startX + side * step;
            if (step === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = gradient;
          ctx.lineWidth = 2.6 - i * 0.45;
          ctx.shadowBlur = 16;
          ctx.shadowColor = 'rgba(124,58,237,0.9)';
          ctx.stroke();
        }
      }

      // Soft bloom: translucent filled lobes that breathe inside the rings.
      for (let k = 0; k < 3; k++) {
        ctx.beginPath();
        for (let a = 0; a <= Math.PI * 2 + 0.05; a += 0.05) {
          const wobble =
            Math.sin(2 * a + t * (0.8 + k * 0.3) + k * 2.1) * 0.6 +
            Math.sin(4 * a - t * 1.1 + k) * 0.4;
          const r = R * (1.02 + k * 0.05) * (1 + wobble * (0.05 + e * 0.12));
          const angle = a - s.spin * (0.4 + k * 0.15);
          const x = cx + Math.cos(angle) * r;
          const y = cy + Math.sin(angle) * r;
          if (a === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        const bloom = ctx.createRadialGradient(
          cx,
          cy,
          R * 0.55,
          cx,
          cy,
          R * 1.25,
        );
        const hue = ['79,107,255', '139,92,246', '236,72,153'][k];
        bloom.addColorStop(0, `rgba(${hue},0)`);
        bloom.addColorStop(0.8, `rgba(${hue},${0.1 + e * 0.12})`);
        bloom.addColorStop(1, `rgba(${hue},0)`);
        ctx.fillStyle = bloom;
        ctx.shadowBlur = 0;
        ctx.fill();
      }

      // Rippling rings.
      for (let k = 0; k < 6; k++) {
        ctx.beginPath();
        const direction = k % 2 ? -1 : 1;
        for (let a = 0; a <= Math.PI * 2 + 0.05; a += 0.035) {
          const wobble =
            Math.sin(3 * a + t * 1.3 + k * 1.7) * 0.5 +
            Math.sin(5 * a - t * 1.9 + k) * 0.3 +
            Math.sin(7 * a + t * 2.6 + k * 0.6) * 0.2;
          const r = R * (0.9 + k * 0.035) * (1 + wobble * (0.045 + e * 0.13));
          const angle = a + s.spin * direction * (0.6 + k * 0.1);
          const x = cx + Math.cos(angle) * r;
          const y = cy + Math.sin(angle) * r;
          if (a === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.strokeStyle = paletteGradient(
          ctx,
          cx,
          cy,
          s.spin * 1.4 + k,
          0.5 + e * 0.35,
        );
        ctx.lineWidth = 2.4 - k * 0.2;
        ctx.shadowBlur = 28;
        ctx.shadowColor = 'rgba(91,108,255,0.95)';
        ctx.stroke();
      }

      // Dark glassy core.
      ctx.globalCompositeOperation = 'source-over';
      ctx.shadowBlur = 0;
      const core = ctx.createRadialGradient(
        cx,
        cy - R * 0.2,
        R * 0.1,
        cx,
        cy,
        R * 0.92,
      );
      core.addColorStop(0, 'rgba(10,12,40,0.95)');
      core.addColorStop(0.75, 'rgba(8,10,34,0.85)');
      core.addColorStop(1, 'rgba(8,10,34,0)');
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.92, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'lighter';
      const sheen = ctx.createRadialGradient(
        cx - R * 0.35,
        cy - R * 0.4,
        2,
        cx,
        cy,
        R,
      );
      sheen.addColorStop(0, `rgba(160,180,255,${0.12 + e * 0.15})`);
      sheen.addColorStop(1, 'rgba(160,180,255,0)');
      ctx.fillStyle = sheen;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.9, 0, Math.PI * 2);
      ctx.fill();

      // Busy helper Dots orbit the orb.
      s.helpers.forEach((name, index) => {
        const color = HELPER_COLORS[name] ?? '#8b7bff';
        const angle = t * 0.9 + (index * Math.PI * 2) / s.helpers.length;
        const ox = cx + Math.cos(angle) * R * 1.85;
        const oy = cy + Math.sin(angle) * R * 0.62;
        for (let trail = 1; trail <= 14; trail++) {
          const back = angle - trail * 0.05;
          ctx.fillStyle = `${color}${Math.round(40 - trail * 2.5)
            .toString(16)
            .padStart(2, '0')}`;
          ctx.beginPath();
          ctx.arc(
            cx + Math.cos(back) * R * 1.85,
            cy + Math.sin(back) * R * 0.62,
            6 - trail * 0.3,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
        const glow = ctx.createRadialGradient(ox, oy, 0, ox, oy, 22);
        glow.addColorStop(0, color);
        glow.addColorStop(0.35, `${color}99`);
        glow.addColorStop(1, `${color}00`);
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(ox, oy, 22, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = 'rgba(220,225,255,0.85)';
        ctx.font = '600 12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(name, ox, oy + 36);
        ctx.globalCompositeOperation = 'lighter';
      });

      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
    };
  }, [level]);

  return <canvas ref={canvas} className="friday-orb-canvas" aria-hidden />;
}
