import { useEffect, useMemo, useRef, useState } from 'react';
import { Tooltip } from './Tooltip.jsx';
import { LANES, filterCatalog } from '../js/mixer.js';

// The mixer's picker: one lane at a time, a searchable list of every job ability,
// spell and weapon skill, and — the point of it — the row under the cursor plays on
// the stage. Hover or arrow to browse, click or Enter to take it for the lane.

const KINDS = [
  { id: 'ja', label: 'Ability' },
  { id: 'spell', label: 'Spell' },
  { id: 'ws', label: 'Weapon Skill' },
];

const mixerListUi = { query: '', kinds: new Set(), lane: 'motion' };

function counts(e) {
  const bits = [];
  if (e.clips?.length) bits.push(`${e.clips.length} clip`);
  if (e.gens?.length) bits.push(`${e.gens.length} gen`);
  const snd = (e.sounds?.length ?? 0);
  if (snd) bits.push(`${snd} snd`);
  if (e.total) bits.push(`${e.total} f`);
  return bits.join(' · ');
}

function Row({ entry, focused, taken, onPick }) {
  return (
    <div className={`node${focused ? ' selected' : ''}`}>
      <div className={`row mixer-row${taken ? ' taken' : ''}`}
        onClick={() => onPick(entry)}>
        <span className="caret"><span className="icon" /></span>
        <span className="kind icon">{entry.kind === 'ws' ? 'swords' : entry.kind === 'spell' ? 'auto_fix_high' : 'bolt'}</span>
        <span className="effect-name">{entry.name}</span>
        <span className="mono-small effect-sub">{counts(entry)}</span>
        <span className="mono-small effect-id">{entry.spec}</span>
      </div>
    </div>
  );
}

export function MixerList({
  catalog, catalogBusy, onBuildCatalog,
  lane, onLane, sources,
  onPick, onClearLane,
}) {
  const [query, setQuery] = useState(() => mixerListUi.query);
  const [kinds, setKinds] = useState(() => new Set(mixerListUi.kinds));
  const [focus, setFocus] = useState(-1);
  const scrollRef = useRef(null);

  useEffect(() => { mixerListUi.query = query; }, [query]);
  useEffect(() => { mixerListUi.kinds = kinds; }, [kinds]);
  useEffect(() => { mixerListUi.lane = lane; }, [lane]);

  const entries = catalog?.entries ?? [];
  const results = useMemo(
    () => filterCatalog(entries, { query, kinds, lane }),
    [entries, query, kinds, lane],
  );

  useEffect(() => { setFocus(-1); }, [query, kinds, lane]);

  const onKey = (e) => {
    if (!results.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown'
        ? Math.min(results.length - 1, focus + 1)
        : Math.max(0, focus - 1);
      setFocus(next);
      const el = scrollRef.current?.querySelectorAll('.node')[next];
      el?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && focus >= 0) {
      e.preventDefault();
      onPick(results[focus]);
    }
  };

  const toggleKind = (id) => setKinds((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const current = sources?.[lane];

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
          <span className="side-note">No {LANES.find((l) => l.id === lane)?.label.toLowerCase()} source yet — hover a row to preview, click to take it.</span>
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
      <div className="mixer-kinds">
        {KINDS.map((k) => (
          <button key={k.id} type="button" className={`mixer-chip${kinds.has(k.id) ? ' on' : ''}`}
            onClick={() => toggleKind(k.id)}>{k.label}</button>
        ))}
        <span className="mono-small mixer-count">{results.length}</span>
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
        {catalog && results.length === 0 && <div className="side-note">Nothing matches.</div>}
        {catalog && results.map((e, i) => (
          <Row key={e.spec} entry={e}
            focused={i === focus}
            taken={current?.spec === e.spec}
            onPick={(entry) => { setFocus(i); onPick(entry); }} />
        ))}
      </div>
      <div className="mixer-hint mono-small">click a row to use it for this lane · the stage plays the mix so far</div>
    </div>
  );
}
