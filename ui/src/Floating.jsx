import { useEffect, useRef, useState } from 'react';

// A right-rail panel as a floating window. The host is fixed, the panel inside it
// is forced in-flow (app.css: .float-host > .panel), and the panel's own header —
// details-header, panel-title, plc-header, wx-header — is the drag handle, so a
// panel needs no change to move. The spot is remembered per id; until dragged,
// `defaultPos` places it. A press brings the host above its siblings.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const key = (id) => `float:${id}`;
const readPos = (id) => { try { return JSON.parse(localStorage.getItem(key(id)) || 'null'); } catch { return null; } };
const writePos = (id, pos) => { try { localStorage.setItem(key(id), JSON.stringify(pos)); } catch { /* private mode */ } };

const HEADER = '.details-header, .panel-title, .plc-header, .wx-header, .cseq-header';
const CONTROL = 'button, input, select, textarea, a, [role="button"], [role="tab"], label, .combo';

let topZ = 25;

export function Floating({ id, open = true, width = 320, defaultPos = { right: 68, top: 60 }, children }) {
  const [pos, setPos] = useState(() => readPos(id));
  const [z, setZ] = useState(() => ++topZ);
  const hostRef = useRef(null);
  const drag = useRef(null);
  useEffect(() => { if (pos) writePos(id, pos); }, [id, pos]);

  // Keep a remembered spot reachable after a resolution change.
  useEffect(() => {
    if (!pos || !open) return;
    const el = hostRef.current;
    const w = el?.offsetWidth ?? width;
    const h = el?.offsetHeight ?? 200;
    const x = clamp(pos.x, 0, Math.max(window.innerWidth - w, 0));
    const y = clamp(pos.y, 0, Math.max(window.innerHeight - Math.min(h, 80), 0));
    if (x !== pos.x || y !== pos.y) setPos({ x, y });
  }, [pos, open, width]);

  const onPointerDown = (e) => {
    setZ(++topZ);
    const header = e.target.closest(HEADER);
    if (!header || !hostRef.current?.contains(header) || e.target.closest(CONTROL)) return;
    const rect = hostRef.current.getBoundingClientRect();
    if (!pos) setPos({ x: rect.left, y: rect.top });
    drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    hostRef.current.setPointerCapture?.(e.pointerId);
    hostRef.current.classList.add('dragging');
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    const el = hostRef.current;
    const w = el?.offsetWidth ?? width;
    const h = el?.offsetHeight ?? 200;
    setPos({
      x: clamp(e.clientX - drag.current.dx, 0, Math.max(window.innerWidth - w, 0)),
      y: clamp(e.clientY - drag.current.dy, 0, Math.max(window.innerHeight - Math.min(h, 80), 0)),
    });
  };
  const onPointerUp = () => {
    drag.current = null;
    hostRef.current?.classList.remove('dragging');
  };

  if (!open) return null;
  const style = {
    width,
    zIndex: z,
    ...(pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : defaultPos),
  };
  return (
    <div className="float-host" ref={hostRef} style={style} data-float={id}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      {children}
    </div>
  );
}
