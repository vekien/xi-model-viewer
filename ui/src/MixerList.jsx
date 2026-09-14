import { useEffect, useMemo, useRef, useState } from 'react';
import { Tooltip } from './Tooltip.jsx';
import { LANES, filterCatalog } from '../js/mixer.js';

// The mixer's picker: one lane at a time, the catalog as the same collapsible
// tree the other lists draw (one group per category — Job Ability, Spell, Weapon
// Skill…), a flat cross-group list while searching, and the row you click is
// taken for the lane and played on the stage with the mix so far.

const MAX_RESULTS = 400;   // cap the flat search list so a broad query stays snappy

// Category order in the tree; anything the catalog adds later sorts after these.
const CAT_ORDER = ['Job Ability', 'Spell', 'Weapon Skill', 'Weapon Skill (extended)'];
const KIND_ICON = { ja: 'bolt', spell: 'auto_fix_high', ws: 'swords' };

// Survive Mixer ↔ other views: search, open groups and lane stay where you left them.
const mixerListUi = { query: '', openCats: new Set(), lane: 'motion' };

function counts(e) {
  const bits = [];
  if (e.clips?.length) bits.push(`${e.clips.length} clip`);
  if (e.gens?.length) bits.push(`${e.gens.length} gen`);
  const snd = (e.sounds?.length ?? 0);
  if (snd) bits.push(`${snd} snd`);
  if (e.total) bits.push(`${e.total} f`);
  return bits.join(' · ');
}

// One line per row: the name, and while searching the group it came from. The
// spec and section counts are the tip — useful when choosing, noise as a column.
function Row({ entry, sub, focused, taken, onPick }) {
  return (
    <div className={`node${focused ? ' selected' : ''}`} data-spec={entry.spec}>
      <Tooltip content={[entry.spec, counts(entry)].filter(Boolean).join(' · ')} placement="right" delay={[350, 0]}>
        <div className={`row mixer-row${taken ? ' taken' : ''}`} onClick={() => onPick(entry)}>
          <span className="caret"><span className="icon" /></span>
          <span className="kind icon">{KIND_ICON[entry.kind] ?? 'bolt'}</span>
          <span className="effect-name">{entry.name}</span>
          {sub && <span className="mono-small effect-sub">{sub}</span>}
        </div>
      </Tooltip>
    </div>
  );
}

/** Entries grouped by catalog category, in CAT_ORDER, each group already lane-filtered. */
function groupByCat(entries) {
  const byCat = new Map();
  for (const e of entries) {
    const cat = e.cat || 'Other';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(e);
  }
  const rank = (c) => { const i = CAT_ORDER.indexOf(c); return i < 0 ? CAT_ORDER.length : i; };
  return [...byCat.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([cat, list]) => ({ id: cat, label: cat, kind: list[0]?.kind, entries: list }));
}

