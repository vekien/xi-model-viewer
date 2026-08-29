import { useEffect, useMemo, useState } from 'react';
import { Tooltip } from './Tooltip.jsx';

// Effect categories/entries baked from AltanaViewer's List/Effect CSVs (see
// dev/bake-effects.mjs). Each entry: { name, path: "ROM/d/f.DAT" }.

const MAX_RESULTS = 400;   // cap the flat search list so a broad query stays snappy

// Survive Character ↔ Effects unmount: list tree + search stay where you left them.
const effectListUi = {
  query: '',
  openCats: new Set(),
  data: null,   // cached fetch so re-open doesn't flash "Loading…"
};

/** Badge from path: ROM/15/89.DAT → 15/89 */
function pathId(path) {
  if (!path) return '';
  const m = String(path).replace(/\\/g, '/').match(/([^/]+)\/(\d+)\/(\d+)\.DAT$/i);
  return m ? `${m[2]}/${m[3]}` : String(path).replace(/\\/g, '/');
}

function EffectRow({ entry, sub, selected, onSelect }) {
  const id = pathId(entry.path);
  return (
    <div className={`node${selected ? ' selected' : ''}`}>
      <div className="row" onClick={() => onSelect(entry)}>
        <span className="caret"><span className="icon" /></span>
        <span className="kind icon">bolt</span>
        <span className="effect-name">{entry.name}</span>
        {sub && <span className="mono-small effect-sub">{sub}</span>}
        {id && <span className="mono-small effect-id">{id}</span>}
      </div>
    </div>
  );
}

export function EffectList({ onSelect, selectedPath }) {
  const [data, setData] = useState(() => effectListUi.data);
  const [query, setQuery] = useState(() => effectListUi.query);
  const [openCats, setOpenCats] = useState(() => new Set(effectListUi.openCats));

  useEffect(() => {
    effectListUi.query = query;
  }, [query]);
  useEffect(() => {
    effectListUi.openCats = openCats;
  }, [openCats]);

  useEffect(() => {
    if (effectListUi.data) {
      setData(effectListUi.data);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('lists/effects.json');
        const json = res.ok ? await res.json() : { categories: [] };
        if (!cancelled) {
          effectListUi.data = json;
          setData(json);
        }
      } catch {
        if (!cancelled) {
          const empty = { categories: [] };
          effectListUi.data = empty;
          setData(empty);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const q = query.trim().toLowerCase();

  // Flat, cross-category matches while searching; null means "not searching",
  // which switches the view back to the collapsible category tree.
  const results = useMemo(() => {
    if (!data || !q) return null;
    const out = [];
    for (const cat of data.categories) {
      const catMatches = cat.label.toLowerCase().includes(q);
      for (const e of cat.entries) {
        const id = pathId(e.path).toLowerCase();
        if (catMatches || e.name.toLowerCase().includes(q) || id.includes(q) || String(e.path || '').toLowerCase().includes(q)) {
          out.push({ ...e, cat: cat.label });
          if (out.length >= MAX_RESULTS) return out;
        }
      }
    }
    return out;
  }, [data, q]);

  const toggle = (id) => setOpenCats((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  return (
    <div id="tree" className="panel list-panel">
      <div className="list-search-wrap">
        <input
          className="list-search"
          type="text"
          placeholder="Search effects…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        {query && (
          <Tooltip content="Clear">
            <button className="list-search-clear" onClick={() => setQuery('')}>
              <span className="icon">close</span>
            </button>
          </Tooltip>
        )}
      </div>

      <div className="list-scroll">
        {!data && <div className="side-note">Loading effects…</div>}

        {data && results && results.length === 0 && (
          <div className="side-note">No effects match “{query}”.</div>
        )}
        {data && results && results.map((e, i) => (
          <EffectRow key={`${e.cat}:${e.path}:${i}`} entry={e} sub={e.cat}
            selected={selectedPath === e.path} onSelect={onSelect} />
        ))}
        {data && results?.length >= MAX_RESULTS && (
          <div className="side-note">Showing first {MAX_RESULTS} — refine your search.</div>
        )}

        {data && !results && data.categories.map((cat) => (
          <div key={cat.id} className={`node${openCats.has(cat.id) ? ' open' : ''}`}>
            <div className="row" onClick={() => toggle(cat.id)}>
              <span className="caret icon">chevron_right</span>
              <span className="kind icon">auto_awesome</span>
              <span>{cat.label}</span>
              <span className="badge">{cat.entries.length}</span>
            </div>
            {openCats.has(cat.id) && (
              <div className="children">
                {cat.entries.map((e, i) => (
                  <EffectRow key={`${cat.id}:${e.path}:${i}`} entry={{ ...e, cat: cat.label }}
                    selected={selectedPath === e.path} onSelect={onSelect} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
