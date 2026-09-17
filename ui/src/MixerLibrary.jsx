import { useEffect, useMemo, useRef, useState } from 'react';
import { Tooltip } from './Tooltip.jsx';
import { CategoryInput } from './CategoryInput.jsx';

// The Mixes panel — what the timeline's Load opens: every saved mix, filed by
// category, one folding group per category with the unfiled ones last. A row
// opens its mix; on hover it can be renamed or re-filed (one inline form),
// duplicated or deleted. A folded group stays folded across visits; a search
// opens everything it hits.

const UNFILED = 'Uncategorised';
const FOLD_KEY = 'mixerLibFolded';
const readFolded = () => { try { return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) || '[]')); } catch { return new Set(); } };
const writeFolded = (set) => { try { localStorage.setItem(FOLD_KEY, JSON.stringify([...set])); } catch { /* private mode */ } };

/** The categories in use, each once, A–Z — what the category fields offer. */
export function categoriesOf(rows) {
  return [...new Set(rows.map((r) => String(r.category ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/** Rows by category, A–Z with the unfiled group last; names A–Z within. */
function groupRows(rows) {
  const by = new Map();
  for (const r of rows) {
    const cat = String(r.category ?? '').trim();
    if (!by.has(cat)) by.set(cat, []);
    by.get(cat).push(r);
  }
  return [...by.entries()]
    .map(([cat, list]) => ({ cat, rows: list.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => (a.cat === '' ? 1 : b.cat === '' ? -1 : a.cat.localeCompare(b.cat)));
}

const sourceLine = (r) => ['motion', 'vfx', 'sound'].map((l) => r.sources?.[l]?.name ?? r.sources?.[l]?.spec).filter(Boolean).join(' · ');
const safeName = (s) => s.replace(/[^A-Za-z0-9_-]/g, '_');

/** One saved mix: open on click; hover for edit (name and category), duplicate, delete. */
function Row({ r, current, onStage, categories, onOpen, onRename, onSetCategory, onDuplicate, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(r.name);
  const [cat, setCat] = useState(r.category ?? '');
  const nameRef = useRef(null);
  useEffect(() => { if (editing) { nameRef.current?.focus(); nameRef.current?.select?.(); } }, [editing]);
  const stop = (e) => e.stopPropagation();
  const begin = () => { setName(r.name); setCat(r.category ?? ''); setEditing(true); };
  // The rename lands first (it carries the index entry along), then the new
  // category goes on whatever name the mix ended up with.
  const commit = async (e) => {
    e.preventDefault();
    setEditing(false);
    const to = name.trim();
    const next = cat.trim();
    let final = r.name;
    if (to && to !== r.name) final = (await onRename?.(r.name, to)) ?? r.name;
    if (next !== String(r.category ?? '').trim()) await onSetCategory?.(final, next);
  };
  return (
    <div className={`mixer-recipe-row${current ? ' on' : ''}${editing ? ' busy' : ''}`} onClick={() => !editing && onOpen?.(r.name)}>
      <div className="mixer-recipe-main">
        {editing
          ? (
            <form className="mixer-save mixer-lib-edit" onClick={stop} onSubmit={commit}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); } }}>
              <input ref={nameRef} value={name} spellCheck={false} placeholder="Mix name" aria-label="Mix name"
                onChange={(e) => setName(safeName(e.target.value))} />
              <CategoryInput value={cat} onChange={setCat} options={categories} placeholder="Category" />
              <Tooltip content="Apply"><button type="submit" className="pc-tbtn" aria-label="Apply"><span className="icon">check</span></button></Tooltip>
              <Tooltip content="Cancel"><button type="button" className="pc-tbtn" aria-label="Cancel" onClick={() => setEditing(false)}><span className="icon">close</span></button></Tooltip>
            </form>
          )
          : (
            <>
              <span className="mixer-recipe-name">
                {r.name}
                {onStage && <span className="mixer-recipe-badge">ON STAGE</span>}
              </span>
              <span className="mixer-recipe-src">{sourceLine(r) || 'empty'}</span>
            </>
          )}
      </div>
      {!editing && (
        <span className="mixer-recipe-acts" onClick={stop}>
          <Tooltip content="Rename, or file under another category"><button type="button" className="pc-tbtn" aria-label="Edit" onClick={begin}><span className="icon">edit</span></button></Tooltip>
          <Tooltip content="Duplicate"><button type="button" className="pc-tbtn" aria-label="Duplicate" onClick={() => onDuplicate?.(r.name)}><span className="icon">content_copy</span></button></Tooltip>
          {/* One click: a mix is a small JSON file, cheap to recreate. */}
          <Tooltip content="Delete"><button type="button" className="pc-tbtn" aria-label="Delete" onClick={() => onDelete?.(r.name)}><span className="icon">delete</span></button></Tooltip>
        </span>
      )}
    </div>
  );
}

export function MixerLibrary({ recipes = [], current = '', stageName = null, onOpen, onRename, onSetCategory, onDuplicate, onDelete, onClose }) {
  const [query, setQuery] = useState('');
  const [folded, setFolded] = useState(readFolded);
  const toggle = (cat) => setFolded((prev) => {
    const next = new Set(prev);
    if (next.has(cat)) next.delete(cat); else next.add(cat);
    writeFolded(next);
    return next;
  });
  const categories = useMemo(() => categoriesOf(recipes), [recipes]);
  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () => (q ? recipes.filter((r) => `${r.name} ${r.category ?? ''} ${sourceLine(r)}`.toLowerCase().includes(q)) : recipes),
    [recipes, q],
  );
  const groups = useMemo(() => groupRows(shown), [shown]);
  return (
    <div id="mixer-library" className="panel mixer-panel mixer-library">
      <div className="details-header">
        <span className="icon">folder_open</span>
        <span className="details-title">Mixes</span>
        <span className="mono-small">{recipes.length}</span>
        <span className="sp" />
        <button type="button" className="icon-btn details-close" aria-label="Close" onClick={onClose}>
          <span className="icon">close</span>
        </button>
      </div>
      <input type="text" className="list-search" placeholder="Search mixes…" value={query} spellCheck={false}
        onChange={(e) => setQuery(e.target.value)} />
      <div className="mixer-recipes mixer-lib-list">
        {!recipes.length && <div className="side-note">Nothing saved yet — Save writes a mix into exports/ability/mixer.</div>}
        {recipes.length > 0 && !shown.length && <div className="side-note">Nothing matches “{query.trim()}”.</div>}
        {groups.map((g) => {
          // A search shows every group it hits, so folding is off until it is cleared.
          const open = !!q || !folded.has(g.cat);
          return (
            <div key={g.cat ? `c:${g.cat}` : 'unfiled'} className={`mixer-lib-group${open ? ' open' : ''}`}>
              <div className="mixer-lib-cat" onClick={() => { if (!q) toggle(g.cat); }}>
                <span className="caret icon">chevron_right</span>
                <span className="mixer-lib-cat-name">{g.cat || UNFILED}</span>
                <span className="badge">{g.rows.length}</span>
              </div>
              {open && g.rows.map((r) => (
                <Row key={r.name} r={r} current={r.name === current} onStage={r.name === stageName} categories={categories}
                  onOpen={onOpen} onRename={onRename} onSetCategory={onSetCategory} onDuplicate={onDuplicate} onDelete={onDelete} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
