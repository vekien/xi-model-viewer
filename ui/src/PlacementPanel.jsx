import { useEffect, useMemo, useRef, useState } from 'react';
import { Tooltip } from './Tooltip.jsx';

const HEIGHT_KEY = 'plcPanelHeight';
const TAB_KEY = 'plcObjectsTab';
const MIN_H = 160;
const MAX_H = () => Math.max(MIN_H, window.innerHeight - 80);
const DEFAULT_H = 500;

/**
 * Top-right zone objects panel: Static Mesh + Visual Effects tabs,
 * minimizeable, height-resizable. Live Selection from the header.
 */
export function PlacementPanel({
  groups, selectedKey, onSelectGroup, onSelectInstance, onClose, showEnv = false,
  liveSelection = false, onToggleLiveSelection, onResetPlacement, isPlacementMoved,
  isPlacementHidden, onTogglePlacementVisible, onToggleGroupVisible, hiddenTick = 0,
  effectGroups = null, onToggleEffectVisible, onToggleEffectGroupVisible,
  onSelectEffect, onSelectEffectGroup, vfxHiddenTick = 0,
}) {
  const [tab, setTab] = useState(() => {
    try {
      const v = localStorage.getItem(TAB_KEY);
      return v === 'vfx' ? 'vfx' : 'mesh';
    } catch { return 'mesh'; }
  });
  const [query, setQuery] = useState('');
  const [openMesh, setOpenMesh] = useState(null);
  const [minimized, setMinimized] = useState(false);
  const [height, setHeight] = useState(() => {
    const v = parseInt(localStorage.getItem(HEIGHT_KEY) || '', 10);
    return Number.isFinite(v) ? Math.min(Math.max(v, MIN_H), 900) : DEFAULT_H;
  });
  const drag = useRef(null);
  const selectedRef = useRef(null);

  const setTabPersist = (next) => {
    setTab(next);
    try { localStorage.setItem(TAB_KEY, next); } catch { /* quota */ }
  };

  const meshGroups = useMemo(() => {
    if (!groups?.length) return [];
    // Env (sky/water) only when Toggle Skybox is on. Unplaced always listed.
    return groups.filter((g) => !g.kind || g.kind === 'unplaced' || showEnv);
  }, [groups, showEnv]);

  const vfxGroups = useMemo(() => effectGroups ?? [], [effectGroups, vfxHiddenTick]);

  const activeGroups = tab === 'vfx' ? vfxGroups : meshGroups;

  const filtered = useMemo(() => {
    if (!activeGroups.length) return [];
    const q = query.trim().toLowerCase();
    if (!q) return activeGroups;
    return activeGroups
      .map((g) => {
        const label = tab === 'vfx' ? vfxLabel(g) : displayLabel(g);
        const name = g.mesh || g.name || '';
        const meshHit = name.toLowerCase().includes(q)
          || g.meshId?.toLowerCase().includes(q)
          || label.toLowerCase().includes(q);
        if (meshHit) return g;
        const instances = (g.instances || []).filter((p) =>
          String(p.name || '').toLowerCase().includes(q)
          || String(p.id || '').toLowerCase().includes(q)
          || String(p.index ?? '').includes(q));
        return instances.length ? { ...g, instances, count: instances.length } : null;
      })
      .filter(Boolean);
  }, [activeGroups, query, tab]);

  // Viewport / external selection: clear filter, expand group, un-minimize, scroll.
  useEffect(() => {
    if (!selectedKey || !groups?.length) return;
    if (tab !== 'mesh') return;
    setQuery('');
    setMinimized(false);
    if (selectedKey.startsWith('mesh:')) {
      setOpenMesh(selectedKey.slice(5));
    } else if (selectedKey.startsWith('inst:')) {
      const name = selectedKey.slice(5);
      const g = groups.find((x) => x.instances?.some((p) => p.name === name));
      if (g) setOpenMesh(g.mesh);
    }
  }, [selectedKey, groups, tab]);

  useEffect(() => {
    if (!selectedKey || tab !== 'mesh') return undefined;
    let nested = 0;
    const id = requestAnimationFrame(() => {
      nested = requestAnimationFrame(() => {
        selectedRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
      });
    });
    return () => {
      cancelAnimationFrame(id);
      if (nested) cancelAnimationFrame(nested);
    };
  }, [selectedKey, openMesh, query, minimized, tab]);

  const totalInst = activeGroups.reduce((n, g) => n + (g.count ?? g.instances?.length ?? 0), 0);
  const shownInst = filtered.reduce((n, g) => n + (g.count ?? g.instances?.length ?? 0), 0);

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

  void hiddenTick;
  void vfxHiddenTick;

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
        {typeof onToggleLiveSelection === 'function' && tab === 'mesh' && (
          <Tooltip content={liveSelection
            ? 'Live Selection on — hover wireframe, click to select'
            : 'Live Selection — hover wireframe, click to select'}>
            <button
              type="button"
              className={`icon-btn plc-tool${liveSelection ? ' on' : ''}`}
              aria-pressed={liveSelection}
              aria-label="Live Selection"
              onClick={onToggleLiveSelection}
            >
              <span className="icon">arrow_selector_tool</span>
            </button>
          </Tooltip>
        )}
        <Tooltip content={minimized ? 'Restore' : 'Minimize'}>
          <button
            type="button"
            className="icon-btn plc-tool"
            onClick={() => setMinimized((v) => !v)}
          >
            <span className="icon">{minimized ? 'open_in_full' : 'remove'}</span>
          </button>
        </Tooltip>
        {onClose && (
          <Tooltip content="Close">
            <button type="button" className="icon-btn plc-tool" onClick={onClose}>
              <span className="icon">close</span>
            </button>
          </Tooltip>
        )}
      </div>

      {!minimized && (
        <>
          <div className="plc-tabs" role="tablist" aria-label="Object kind">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'mesh'}
              className={`plc-tab${tab === 'mesh' ? ' active' : ''}`}
              onClick={() => { setTabPersist('mesh'); setQuery(''); setOpenMesh(null); }}
            >
              <span className="icon">deployed_code</span>
              Static Mesh
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'vfx'}
              className={`plc-tab${tab === 'vfx' ? ' active' : ''}`}
              onClick={() => { setTabPersist('vfx'); setQuery(''); setOpenMesh(null); }}
            >
              <span className="icon">auto_awesome</span>
              Visual Effects
            </button>
          </div>

          <div className="plc-search">
            <span className="icon">search</span>
            <input
              type="search"
              placeholder={tab === 'vfx' ? 'Filter effect…' : 'Filter mesh or instance…'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
            />
          </div>

          <div className="plc-body">
            {tab === 'mesh' && (
              <>
                {!groups && <div className="side-note">No zone loaded.</div>}
                {groups && groups.length === 0 && <div className="side-note">No placements.</div>}
                {groups && groups.length > 0 && filtered.length === 0 && (
                  <div className="side-note">No matches for “{query}”.</div>
                )}
                {filtered.map((g) => renderMeshGroup(g, {
                  openMesh, setOpenMesh, query, selectedKey, selectedRef,
                  onSelectGroup, onSelectInstance, isPlacementMoved, isPlacementHidden,
                  onToggleGroupVisible, onTogglePlacementVisible, onResetPlacement,
                }))}
              </>
            )}

            {tab === 'vfx' && (
              <>
                {!effectGroups && <div className="side-note">No effects loaded.</div>}
                {effectGroups && effectGroups.length === 0 && (
                  <div className="side-note">No visual effects in this zone.</div>
                )}
                {effectGroups && effectGroups.length > 0 && filtered.length === 0 && (
                  <div className="side-note">No matches for “{query}”.</div>
                )}
                {filtered.map((g) => renderVfxGroup(g, {
                  openMesh, setOpenMesh, query, selectedRef,
                  onSelectEffectGroup, onSelectEffect,
                  onToggleEffectGroupVisible, onToggleEffectVisible,
                }))}
              </>
            )}
          </div>

          {activeGroups.length > 0 && (
            <div className="plc-footer side-note">
              {query
                ? `${filtered.length} types · ${shownInst.toLocaleString()} / ${totalInst.toLocaleString()}`
                : tab === 'vfx'
                  ? `${activeGroups.length} types · ${totalInst.toLocaleString()} effects`
                  : `${activeGroups.length} types · ${totalInst.toLocaleString()} placements`}
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

function renderMeshGroup(g, ctx) {
  const {
    openMesh, setOpenMesh, query, selectedKey, selectedRef,
    onSelectGroup, onSelectInstance, isPlacementMoved, isPlacementHidden,
    onToggleGroupVisible, onTogglePlacementVisible, onResetPlacement,
  } = ctx;
  const isOpen = openMesh === g.mesh || (!!query && g.instances.length <= 40);
  const groupSel = selectedKey === `mesh:${g.mesh}`;
  const envClass = g.kind === 'water' ? ' env-water'
    : g.kind === 'sky' ? ' env-sky'
      : g.kind === 'unplaced' ? ' env-unplaced' : '';
  const hidN = g.instances.reduce((n, p) => n + (isPlacementHidden?.(p) || p.userHidden ? 1 : 0), 0);
  const groupVis = hidN === 0 ? 'on' : hidN === g.instances.length ? 'off' : 'mixed';
  return (
    <div key={`${g.kind || 'w'}:${g.mesh}`} className={`plc-group${isOpen ? ' open' : ''}${groupSel ? ' selected' : ''}${envClass}${groupVis === 'off' ? ' vis-off' : ''}`}>
      <div
        ref={groupSel ? selectedRef : undefined}
        className="plc-row plc-mesh"
        onClick={() => {
          setOpenMesh(isOpen && openMesh === g.mesh ? null : g.mesh);
          onSelectGroup?.(g);
        }}
      >
        <span className="caret icon">chevron_right</span>
        {typeof onToggleGroupVisible === 'function' && (
          <VisBtn
            state={groupVis}
            showLabel="Show group"
            hideLabel="Hide group"
            onClick={() => onToggleGroupVisible(g)}
          />
        )}
        <span className="kind icon">{g.kind === 'water' ? 'water' : g.kind === 'sky' ? 'cloud' : g.kind === 'unplaced' ? 'location_off' : 'deployed_code'}</span>
        <span className="plc-name">{displayLabel(g)}</span>
        <span className="badge">{g.count}</span>
      </div>
      {isOpen && (
        <div className="plc-instances">
          {g.instances.map((p) => {
            const sel = selectedKey === `inst:${p.name}`;
            const moved = !!isPlacementMoved?.(p);
            const hidden = !!(isPlacementHidden?.(p) || p.userHidden);
            return (
              <div
                key={p.name}
                ref={sel ? selectedRef : undefined}
                className={`plc-row plc-inst${sel ? ' selected' : ''}${moved ? ' moved' : ''}${hidden ? ' vis-off' : ''}`}
                onClick={(e) => { e.stopPropagation(); onSelectInstance?.(p); }}
                title={`#${p.index}  pos ${fmt3(p.rawPos)}${moved ? ' · moved' : ''}${hidden ? ' · hidden' : ''}`}
              >
                <span className="caret icon" />
                {typeof onTogglePlacementVisible === 'function' && (
                  <VisBtn
                    state={hidden ? 'off' : 'on'}
                    showLabel="Show object"
                    hideLabel="Hide object"
                    onClick={() => onTogglePlacementVisible(p)}
                  />
                )}
                <span className="kind icon">place</span>
                <span className="plc-name">{p.name}</span>
                {moved && typeof onResetPlacement === 'function' && (
                  <Tooltip content="Reset object placement">
                    <button
                      type="button"
                      className="icon-btn plc-reset"
                      onClick={(e) => {
                        e.stopPropagation();
                        onResetPlacement(p);
                      }}
                    >
                      <span className="icon">restart_alt</span>
                    </button>
                  </Tooltip>
                )}
                <span className="mono-small plc-idx">{p.index}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function renderVfxGroup(g, ctx) {
  const {
    openMesh, setOpenMesh, query, selectedRef,
    onSelectEffectGroup, onSelectEffect,
    onToggleEffectGroupVisible, onToggleEffectVisible,
  } = ctx;
  const openKey = `vfx:${g.name}`;
  const isOpen = openMesh === openKey || (!!query && g.instances.length <= 40);
  const hidN = g.instances.reduce((n, p) => n + (p.userHidden || p.hidden ? 1 : 0), 0);
  const groupVis = hidN === 0 ? 'on' : hidN === g.instances.length ? 'off' : 'mixed';
  return (
    <div key={`vfx:${g.kind || 'z'}:${g.name}`} className={`plc-group${isOpen ? ' open' : ''}${groupVis === 'off' ? ' vis-off' : ''}${g.kind === 'weather' ? ' env-weather' : ''}`}>
      <div
        className="plc-row plc-mesh"
        onClick={() => {
          setOpenMesh(isOpen && openMesh === openKey ? null : openKey);
          onSelectEffectGroup?.(g);
        }}
      >
        <span className="caret icon">chevron_right</span>
        {typeof onToggleEffectGroupVisible === 'function' && (
          <VisBtn
            state={groupVis}
            showLabel="Show effects"
            hideLabel="Hide effects"
            onClick={() => onToggleEffectGroupVisible(g)}
          />
        )}
        <span className="kind icon">{g.kind === 'weather' ? 'cloud' : 'auto_awesome'}</span>
        <span className="plc-name">{vfxLabel(g)}</span>
        <span className="badge">{g.count}</span>
      </div>
      {isOpen && (
        <div className="plc-instances">
          {g.instances.map((p) => {
            const hidden = !!(p.userHidden || p.hidden);
            return (
              <div
                key={p.key || p.name}
                ref={undefined}
                className={`plc-row plc-inst${hidden ? ' vis-off' : ''}`}
                onClick={(e) => { e.stopPropagation(); onSelectEffect?.(p); }}
                title={`${p.id || ''}  pos ${fmt3(p.rawPos || p.pos)}${p.weatherId ? ` · ${p.weatherId}` : ''}${hidden ? ' · hidden' : ''}`}
              >
                <span className="caret icon" />
                {typeof onToggleEffectVisible === 'function' && (
                  <VisBtn
                    state={hidden ? 'off' : 'on'}
                    showLabel="Show effect"
                    hideLabel="Hide effect"
                    onClick={() => onToggleEffectVisible(p)}
                  />
                )}
                <span className="kind icon">bolt</span>
                <span className="plc-name">{p.name}</span>
                {p.weatherId && <span className="mono-small plc-idx">{p.weatherId}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function VisBtn({ state, showLabel, hideLabel, onClick }) {
  const off = state === 'off';
  const mixed = state === 'mixed';
  const label = off ? showLabel : hideLabel;
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className={`icon-btn plc-vis${off ? ' off' : ''}${mixed ? ' mixed' : ''}`}
        aria-label={label}
        aria-pressed={!off}
        onClick={(e) => {
          e.stopPropagation();
          onClick?.();
        }}
      >
        <span className="icon">{off ? 'visibility_off' : 'visibility'}</span>
      </button>
    </Tooltip>
  );
}

function fmt3(v) {
  if (!v) return '';
  return v.map((n) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1))).join(', ');
}

function displayLabel(g) {
  if (g.kind === 'water') return `(WATER) ${g.mesh}`;
  if (g.kind === 'sky') return `(SKYBOX) ${g.mesh}`;
  if (g.kind === 'unplaced') return `(UNPLACED) ${g.mesh}`;
  return g.mesh;
}

function vfxLabel(g) {
  if (g.kind === 'weather') return `(WEATHER) ${g.name}`;
  return g.name;
}
