import { useEffect, useMemo, useState } from 'react';
import { Tooltip } from './Tooltip.jsx';

// zones.json shape (from `xi zone json`): [{ id, name, path, group? }]
// path is leveleditor-style `game/ROM…/N.DAT`.

// Curated groups (no ROM number of their own) always sort after the ROM groups.
const TAIL_GROUPS = ['Dev / Prototype', 'Rooms'];
const PIN_KEY = 'pinnedZones';

function romOf(z) {
  return (z.path.match(/(?:game\/)?(ROM\d*)\//i)?.[1] || 'ROM').toUpperCase();
}

function groupOf(z) {
  return z.group || romOf(z);
}

function groupLabel(g) {
  return g === 'ROM' ? 'ROM (base)' : g;
}

/** Stable pin key — path is unique across the list. */
function zoneKey(z) {
  return String(z.path || '').replace(/\\/g, '/').toLowerCase();
}

function loadPins() {
  try {
    const v = JSON.parse(localStorage.getItem(PIN_KEY) || '[]');
    return Array.isArray(v) ? v.map((k) => String(k).toLowerCase()) : [];
  } catch {
    return [];
  }
}

function savePins(keys) {
  try { localStorage.setItem(PIN_KEY, JSON.stringify(keys)); } catch { /* quota */ }
}

async function loadZones() {
  const res = await fetch('lists/zones.json');
  if (!res.ok) throw new Error(`${res.status} lists/zones.json`);
  return res.json();
}

export function ZoneList({ selectedPath, onSelectZone, onError }) {
  const [zones, setZones] = useState(null);
  const [query, setQuery] = useState('');
  const [pinned, setPinned] = useState(loadPins);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await loadZones();
        if (!cancelled) setZones(Array.isArray(list) ? list : []);
      } catch (err) {
        if (!cancelled) {
          setZones([]);
          onError?.(`Failed to load zones: ${err.message ?? err}`);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [onError]);

  const togglePin = (z) => {
    const k = zoneKey(z);
    setPinned((prev) => {
      const next = prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k];
      savePins(next);
      return next;
    });
  };

  const pinSet = useMemo(() => new Set(pinned), [pinned]);

  const groups = useMemo(() => {
    if (!zones) return null;
    const q = query.trim().toLowerCase();
    const filtered = q
      ? zones.filter((z) =>
        z.name?.toLowerCase().includes(q)
        || String(z.id).includes(q)
        || z.path?.toLowerCase().includes(q))
      : zones;

    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

    // Pinned folder first (only keys that still exist in the list).
    const pinnedZones = filtered
      .filter((z) => pinSet.has(zoneKey(z)))
      .slice()
      .sort(byName);

    // ROM groups by number first, then the two curated groups at the bottom.
    const order = [...new Set(filtered.map(groupOf))].sort((a, b) => {
      const ta = TAIL_GROUPS.indexOf(a), tb = TAIL_GROUPS.indexOf(b);
      if (ta !== -1 || tb !== -1) return (ta === -1 ? -1 : ta) - (tb === -1 ? -1 : tb);
      return (+a.slice(3) || 1) - (+b.slice(3) || 1);
    });

    const rest = order.map((g) => ({
      key: g,
      label: groupLabel(g),
      zones: filtered
        .filter((z) => groupOf(z) === g)
        .slice()
        .sort(byName),
    })).filter((g) => g.zones.length);

    if (!pinnedZones.length) return rest;
    return [
      { key: '__pinned__', label: 'Pinned', zones: pinnedZones, pinnedFolder: true },
      ...rest,
    ];
  }, [zones, query, pinSet]);

  const total = zones?.length ?? 0;
  // Count unique zones when filtering (pinned folder duplicates don't inflate total).
  const shownUnique = useMemo(() => {
    if (!zones) return 0;
    const q = query.trim().toLowerCase();
    if (!q) return total;
    return zones.filter((z) =>
      z.name?.toLowerCase().includes(q)
      || String(z.id).includes(q)
      || z.path?.toLowerCase().includes(q)).length;
  }, [zones, query, total]);

  return (
    <div id="tree" className="panel zone-panel">
      <div className="zone-search">
        <span className="icon">search</span>
        <input
          type="search"
          placeholder="Filter zones…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="list-scroll">
        {zones === null && <div className="side-note">Loading zones…</div>}
        {zones && total === 0 && <div className="side-note">No zones in lists/zones.json.</div>}
        {zones && total > 0 && shownUnique === 0 && <div className="side-note">No zones match “{query}”.</div>}
        {groups?.map((g) => (
          <ZoneGroup
            key={g.key}
            group={g}
            selectedPath={selectedPath}
            onSelectZone={onSelectZone}
            pinSet={pinSet}
            onTogglePin={togglePin}
            defaultOpen={!query && (g.key === 'ROM' || g.pinnedFolder)}
            forceOpen={!!query}
          />
        ))}
      </div>
      {zones && total > 0 && (
        <div className="side-note zone-count">
          {query ? `${shownUnique} / ${total}` : `${total}`} zones
          {pinned.length > 0 && !query ? ` · ${pinned.length} pinned` : ''}
        </div>
      )}
    </div>
  );
}

function ZoneGroup({
  group, selectedPath, onSelectZone, pinSet, onTogglePin, defaultOpen, forceOpen,
}) {
  const [open, setOpen] = useState(defaultOpen);
  const show = forceOpen || open;

  return (
    <div className={`node${show ? ' open' : ''}${group.pinnedFolder ? ' zone-pinned-group' : ''}`}>
      <div className="row" onClick={() => setOpen(!open)}>
        <span className="caret icon">chevron_right</span>
        <span className={`kind icon${group.pinnedFolder ? ' zone-pin-folder-icon' : ''}`}>
          {group.pinnedFolder ? 'keep' : 'folder'}
        </span>
        <span>{group.label}</span>
        <span className="badge">{group.zones.length}</span>
      </div>
      {show && (
        <div className="children">
          {group.zones.map((z) => (
            <ZoneRow
              key={`${z.id}-${z.path}`}
              zone={z}
              selectedPath={selectedPath}
              pinned={pinSet.has(zoneKey(z))}
              onSelectZone={onSelectZone}
              onTogglePin={onTogglePin}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ZoneRow({ zone: z, selectedPath, pinned, onSelectZone, onTogglePin }) {
  const rel = String(z.path || '').replace(/^game[\\/]/i, '').replace(/\//g, '\\');
  const sel = selectedPath && selectedPath.endsWith(rel.toLowerCase());

  return (
    <div className={`node zone-row${sel ? ' selected' : ''}${pinned ? ' zone-is-pinned' : ''}`}>
      <div className="row" onClick={() => onSelectZone?.(z)}>
        <span className="caret icon" />
        <span className="kind icon">map</span>
        <span className="zone-name">{z.name}</span>
        <span className="mono-small zone-id">{z.id}</span>
        <Tooltip content={pinned ? 'Unpin zone' : 'Pin zone'} placement="right">
          <button
            type="button"
            className={`zone-pin-btn${pinned ? ' on' : ''}`}
            aria-label={pinned ? 'Unpin zone' : 'Pin zone'}
            aria-pressed={pinned}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin?.(z);
            }}
          >
            <span className={`icon${pinned ? ' fill' : ''}`}>keep</span>
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
