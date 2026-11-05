// Friday: the click-through window over the whole screen (friday/desktop).
// It draws the marks Friday sends (Show me where, Draw on screen), and while
// the owner points, takes the mouse so they can drag round part of the screen.
// Marks are placed from 0 to 1000 across the screen (friday_services/overlay.py).
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { followActivity, ownerHeaders } from './activity';
import './overlay.css';

export const OVERLAY_HASH = '#/overlay';
// Each mark appears after the last, so a drawing builds up.
const STEP_MS = 450;
const KEEP_MS = { where: 25_000, draw: 60_000 };

export interface Mark {
  kind: 'ring' | 'box' | 'arrow' | 'text';
  x: number;
  y: number;
  w?: number;
  h?: number;
  x2?: number;
  y2?: number;
  text?: string;
}
type Mode = keyof typeof KEEP_MS;

/** The dragged area as parts of the window (0 to 1), whichever way it went. */
export function dragArea(
  from: { x: number; y: number },
  to: { x: number; y: number },
  width: number,
  height: number,
) {
  return {
    x: Math.min(from.x, to.x) / width,
    y: Math.min(from.y, to.y) / height,
    w: Math.abs(to.x - from.x) / width,
    h: Math.abs(to.y - from.y) / height,
  };
}

const pct = (value: number) => `${value / 10}%`;

function MarkShape({ mark, index }: { mark: Mark; index: number }) {
  const delay = { animationDelay: `${index * STEP_MS}ms` };
  if (mark.kind === 'arrow')
    return (
      <line
        className="overlay-arrow"
        style={delay}
        x1={mark.x}
        y1={mark.y}
        x2={mark.x2}
        y2={mark.y2}
        markerEnd="url(#overlay-head)"
        vectorEffect="non-scaling-stroke"
      />
    );
  if (mark.kind === 'text') return null;
  return mark.kind === 'ring' ? (
    <ellipse
      className="overlay-ring"
      style={delay}
      cx={mark.x + (mark.w ?? 0) / 2}
      cy={mark.y + (mark.h ?? 0) / 2}
      rx={(mark.w ?? 0) / 2 + 6}
      ry={(mark.h ?? 0) / 2 + 6}
      vectorEffect="non-scaling-stroke"
    />
  ) : (
    <rect
      className="overlay-box"
      style={delay}
      x={mark.x}
      y={mark.y}
      width={mark.w}
      height={mark.h}
      rx={6}
      vectorEffect="non-scaling-stroke"
    />
  );
}

/** Where a mark's label goes: under a shape, on an arrow's middle. */
function labelSpot(mark: Mark) {
  if (mark.kind === 'arrow')
    return {
      left: pct((mark.x + (mark.x2 ?? mark.x)) / 2),
      top: pct((mark.y + (mark.y2 ?? mark.y)) / 2),
    };
  if (mark.kind === 'text') return { left: pct(mark.x), top: pct(mark.y) };
  const below = mark.y + (mark.h ?? 0) + 8;
  return {
    left: pct(mark.x),
    top: pct(below > 950 ? Math.max(mark.y - 40, 0) : below),
  };
}

export function ScreenOverlay() {
  const [marks, setMarks] = useState<Mark[]>([]);
  const [picking, setPicking] = useState(false);
  const [from, setFrom] = useState<{ x: number; y: number } | null>(null);
  const [to, setTo] = useState<{ x: number; y: number } | null>(null);
  const clearing = useRef<ReturnType<typeof setTimeout>>(undefined);

  const takeMouse = (on: boolean) =>
    (
      globalThis as {
        fridayDesktop?: { setOverlayMouse?: (on: boolean) => void };
      }
    ).fridayDesktop?.setOverlayMouse?.(on);

  const answer = (rect: unknown) => {
    setPicking(false);
    setFrom(null);
    setTo(null);
    takeMouse(false);
    // After a frame, so the selection is off the screen for the screenshot.
    requestAnimationFrame(() => {
      void fetch('/api/friday/overlay/picked', {
        method: 'POST',
        headers: { ...ownerHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ rect }),
      });
    });
  };

  useEffect(() => {
    document.documentElement.classList.add('friday-overlay-page');
    const stop = followActivity(
      (event) => {
        if (event.actor !== 'control') return;
        if (event.action === 'overlay') {
          try {
            const drawing = JSON.parse(event.detail) as {
              mode: Mode;
              marks: Mark[];
            };
            setMarks(drawing.marks);
            clearTimeout(clearing.current);
            clearing.current = setTimeout(
              () => setMarks([]),
              KEEP_MS[drawing.mode] ?? KEEP_MS.where,
            );
          } catch {
            // not a drawing: nothing to show
          }
        } else if (event.action === 'overlay_clear') {
          setMarks([]);
        } else if (event.action === 'overlay_pick') {
          setMarks([]);
          setPicking(true);
          takeMouse(true);
        } else if (event.action === 'overlay_pick_end') {
          setPicking(false);
          setFrom(null);
          setTo(null);
          takeMouse(false);
        }
      },
      () => {},
      false,
    );
    return () => {
      stop();
      clearTimeout(clearing.current);
      document.documentElement.classList.remove('friday-overlay-page');
    };
  }, []);

  useEffect(() => {
    if (!picking) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') answer(null);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [picking]);

  const spot = (event: PointerEvent) => ({
    x: event.clientX,
    y: event.clientY,
  });
  const area = from && to && dragArea(from, to, innerWidth, innerHeight);

  return (
    <div
      className={`friday-overlay ${picking ? 'picking' : ''}`}
      onPointerDown={(event) => {
        if (!picking) return;
        setFrom(spot(event));
        setTo(spot(event));
      }}
      onPointerMove={(event) => {
        if (picking && from) setTo(spot(event));
      }}
      onPointerUp={(event) => {
        if (picking && from)
          answer(dragArea(from, spot(event), innerWidth, innerHeight));
      }}
    >
      {picking && (
        <div className="overlay-hint">
          Drag round what you mean. Esc to cancel.
        </div>
      )}
      {area && (
        <div
          className="overlay-selection"
          style={{
            left: `${area.x * 100}%`,
            top: `${area.y * 100}%`,
            width: `${area.w * 100}%`,
            height: `${area.h * 100}%`,
          }}
        />
      )}
      <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden>
        <defs>
          <marker
            id="overlay-head"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path d="M0 0L10 5L0 10z" className="overlay-head" />
          </marker>
        </defs>
        {marks.map((mark, index) => (
          <MarkShape key={index} mark={mark} index={index} />
        ))}
      </svg>
      {marks.map(
        (mark, index) =>
          mark.text && (
            <span
              key={index}
              className="overlay-label"
              style={{
                ...labelSpot(mark),
                animationDelay: `${index * STEP_MS}ms`,
              }}
            >
              {mark.text}
            </span>
          ),
      )}
    </div>
  );
}
