import { useEffect, useRef, useState } from 'react';
import { nextZ } from './zstack.js';

// A right-rail panel as a floating window. The host is fixed, the panel inside it
// is forced in-flow (app.css: .float-host > .panel), and the panel's own header —
// details-header, panel-title, plc-header, wx-header — is the drag handle, so a
// panel needs no change to move. The spot is remembered per id; until dragged,
// `defaultPos` places it. A press brings the host above its siblings.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const key = (id) => `float:${id}`;
const sizeKey = (id) => `float:${id}:size`;
const readPos = (id) => { try { return JSON.parse(localStorage.getItem(key(id)) || 'null'); } catch { return null; } };
const writePos = (id, pos) => { try { localStorage.setItem(key(id), JSON.stringify(pos)); } catch { /* private mode */ } };
const readSize = (id) => { try { return JSON.parse(localStorage.getItem(sizeKey(id)) || 'null'); } catch { return null; } };
const writeSize = (id, s) => { try { localStorage.setItem(sizeKey(id), JSON.stringify(s)); } catch { /* private mode */ } };

const MIN_W = 200;
const MIN_H = 160;
const HEADER = '.panel-head, .cseq-header';
const CONTROL = 'button, input, select, textarea, a, [role="button"], [role="tab"], label, .combo';

export function Floating({ id, open = true, width = 320, defaultPos = { right: 68, top: 60 }, resizable = true, defaultSize = null, children }) {
  const [pos, setPos] = useState(() => readPos(id));
  // A width/height the corner grip pins (persisted); until then the panel is its
  // content size at the `width` given, or the `defaultSize` a panel opens at.
  const [size, setSize] = useState(() => (resizable ? (readSize(id) ?? defaultSize) : null));
  const resizeRef = useRef(null);
  useEffect(() => { if (resizable) writeSize(id, size); }, [id, size, resizable]);
  // The shared window stack (zstack.js), not a private counter: a click here can
  // now raise the panel above the mixer, the sequencer and the modal windows.
  const [z, setZ] = useState(() => nextZ());
  const hostRef = useRef(null);
  const drag = useRef(null);
  useEffect(() => { if (pos) writePos(id, pos); }, [id, pos]);

  // Opened from the side rail (open goes false → true): come to the front, above
  // the mixer, the sequencer and any panel already up. On first mount, and for an
  // always-open panel, wasOpen already matches, so nothing is raised for free.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) setZ(nextZ());
    wasOpen.current = open;
  }, [open]);

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

  // The drag listens on the window for its lifetime rather than trusting pointer
  // capture on the host: the canvas and the modals capture and swallow pointer
  // events of their own, and a stolen capture left a drag dead after one step.
  const onPointerDown = (e) => {
    setZ(nextZ());
    if (e.button !== 0) return;
    const el = hostRef.current;
    // The grab area is the header (between its controls) and the panel's own
    // padding: a press that lands on the panel element itself, not on a child,
    // is in the 12px frame around the content, so every edge drags.
    const header = e.target.closest(HEADER);
    const onFrame = e.target === el || e.target === el?.firstElementChild;
    if (!onFrame && (!header || !el?.contains(header) || e.target.closest(CONTROL))) return;
    const rect = el.getBoundingClientRect();
    if (!pos) setPos({ x: rect.left, y: rect.top });
    const d = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    drag.current = d;
    el.classList.add('dragging');
    e.preventDefault();
    const move = (ev) => {
      if (drag.current !== d) return;
      if (ev.buttons === 0) { end(); return; }   // released somewhere we were not told about
      const w = el.offsetWidth || width;
      const h = el.offsetHeight || 200;
      setPos({
        x: clamp(ev.clientX - d.dx, 0, Math.max(window.innerWidth - w, 0)),
        y: clamp(ev.clientY - d.dy, 0, Math.max(window.innerHeight - Math.min(h, 80), 0)),
      });
    };
    const end = () => {
      if (drag.current === d) drag.current = null;
      el.classList.remove('dragging');
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      window.removeEventListener('blur', end);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
    window.addEventListener('blur', end);
  };

  // Bottom-right corner grip: pins the host's width and height (the panel fills it
  // and its body scrolls — see .float-host.resized > .panel).
  const startResize = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = hostRef.current;
    const rect = el.getBoundingClientRect();
    if (!pos) setPos({ x: rect.left, y: rect.top });
    resizeRef.current = { x0: e.clientX, y0: e.clientY, w0: rect.width, h0: rect.height };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not captured */ }
  };
  const onResizeMove = (e) => {
    const r = resizeRef.current;
    if (!r) return;
    const maxW = Math.max(MIN_W, window.innerWidth - 16);
    const maxH = Math.max(MIN_H, window.innerHeight - 16);
    setSize({
      w: Math.min(maxW, Math.max(MIN_W, Math.round(r.w0 + (e.clientX - r.x0)))),
      h: Math.min(maxH, Math.max(MIN_H, Math.round(r.h0 + (e.clientY - r.y0)))),
    });
  };
  const endResize = () => { resizeRef.current = null; };

  if (!open) return null;
  const style = {
    width: size?.w ?? width,
    zIndex: z,
    ...(size?.h ? { height: size.h } : null),
    ...(pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : defaultPos),
  };
  return (
    <div className={`float-host${size?.h ? ' resized' : ''}`} ref={hostRef} style={style} data-float={id} onPointerDown={onPointerDown}>
      {children}
      {resizable && (
        <div className="float-resize-c" onPointerDown={startResize} onPointerMove={onResizeMove}
          onPointerUp={endResize} onPointerCancel={endResize}
          onDoubleClick={() => setSize(defaultSize)} />
      )}
    </div>
  );
}
