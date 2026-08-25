import { useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { routeFocalToFov } from '../js/dat/inspect.js';

const fmt = (v, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : '—');
const fmt3 = (v) => v?.map((x) => fmt(x)).join(', ') ?? '—';

/** Draggable floating table of 0x06 Route camera keyframes. */
export function RouteModal({ route, title = 'Route', onClose, onFocus, zIndex = 2100 }) {
  const panelRef = useRef(null);
  const dragState = useRef(null);
  const [pos, setPos] = useState(null);

  if (!route) return null;
  const keys = route.keys ?? [];
  const n = keys.length;
  const meta = n === 1
    ? `still · ${route.modeName || `mode ${route.mode}`}`
    : `${n} keys · ${route.modeName || `mode ${route.mode}`}`;

  const startDrag = (e) => {
    onFocus?.();
    if (e.target.closest('button, input, a, [role="button"]')) return;
    const rect = panelRef.current.getBoundingClientRect();
    dragState.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDrag = (e) => {
    if (!dragState.current) return;
    setPos(clamp({
      x: e.clientX - dragState.current.dx,
      y: e.clientY - dragState.current.dy,
    }, panelRef.current));
  };
  const endDrag = () => { dragState.current = null; };

  const style = pos
    ? {
      position: 'fixed', left: pos.x, top: pos.y, transform: 'none', zIndex,
      width: 'min(720px, 94vw)', maxHeight: 'min(72vh, 560px)',
    }
    : {
      position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex,
      width: 'min(720px, 94vw)', maxHeight: 'min(72vh, 560px)',
    };

  return (
    <div className="zdef-modal route-modal" ref={panelRef} style={style} onPointerDown={onFocus}>
      <div
        className="modal-header"
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
      >
        <span className="icon">alt_route</span>
        <span className="modal-title mono">{title}</span>
        <span className="route-count mono">{meta}</span>
        <Button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="Close">
          <span className="icon">close</span>
        </Button>
      </div>
      <div className="zdef-table-wrap">
        <table className="zdef-table">
          <thead>
            <tr>
              <th className="mono">#</th>
              <th className="mono">t</th>
              <th className="mono">Eye</th>
              <th className="mono">Look-at</th>
              <th className="mono">Focal</th>
              <th className="mono">FOV</th>
              <th className="mono">Roll</th>
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 && (
              <tr>
                <td colSpan={7} className="zdef-empty">No keyframes</td>
              </tr>
            )}
            {keys.map((k, i) => {
              const fov = routeFocalToFov(k.focal);
              return (
                <tr key={i}>
                  <td className="mono">{i}</td>
                  <td className="mono">{fmt(k.time, 3)}</td>
                  <td className="mono zdef-vec">{fmt3(k.eye)}</td>
                  <td className="mono zdef-vec">{fmt3(k.look)}</td>
                  <td className="mono">{fmt(k.focal, 1)}</td>
                  <td className="mono">{fov != null ? `${fov.toFixed(1)}°` : '—'}</td>
                  <td className="mono">{fmt(k.roll, 3)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function clamp(p, panel) {
  const w = panel?.offsetWidth ?? 480;
  const h = panel?.offsetHeight ?? 320;
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}
