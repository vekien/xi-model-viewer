import { useEffect, useMemo, useState } from 'react';
import { Combo } from './Combo.jsx';
import { NpcList } from './NpcList.jsx';
import { Tooltip } from './Tooltip.jsx';

/**
 * Effects-only actor picker under Options: None (bare effect), Character
 * (full gear) or NPC list.
 */
export function EffectActorsPanel({
  tab, onTab,
  pc,
  selectedPath,
  onSelectNpc,
  onClose,
}) {
  return (
    <div id="effect-actors" className="panel">
      <div className="details-header">
        <span className="icon">groups</span>
        <span className="details-title">Actors</span>
        {onClose && (
          <Tooltip content="Close">
            <button type="button" className="icon-btn details-close" onClick={onClose}>
              <span className="icon">close</span>
            </button>
          </Tooltip>
        )}
      </div>

      <div className="seg-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className={`seg-tab${tab === 'none' ? ' on' : ''}`}
          aria-selected={tab === 'none'}
          onClick={() => onTab('none')}
        >
          None
        </button>
        <button
          type="button"
          role="tab"
          className={`seg-tab${tab === 'pc' ? ' on' : ''}`}
          aria-selected={tab === 'pc'}
          onClick={() => onTab('pc')}
        >
          Character
        </button>
        <button
          type="button"
          role="tab"
          className={`seg-tab${tab === 'npc' ? ' on' : ''}`}
          aria-selected={tab === 'npc'}
          onClick={() => onTab('npc')}
        >
          NPC
        </button>
      </div>

      <div className="fx-actor-body">
        {tab === 'none' && <div className="side-note">Effect plays on the empty stage.</div>}
        {tab === 'pc' && <EffectPcStrip pc={pc} />}
        {tab === 'npc' && (
          <div className="fx-actor-npc plc-list-shell">
            <NpcList
              onSelectEntry={onSelectNpc}
              selectedPath={selectedPath}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** Same slots as CharacterList (face + weapons + armor). */
const PC_SLOTS = [
  { key: 'face', label: 'Face', section: null },
  { key: 'main', label: 'Main', section: 'Weapon' },
  { key: 'sub', label: 'Sub', section: 'Weapon' },
  { key: 'range', label: 'Ranged', section: 'Weapon' },
  { key: 'head', label: 'Head', section: 'Armor' },
  { key: 'body', label: 'Body', section: 'Armor' },
  { key: 'hands', label: 'Hands', section: 'Armor' },
  { key: 'legs', label: 'Legs', section: 'Armor' },
  { key: 'feet', label: 'Feet', section: 'Armor' },
];

export function EffectPcStrip({ pc, gearsetsFirst = false }) {
  const {
    races, race, setRace, slots, sel, setSel, applyGearSet,
  } = pc ?? {};
  const raceItems = useMemo(
    () => (races ?? []).map((r) => ({ id: r.id, label: r.label })),
    [races],
  );

  const gearItems = useMemo(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('pcGearSets') || 'null');
      const sets = Array.isArray(raw?.sets) ? raw.sets : (Array.isArray(raw) ? raw : []);
      return [
        { id: '', label: '— none —' },
        ...sets
          .filter((s) => s?.id && s?.name)
          .map((s) => ({
            id: s.id,
            label: s.race && s.race !== race ? `${s.name} (${s.race})` : s.name,
            set: s,
          })),
      ];
    } catch {
      return [{ id: '', label: '— none —' }];
    }
  }, [race, sel, slots]); // refresh when look changes (save elsewhere)

  const [gearId, setGearId] = useState('');

  // Drop selection if the set was deleted.
  useEffect(() => {
    if (gearId && !gearItems.some((g) => g.id === gearId)) setGearId('');
  }, [gearId, gearItems]);

  if (races === null) {
    return <div className="side-note">Loading character lists…</div>;
  }
  if (!races?.length) {
    return <div className="side-note">No PC lists found.</div>;
  }

  const pick = (key) => (id) => setSel((s) => ({ ...s, [key]: id }));

  const onGear = (id) => {
    setGearId(id);
    const entry = gearItems.find((g) => g.id === id)?.set;
    if (entry) applyGearSet?.(entry);
  };

  const slotRow = (s) => {
    const items = slots?.[s.key];
    if (!items?.length) return null;
    const typed = s.section === 'Weapon' || s.section === 'Armor';
    return (
      <div className="pc-ctrl" key={s.key}>
        <span className="pc-ctrl-label">{s.label}</span>
        <Combo value={sel?.[s.key]} items={items} onChange={pick(s.key)} groupByType={typed} />
      </div>
    );
  };

  const section = (name) => {
    const rows = PC_SLOTS.filter((s) => s.section === name).map(slotRow).filter(Boolean);
    if (!rows.length) return null;
    return (
      <div className="fx-actor-section" key={name}>
        <div className="fx-actor-sec-title">{name}</div>
        {rows}
      </div>
    );
  };

  const gearRow = (label) => (
    <div className="pc-ctrl">
      <span className="pc-ctrl-label">{label}</span>
      <Combo value={gearId} items={gearItems} onChange={onGear} placeholder="— none —" />
    </div>
  );

  return (
    <div className="fx-actor-pc">
      {gearsetsFirst && gearRow('Gearsets')}
      <div className="pc-ctrl">
        <span className="pc-ctrl-label">Race</span>
        <Combo value={race} items={raceItems} onChange={setRace} />
      </div>
      {slotRow(PC_SLOTS[0]) /* Face */}
      {section('Weapon')}
      {section('Armor')}
      {!gearsetsFirst && gearRow('Gearset')}
    </div>
  );
}
