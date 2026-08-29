import { useEffect, useMemo, useState } from 'react';
import { Combo } from './Combo.jsx';
import { NpcList } from './NpcList.jsx';

/**
 * Effects-only actor picker under Options: Character (race/face/body/gearset)
 * or NPC list. Switching a PC slot loads the character; picking an NPC loads it.
 */
export function EffectActorsPanel({
  tab, onTab,
  pc,
  selectedPath,
  onSelectNpc,
}) {
  return (
    <div id="effect-actors" className="panel">
      <div className="panel-title">
        <span className="icon">groups</span>
        Actors
      </div>

      <div className="seg-tabs" role="tablist">
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
        {tab === 'pc' && <EffectPcStrip pc={pc} />}
        {tab === 'npc' && (
          <div className="fx-actor-npc">
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

function EffectPcStrip({ pc }) {
  const {
    races, race, setRace, slots, sel, setSel, applyGearSet,
  } = pc ?? {};
  const raceItems = useMemo(
    () => (races ?? []).map((r) => ({ id: r.id, label: r.label })),
    [races],
  );
  const faceItems = slots?.face ?? [];
  const bodyItems = slots?.body ?? [];
  const mainItems = slots?.main ?? [];

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

  return (
    <div className="fx-actor-pc">
      <div className="pc-ctrl">
        <span className="pc-ctrl-label">Race</span>
        <Combo value={race} items={raceItems} onChange={setRace} />
      </div>
      {faceItems.length > 0 && (
        <div className="pc-ctrl">
          <span className="pc-ctrl-label">Face</span>
          <Combo value={sel?.face} items={faceItems} onChange={pick('face')} />
        </div>
      )}
      {bodyItems.length > 0 && (
        <div className="pc-ctrl">
          <span className="pc-ctrl-label">Body</span>
          <Combo value={sel?.body} items={bodyItems} onChange={pick('body')} groupByType />
        </div>
      )}
      {mainItems.length > 0 && (
        <div className="pc-ctrl">
          <span className="pc-ctrl-label">Main</span>
          <Combo value={sel?.main} items={mainItems} onChange={pick('main')} groupByType />
        </div>
      )}
      <div className="pc-ctrl">
        <span className="pc-ctrl-label">Gearset</span>
        <Combo value={gearId} items={gearItems} onChange={onGear} placeholder="— none —" />
      </div>
    </div>
  );
}
