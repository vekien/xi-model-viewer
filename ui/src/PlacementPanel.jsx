import { useEffect, useMemo, useRef, useState } from 'react';
import { Tooltip } from './Tooltip.jsx';

const HEIGHT_KEY = 'plcPanelHeight';
const TAB_KEY = 'plcObjectsTab';
const MIN_H = 160;
const MAX_H = () => Math.max(MIN_H, window.innerHeight - 80);
const DEFAULT_H = 500;

/**
 * Top-right zone objects panel: Static Mesh / VFX / SFX tabs,
 * height-resizable. Live Selection from the header.
 */
export function PlacementPanel({
  groups, selectedKey, onSelectGroup, onSelectInstance, onClose, showEnv = false,
  liveSelection = false, onToggleLiveSelection, onResetPlacement, isPlacementMoved,
  isPlacementHidden, onTogglePlacementVisible, onToggleGroupVisible, hiddenTick = 0,
  effectGroups = null, onToggleEffectVisible, onToggleEffectGroupVisible,
  onSelectEffect, onSelectEffectGroup, vfxHiddenTick = 0,
  soundGroups = null, sfxListTick = 0, onRefreshSoundGroups,
  onSelectSound, onSelectSoundGroup, onPlaySound, playingSoundKey = null,
}) {
  const [tab, setTab] = useState(() => {
    try {
      const v = localStorage.getItem(TAB_KEY);
      if (v === 'vfx' || v === 'sfx' || v === 'mesh') return v;
      return 'mesh';
    } catch { return 'mesh'; }
  });
  const [query, setQuery] = useState('');
  const [openMesh, setOpenMesh] = useState(null);
  const [sfxNames, setSfxNames] = useState(() => new Map());
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('lists/sfx.json');
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setSfxNames(new Map(Object.entries(data.names ?? {})));
      } catch { /* optional */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Live SFX sources move (path snap) and spawn with weather — refresh while tab open.
  useEffect(() => {
    if (tab !== 'sfx' || typeof onRefreshSoundGroups !== 'function') return undefined;
    onRefreshSoundGroups();
    const id = setInterval(() => onRefreshSoundGroups(), 1500);
    return () => clearInterval(id);
  }, [tab, onRefreshSoundGroups]);

  const meshGroups = useMemo(() => {
    if (!groups?.length) return [];
    // Env (sky/water) only when Toggle Skybox is on. Unplaced and collision
    // proxies are always listed (both default to hidden via their row eye).
    const list = groups.filter((g) => !g.kind || g.kind === 'unplaced' || g.kind === 'collision' || g.kind === 'subarea' || showEnv);
    // World first, then Sky / Water / Collision / Sub areas / Unplaced.
    return list.slice().sort((a, b) => {
      const ka = MESH_KIND_ORDER[a.kind || 'world'] ?? 99;
      const kb = MESH_KIND_ORDER[b.kind || 'world'] ?? 99;
      if (ka !== kb) return ka - kb;
      return String(a.mesh || a.name || '').localeCompare(String(b.mesh || b.name || ''));
    });
  }, [groups, showEnv]);

  // The *Tick props are re-render triggers, not data: rows read visibility
  // state inline, so a bumped tick has to reach them as a plain prop change.
  // They used to sit in these dep arrays, which did nothing — the memo
  // recomputed and handed back the identical array reference, so every
  // downstream memo keyed on it saw no change and the tick died here.
  const vfxGroups = useMemo(() => effectGroups ?? [], [effectGroups]);
  const sfxGroups = useMemo(() => soundGroups ?? [], [soundGroups]);

  const activeGroups = tab === 'vfx' ? vfxGroups : tab === 'sfx' ? sfxGroups : meshGroups;

  const filtered = useMemo(() => {
    if (!activeGroups.length) return [];
    const q = query.trim().toLowerCase();
    if (!q) return activeGroups;
    const kindOnly = kindSearchMatch(q);
    return activeGroups
      .map((g) => {
        if (kindOnly && !kindOnly(g)) return null;
        if (kindOnly) return g; // pure kind filter — keep full group
        const label = tab === 'vfx' ? vfxLabel(g)
          : tab === 'sfx' ? sfxLabel(g, sfxNames)
            : displayLabel(g);
        const name = g.mesh || g.name || '';
        const sid = g.soundId != null ? String(g.soundId) : '';
        const kindHit = groupKindTokens(g).some((t) => t.includes(q) || q.includes(t));
        const meshHit = kindHit
          || name.toLowerCase().includes(q)
          || g.meshId?.toLowerCase().includes(q)
          || label.toLowerCase().includes(q)
          || sid.includes(q)
          || (sid && `se${sid.padStart(6, '0')}`.includes(q));
        if (meshHit) return g;
        const instances = (g.instances || []).filter((p) =>
          String(p.name || '').toLowerCase().includes(q)
          || String(p.id || '').toLowerCase().includes(q)
          || String(p.soundId ?? '').includes(q)
          || String(p.index ?? '').includes(q));
        return instances.length ? { ...g, instances, count: instances.length } : null;
      })
      .filter(Boolean);
  }, [activeGroups, query, tab, sfxNames]);

  /** Mesh tab: fold into labeled sections (Sky, Collision, …). */
  const meshSections = useMemo(() => {
    if (tab !== 'mesh') return null;
    const sections = [];
    let cur = null;
    for (const g of filtered) {
      const key = g.kind || 'world';
      if (!cur || cur.key !== key) {
        cur = {
          key,
          title: MESH_SECTION_TITLE[key] || null,
          groups: [],
        };
        sections.push(cur);
      }
      cur.groups.push(g);
    }
    return sections;
  }, [filtered, tab]);

  // Viewport / external selection: clear filter, expand group, un-minimize, scroll.
  useEffect(() => {
    if (!selectedKey || !groups?.length) return;
    if (tab !== 'mesh') return;
    setQuery('');
    if (selectedKey.startsWith('mesh:')) {
      const mesh = selectedKey.slice(5);
      const g = groups.find((x) => x.mesh === mesh);
      setOpenMesh(g ? `${g.kind || 'w'}:${g.mesh}` : mesh);
    } else if (selectedKey.startsWith('inst:')) {
      const name = selectedKey.slice(5);
      const g = groups.find((x) => x.instances?.some((p) => p.name === name));
      if (g) setOpenMesh(`${g.kind || 'w'}:${g.mesh}`);
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
  }, [selectedKey, openMesh, query, tab]);

  const totalInst = activeGroups.reduce((n, g) => n + (g.count ?? g.instances?.length ?? 0), 0);

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
      className="panel"
      style={{ height }}
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
        {onClose && (
          <Tooltip content="Close">
            <button type="button" className="icon-btn plc-tool" onClick={onClose}>
              <span className="icon">close</span>
            </button>
          </Tooltip>
        )}
      </div>

      <>
          <div className="seg-tabs" role="tablist" aria-label="Object kind">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'mesh'}
              className={`seg-tab${tab === 'mesh' ? ' on' : ''}`}
              onClick={() => { setTabPersist('mesh'); setQuery(''); setOpenMesh(null); }}
            >
              <span className="icon">deployed_code</span>
              Meshes
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'vfx'}
              className={`seg-tab${tab === 'vfx' ? ' on' : ''}`}
              onClick={() => { setTabPersist('vfx'); setQuery(''); setOpenMesh(null); }}
            >
              <span className="icon">auto_awesome</span>
              VFX
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'sfx'}
              className={`seg-tab${tab === 'sfx' ? ' on' : ''}`}
              onClick={() => { setTabPersist('sfx'); setQuery(''); setOpenMesh(null); }}
            >
              <span className="icon">graphic_eq</span>
              SFX
            </button>
          </div>

          <div className="list-search-wrap plc-search">
            <input
              type="text"
              className="list-search"
              placeholder={
                tab === 'vfx' ? 'Search VFX…'
                  : tab === 'sfx' ? 'Search SFX…'
                    : 'Search objects…'
              }
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
            />
          </div>

          <div className="plc-list-shell">
            <div className="plc-body">
              {tab === 'mesh' && (
                <>
                  {!groups && <div className="side-note">No zone loaded.</div>}
                  {groups && groups.length === 0 && <div className="side-note">No placements.</div>}
                  {groups && groups.length > 0 && filtered.length === 0 && (
                    <div className="side-note">No matches for “{query}”.</div>
                  )}
                  {(meshSections || []).map((sec) => (
                    <div key={sec.key} className={`plc-section plc-sec-${sec.key}`}>
                      {sec.title && (
                        <div className="plc-section-title">
                          <span className="icon">{MESH_SECTION_ICON[sec.key] || 'deployed_code'}</span>
                          {sec.title}
                          <span className="plc-section-count mono">
                            {sec.groups.reduce((n, g) => n + (g.count ?? g.instances?.length ?? 0), 0)}
                          </span>
                        </div>
                      )}
                      {sec.groups.map((g) => renderMeshGroup(g, {
                        openMesh, setOpenMesh, query, selectedKey, selectedRef,
                        onSelectGroup, onSelectInstance, isPlacementMoved, isPlacementHidden,
                        onToggleGroupVisible, onTogglePlacementVisible, onResetPlacement,
                        hideKindPrefix: !!sec.title && sec.key !== 'world',
                      }))}
                    </div>
                  ))}
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

              {tab === 'sfx' && (
                <>
                  {!soundGroups && <div className="side-note">No zone loaded.</div>}
                  {soundGroups && soundGroups.length === 0 && (
                    <div className="side-note">No positional SFX in this zone.</div>
                  )}
                  {soundGroups && soundGroups.length > 0 && filtered.length === 0 && (
                    <div className="side-note">No matches for “{query}”.</div>
                  )}
                  {filtered.map((g) => renderSfxGroup(g, {
                    openMesh, setOpenMesh, query, selectedKey, selectedRef,
                    sfxNames, onSelectSoundGroup, onSelectSound, onPlaySound, playingSoundKey,
                  }))}
                </>
              )}
            </div>
          </div>

          <Tooltip content="Drag to resize">
            <div
              className="plc-resize"
              onPointerDown={startResize}
            />
          </Tooltip>
      </>

    </div>
  );
}

