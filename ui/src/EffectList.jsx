import { useEffect, useMemo, useState } from 'react';

// Effect categories/entries baked from AltanaViewer's List/Effect CSVs (see
// dev/bake-effects.mjs). Each entry names a spell/ability/status DAT the
// particle runtime can play: { name, dir, file, path: "ROM/d/f.DAT" }.

const MAX_RESULTS = 400;   // cap the flat search list so a broad query stays snappy

function EffectRow({ entry, sub, selected, onSelect }) {
  return (
    <div className={`node${selected ? ' selected' : ''}`}>
      <div className="row" onClick={() => onSelect(entry)}>
        <span className="caret"><span className="icon" /></span>
        <span className="kind icon">bolt</span>
        <span className="effect-name">{entry.name}</span>
        {sub && <span className="mono-small effect-sub">{sub}</span>}
        <span className="mono-small effect-id">{entry.dir}/{entry.file}</span>
      </div>
    </div>
  );
}

export function EffectList({ onSelect, selectedPath }) {
  const [data, setData] = useState(null);            // { categories } | null while loading
  const [query, setQuery] = useState('');
  const [openCats, setOpenCats] = useState(() => new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('lists/effects.json');
        const json = res.ok ? await res.json() : { categories: [] };
        if (!cancelled) setData(json);
      } catch { if (!cancelled) setData({ categories: [] }); }
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
        if (catMatches || e.name.toLowerCase().includes(q) || `${e.dir}/${e.file}`.includes(q)) {
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
        <span className="icon">search</span>
        <input
          className="list-search"
          type="text"
          placeholder="Search effects…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        {query && (
          <button className="list-search-clear" title="Clear" onClick={() => setQuery('')}>
            <span className="icon">close</span>
          </button>
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
