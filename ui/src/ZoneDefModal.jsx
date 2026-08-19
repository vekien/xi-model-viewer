import { useMemo, useRef, useState } from 'react';
import { Button } from '@headlessui/react';

const fmt3 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');

/** Draggable floating table of 0x1C ZoneDef placements (mesh id, pose, scale). */
export function ZoneDefModal({
  placements = [], title = 'ZoneDef', loading = false, error = '',
  onClose, onFocus, cascadeOffset = 0, zIndex = 2000,
}) {
  const panelRef = useRef(null);
  const dragState = useRef(null);
  const [pos, setPos] = useState(null);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const list = Array.isArray(placements) ? placements : [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((p) => {
      const hay = `${p.index} ${p.meshId || ''} ${p.fileIdLink ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [placements, query]);

  const total = Array.isArray(placements) ? placements.length : 0;

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

  const cascade = cascadeOffset * 28;
  const style = pos
    ? { left: pos.x, top: pos.y, transform: 'none', zIndex }
    : {
      left: `calc(50% + ${cascade}px)`,
      top: `calc(42% + ${cascade}px)`,
      transform: 'translate(-50%, -50%)',
      zIndex,
    };

  return (
    <div className="zdef-modal" ref={panelRef} style={style} onPointerDown={onFocus}>
      <div
        className="modal-header"
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
      >
        <span className="icon">map</span>
        <span className="modal-title mono">{title}</span>
        <span className="zdef-count mono">
          {loading ? 'loading…'
            : filtered.length === total
              ? `${total.toLocaleString()} placements`
              : `${filtered.length.toLocaleString()} / ${total.toLocaleString()}`}
        </span>
        <Button className="icon-btn modal-close" onClick={onClose} title="Close">
          <span className="icon">close</span>
        </Button>
      </div>
      <div className="zdef-search">
        <span className="icon">search</span>
        <input
          className="list-search"
          type="search"
          placeholder="Filter mesh id, index…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button type="button" className="list-search-clear" onClick={() => setQuery('')} title="Clear">
            <span className="icon">close</span>
          </button>
        )}
      </div>
      <div className="zdef-table-wrap">
        <table className="zdef-table">
          <thead>
            <tr>
              <th className="mono">#</th>
              <th>Mesh</th>
              <th className="mono">Position</th>
              <th className="mono">Rotation</th>
              <th className="mono">Scale</th>
              <th className="mono">Link</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="zdef-empty">Reading placements…</td>
              </tr>
            )}
            {!loading && error && (
              <tr>
                <td colSpan={6} className="zdef-empty">{error}</td>
              </tr>
            )}
            {!loading && !error && filtered.map((p) => (
              <tr key={p.index} className={p.pos?.[1] <= -90000 ? 'zdef-hidden' : undefined}>
                <td className="mono">{p.index}</td>
                <td className="mono zdef-mesh">{p.meshId || '—'}</td>
                <td className="mono zdef-vec">
                  {fmt3(p.pos?.[0])}, {fmt3(p.pos?.[1])}, {fmt3(p.pos?.[2])}
                </td>
                <td className="mono zdef-vec">
                  {fmt3(p.rot?.[0])}, {fmt3(p.rot?.[1])}, {fmt3(p.rot?.[2])}
                </td>
                <td className="mono zdef-vec">
                  {fmt3(p.scale?.[0])}, {fmt3(p.scale?.[1])}, {fmt3(p.scale?.[2])}
                </td>
                <td className="mono">
                  {p.fileIdLink != null ? p.fileIdLink : '—'}
                </td>
              </tr>
            ))}
            {!loading && !error && filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="zdef-empty">
                  {query ? `No placements match “${query}”.` : 'No placements.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function clamp(p, panel) {
  const w = panel?.offsetWidth ?? 720;
  const h = panel?.offsetHeight ?? 420;
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}
