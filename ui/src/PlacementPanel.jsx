import { useEffect, useMemo, useRef, useState } from 'react';
import { Tooltip } from './Tooltip.jsx';

const HEIGHT_KEY = 'plcPanelHeight';
const MIN_H = 160;
const MAX_H = () => Math.max(MIN_H, window.innerHeight - 80);
const DEFAULT_H = 500;

/**
 * Top-right zone objects panel: mesh types + instances, minimizeable, height-resizable.
 */
export function PlacementPanel({ groups, selectedKey, onSelectGroup, onSelectInstance, onClose, showEnv = false }) {
  const [query, setQuery] = useState('');
  const [openMesh, setOpenMesh] = useState(null);
  const [minimized, setMinimized] = useState(false);
  const [height, setHeight] = useState(() => {
    const v = parseInt(localStorage.getItem(HEIGHT_KEY) || '', 10);
    return Number.isFinite(v) ? Math.min(Math.max(v, MIN_H), 900) : DEFAULT_H;
  });
  const drag = useRef(null);

  const visibleGroups = useMemo(() => {
    if (!groups?.length) return [];
    // Env (sky/water) only appear when Toggle Skybox is on.
    return groups.filter((g) => !g.kind || showEnv);
  }, [groups, showEnv]);

  const filtered = useMemo(() => {
    if (!visibleGroups.length) return [];
    const q = query.trim().toLowerCase();
    if (!q) return visibleGroups;
    return visibleGroups
      .map((g) => {
        const label = displayLabel(g);
        const meshHit = g.mesh.toLowerCase().includes(q)
          || g.meshId?.toLowerCase().includes(q)
          || label.toLowerCase().includes(q);
        if (meshHit) return g;
        const instances = g.instances.filter((p) =>
          p.name.toLowerCase().includes(q) || String(p.index).includes(q));
        return instances.length ? { ...g, instances, count: instances.length } : null;
      })
      .filter(Boolean);
  }, [visibleGroups, query]);

  const totalInst = visibleGroups.reduce((n, g) => n + g.count, 0);
  const shownInst = filtered.reduce((n, g) => n + g.count, 0);

  useEffect(() => {
    const onMove = (e) => {
      if (!drag.current) return;
      const next = Math.min(MAX_H(), Math.max(MIN_H, e.clientY - drag.current.top));
      setHeight(next);
    };
    const onUp = () => {
      if (!drag.current) return;
      drag.current = null;
      document.body.classList.remove('plc-resizing');
      setHeight((h) => {
        try { localStorage.setItem(HEIGHT_KEY, String(h)); } catch { /* quota */ }
        return h;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  const startResize = (e) => {
    if (minimized) return;
    e.preventDefault();
    const panel = e.currentTarget.parentElement;
    const top = panel.getBoundingClientRect().top;
    drag.current = { top };
    document.body.classList.add('plc-resizing');
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  return (
    <div
      id="placements"
      className={`panel${minimized ? ' minimized' : ''}`}
      style={minimized ? undefined : { height }}
    >
      <div className="plc-header">
        <span className="icon">lists</span>
        <span className="plc-title">Objects</span>
        <span className="plc-meta mono">{totalInst.toLocaleString()}</span>
        <Tooltip content={minimized ? 'Restore' : 'Minimize'}>
          <button
            className="icon-btn plc-tool"
            onClick={() => setMinimized((v) => !v)}
          >
            <span className="icon">{minimized ? 'open_in_full' : 'remove'}</span>
          </button>
        </Tooltip>
        {onClose && (
          <Tooltip content="Close">
            <button className="icon-btn plc-tool" onClick={onClose}>
              <span className="icon">close</span>
            </button>
          </Tooltip>
        )}
      </div>

      {!minimized && (
        <>
          <div className="plc-search">
            <span className="icon">search</span>
            <input
              type="search"
              placeholder="Filter mesh or instance…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
            />
          </div>

          <div className="plc-body">
            {!groups && <div className="side-note">No zone loaded.</div>}
            {groups && groups.length === 0 && <div className="side-note">No placements.</div>}
            {groups && groups.length > 0 && filtered.length === 0 && (
              <div className="side-note">No matches for “{query}”.</div>
            )}

            {filtered.map((g) => {
              const isOpen = openMesh === g.mesh || (!!query && g.instances.length <= 40);
              const groupSel = selectedKey === `mesh:${g.mesh}`;
              const envClass = g.kind === 'water' ? ' env-water' : g.kind === 'sky' ? ' env-sky' : '';
              return (
                <div key={`${g.kind || 'w'}:${g.mesh}`} className={`plc-group${isOpen ? ' open' : ''}${groupSel ? ' selected' : ''}${envClass}`}>
                  <div
                    className="plc-row plc-mesh"
                    onClick={() => {
                      setOpenMesh(isOpen && openMesh === g.mesh ? null : g.mesh);
                      onSelectGroup?.(g);
                    }}
                    title={`${displayLabel(g)} — ${g.count} instance${g.count === 1 ? '' : 's'}`}
                  >
                    <span className="caret icon">chevron_right</span>
                    <span className="kind icon">{g.kind === 'water' ? 'water' : g.kind === 'sky' ? 'cloud' : 'deployed_code'}</span>
                    <span className="plc-name">{displayLabel(g)}</span>
                    <span className="badge">{g.count}</span>
                  </div>
                  {isOpen && (
                    <div className="plc-instances">
                      {g.instances.map((p) => {
                        const sel = selectedKey === `inst:${p.name}`;
                        return (
                          <div
                            key={p.name}
                            className={`plc-row plc-inst${sel ? ' selected' : ''}`}
                            onClick={(e) => { e.stopPropagation(); onSelectInstance?.(p); }}
                            title={`#${p.index}  pos ${fmt3(p.rawPos)}`}
                          >
                            <span className="caret icon" />
                            <span className="kind icon">place</span>
                            <span className="plc-name">{p.name}</span>
                            <span className="mono-small plc-idx">{p.index}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {visibleGroups.length > 0 && (
            <div className="plc-footer side-note">
              {query
                ? `${filtered.length} types · ${shownInst.toLocaleString()} / ${totalInst.toLocaleString()}`
                : `${visibleGroups.length} types · ${totalInst.toLocaleString()} placements`}
            </div>
          )}

          <div
            className="plc-resize"
            onPointerDown={startResize}
            title="Drag to resize"
          />
        </>
      )}
    </div>
  );
}

function fmt3(v) {
  if (!v) return '';
  return v.map((n) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1))).join(', ');
}

function displayLabel(g) {
  if (g.kind === 'water') return `(WATER) ${g.mesh}`;
  if (g.kind === 'sky') return `(SKYBOX) ${g.mesh}`;
  return g.mesh;
}
