import { useCallback, useEffect, useRef } from 'react';
import { Tooltip } from './Tooltip.jsx';

const SIZE = 88;
const R = 34; // sphere radius in px
const DEFAULT_DIR = [0.35, 0.9, 0.25];

function norm(v) {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/**
 * Screen offset (−1..1, +Y up) → unit direction (Y-up, +Z toward viewer).
 *
 * The near hemisphere only: a screen point maps to two directions on the
 * sphere and this picks +Z. The far half is reached by dragging the hollow
 * handle instead, which negates the whole vector (see `eventToDir`) — the
 * light used to be stuck in front of the model because nothing ever did.
 */
function hitDir(nx, ny) {
  const d2 = nx * nx + ny * ny;
  if (d2 > 1) {
    const inv = 1 / Math.sqrt(d2);
    return [nx * inv, ny * inv, 0];
  }
  return [nx, ny, Math.sqrt(1 - d2)];
}

/**
 * Compact trackball for the custom shadow sun. Bottom-right, only while
 * View → Shadows is on. Drag the handle around the sphere; double-click resets.
 */
export function LightGizmo({ dir, onChange, onReset, detailsOpen = false }) {
  const canvasRef = useRef(null);
  const dirRef = useRef(dir || DEFAULT_DIR);
  const dragRef = useRef(false);
  // Set for the duration of a right-drag: the pointer is moving the antipode.
  const backRef = useRef(false);

  useEffect(() => {
    dirRef.current = dir && Math.hypot(...dir) > 1e-6 ? norm(dir) : DEFAULT_DIR;
    draw();
  }, [dir]);

  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = SIZE;
    const h = SIZE;
    if (c.width !== w * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const D = dirRef.current;

    // Disc fill
    const g = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.1, cx, cy, R);
    g.addColorStop(0, 'rgba(255, 240, 180, 0.14)');
    g.addColorStop(0.55, 'rgba(40, 48, 58, 0.85)');
    g.addColorStop(1, 'rgba(18, 22, 28, 0.95)');
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Equator + meridian hints
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.beginPath();
    ctx.ellipse(cx, cy, R, R * 0.28, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, cy, R * 0.28, R, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Two handles, always both on screen. The solid one is the light itself;
    // the hollow one is its antipode — the side the shadow falls towards — and
    // is what a right-drag grabs. Since a screen point maps to two directions,
    // the antipode is the only way to show "the other side" as a separate,
    // grabbable target rather than a dot hidden underneath the first.
    const front = D[2] >= -0.02;
    const hx = cx + D[0] * R;
    const hy = cy - D[1] * R;
    const ax = cx - D[0] * R;
    const ay = cy + D[1] * R;

    // Ray from centre toward the light; dashed while the light is behind.
    ctx.strokeStyle = front ? 'rgba(255, 210, 120, 0.45)' : 'rgba(255, 210, 120, 0.18)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash(front ? [] : [2, 2]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    ctx.setLineDash([]);

    // Antipode (right-drag target)
    ctx.beginPath();
    ctx.arc(ax, ay, 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20, 24, 30, 0.75)';
    ctx.fill();
    ctx.strokeStyle = front ? 'rgba(255, 255, 255, 0.28)' : 'rgba(255, 210, 120, 0.7)';
    ctx.lineWidth = 1.25;
    ctx.stroke();

    // Light handle
    ctx.beginPath();
    ctx.arc(hx, hy, front ? 6 : 4.5, 0, Math.PI * 2);
    ctx.fillStyle = front ? '#ffd078' : 'rgba(180, 160, 100, 0.55)';
    ctx.fill();
    ctx.strokeStyle = front ? 'rgba(255, 255, 255, 0.55)' : 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Label
    ctx.fillStyle = 'rgba(200, 210, 220, 0.75)';
    ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Light', cx, h - 4);
  }, []);

  useEffect(() => {
    draw();
  }, [draw]);

  const eventToDir = (e) => {
    const c = canvasRef.current;
    const rect = c.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const nx = (x - SIZE / 2) / R;
    const ny = -(y - SIZE / 2) / R;
    const d = hitDir(nx, ny);
    // Right-drag grabs the hollow antipode, so the pointer is placing the far
    // end of the ray: negate it and the light lands on the far hemisphere,
    // which hitDir alone can never produce.
    return backRef.current ? [-d[0], -d[1], -d[2]] : d;
  };

  const onPointerDown = (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = true;
    backRef.current = e.button === 2;
    const d = eventToDir(e);
    dirRef.current = d;
    onChange?.(d);
    draw();
  };

  const onPointerMove = (e) => {
    if (!dragRef.current) return;
    const d = eventToDir(e);
    dirRef.current = d;
    onChange?.(d);
    draw();
  };

  const onPointerUp = (e) => {
    dragRef.current = false;
    backRef.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* */ }
  };

  const onDblClick = (e) => {
    e.preventDefault();
    dirRef.current = DEFAULT_DIR;
    onReset?.();
    draw();
  };

  return (
    <div
      id="light-gizmo"
      className={`light-gizmo${detailsOpen ? ' details-open' : ''}`}
    >
      {/* Help sits on its own target: hovering it explains the widget, while
          hovering (or dragging) the sphere itself no longer pops a tip. */}
      <Tooltip content="Drag the filled handle to aim the light · right-drag the hollow one to put it behind · double-click to reset">
        <span className="light-gizmo-help">?</span>
      </Tooltip>
      <canvas
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDblClick}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
}

export const DEFAULT_LIGHT_DIR = DEFAULT_DIR;