export function MixerList({
  catalog, catalogBusy, onBuildCatalog,
  lane, onLane, sources,
  onPick, onClearLane,
}) {
  const [query, setQuery] = useState(() => mixerListUi.query);
  const [openCats, setOpenCats] = useState(() => new Set(mixerListUi.openCats));
  const [focus, setFocus] = useState(-1);
  const scrollRef = useRef(null);

  useEffect(() => { mixerListUi.query = query; }, [query]);
  useEffect(() => { mixerListUi.openCats = openCats; }, [openCats]);
  useEffect(() => { mixerListUi.lane = lane; }, [lane]);

  const entries = catalog?.entries ?? [];
  const q = query.trim();

  // Everything this lane can use, in catalog order — the tree's population.
  const usable = useMemo(() => filterCatalog(entries, { lane, limit: Infinity }), [entries, lane]);
  const groups = useMemo(() => groupByCat(usable), [usable]);

  // Flat, cross-group matches while searching; null means "not searching",
  // which switches the view back to the collapsible tree.
  const results = useMemo(
    () => (q ? filterCatalog(entries, { query: q, lane, limit: MAX_RESULTS }) : null),
    [entries, q, lane],
  );

  // The rows on screen, in order — what the arrow keys walk.
  const visible = useMemo(() => {
    if (results) return results;
    const out = [];
    for (const g of groups) if (openCats.has(g.id)) out.push(...g.entries);
    return out;
  }, [results, groups, openCats]);

  useEffect(() => { setFocus(-1); }, [query, lane]);

  const onKey = (e) => {
    if (!visible.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown'
        ? Math.min(visible.length - 1, focus + 1)
        : Math.max(0, focus - 1);
      setFocus(next);
      const spec = visible[next]?.spec;
      const el = spec ? scrollRef.current?.querySelector(`.node[data-spec="${CSS.escape(spec)}"]`) : null;
      el?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && focus >= 0) {
      e.preventDefault();
      onPick(visible[focus]);
    }
  };

  const toggle = (id) => setOpenCats((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const current = sources?.[lane];
  const focusedSpec = focus >= 0 ? visible[focus]?.spec : null;
  const pick = (entry) => { setFocus(visible.findIndex((v) => v.spec === entry.spec)); onPick(entry); };

  return (
    <div id="tree" className="panel list-panel mixer-list">
      <div className="seg-tabs mixer-lane-tabs" role="tablist">
        {LANES.map((l) => (
          <button key={l.id} type="button" role="tab"
            className={`seg-tab${lane === l.id ? ' on' : ''}`}
            aria-selected={lane === l.id}
            style={{ '--lane': l.color }}
            onClick={() => onLane(l.id)}>
            <span className="mixer-lane-dot" />{l.label}
          </button>
        ))}
      </div>

      <div className="mixer-current">
        {current ? (
          <>
            <span className="mixer-current-name">{current.name ?? current.spec}</span>
            <span className="mono-small">{current.spec}</span>
            <Tooltip content="Clear this lane">
              <button type="button" className="pc-tbtn" onClick={() => onClearLane(lane)}>
                <span className="icon">close</span>
              </button>
            </Tooltip>
          </>
        ) : (
          <span className="side-note">No {LANES.find((l) => l.id === lane)?.label.toLowerCase()} source yet — open a group and click a row to take it.</span>
        )}
      </div>

      <div className="list-search-wrap">
        <input className="list-search" type="text" placeholder="Search abilities, spells, weapon skills…"
          value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} spellCheck={false} />
        {query && (
          <Tooltip content="Clear">
            <button className="list-search-clear" onClick={() => setQuery('')}>
              <span className="icon">close</span>
            </button>
          </Tooltip>
        )}
      </div>

      <div className="list-scroll" ref={scrollRef} tabIndex={0} onKeyDown={onKey}>
        {!catalog && (
          <div className="side-note mixer-empty">
            <p>The pick list is <span className="mono">abilities.json</span>, baked by <span className="mono">xi mv update --only abilities</span> like the other lists — every job ability, spell and weapon skill with its generators, sounds and clips. This build has none yet; building it here takes about a minute.</p>
            <button type="button" className="mixer-btn" disabled={catalogBusy} onClick={onBuildCatalog}>
              {catalogBusy ? 'Building…' : 'Build catalog'}
            </button>
          </div>
        )}

        {catalog && results && results.length === 0 && (
          <div className="side-note">Nothing matches “{query}”.</div>
        )}
        {catalog && results && results.map((e) => (
          <Row key={e.spec} entry={e} sub={e.cat}
            focused={e.spec === focusedSpec} taken={current?.spec === e.spec} onPick={pick} />
        ))}
        {catalog && results?.length >= MAX_RESULTS && (
          <div className="side-note">Showing first {MAX_RESULTS} — refine your search.</div>
        )}

        {catalog && !results && groups.map((g) => (
          <div key={g.id} className={`node${openCats.has(g.id) ? ' open' : ''}`}>
            <div className="row" onClick={() => toggle(g.id)}>
              <span className="caret icon">chevron_right</span>
              <span className="kind icon">{KIND_ICON[g.kind] ?? 'auto_awesome'}</span>
              <span>{g.label}</span>
              <span className="badge">{g.entries.length}</span>
            </div>
            {openCats.has(g.id) && (
              <div className="children">
                {g.entries.map((e) => (
                  <Row key={e.spec} entry={e}
                    focused={e.spec === focusedSpec} taken={current?.spec === e.spec} onPick={pick} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="mixer-hint mono-small">click a row to use it for this lane · the stage plays the mix so far</div>
    </div>
  );
}
