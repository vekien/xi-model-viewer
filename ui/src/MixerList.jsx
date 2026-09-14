import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Tooltip } from './Tooltip.jsx';
import { LANES, filterCatalog, entryPathForRace } from '../js/mixer.js';
import { walkSections } from '../js/dat.js';

// The mixer's picker: one lane at a time, drawn as the same collapsible tree the
// other lists use. On the Motion lane the character's own animation catalog comes
// first — the Animation panel's categories (General, Basic, Battle, Emote, the
// weapon groups…) — and the ability catalog follows as "All: …" groups. A clip
// pack such as Basic has no `main` routine, so its row expands to the routines the
// DAT holds and each one is a pick of its own. The other lanes show the ability
// catalog alone. While searching, one flat cross-group list with the group as the
// sub-line. The row you click is taken for the lane and the stage plays the mix.

const MAX_RESULTS = 400;   // cap the flat search list so a broad query stays snappy

// Ability-catalog groups in tree order; anything the catalog adds later sorts after.
const CAT_ORDER = ['Job Ability', 'Spell', 'Weapon Skill', 'Weapon Skill (extended)'];
// The animation catalog's general groups come first, in this order; the weapon and
// job groups follow alphabetically.
const ACTION_FIRST = ['General', 'Basic', 'Battle', 'Emote', 'WS (Unreleased)'];
const KIND_ICON = { ja: 'bolt', spell: 'auto_fix_high', ws: 'swords', action: 'directions_run' };

// Survive Mixer ↔ other views: search, open groups and lane stay where you left them.
const mixerListUi = { query: '', openCats: new Set(), openActions: new Set(), lane: 'motion' };
// Routines per action, read once from the DAT(s): spec → [{ id, path }] | 'loading'.
const routineCache = new Map();

const normRel = (p) => String(p ?? '').replace(/\\/g, '/');

function counts(e) {
  const bits = [];
  if (e.clips?.length) bits.push(`${e.clips.length} clip`);
  if (e.gens?.length) bits.push(`${e.gens.length} gen`);
  const snd = (e.sounds?.length ?? 0);
  if (snd) bits.push(`${snd} snd`);
  if (e.total) bits.push(`${e.total} f`);
  return bits.join(' · ');
}

