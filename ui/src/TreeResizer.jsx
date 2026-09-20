import { useEffect, useRef, useState } from 'react';

// One drag handle at the right edge of the left panel (#tree). Every left view
// renders the same #tree, so a single global handle sets its width for all of
// them, through the --tree-w custom property. The width is remembered.

const KEY = 'treeWidth';
const MIN = 240;
const MAX = 680;
const DEF = 336;
const clamp = (v) => Math.min(MAX, Math.max(MIN, v));
const read = () => {
  try { const v = Number(JSON.parse(localStorage.getItem(KEY))); return Number.isFinite(v) ? clamp(v) : DEF; } catch { return DEF; }
};

export function TreeResizer() {
  const [w, setW] = useState(read);
  const drag = useRef(null);
  useEffect(() => {
    document.documentElement.style.setProperty('--tree-w', `${w}px`);
    try { localStorage.setItem(KEY, JSON.stringify(w)); } catch { /* quota */ }
  }, [w]);
  const onDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const d = { x0: e.clientX, w0: w };
    drag.current = d;
    const move = (ev) => { if (drag.current === d) setW(clamp(Math.round(d.w0 + (ev.clientX - d.x0)))); };
    const up = () => {
      drag.current = null;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  };
  return <div id="tree-resize" onPointerDown={onDown} title="Drag to resize the panel" />;
}