function renderMeshGroup(g, ctx) {
  const {
    openMesh, setOpenMesh, query, selectedKey, selectedRef,
    onSelectGroup, onSelectInstance, isPlacementMoved, isPlacementHidden,
    onToggleGroupVisible, onTogglePlacementVisible, onResetPlacement,
    hideKindPrefix = false,
  } = ctx;
  const openKey = `${g.kind || 'w'}:${g.mesh}`;
  const isOpen = openMesh === openKey || openMesh === g.mesh
    || (!!query && g.instances.length <= 40);
  const groupSel = selectedKey === `mesh:${g.mesh}`;
  const envClass = g.kind === 'water' ? ' env-water'
    : g.kind === 'sky' ? ' env-sky'
      : g.kind === 'unplaced' ? ' env-unplaced'
        : g.kind === 'collision' ? ' env-collision'
          : g.kind === 'subarea' ? ' env-subarea' : '';
  const hidN = g.instances.reduce((n, p) => n + (isPlacementHidden?.(p) || p.userHidden ? 1 : 0), 0);
  const groupVis = hidN === 0 ? 'on' : hidN === g.instances.length ? 'off' : 'mixed';
  return (
    <div key={openKey} className={`plc-group${isOpen ? ' open' : ''}${groupSel ? ' selected' : ''}${envClass}${groupVis === 'off' ? ' vis-off' : ''}`}>
      <div
        ref={groupSel ? selectedRef : undefined}
        className="plc-row plc-mesh"
        onClick={() => {
          setOpenMesh(isOpen && openMesh === openKey ? null : openKey);
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
        <span className="kind icon">{g.kind === 'water' ? 'water' : g.kind === 'sky' ? 'cloud' : g.kind === 'unplaced' ? 'location_off' : g.kind === 'collision' ? 'block' : g.kind === 'subarea' ? 'meeting_room' : 'deployed_code'}</span>
        <span className="plc-name">{displayLabel(g, hideKindPrefix)}</span>
        <span className="badge">{g.count}</span>
      </div>
      {isOpen && (
        <div className="plc-instances">
          {g.instances.map((p) => {
            const sel = selectedKey === `inst:${p.name}`;
            const moved = !!isPlacementMoved?.(p);
            const hidden = !!(isPlacementHidden?.(p) || p.userHidden);
            return (
              <Tooltip
                key={p.name}
                content={`#${p.index}  pos ${fmt3(p.rawPos)}${moved ? ' · moved' : ''}${hidden ? ' · hidden' : ''}`}
              >
                <div
                  ref={sel ? selectedRef : undefined}
                  className={`plc-row plc-inst${sel ? ' selected' : ''}${moved ? ' moved' : ''}${hidden ? ' vis-off' : ''}`}
                  onClick={(e) => { e.stopPropagation(); onSelectInstance?.(p); }}
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
              </Tooltip>
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
              <Tooltip
                key={p.key || p.name}
                content={`${p.id || ''}  pos ${fmt3(p.rawPos || p.pos)}${p.weatherId ? ` · ${p.weatherId}` : ''}${hidden ? ' · hidden' : ''}`}
              >
                <div
                  className={`plc-row plc-inst${hidden ? ' vis-off' : ''}`}
                  onClick={(e) => { e.stopPropagation(); onSelectEffect?.(p); }}
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
              </Tooltip>
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

const MESH_KIND_ORDER = {
  world: 0,
  sky: 1,
  water: 2,
  collision: 3,
  subarea: 4,
  unplaced: 5,
};

const MESH_SECTION_TITLE = {
  world: null, // tab is already Meshes — only special kinds get headers
  sky: 'Sky',
  water: 'Water',
  collision: 'Collision',
  subarea: 'Sub areas',
  unplaced: 'Unplaced',
};

const MESH_SECTION_ICON = {
  world: 'deployed_code',
  sky: 'cloud',
  water: 'water',
  collision: 'block',
  subarea: 'meeting_room',
  unplaced: 'location_off',
};

/** Tokens for kind search ("sky", "sub area", "collision", …). */
function groupKindTokens(g) {
  const k = g.kind || (g.kind === undefined && !g.soundId ? 'world' : null);
  if (k === 'sky') return ['sky', 'skybox'];
  if (k === 'water') return ['water', 'sea'];
  if (k === 'collision') return ['collision', 'coll', 'hit'];
  if (k === 'subarea') return ['subarea', 'sub-area', 'sub area', 'sub areas', 'interior', 'shop'];
  if (k === 'unplaced') return ['unplaced', 'orphan'];
  if (k === 'weather' || g.kind === 'weather') return ['weather'];
  if (g.kind === 'sfx' || g.soundId != null) return ['sfx', 'sound'];
  return ['mesh', 'meshes', 'world', 'placement', 'static'];
}

/**
 * Pure kind filter: "sky", "sub area", "collision" → only that section.
 * Returns a predicate, or null if the query isn't a kind keyword.
 */
function kindSearchMatch(q) {
  const t = q.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return null;
  const map = [
    [['sky', 'skybox'], (g) => g.kind === 'sky'],
    [['water', 'sea'], (g) => g.kind === 'water'],
    [['collision', 'coll', 'hitwall'], (g) => g.kind === 'collision'],
    [['sub area', 'subarea', 'sub-area', 'sub areas', 'interior'], (g) => g.kind === 'subarea'],
    [['unplaced', 'orphan'], (g) => g.kind === 'unplaced'],
    [['weather'], (g) => g.kind === 'weather'],
    [['mesh', 'meshes', 'world', 'placement', 'static'], (g) => !g.kind || g.kind === 'world'],
  ];
  for (const [keys, pred] of map) {
    if (keys.some((k) => t === k || t === `${k}s`)) return pred;
  }
  return null;
}

function displayLabel(g, hideKindPrefix = false) {
  if (hideKindPrefix) {
    if (g.kind === 'subarea') {
      const ids = [...new Set(g.instances.map((p) => p.subAreaId).filter((v) => v != null))];
      if (ids.length === 1) return `${g.mesh} · ${ids[0]}`;
    }
    return g.mesh;
  }
  if (g.kind === 'water') return `(WATER) ${g.mesh}`;
  if (g.kind === 'sky') return `(SKYBOX) ${g.mesh}`;
  if (g.kind === 'unplaced') return `(UNPLACED) ${g.mesh}`;
  if (g.kind === 'collision') return `(COLLISION) ${g.mesh}`;
  if (g.kind === 'subarea') {
    const ids = [...new Set(g.instances.map((p) => p.subAreaId).filter((v) => v != null))];
    return `(SUB-AREA ${ids.length === 1 ? ids[0] : ids.length}) ${g.mesh}`;
  }
  return g.mesh;
}

function vfxLabel(g) {
  if (g.kind === 'weather') return `(WEATHER) ${g.name}`;
  return g.name;
}

function sfxTitle(soundId, names) {
  if (soundId == null) return '';
  const key = String(soundId).padStart(6, '0');
  return names?.get(key) || names?.get(String(soundId)) || '';
}

function sfxLabel(g, names) {
  const se = g.soundId != null ? `se${String(g.soundId).padStart(6, '0')}` : (g.name || 'sound');
  const title = sfxTitle(g.soundId, names);
  return title ? `${se} · ${title}` : se;
}

function renderSfxGroup(g, ctx) {
  const {
    openMesh, setOpenMesh, query, selectedKey, selectedRef,
    sfxNames, onSelectSoundGroup, onSelectSound, onPlaySound, playingSoundKey,
  } = ctx;
  const openKey = `sfx:${g.soundId ?? g.name}`;
  const isOpen = openMesh === openKey || (!!query && g.instances.length <= 40);
  const groupSel = selectedKey === `sfxg:${g.soundId ?? g.name}`;
  const groupOffset = `grp:${g.soundId}`;
  const groupPlaying = g.soundId != null && playingSoundKey === `${groupOffset}:${g.soundId}`;
  return (
    <div key={openKey} className={`plc-group${isOpen ? ' open' : ''}${groupSel ? ' selected' : ''}`}>
      <div
        ref={groupSel ? selectedRef : undefined}
        className="plc-row plc-mesh"
        onClick={() => {
          setOpenMesh(isOpen && openMesh === openKey ? null : openKey);
          onSelectSoundGroup?.(g);
        }}
      >
        <span className="caret icon">chevron_right</span>
        {typeof onPlaySound === 'function' && g.soundId != null && (
          <Tooltip content={groupPlaying ? 'Stop' : 'Play sound'}>
            <button
              type="button"
              className={`icon-btn plc-sfx-play${groupPlaying ? ' on' : ''}`}
              aria-label={groupPlaying ? 'Stop' : 'Play'}
              onClick={(e) => {
                e.stopPropagation();
                onPlaySound({ soundId: g.soundId, key: groupOffset });
              }}
            >
              <span className={`icon${groupPlaying ? ' data-sfx-icon-play' : ''}`}>
                {groupPlaying ? 'stop' : 'play_arrow'}
              </span>
            </button>
          </Tooltip>
        )}
        <span className="kind icon">graphic_eq</span>
        <span className="plc-name">{sfxLabel(g, sfxNames)}</span>
        <span className="badge">{g.count}</span>
      </div>
      {isOpen && (
        <div className="plc-instances">
          {g.instances.map((p) => {
            const sel = selectedKey === p.key;
            const offset = p.key || `se:${p.soundId}:${p.index}`;
            const playing = p.soundId != null && playingSoundKey === `${offset}:${p.soundId}`;
            const far = p.far > 0 ? `far ${p.far}` : '';
            return (
              <Tooltip
                key={p.key || `${p.name}-${p.index}`}
                content={`${p.soundId != null ? `se${String(p.soundId).padStart(6, '0')}` : ''}  pos ${fmt3(p.rawPos || p.pos)}${far ? ` · ${far}` : ''}${p.active === false ? ' · out of range' : ''}${p.looping ? ' · loop' : ''}`}
              >
                <div
                  ref={sel ? selectedRef : undefined}
                  className={`plc-row plc-inst${sel ? ' selected' : ''}${p.active === false ? ' vis-off' : ''}`}
                  onClick={(e) => { e.stopPropagation(); onSelectSound?.(p); }}
                >
                  <span className="caret icon" />
                  {typeof onPlaySound === 'function' && p.soundId != null && (
                    <Tooltip content={playing ? 'Stop' : 'Play sound'}>
                      <button
                        type="button"
                        className={`icon-btn plc-sfx-play${playing ? ' on' : ''}`}
                        aria-label={playing ? 'Stop' : 'Play'}
                        onClick={(e) => {
                          e.stopPropagation();
                          onPlaySound({ ...p, key: offset });
                        }}
                      >
                        <span className={`icon${playing ? ' data-sfx-icon-play' : ''}`}>
                          {playing ? 'stop' : 'play_arrow'}
                        </span>
                      </button>
                    </Tooltip>
                  )}
                  <span className="kind icon">volume_up</span>
                  <span className="plc-name">{p.name}</span>
                  {p.active && <span className="mono-small plc-idx on-air">near</span>}
                  {p.soundId != null && (
                    <span className="mono-small plc-idx">{String(p.soundId).padStart(6, '0')}</span>
                  )}
                </div>
              </Tooltip>
            );
          })}
        </div>
      )}
    </div>
  );
}
