import { useEffect, useMemo, useState } from 'react';
import { Tooltip } from './Tooltip.jsx';

// NPC data comes fully resolved from lists/npcs.json (baked by
// dev/bake-lists.mjs): categories in display order, each with its entries —
// { name, variants: [DAT paths], base?: companion DAT,
//   anims?: [{ path, clips }] borrowed animation packs } or { separator }.

// Survive Effects ↔ NPC unmount: open folders + entry expands stay put.
const npcListUi = {
  openCats: new Set(),
  openEntries: new Set(),
  categories: null,
  query: '',
};

const PIN_KEY = 'pinnedNpcs';

function entryKey(catName, entry, index) {
  const v0 = entry.variants?.[0] || entry.name || index;
  return `${catName}::${v0}`;
}

/** Stable pin id — category + first variant path (or name). */
function pinKey(catName, entry, index) {
  return String(entryKey(catName, entry, index)).toLowerCase();
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
  const [pinned, setPinned] = useState(loadPins);

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

  const pinSet = useMemo(() => new Set(pinned), [pinned]);

  const togglePin = (catName, entry, index) => {
    const k = pinKey(catName, entry, index);
    setPinned((prev) => {
      const next = prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k];
      savePins(next);
      return next;
    });
  };

  const q = query.trim().toLowerCase();

  // Flat catalog of real entries (for pin lookup + counts).
  const allEntries = useMemo(() => {
    if (!categories) return [];
    const out = [];
    for (const cat of categories) {
      (cat.entries ?? []).forEach((entry, i) => {
        if (entry.separator !== undefined) return;
        out.push({ catName: cat.name, entry, index: i, key: pinKey(cat.name, entry, i) });
      });
    }
    return out;
  }, [categories]);

  const filtered = useMemo(() => {
    if (!categories) return null;
    const cats = !q
      ? categories
      : (() => {
        const out = [];
        for (const cat of categories) {
          const catHit = (cat.name || '').toLowerCase().includes(q);
          const entries = (cat.entries ?? []).filter(
            (e) => e.separator === undefined && (catHit || entryMatches(e, q)),
          );
          if (entries.length) out.push({ ...cat, entries });
        }
        return out;
      })();

    const byName = (a, b) =>
      (a.entry.name || '').localeCompare(b.entry.name || '', undefined, { sensitivity: 'base' });

    // Pinned folder first — only keys that still exist, matching current filter.
    const pinnedRows = allEntries
      .filter((row) => pinSet.has(row.key))
      .filter((row) => !q || entryMatches(row.entry, q) || row.catName.toLowerCase().includes(q))
      .slice()
      .sort(byName);

    const rest = cats.map((cat) => ({
      name: cat.name,
      entries: cat.entries ?? [],
      pinnedFolder: false,
    }));

    if (!pinnedRows.length) return rest;
    return [
      {
        name: 'Pinned',
        pinnedFolder: true,
        entries: pinnedRows.map((r) => ({
          ...r.entry,
          __pinCat: r.catName,
          __pinIndex: r.index,
        })),
      },
      ...rest,
    ];
  }, [categories, q, pinSet, allEntries]);

  const total = allEntries.length;
  const shownUnique = useMemo(() => {
    if (!q) return total;
    return allEntries.filter(
      (r) => entryMatches(r.entry, q) || r.catName.toLowerCase().includes(q),
    ).length;
  }, [allEntries, q, total]);

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
        {filtered?.map((cat) => {
          const catKey = cat.pinnedFolder ? '__pinned__' : cat.name;
          const defaultPinnedOpen = cat.pinnedFolder && !openCats.has('__pinned_closed__');
          return (
            <NpcCategory
              key={catKey}
              category={cat}
              open={q ? true : (cat.pinnedFolder ? defaultPinnedOpen : openCats.has(cat.name))}
              onToggle={() => {
                if (cat.pinnedFolder) {
                  setOpenCats((s) => {
                    const n = new Set(s);
                    if (n.has('__pinned_closed__')) n.delete('__pinned_closed__');
                    else n.add('__pinned_closed__');
                    return n;
                  });
                } else {
                  toggleCat(cat.name);
                }
              }}
              searching={!!q}
              openEntries={openEntries}
              onToggleEntry={toggleEntry}
              onSelectEntry={onSelectEntry}
              selectedPath={selectedPath}
              pinSet={pinSet}
              onTogglePin={togglePin}
            />
          );
        })}
      </div>
      {categories && total > 0 && (
        <div className="side-note zone-count">
          {q ? `${shownUnique} / ${total}` : `${total}`} NPCs
          {pinned.length > 0 && !q ? ` · ${pinned.length} pinned` : ''}
        </div>
      )}
    </div>
  );
}

