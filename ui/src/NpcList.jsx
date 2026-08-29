import { useEffect, useMemo, useState } from 'react';
import { Tooltip } from './Tooltip.jsx';

// NPC data comes fully resolved from lists/npcs.json (baked by
// dev/bake-lists.mjs): categories in display order, each with its entries —
// { name, variants: [DAT paths], base?: companion DAT } or { separator }.

// Survive Effects ↔ NPC unmount: open folders + entry expands stay put.
const npcListUi = {
  openCats: new Set(),
  openEntries: new Set(),
  categories: null,
  query: '',
};

function entryKey(catName, entry, index) {
  const v0 = entry.variants?.[0] || entry.name || index;
  return `${catName}::${v0}`;
}

function entryMatches(entry, q) {
  if (entry.separator !== undefined) return false;
  if ((entry.name || '').toLowerCase().includes(q)) return true;
  return (entry.variants ?? []).some((v) => v.toLowerCase().includes(q));
}

export function NpcList({ onSelectEntry, selectedPath, onError }) {
  const [categories, setCategories] = useState(() => npcListUi.categories);
  const [openCats, setOpenCats] = useState(() => new Set(npcListUi.openCats));
  const [openEntries, setOpenEntries] = useState(() => new Set(npcListUi.openEntries));
  const [query, setQuery] = useState(() => npcListUi.query);

  useEffect(() => { npcListUi.openCats = openCats; }, [openCats]);
  useEffect(() => { npcListUi.openEntries = openEntries; }, [openEntries]);
  useEffect(() => { npcListUi.query = query; }, [query]);

  useEffect(() => {
    if (npcListUi.categories) {
      setCategories(npcListUi.categories);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('lists/npcs.json');
        if (!res.ok) throw new Error(`${res.status} npcs.json`);
        const cats = (await res.json()).categories;
        if (!cancelled) {
          npcListUi.categories = cats;
          setCategories(cats);
        }
      } catch (err) {
        if (!cancelled) {
          onError?.(`Failed to load NPC lists: ${err.message ?? err}`);
          npcListUi.categories = [];
          setCategories([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [onError]);

  // Auto-expand the category/entry that owns the current selection.
  useEffect(() => {
    if (!categories || !selectedPath) return;
    const sel = selectedPath.toLowerCase();
    for (const cat of categories) {
      for (let i = 0; i < (cat.entries?.length ?? 0); i++) {
        const entry = cat.entries[i];
        if (entry.separator !== undefined) continue;
        const hit = (entry.variants ?? []).some((v) => v.toLowerCase() === sel);
        if (!hit) continue;
        setOpenCats((s) => {
          if (s.has(cat.name)) return s;
          const n = new Set(s);
          n.add(cat.name);
          return n;
        });
        if ((entry.variants?.length ?? 0) > 1) {
          const ek = entryKey(cat.name, entry, i);
          setOpenEntries((s) => {
            if (s.has(ek)) return s;
            const n = new Set(s);
            n.add(ek);
            return n;
          });
        }
        return;
      }
    }
  }, [categories, selectedPath]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!categories) return null;
    if (!q) return categories;
    const out = [];
    for (const cat of categories) {
      const catHit = (cat.name || '').toLowerCase().includes(q);
      const entries = (cat.entries ?? []).filter(
        (e) => e.separator === undefined && (catHit || entryMatches(e, q)),
      );
      if (entries.length) out.push({ ...cat, entries });
    }
    return out;
  }, [categories, q]);

  const toggleCat = (name) => setOpenCats((s) => {
    const n = new Set(s);
    if (n.has(name)) n.delete(name); else n.add(name);
    return n;
  });

  const toggleEntry = (key) => setOpenEntries((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  return (
    <div id="tree" className="panel list-panel">
      <div className="list-search-wrap">
        <input
          className="list-search"
          type="text"
          placeholder="Search NPCs…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        {query && (
          <Tooltip content="Clear">
            <button type="button" className="list-search-clear" onClick={() => setQuery('')}>
              <span className="icon">close</span>
            </button>
          </Tooltip>
        )}
      </div>
      <div className="list-scroll">
        {categories === null && <div className="side-note">Loading NPC lists…</div>}
        {filtered && filtered.length === 0 && (
          <div className="side-note">No NPCs match “{query.trim()}”.</div>
        )}
        {filtered?.map((cat) => (
          <NpcCategory
            key={cat.name}
            category={cat}
            open={q ? true : openCats.has(cat.name)}
            onToggle={() => toggleCat(cat.name)}
            searching={!!q}
            openEntries={openEntries}
            onToggleEntry={toggleEntry}
            onSelectEntry={onSelectEntry}
            selectedPath={selectedPath}
          />
        ))}
      </div>
    </div>
  );
}

function NpcCategory({
  category, open, onToggle, searching, openEntries, onToggleEntry, onSelectEntry, selectedPath,
}) {
  const entries = category.entries;

  return (
    <div className={`node${open ? ' open' : ''}`}>
      <div className="row" onClick={searching ? undefined : onToggle}>
        <span className="caret icon">chevron_right</span>
        <span className="kind icon">folder</span>
        <span>{category.name}</span>
      </div>
      {open && entries && (
        <div className="children">
          {entries.map((entry, i) =>
            entry.separator !== undefined ? (
              <div key={i} className="side-separator">{entry.separator}</div>
            ) : (
              <NpcEntry
                key={i}
                catName={category.name}
                index={i}
                entry={entry}
                open={openEntries.has(entryKey(category.name, entry, i))}
                onToggleOpen={() => onToggleEntry(entryKey(category.name, entry, i))}
                onSelectEntry={onSelectEntry}
                selectedPath={selectedPath}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function NpcEntry({ entry, open, onToggleOpen, onSelectEntry, selectedPath }) {
  const multi = entry.variants.length > 1;

  const load = (variant) =>
    onSelectEntry({
      name: entry.name,
      paths: entry.base ? [entry.base, variant] : [variant],
      key: variant.toLowerCase(),
    });

  const isSelected = (variant) => selectedPath === variant.toLowerCase();

  return (
    <div className={`node${open ? ' open' : ''}${!multi && isSelected(entry.variants[0]) ? ' selected' : ''}`}>
      <div className="row" onClick={() => load(entry.variants[0])}>
        <span
          className="caret icon"
          onClick={(e) => { if (multi) { e.stopPropagation(); onToggleOpen(); } }}
        >
          {multi ? 'chevron_right' : ''}
        </span>
        <span className="kind icon">deployed_code</span>
        <span>{entry.name}</span>
        {multi && <span className="badge">{entry.variants.length}</span>}
      </div>
      {multi && open && (
        <div className="children">
          {entry.variants.map((v) => (
            <div key={v} className={`node${isSelected(v) ? ' selected' : ''}`}>
              <div className="row" onClick={() => load(v)}>
                <span className="caret icon"></span>
                <span className="kind icon">draft</span>
                <span className="mono-small">{v}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
