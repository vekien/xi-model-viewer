import { useEffect, useMemo, useState } from 'react';

// zones.json shape (from `xi zone json`): [{ id, name, path, group? }]
// path is leveleditor-style `game/ROM…/N.DAT`.

function romOf(z) {
  return (z.path.match(/(?:game\/)?(ROM\d*)\//i)?.[1] || 'ROM').toUpperCase();
}

function groupOf(z) {
  return z.group || romOf(z);
}

function groupLabel(g) {
  return g === 'ROM' ? 'ROM (base)' : g;
}

async function loadZones() {
  const res = await fetch('lists/zones.json');
  if (!res.ok) throw new Error(`${res.status} lists/zones.json`);
  return res.json();
}

export function ZoneList({ selectedPath, onSelectZone, onError }) {
  const [zones, setZones] = useState(null);
  const [query, setQuery] = useState('');

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

  const groups = useMemo(() => {
    if (!zones) return null;
    const q = query.trim().toLowerCase();
    const filtered = q
      ? zones.filter((z) =>
        z.name?.toLowerCase().includes(q)
        || String(z.id).includes(q)
        || z.path?.toLowerCase().includes(q))
      : zones;

    const order = [...new Set(filtered.map(groupOf))].sort((a, b) => {
      if (a === 'Rooms') return 1;
      if (b === 'Rooms') return -1;
      return (+a.slice(3) || 1) - (+b.slice(3) || 1);
    });

    return order.map((g) => ({
      key: g,
      label: groupLabel(g),
      zones: filtered
        .filter((z) => groupOf(z) === g)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    })).filter((g) => g.zones.length);
  }, [zones, query]);

  const total = zones?.length ?? 0;
  const shown = groups?.reduce((n, g) => n + g.zones.length, 0) ?? 0;

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
        {zones && total > 0 && shown === 0 && <div className="side-note">No zones match “{query}”.</div>}
        {groups?.map((g) => (
          <ZoneGroup
            key={g.key}
            group={g}
            selectedPath={selectedPath}
            onSelectZone={onSelectZone}
            defaultOpen={!query && g.key === 'ROM'}
            forceOpen={!!query}
          />
        ))}
      </div>
      {zones && total > 0 && (
        <div className="side-note zone-count">
          {query ? `${shown} / ${total}` : `${total}`} zones
        </div>
      )}
    </div>
  );
}

function ZoneGroup({ group, selectedPath, onSelectZone, defaultOpen, forceOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const show = forceOpen || open;

  return (
    <div className={`node${show ? ' open' : ''}`}>
      <div className="row" onClick={() => setOpen(!open)}>
        <span className="caret icon">chevron_right</span>
        <span className="kind icon">folder</span>
        <span>{group.label}</span>
        <span className="badge">{group.zones.length}</span>
      </div>
      {show && (
        <div className="children">
          {group.zones.map((z) => {
            const rel = String(z.path || '').replace(/^game[\\/]/i, '').replace(/\//g, '\\');
            const sel = selectedPath && selectedPath.endsWith(rel.toLowerCase());
            return (
              <div key={`${z.id}-${z.path}`} className={`node${sel ? ' selected' : ''}`}>
                <div className="row" onClick={() => onSelectZone?.(z)} title={z.path}>
                  <span className="caret icon" />
                  <span className="kind icon">map</span>
                  <span className="zone-name">{z.name}</span>
                  <span className="mono-small zone-id">{z.id}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