/** Tip text: the spec and section counts for a catalog entry, the DAT(s) for an action. */
function tipFor(entry) {
  if (entry.kind === 'action') return entry.datPaths.map((p) => p.replace(/^ROM\//, '').replace(/\.DAT$/i, '')).join(' · ');
  return [entry.spec, counts(entry)].filter(Boolean).join(' · ');
}

/** The Animation panel's actions as mixer entries, grouped; a weapon skill the ability
 *  catalog also knows (same DAT for this race) is the catalog's entry, so it stays
 *  race-bound and named the same. */
function actionGroups(actions, catalog, race) {
  if (!actions?.length) return [];
  const byPath = new Map();
  for (const e of catalog?.entries ?? []) {
    if (e.kind !== 'ws') continue;
    byPath.set(normRel(entryPathForRace(e, race)).toLowerCase(), e);
  }
  const byGroup = new Map();
  for (const a of actions) {
    const datPaths = (a.paths ?? []).map(normRel);
    if (!datPaths.length) continue;
    const hit = datPaths.length === 1 ? byPath.get(datPaths[0].toLowerCase()) : null;
    const entry = hit ?? {
      spec: datPaths[0], kind: 'action', name: a.label, path: datPaths[0], datPaths, cat: a.group,
    };
    const g = a.group || 'Others';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(entry);
  }
  const rank = (g) => { const i = ACTION_FIRST.indexOf(g); return i < 0 ? ACTION_FIRST.length : i; };
  return [...byGroup.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([g, list]) => ({ id: `act:${g}`, label: g, icon: 'directions_run', entries: list, first: rank(g) < ACTION_FIRST.length }));
}

/** Ability-catalog entries grouped by category, in CAT_ORDER, already lane-filtered. */
function catalogGroups(entries, prefix) {
  const byCat = new Map();
  for (const e of entries) {
    const cat = e.cat || 'Other';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(e);
  }
  const rank = (c) => { const i = CAT_ORDER.indexOf(c); return i < 0 ? CAT_ORDER.length : i; };
  return [...byCat.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([cat, list]) => ({ id: `cat:${cat}`, label: `${prefix}${cat}`, icon: KIND_ICON[list[0]?.kind] ?? 'auto_awesome', entries: list }));
}

/** 0x07 routine tags in a DAT, in file order. */
function routinesIn(buffer) {
  return walkSections(buffer).filter((s) => s.typeCode === 0x07).map((s) => s.id.replace(/[\0 ]+$/, ''));
}

// One line per row: the name, and while searching the group it came from. The
// spec and section counts are the tip — useful when choosing, noise as a column.
function Row({ entry, sub, focused, taken, onPick, expandable, open, onToggle, children }) {
  return (
    <div className={`node${focused ? ' selected' : ''}${open ? ' open' : ''}`} data-spec={entry.spec}>
      <Tooltip content={tipFor(entry)} placement="right" delay={[350, 0]}>
        <div className={`row mixer-row${taken ? ' taken' : ''}`} onClick={() => onPick(entry)}>
          {expandable
            ? <span className="caret icon" onClick={(e) => { e.stopPropagation(); onToggle(entry); }}>chevron_right</span>
            : <span className="caret"><span className="icon" /></span>}
          <span className="kind icon">{KIND_ICON[entry.kind] ?? 'bolt'}</span>
          <span className="effect-name">{entry.name}</span>
          {sub && <span className="mono-small effect-sub">{sub}</span>}
        </div>
      </Tooltip>
      {open && children}
    </div>
  );
}

function Group({ group, open, onToggle, children }) {
  return (
    <div className={`node${open ? ' open' : ''}`}>
      <div className="row" onClick={() => onToggle(group.id)}>
        <span className="caret icon">chevron_right</span>
        <span className="kind icon">{group.icon}</span>
        <span>{group.label}</span>
        <span className="badge">{group.entries.length}</span>
      </div>
      {open && <div className="children">{children}</div>}
    </div>
  );
}

export function MixerList({
  catalog, catalogBusy, onBuildCatalog,
  actions, race, readDat,
  lane, onLane, sources,
  onPick, onClearLane,
}) {
  const [query, setQuery] = useState(() => mixerListUi.query);
  const [openCats, setOpenCats] = useState(() => new Set(mixerListUi.openCats));
  const [openActions, setOpenActions] = useState(() => new Set(mixerListUi.openActions));
  const [, bump] = useState(0);          // re-render when a routine read lands
  const [focus, setFocus] = useState(-1);
  const scrollRef = useRef(null);

  useEffect(() => { mixerListUi.query = query; }, [query]);
  useEffect(() => { mixerListUi.openCats = openCats; }, [openCats]);
  useEffect(() => { mixerListUi.openActions = openActions; }, [openActions]);
  useEffect(() => { mixerListUi.lane = lane; }, [lane]);

  const entries = catalog?.entries ?? [];
  const q = query.trim();
  const motion = lane === 'motion';

  // Everything this lane can use, in catalog order — the tree's population.
  const usable = useMemo(() => filterCatalog(entries, { lane, limit: Infinity }), [entries, lane]);
  const actGroups = useMemo(() => (motion ? actionGroups(actions, catalog, race) : []), [motion, actions, catalog, race]);
  const catGroups = useMemo(() => catalogGroups(usable, motion && actGroups.length ? 'All: ' : ''), [usable, motion, actGroups.length]);

  // Flat, cross-group matches while searching; null means "not searching",
  // which switches the view back to the collapsible tree.
  const results = useMemo(() => {
    if (!q) return null;
    const ql = q.toLowerCase();
    const out = [];
    for (const g of actGroups) {
      const groupHit = g.label.toLowerCase().includes(ql);
      for (const e of g.entries) {
        if (groupHit || e.name.toLowerCase().includes(ql)) out.push({ ...e, cat: g.label });
      }
    }
    if (out.length < MAX_RESULTS) out.push(...filterCatalog(entries, { query: q, lane, limit: MAX_RESULTS - out.length }));
    return out;
  }, [entries, q, lane, actGroups]);

  // The rows on screen, in order — what the arrow keys walk.
  const visible = useMemo(() => {
    if (results) return results;
    const out = [];
    for (const g of [...actGroups, ...catGroups]) if (openCats.has(g.id)) out.push(...g.entries);
    return out;
  }, [results, actGroups, catGroups, openCats]);

  useEffect(() => { setFocus(-1); }, [query, lane]);

  const toggle = (id) => setOpenCats((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  /** The routines an action's DAT(s) hold, read once; 'loading' while the read is out. */
  const routinesFor = (entry) => {
    const have = routineCache.get(entry.spec);
    if (have) return have;
    routineCache.set(entry.spec, 'loading');
    (async () => {
      const out = [];
      for (const path of entry.datPaths) {
        try {
          for (const id of routinesIn(await readDat(path))) out.push({ id, path });
        } catch { /* unreadable DAT: no routines from it */ }
      }
      routineCache.set(entry.spec, out);
      bump((n) => n + 1);
    })();
    return 'loading';
  };

  const toggleAction = (entry) => {
    routinesFor(entry);
    setOpenActions((s) => {
      const n = new Set(s);
      if (n.has(entry.spec)) n.delete(entry.spec); else n.add(entry.spec);
      return n;
    });
  };

  /** A routine of an action: the pick names that DAT and routine; `main` keeps the
   *  action's own name, any other routine is suffixed with it. */
  const pickRoutine = (entry, r) => onPick({
    ...entry, spec: r.path, path: r.path, routine: r.id,
    name: r.id === 'main' ? entry.name : `${entry.name} · ${r.id}`,
  });

  // A click that landed while the DAT was still being read: finished when it arrives.
  const pendingPick = useRef(null);
  const pick = (entry) => {
    setFocus(visible.findIndex((v) => v.spec === entry.spec));
    if (entry.kind !== 'action') { onPick(entry); return; }
    // An action plays its `main` when it has one; a clip pack opens to its routines.
    const rs = routinesFor(entry);
    if (rs === 'loading') { pendingPick.current = entry.spec; return; }
    const main = rs.find((r) => r.id === 'main');
    if (main) pickRoutine(entry, main);
    else setOpenActions((s) => new Set(s).add(entry.spec));
  };
  useEffect(() => {
    const spec = pendingPick.current;
    if (!spec) return;
    const rs = routineCache.get(spec);
    if (!rs || rs === 'loading') return;
    pendingPick.current = null;
    const entry = visible.find((v) => v.spec === spec);
    if (entry) pick(entry);
  });

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
      pick(visible[focus]);
    }
  };

  const current = sources?.[lane];
  const focusedSpec = focus >= 0 ? visible[focus]?.spec : null;
  const isTaken = (entry) => (entry.kind === 'action'
    ? entry.datPaths.includes(current?.spec)
    : current?.spec === entry.spec);

  const renderRow = (e, sub) => {
    const expandable = e.kind === 'action';
    const open = expandable && openActions.has(e.spec);
    const rs = open ? routinesFor(e) : null;
    return (
      <Row key={e.spec} entry={e} sub={sub} focused={e.spec === focusedSpec} taken={isTaken(e)}
        onPick={pick} expandable={expandable} open={open} onToggle={toggleAction}>
        {open && (
          <div className="children">
            {rs === 'loading' && <div className="side-note">Reading routines…</div>}
            {Array.isArray(rs) && rs.length === 0 && <div className="side-note">No routines in this DAT.</div>}
            {Array.isArray(rs) && rs.map((r) => (
              <div key={`${r.path}:${r.id}`} className="node">
                <div className={`row mixer-row${current?.spec === r.path && (current?.routine ?? 'main') === r.id ? ' taken' : ''}`}
                  onClick={() => pickRoutine(e, r)}>
                  <span className="caret"><span className="icon" /></span>
                  <span className="kind icon">schedule</span>
                  <span className="effect-name mono">{r.id}</span>
                  {e.datPaths.length > 1 && <span className="mono-small effect-sub">{r.path.replace(/^ROM\//, '').replace(/\.DAT$/i, '')}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Row>
    );
  };

  // Motion lane: the general groups, a rule, the weapon and job groups, a rule,
  // then the ability catalog. Other lanes: the catalog alone.
  const blocks = [];
  if (actGroups.length) {
    blocks.push(actGroups.filter((g) => g.first), actGroups.filter((g) => !g.first));
  }
  blocks.push(catGroups);

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
            <span className="mono-small">{current.routine && current.routine !== 'main' ? `${current.spec} · ${current.routine}` : current.spec}</span>
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
        <input className="list-search" type="text" placeholder={motion ? 'Search animations, abilities, spells, weapon skills…' : 'Search abilities, spells, weapon skills…'}
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
        {catalog && results && results.map((e) => renderRow(e, e.cat))}
        {catalog && results?.length >= MAX_RESULTS && (
          <div className="side-note">Showing first {MAX_RESULTS} — refine your search.</div>
        )}

        {catalog && !results && blocks.map((groups, i) => (
          groups.length > 0 && (
            <Fragment key={i}>
              {i > 0 && <div className="tree-sep" />}
              {groups.map((g) => (
                <Group key={g.id} group={g} open={openCats.has(g.id)} onToggle={toggle}>
                  {g.entries.map((e) => renderRow(e))}
                </Group>
              ))}
            </Fragment>
          )
        ))}
      </div>
      <div className="mixer-hint mono-small">click a row to use it for this lane · the stage plays the mix so far</div>
    </div>
  );
}