function NpcCategory({
  category, open, onToggle, searching, openEntries, onToggleEntry, onSelectEntry,
  selectedPath, pinSet, onTogglePin,
}) {
  const entries = category.entries;
  const pinnedFolder = !!category.pinnedFolder;

  return (
    <div className={`node${open ? ' open' : ''}${pinnedFolder ? ' zone-pinned-group' : ''}`}>
      <div className="row" onClick={searching ? undefined : onToggle}>
        <span className="caret icon">{searching ? '' : 'chevron_right'}</span>
        <span className={`kind icon${pinnedFolder ? ' zone-pin-folder-icon' : ''}`}>
          {pinnedFolder ? 'keep' : 'folder'}
        </span>
        <span>{category.name}</span>
        {pinnedFolder && <span className="badge">{entries.length}</span>}
      </div>
      {open && entries && (
        <div className="children">
          {entries.map((entry, i) => {
            if (entry.separator !== undefined) {
              return <div key={i} className="side-separator">{entry.separator}</div>;
            }
            const catName = entry.__pinCat ?? category.name;
            const index = entry.__pinIndex ?? i;
            const ek = entryKey(catName, entry, index);
            const pk = pinKey(catName, entry, index);
            return (
              <NpcEntry
                key={pinnedFolder ? `pin:${pk}` : ek}
                catName={catName}
                index={index}
                entry={entry}
                open={openEntries.has(ek)}
                onToggleOpen={() => onToggleEntry(ek)}
                onSelectEntry={onSelectEntry}
                selectedPath={selectedPath}
                pinned={pinSet.has(pk)}
                onTogglePin={onTogglePin}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function NpcEntry({
  catName, index, entry, open, onToggleOpen, onSelectEntry, selectedPath, pinned, onTogglePin,
}) {
  const multi = entry.variants.length > 1;

  const load = (variant) =>
    onSelectEntry({
      name: entry.name,
      paths: entry.base ? [entry.base, variant] : [variant],
      // Borrowed clip packs: a trust's player-style move set lives in DATs
      // rooted at the content families its model declares, not in the model
      // itself. Passed through whole — App picks one at a time, because a set
      // reuses clip ids and merging them would shadow the duplicates.
      animPacks: entry.anims ?? null,
      key: variant.toLowerCase(),
    });

  const isSelected = (variant) => selectedPath === variant.toLowerCase();

  return (
    <div
      className={`node zone-row${open ? ' open' : ''}${!multi && isSelected(entry.variants[0]) ? ' selected' : ''}${pinned ? ' zone-is-pinned' : ''}`}
    >
      <div className="row" onClick={() => load(entry.variants[0])}>
        <span
          className="caret icon"
          onClick={(e) => { if (multi) { e.stopPropagation(); onToggleOpen(); } }}
        >
          {multi ? 'chevron_right' : ''}
        </span>
        <span className="kind icon">deployed_code</span>
        <span className="tree-file-name">{entry.name}</span>
        {multi && <span className="badge">{entry.variants.length}</span>}
        <Tooltip content={pinned ? 'Unpin NPC' : 'Pin NPC'} placement="right">
          <button
            type="button"
            className={`zone-pin-btn${pinned ? ' on' : ''}`}
            aria-label={pinned ? 'Unpin NPC' : 'Pin NPC'}
            aria-pressed={pinned}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin?.(catName, entry, index);
            }}
          >
            <span className={`icon${pinned ? ' fill' : ''}`}>keep</span>
          </button>
        </Tooltip>
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
