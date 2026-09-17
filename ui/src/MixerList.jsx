import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Tooltip } from './Tooltip.jsx';
import { DRAG_TYPE } from './MixerTimeline.jsx';
import { LANES, filterCatalog, entryPathForRace } from '../js/mixer.js';
import { parseEntity, groupAnimations } from '../js/dat.js';
import { CLIP_NAMES } from './AnimationPanel.jsx';

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

/** Row identity: the spec, plus the clip ref when several rows share one DAT — the base
 *  motions all reference the one race-base DAT, told apart by their clip. A normal entry
 *  has no `clip`, so this is just its spec. */
const idOf = (e) => (e.clip ? `${e.spec}#${e.clip.ref}` : e.spec);

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
  // A base motion is one clip the actor already carries — name it and the pool it plays from.
  if (entry.pool && entry.clip) return `${entry.clip.ref} · ${entry.clip.frames}f · plays from the actor's own pool (every race)`;
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
    // Two actions can resolve to one catalog entry; a group lists it once, since
    // the row key is the spec and a repeat would be a duplicate key.
    if (!byGroup.get(g).some((e) => e.spec === entry.spec)) byGroup.get(g).push(entry);
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

/**
 * What a motion DAT holds, the way the Animation panel's Motion combo lists it:
 * `clips` are the animations grouped by base id (idl0/idl1/idl2 → idl, played
 * with the client's `idl?` wildcard), `routines` the 0x07 schedules that play
 * clips. Effect-only routines are left out — they are no motion.
 */
function packContents(buffer) {
  const m = parseEntity(buffer);
  const clips = groupAnimations(m.animations).map((g) => ({
    id: g.id,
    ref: g.id.length >= 4 ? g.id : `${g.id}?`,
    frames: g.clip.lengthInFrames || 1,
    parts: g.clip.parts?.length ?? 1,
  }));
  const routines = m.schedules.filter((s) => s.clipIds?.length).map((s) => ({ id: s.id, clips: s.clipIds.length }));
  return { clips, routines };
}

/** The + on a row: the entry onto the active track. Click on the row itself previews. */
function AddButton({ tip, onAdd }) {
  return (
    <Tooltip content={tip} placement="right">
      <button type="button" className="pc-tbtn mixer-add" aria-label={tip}
        onClick={(e) => { e.stopPropagation(); onAdd(); }} onPointerDown={(e) => e.stopPropagation()}>
        <span className="icon">add</span>
      </button>
    </Tooltip>
  );
}

