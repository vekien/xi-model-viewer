import { useEffect, useState } from 'react';

// NPC data comes fully resolved from lists/npcs.json (baked by
// dev/bake-lists.mjs): categories in display order, each with its entries —
// { name, variants: [DAT paths], base?: companion DAT } or { separator }.

export function NpcList({ onSelectEntry, selectedPath, onError }) {
  const [categories, setCategories] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('lists/npcs.json');
        if (!res.ok) throw new Error(`${res.status} npcs.json`);
        setCategories((await res.json()).categories);
      } catch (err) {
        onError?.(`Failed to load NPC lists: ${err.message ?? err}`);
        setCategories([]);
      }
    })();
  }, [onError]);

  return (
    <div id="tree" className="panel list-panel">
      <div className="list-scroll">
        {categories === null && <div className="side-note">Loading NPC lists…</div>}
        {categories?.map((cat) => (
          <NpcCategory
            key={cat.name}
            category={cat}
            onSelectEntry={onSelectEntry}
            selectedPath={selectedPath}
            onError={onError}
          />
        ))}
      </div>
    </div>
  );
}

function NpcCategory({ category, onSelectEntry, selectedPath }) {
  const [open, setOpen] = useState(false);
  const entries = category.entries;

  const toggle = () => setOpen(!open);

  return (
    <div className={`node${open ? ' open' : ''}`}>
      <div className="row" onClick={toggle}>
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
              <NpcEntry key={i} entry={entry} onSelectEntry={onSelectEntry} selectedPath={selectedPath} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function NpcEntry({ entry, onSelectEntry, selectedPath }) {
  const [open, setOpen] = useState(false);
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
          onClick={(e) => { if (multi) { e.stopPropagation(); setOpen(!open); } }}
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
                <span className="kind icon">deployed_code</span>
                <span className="mono-small">{v.replace(/\\/g, '/')}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
