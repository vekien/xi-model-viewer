import { useRef } from 'react';

// A bottom-right corner grip to drop into any fixed/absolute modal. It sets the
// target element's inline width/height directly, so a modal gains resize without
// its own size state — it keeps its existing drag/position. The modal's body
// scrolls when the height is pulled below its content (see .modal / .modal-body).
//
// `containerRef` is the panel element; without one it uses the grip's positioned
// parent. Min/max keep it usable and on screen.

export function ResizeCorner({ containerRef, minW = 260, minH = 180 }) {
  const grip = useRef(null);
  const onDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = containerRef?.current ?? grip.current?.offsetParent;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
    try { grip.current?.setPointerCapture?.(e.pointerId); } catch { /* not captured */ }
    const move = (ev) => {
      const maxW = Math.max(minW, window.innerWidth - 16);
      const maxH = Math.max(minH, window.innerHeight - 16);
      el.style.width = `${Math.min(maxW, Math.max(minW, Math.round(start.w + (ev.clientX - start.x))))}px`;
      el.style.height = `${Math.min(maxH, Math.max(minH, Math.round(start.h + (ev.clientY - start.y))))}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  };
  return <div ref={grip} className="modal-resize-c" onPointerDown={onDown} aria-hidden="true" />;
}