/** Drag start for a row: the entry as the pick would send it, typed by lane kind. */
function startEntryDrag(e, dragType, payload) {
  e.dataTransfer.setData(dragType, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = 'copy';
}

// One line per row: the name, and while searching the group it came from. The
// spec and section counts are the tip — useful when choosing, noise as a column.
// A click previews the entry on the stage; the + adds it to the active track;
// the row can be dragged onto a timeline track of its kind.
function Row({ entry, sub, focused, taken, onPreview, onAdd, addTip, dragType, payload, expandable, open, onToggle, children }) {
  return (
    <div className={`node${focused ? ' selected' : ''}${open ? ' open' : ''}`} data-spec={idOf(entry)}>
      <Tooltip content={tipFor(entry)} placement="right" delay={[350, 0]}>
        <div className={`row mixer-row${taken ? ' taken' : ''}`} onClick={() => onPreview(entry)}
          draggable onDragStart={(e) => startEntryDrag(e, dragType, payload())}>
          {expandable
            ? <span className="caret icon" onClick={(e) => { e.stopPropagation(); onToggle(entry); }}>chevron_right</span>
            : <span className="caret"><span className="icon" /></span>}
          <span className="kind icon">{KIND_ICON[entry.kind] ?? 'bolt'}</span>
          <span className="effect-name">{entry.name}</span>
          {sub && <span className="mono-small effect-sub">{sub}</span>}
          <AddButton tip={addTip} onAdd={() => onAdd(entry)} />
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
  lane, onLane, kind = 'ws',
  onPick, onPreview, trackLabel = '',
}) {
  const addTip = `Add to track: ${trackLabel || 'Motion'}`;
  const dragType = `${DRAG_TYPE}${lane}`;
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

  // A job ability or spell can only use motion that lives in the always-loaded race
  // base (referenced, not baked). Rather than list every spell whose motion is really
  // one of a few base casts, the motion lane shows the curated base-motion list
  // (abilities.json `base_motions`, one row per cast / ability motion). WS bakes anything
  // per race, so it shows the full list. Only the motion lane narrows.
  // Every motion is listed on every type. On a job ability or spell the base-pool casts
  // lead as a shortlist — they are referenced by name and proven. Anything else (an emote,
  // a weapon skill, a race's own motion) would be BAKED from one race's copy into the single
  // DAT, which is experimental and unverified in game (the timeline says so); a weapon
  // skill is the proven route for a unique motion.
  const showBase = motion && (kind === 'ja' || kind === 'spell');
  // The base motions, as pick entries: a bare clip pack (`routine: null`), `pool: true`
  // so a preview plays the clip from the actor's own pool. Picking one sets the mix Type.
  const baseMotions = useMemo(
    () => (catalog?.base_motions ?? []).map((b) => ({ ...b, routine: null, pool: true })),
    [catalog]);
  // Everything this lane can use, in catalog order — the tree's population.
  const usable = useMemo(() => filterCatalog(entries, { lane, limit: Infinity }), [entries, lane]);
  const actGroups = useMemo(() => (motion ? actionGroups(actions, catalog, race) : []), [motion, actions, catalog, race]);
  const catGroups = useMemo(() => catalogGroups(usable, motion && actGroups.length ? 'All: ' : ''), [usable, motion, actGroups.length]);

  // Flat, cross-group matches while searching; null means "not searching",
  // which switches the view back to the collapsible tree. Each spec once: a
  // weapon skill sits in its weapon group AND in the catalog, and the row key
  // is the spec — listed twice it was a duplicate key, which left React's DOM
  // with rows that piled up on every keystroke and outlived the search.
  const results = useMemo(() => {
    if (!q) return null;
    const ql = q.toLowerCase();
    const out = [];
    const seen = new Set();
    const take = (e) => { if (!seen.has(idOf(e))) { seen.add(idOf(e)); out.push(e); } };
    for (const g of actGroups) {
      const groupHit = g.label.toLowerCase().includes(ql);
      for (const e of g.entries) {
        if (groupHit || e.name.toLowerCase().includes(ql)) take({ ...e, cat: g.label });
      }
    }
    // The base-motion shortlist joins the search on ja/spell, matched by name.
    if (showBase) for (const e of baseMotions) if (e.name.toLowerCase().includes(ql)) take(e);
    for (const e of filterCatalog(entries, { query: q, lane, limit: MAX_RESULTS })) {
      if (out.length >= MAX_RESULTS) break;
      take(e);
    }
    return out;
  }, [entries, q, lane, actGroups, showBase, baseMotions]);

  // The rows on screen, in order — what the arrow keys walk.
  const visible = useMemo(() => {
    if (results) return results;
    // The base-motion shortlist is drawn open on ja/spell, so it walks with the arrows.
    const out = showBase ? [...baseMotions] : [];
    for (const g of [...actGroups, ...catGroups]) if (openCats.has(g.id)) out.push(...g.entries);
    return out;
  }, [results, showBase, baseMotions, actGroups, catGroups, openCats]);

  useEffect(() => { setFocus(-1); }, [query, lane]);

  const toggle = (id) => setOpenCats((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  /** The clips and routines an action's DAT(s) hold, read once; 'loading' while the
   *  read is out. Each carries the DAT it came from — a set (the emotes) spans several. */
  const routinesFor = (entry) => {
    const have = routineCache.get(entry.spec);
    if (have) return have;
    routineCache.set(entry.spec, 'loading');
    (async () => {
      const out = { clips: [], routines: [] };
      for (const path of entry.datPaths) {
        try {
          const { clips, routines } = packContents(await readDat(path));
          out.clips.push(...clips.map((c) => ({ ...c, path })));
          out.routines.push(...routines.map((r) => ({ ...r, path })));
        } catch { /* unreadable DAT: nothing from it */ }
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

  /** A routine of an action, as the pick sends it: that DAT and routine; `main` keeps
   *  the action's own name, any other routine is suffixed with it. */
  const routineEntry = (entry, r) => ({
    ...entry, spec: r.path, path: r.path, routine: r.id,
    name: r.id === 'main' ? entry.name : `${entry.name} · ${r.id}`,
  });
  /** A bare clip: no routine to inspect — the app makes it one PlayClip event. */
  const clipEntry = (entry, c) => ({
    ...entry, spec: c.path, path: c.path, routine: null,
    clip: { id: c.id, ref: c.ref, frames: c.frames }, name: `${entry.name} · ${c.id}`,
  });

  // Resolve a row to the entry the app gets, then hand it on: an action plays
  // its `main` when it has one, a clip pack opens to its routines instead. A
  // click that lands while the DAT is still being read finishes when it arrives.
  const pendingPick = useRef(null);
  const withResolved = (entry, fn) => {
    setFocus(visible.findIndex((v) => idOf(v) === idOf(entry)));
    if (entry.kind !== 'action') { fn(entry); return; }
    const rs = routinesFor(entry);
    if (rs === 'loading') { pendingPick.current = { spec: entry.spec, fn }; return; }
    const main = rs.routines.find((r) => r.id === 'main');
    if (main) fn(routineEntry(entry, main));
    else setOpenActions((s) => new Set(s).add(entry.spec));
  };
  const add = (entry) => withResolved(entry, (e) => onPick(e));
  const preview = (entry) => withResolved(entry, (e) => onPreview?.(e));
  /** What a dragged action row carries: its `main` when the DAT has been read, else the action as is. */
  const dragEntry = (entry) => {
    if (entry.kind !== 'action') return entry;
    const rs = routineCache.get(entry.spec);
    const main = rs && rs !== 'loading' ? rs.routines.find((r) => r.id === 'main') : null;
    return main ? routineEntry(entry, main) : { ...entry, routine: 'main' };
  };
  useEffect(() => {
    const pending = pendingPick.current;
    if (!pending) return;
    const rs = routineCache.get(pending.spec);
    if (!rs || rs === 'loading') return;
    pendingPick.current = null;
    const entry = visible.find((v) => v.spec === pending.spec);
    if (entry) withResolved(entry, pending.fn);
  });

  const onKey = (e) => {
    if (!visible.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown'
        ? Math.min(visible.length - 1, focus + 1)
        : Math.max(0, focus - 1);
      setFocus(next);
      const spec = visible[next] ? idOf(visible[next]) : null;
      const el = spec ? scrollRef.current?.querySelector(`.node[data-spec="${CSS.escape(spec)}"]`) : null;
      el?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && focus >= 0) {
      e.preventDefault();
      preview(visible[focus]);
    }
  };

  const current = null;   // the track's source is on the timeline's label, with its own X
  const focusedId = focus >= 0 && visible[focus] ? idOf(visible[focus]) : null;
  const isTaken = (entry) => (entry.kind === 'action'
    ? entry.datPaths.includes(current?.spec)
    : current?.spec === entry.spec);

  const renderRow = (e, sub) => {
    const expandable = e.kind === 'action';
    const open = expandable && openActions.has(e.spec);
    const rs = open ? routinesFor(e) : null;
    return (
      <Row key={idOf(e)} entry={e} sub={sub} focused={idOf(e) === focusedId} taken={isTaken(e)}
        onPreview={preview} onAdd={add} addTip={addTip} dragType={dragType} payload={() => dragEntry(e)}
        expandable={expandable} open={open} onToggle={toggleAction}>
        {open && (
          <div className="children">
            {rs === 'loading' && <div className="side-note">Reading the DAT…</div>}
            {rs && rs !== 'loading' && !rs.clips.length && !rs.routines.length && <div className="side-note">No motion in this DAT.</div>}
            {rs && rs !== 'loading' && rs.clips.length > 0 && <div className="side-separator">Animations</div>}
            {rs && rs !== 'loading' && rs.clips.map((c) => (
              <div key={`${c.path}:${c.id}`} className="node">
                <div className={`row mixer-row${current?.name === `${e.name} · ${c.id}` && current?.spec === c.path ? ' taken' : ''}`}
                  onClick={() => onPreview?.(clipEntry(e, c))}
                  draggable onDragStart={(ev) => startEntryDrag(ev, dragType, clipEntry(e, c))}>
                  <span className="caret"><span className="icon" /></span>
                  <span className="kind icon">animation</span>
                  <span className="effect-name mono">{CLIP_NAMES[c.id] ? `${c.id} — ${CLIP_NAMES[c.id]}` : c.id}</span>
                  {e.datPaths.length > 1 && <span className="mono-small effect-sub">{c.path.replace(/^ROM\//, '').replace(/\.DAT$/i, '')}</span>}
                  {c.parts > 1 && <span className="badge">{c.parts}</span>}
                  <AddButton tip={addTip} onAdd={() => onPick(clipEntry(e, c))} />
                </div>
              </div>
            ))}
            {rs && rs !== 'loading' && rs.routines.length > 0 && <div className="side-separator">Schedules</div>}
            {rs && rs !== 'loading' && rs.routines.map((r) => (
              <div key={`${r.path}:${r.id}`} className="node">
                <div className={`row mixer-row${current?.spec === r.path && (current?.routine ?? 'main') === r.id ? ' taken' : ''}`}
                  onClick={() => onPreview?.(routineEntry(e, r))}
                  draggable onDragStart={(ev) => startEntryDrag(ev, dragType, routineEntry(e, r))}>
                  <span className="caret"><span className="icon" /></span>
                  <span className="kind icon">schedule</span>
                  <span className="effect-name mono">{r.id}</span>
                  {e.datPaths.length > 1 && <span className="mono-small effect-sub">{r.path.replace(/^ROM\//, '').replace(/\.DAT$/i, '')}</span>}
                  {r.clips > 1 && <span className="badge">{r.clips}</span>}
                  <AddButton tip={addTip} onAdd={() => onPick(routineEntry(e, r))} />
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

        {/* The base-motion shortlist (ja/spell) is a handful of rows: show it flat and
            open, not folded into a single collapsed group. */}
        {catalog && !results && showBase && baseMotions.length > 0 && (
          <>
            <div className="side-separator">Ability &amp; spell casts · from the actor’s pool</div>
            {baseMotions.map((e) => renderRow(e))}
            <div className="tree-sep" />
          </>
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
    </div>
  );
}
