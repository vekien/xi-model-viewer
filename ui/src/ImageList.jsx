import { useEffect, useMemo, useState } from 'react';
import { listArrowHandler, useScrollIntoView } from './useListArrows.js';

// images.json (from dev/bake-images.mjs): [{ id, name, entries: [{ name, path }] }]
// path is backslash `ROM…\N.DAT`, relative to the game directory.

async function loadImages() {
  const res = await fetch('lists/images.json');
  if (!res.ok) throw new Error(`${res.status} lists/images.json`);
  return res.json();
}

export function ImageList({ selectedPath, onSelectImage, onError }) {
  const [cats, setCats] = useState(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await loadImages();
        if (!cancelled) setCats(Array.isArray(list) ? list : []);
      } catch (err) {
        if (!cancelled) {
          setCats([]);
          onError?.(`Failed to load images: ${err.message ?? err}`);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [onError]);

  const groups = useMemo(() => {
    if (!cats) return null;
    const q = query.trim().toLowerCase();
    return cats
      .map((c) => ({
        key: c.id,
        label: c.name,
        entries: q
          ? c.entries.filter((e) => e.name.toLowerCase().includes(q)
            || e.path.toLowerCase().includes(q))
          : c.entries,
      }))
      .filter((g) => g.entries.length);
  }, [cats, query]);

  const total = cats?.reduce((n, c) => n + c.entries.length, 0) ?? 0;
  const shown = groups?.reduce((n, g) => n + g.entries.length, 0) ?? 0;

  // Which groups are expanded lives here rather than in each ImageGroup, so the
  // arrow keys can walk the rows that are actually on screen. A filter forces
  // every group open, same as before.
  const [openKeys, setOpenKeys] = useState(() => new Set());
  const forceOpen = !!query.trim();
  const toggle = (key) => setOpenKeys((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const visible = useMemo(
    () => (groups ?? []).flatMap((g) => (forceOpen || openKeys.has(g.key) ? g.entries : [])),
    [groups, openKeys, forceOpen],
  );
  const onArrows = listArrowHandler(
    visible,
    visible.findIndex((e) => selectedPath && selectedPath.toLowerCase().endsWith(e.path.toLowerCase())),
    (e) => onSelectImage?.(e),
  );

  return (
    <div id="tree" className="panel zone-panel">
      <div className="zone-search">
        <span className="icon">search</span>
        <input
          type="search"
          placeholder="Filter images…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
      </div>
      {/* Focus on mousedown rather than trusting a click to land on the
          container: rows are plain divs, so without this the arrows would go to
          whatever held focus last. */}
      <div
        className="list-scroll"
        tabIndex={0}
        onMouseDown={(e) => e.currentTarget.focus({ preventScroll: true })}
        onKeyDown={onArrows}
      >
        {cats === null && <div className="side-note">Loading images…</div>}
        {cats && total === 0 && <div className="side-note">No images in lists/images.json.</div>}
        {cats && total > 0 && shown === 0 && <div className="side-note">No images match “{query}”.</div>}
        {groups?.map((g) => (
          <ImageGroup
            key={g.key}
            group={g}
            selectedPath={selectedPath}
            onSelectImage={onSelectImage}
            // 528 UI entries make a poor first impression fully expanded, so
            // groups start closed and the filter drives.
            open={forceOpen || openKeys.has(g.key)}
            onToggle={() => toggle(g.key)}
          />
        ))}
      </div>
      {cats && total > 0 && (
        <div className="side-note zone-count">
          {query ? `${shown} / ${total}` : `${total}`} images
        </div>
      )}
    </div>
  );
}

function ImageGroup({ group, selectedPath, onSelectImage, open, onToggle }) {
  return (
    <div className={`node${open ? ' open' : ''}`}>
      <div className="row" onClick={onToggle}>
        <span className="caret icon">chevron_right</span>
        <span className="kind icon">folder</span>
        <span>{group.label}</span>
        <span className="badge">{group.entries.length}</span>
      </div>
      {open && (
        <div className="children">
          {group.entries.map((e) => (
            <ImageRow
              key={e.path + e.name}
              entry={e}
              selected={!!selectedPath && selectedPath.toLowerCase().endsWith(e.path.toLowerCase())}
              onSelectImage={onSelectImage}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ImageRow({ entry, selected, onSelectImage }) {
  const ref = useScrollIntoView(selected);
  return (
    <div className={`node${selected ? ' selected' : ''}`}>
      <div className="row" ref={ref} onClick={() => onSelectImage?.(entry)} title={entry.path}>
        <span className="caret icon" />
        <span className="kind icon">image</span>
        <span className="zone-name">{entry.name}</span>
      </div>
    </div>
  );
}
