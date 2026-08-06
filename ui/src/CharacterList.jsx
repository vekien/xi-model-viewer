import { useCallback, useEffect, useRef, useState } from 'react';
import { Combo } from './Combo.jsx';
import { Tooltip } from './Tooltip.jsx';

// All character data comes fully resolved from lists/characters.json (baked by
// dev/bake-lists.mjs): races with base skeleton + per-weapon-type battle-idle
// DATs, per-race gear/face items, and actions (Basic + Battle styles + weapon
// skills) with every motion DAT already attached. No CSV/spec parsing here.

const SLOTS = [
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

// Look string (20-byte little-endian blob, hex-encoded to 40 chars).
// size=1 (equipped), face, race number, then 8 slot words each = (slotIdx << 12) | modelId.
const RACE_LOOK_NUM = {
  HumeM: 1, HumeF: 2, ElvaanM: 3, ElvaanF: 4, Tarutaru: 5, Mithra: 7, Galka: 8,
};
const LOOK_SLOT_ORDER  = ['head', 'body', 'hands', 'legs', 'feet', 'main', 'sub', 'range'];
const LOOK_SLOT_IDX    = { head: 1, body: 2, hands: 3, legs: 4, feet: 5, main: 6, sub: 7, range: 8 };
const LOOK_SLOT_OFFSET = { head: 0x04, body: 0x06, hands: 0x08, legs: 0x0A, feet: 0x0C, main: 0x0E, sub: 0x10, range: 0x12 };

// An item's `id` is "<rowIndex>:<spec>" (e.g. "12:137/11"), so parseInt(id) yields the
// ROW INDEX, not the model id — those only coincide for faces, whose rows happen to be
// sequential. Every item carries its real equipment model id as `mid` (baked in by
// dev/bake-lists.mjs from dev/gear-models.json); use it.
//
// `useAlt` selects the alternate equipment table: Tarutaru is one viewer race spanning two
// look races (5 male / 6 female — its "gender" is only the face), and the two tables assign
// DIFFERENT model ids to the same armour DAT, so a female-faced Taru must encode the female
// table's ids (`midAlt`) throughout.
const modelIdOf = (item, useAlt) => {
  if (!item) return 0;
  const id = useAlt && Number.isFinite(item.midAlt) ? item.midAlt : item.mid;
  return Number.isFinite(id) ? id : 0;
};

// ---------------------------------------------------------------------------

// Gear families worth their own section in the armour dropdowns. Order here is
// the order they appear under the plain run. Weapons and faces match none of
// these and keep their own groups (weapon type).
const GEAR_SECTIONS = ['Artifact', 'Relic', 'Empyrean', 'Ebur', 'Furia', 'Ebon'];

/** A-Z, but "None" stays pinned to the top of its group rather than sorting
 *  into the N's. Numeric collation keeps the id-style labels ("29/21",
 *  "183/67") in count order instead of 1-before-2-before-9. */
function byLabel(a, b) {
  const isNone = (it) => it.label.toLowerCase() === 'none';
  if (isNone(a) !== isNone(b)) return isNone(a) ? -1 : 1;
  return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Sort inside each group without moving the groups themselves — they stay in
 * the order they first appear, so weapon types keep their run and stay
 * contiguous (groupRows only heads a section when the group *changes*).
 */
function sortWithinGroups(items) {
  const order = [];
  const groups = new Map();
  for (const it of items) {
    const key = it.group ?? '';
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key).push(it);
  }
  return order.flatMap((key) => groups.get(key).sort(byLabel));
}

/** "Fighter's Lorica (WAR Artifact)" -> Artifact; "Ebur Cuirass" -> Ebur. */
function gearSection(label) {
  // Reforged sets carry job + tier in a trailing parenthetical. One entry reads
  // "(RUN AF@)" — the same Artifact tier, mis-typed in the source list.
  const tier = label.match(/\(\w+ (Artifact|Relic|Empyrean|AF@)\)$/);
  if (tier) return tier[1] === 'AF@' ? 'Artifact' : tier[1];
  const family = label.match(/^(Ebur|Furia|Ebon)\b/);
  return family ? family[1] : null;
}

/**
 * Plain gear first, then one section per family, everything A-Z within its own
 * section. The families can't just be labelled where they lie: the three colour
 * variants are stored piece by piece, so Ebon/Furia/Ebur alternate all the way
 * down the list and only gathering them makes a section.
 *
 * Sorts a copy throughout — the source arrays live in raceData and are re-read
 * on every race switch.
 */
function orderSlotItems(items) {
  const found = new Map(GEAR_SECTIONS.map((name) => [name, []]));
  const plain = [];
  for (const it of items) {
    const name = gearSection(it.label);
    if (name) found.get(name).push({ ...it, group: name });
    // The source splits each armour list in half with a rule of dashes. It has
    // no name to head a section with, so that run just reads as plain gear.
    else plain.push(it.group?.startsWith('---') ? { ...it, group: null } : it);
  }
  return [
    ...sortWithinGroups(plain),
    ...GEAR_SECTIONS.flatMap((name) => found.get(name).sort(byLabel)),
  ];
}

function buildLookHex(race, sel, slots, raceInfo) {
  const faceItem = slots?.face?.find((it) => it.id === sel.face);
  // The face can override the look race (Tarutaru); otherwise the race's own byte.
  const raceNum = faceItem?.lookRace ?? raceInfo?.lookRace ?? RACE_LOOK_NUM[race];
  if (!raceNum || !slots) return null;
  const useAlt = raceNum !== (raceInfo?.lookRace ?? RACE_LOOK_NUM[race]);
  const buf = new Uint8Array(20);
  const dv  = new DataView(buf.buffer);
  dv.setUint16(0x00, 1, true);   // size = 1 (equipped)
  buf[0x02] = modelIdOf(faceItem, useAlt) & 0xFF;
  buf[0x03] = raceNum;
  for (const key of LOOK_SLOT_ORDER) {
    const item    = slots[key]?.find((it) => it.id === sel[key]);
    const modelId = modelIdOf(item, useAlt);
    dv.setUint16(LOOK_SLOT_OFFSET[key], ((LOOK_SLOT_IDX[key] << 12) | (modelId & 0x0FFF)) >>> 0, true);
  }
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------

/**
 * Character composer state. Owns the race index, the per-race slot/action
 * lists, and the current selections; assembles the merged DAT path list and
 * calls onLoad whenever it changes. Lives in App so the Animation panel
 * and the left panel share one instance.
 */
const PC_STATE_KEY = 'pcState';
const GEARSETS_KEY = 'pcGearSets';

/** Persisted composer selections: { race, sel, actionGroup, action }. */
function loadPcState() {
  try { return JSON.parse(localStorage.getItem(PC_STATE_KEY) || 'null') ?? {}; } catch { return {}; }
}

/**
 * Gear set library (localStorage → app data in the Tauri shell).
 * sets: { id, name, race, gear: { slotKey: label } }
 */
function loadGearSets() {
  try {
    const raw = JSON.parse(localStorage.getItem(GEARSETS_KEY) || 'null');
    if (!raw) return [];
    // v1 had folders — keep every set, drop folder metadata.
    if (Array.isArray(raw.sets)) return raw.sets.map(({ id, name, race, gear, updatedAt }) => (
      { id, name, race, gear, updatedAt }
    )).filter((s) => s?.id && s?.name && s?.race && s?.gear);
    if (Array.isArray(raw)) return raw;
    return [];
  } catch {
    return [];
  }
}

function saveGearSets(sets) {
  try { localStorage.setItem(GEARSETS_KEY, JSON.stringify({ version: 2, sets })); } catch { /* quota */ }
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Snapshot the current look as race + per-slot item labels (portable across races/rebakes). */
function snapshotLoadout(race, sel, slots) {
  const gear = {};
  for (const s of SLOTS) {
    const it = slots?.[s.key]?.find((x) => x.id === sel[s.key]);
    if (it) gear[s.key] = it.label;
  }
  return { race, gear };
}

export function useCharacter({ enabled, onLoad, onError }) {
  const saved = useRef(loadPcState());
  const [races, setRaces] = useState(null);
  const [race, setRaceState] = useState(saved.current.race ?? '');
  const [slots, setSlots] = useState(null);     // { slotKey: items[] | null }
  // Race id the current slots/sel/actions belong to. Load waits until this
  // matches `race` so a switch never merges the new base onto the previous
  // race's face/gear (shared labels like "F1A" make that easy to miss).
  const [slotsRace, setSlotsRace] = useState('');
  const [sel, setSel] = useState({});           // slotKey -> item id
  const [actions, setActions] = useState([]);
  const [actionGroup, setActionGroupState] = useState('');
  const [action, setAction] = useState('');
  const lastKey = useRef('');
  const lastRace = useRef('');                  // race of the last onLoad (camera keep)
  const restored = useRef(false);               // saved selections applied?
  const carry = useRef({ gear: {}, actionKey: null });   // selections to carry across a race switch
  const pendingGear = useRef(null);             // gear-set labels to apply after race/slots ready
  const prevSelRef = useRef(null);              // sel snapshot from the last onLoad (for displayPath)
  const raceData = useRef(new Map());           // race id -> full characters.json entry
  const prevEnabled = useRef(false);
  const cbRef = useRef({});
  cbRef.current = { onLoad, onError };

  /** UI race pick: invalidate slot ownership in the same event so the load
   *  effect cannot run one frame with the new race + old face/gear paths. */
  const setRace = (id) => {
    if (id === race) return;
    setSlotsRace('');
    lastKey.current = '';
    lastRace.current = '';
    prevSelRef.current = null;
    setRaceState(id);
  };

  const groupOf = (a) => a.group ?? 'Other';
  const actionGroups = [...new Set(actions.map(groupOf))];
  const actionEntries = actions.filter((a) => groupOf(a) === actionGroup);

  /** Switching category also selects its first entry. */
  const setActionGroup = (g) => {
    setActionGroupState(g);
    setAction(actions.find((a) => groupOf(a) === g)?.id ?? '');
  };

  // Character data (once, on first enable)
  useEffect(() => {
    if (!enabled || races !== null) return;
    (async () => {
      try {
        const res = await fetch('lists/characters.json');
        if (!res.ok) throw new Error(`${res.status} characters.json`);
        const data = await res.json();
        raceData.current = new Map(data.races.map((r) => [r.id, r]));
        const rs = data.races.map((r) => ({ id: r.id, label: r.label, base: r.base,
                                            lookRace: r.lookRace }));
        setRaces(rs);
        setRaceState((r) => (rs.some((x) => x.id === r) ? r : rs[0]?.id || ''));
      } catch (err) {
        cbRef.current.onError?.(`Failed to load character lists: ${err.message ?? err}`);
        setRaces([]);
      }
    })();
  }, [enabled, races]);

  // Mirror the current selections by *label* so a race switch can carry them
  // over (item ids are race-specific, labels are shared). Deps exclude race, so
  // this holds the previous race's picks while the per-race effect reloads.
  useEffect(() => {
    const gear = {};
    for (const s of SLOTS) {
      const it = slots?.[s.key]?.find((x) => x.id === sel[s.key]);
      if (it) gear[s.key] = it.label;
    }
    const a = actions.find((x) => x.id === action);
    carry.current = { gear, actionKey: a ? `${a.group ?? ''}|${a.label}` : null };
  }, [slots, sel, actions, action]);

  // Per-race lists (all in memory once characters.json is loaded); defaults:
  // the slot's "None" entry when it has one, else first.
  useEffect(() => {
    if (!race || !races?.length) return;
    const entry = raceData.current.get(race);
    if (!entry) return;

    const slotMap = {};
    const defaults = {};
    for (const s of SLOTS) {
      const raw = entry.slots?.[s.key] ?? null;
      const items = raw?.length ? orderSlotItems(raw) : raw;
      slotMap[s.key] = items;
      if (items?.length) {
        const none = items.find((it) => it.label.toLowerCase() === 'none');
        defaults[s.key] = (none ?? items[0]).id;
      }
    }
    const acts = entry.actions ?? [];

    // Restore the saved selections once, and only for the race they belong to
    // (gear lists are race-specific; a manual race switch carries by label).
    // A pending gear-set load wins over both (labels applied after slots exist).
    const s = saved.current;
    const restoring = !restored.current && s.race === race;
    restored.current = true;
    const startSel = { ...defaults };
    let startGroup = acts[0]?.group ?? (acts.length ? 'Other' : '');
    let startAction = acts[0]?.id ?? '';
    const applyLabels = (labels) => {
      if (!labels) return;
      for (const s2 of SLOTS) {
        const want = labels[s2.key];
        const hit = want && slotMap[s2.key]?.find((it) => it.label === want);
        if (hit) startSel[s2.key] = hit.id;
      }
    };
    if (pendingGear.current) {
      applyLabels(pendingGear.current);
      pendingGear.current = null;
    } else if (restoring) {
      for (const [k, id] of Object.entries(s.sel ?? {})) {
        if (slotMap[k]?.some((it) => it.id === id)) startSel[k] = id;
      }
      const act = acts.find((a) => a.id === s.action);
      if (act) { startGroup = act.group ?? 'Other'; startAction = act.id; }
    } else if (carry.current.actionKey || Object.keys(carry.current.gear).length) {
      // Race switch: carry gear + action over by label (item ids differ per race).
      applyLabels(carry.current.gear);
      const [g, l] = (carry.current.actionKey ?? '').split('|');
      const act = acts.find((a) => (a.group ?? '') === g && a.label === l);
      if (act) { startGroup = act.group ?? 'Other'; startAction = act.id; }
    }

    setSlots(slotMap);
    setSlotsRace(race);
    setSel(startSel);
    setActions(acts);
    setActionGroupState(startGroup);
    setAction(startAction);
  }, [race, races]);

  // Persist selections (restored on next launch).
  useEffect(() => {
    if (!races?.length || !race) return;
    try {
      localStorage.setItem(PC_STATE_KEY, JSON.stringify({ race, sel, actionGroup, action }));
    } catch { /* quota / private mode */ }
  }, [races, race, sel, actionGroup, action]);

  // Re-enter the Characters view: allow a reload (and a camera re-fit) even if
  // selections didn't change — another view may have replaced the model.
  useEffect(() => {
    if (enabled && !prevEnabled.current) { lastKey.current = ''; lastRace.current = ''; }
    prevEnabled.current = enabled;
  }, [enabled]);

  // Assemble + load. Skips while selections still point at another race's lists
  // (race updates one render before the per-race effect rebuilds slots/sel —
  // loading then would merge the new base onto the previous race's face/gear).
  useEffect(() => {
    if (!enabled || !races?.length || !slots || slotsRace !== race) return;
    const r = races.find((x) => x.id === race);
    if (!r) return;
    // The base DAT holds only the lower-body motion slot; motionExtra adds the
    // upper-body + waist companion packs (baked in dev/bake-lists.mjs) so
    // locomotion animates the whole body, not just the legs. They stay out of
    // focusPaths so they feed playback without flooding the Animation lists.
    const paths = [r.base, ...(raceData.current.get(race)?.motionExtra ?? [])];
    const weaponSlots = {};
    // Per-part breakdown for the Details panel (label + which DATs each slot contributed).
    const parts = [{ key: 'race', label: 'Race', itemLabel: r.label, paths: [r.base] }];
    for (const s of SLOTS) {
      const items = slots[s.key];
      if (!items?.length) continue;
      const item = items.find((it) => it.id === sel[s.key]);
      if (!item) return;
      paths.push(...item.paths);
      if (s.key === 'main' || s.key === 'sub') weaponSlots[s.key] = item.paths;
      if (item.paths.length) {
        parts.push({
          key: s.key,
          label: s.section === 'Weapon' ? `Weapon: ${s.label}` : s.label,
          itemLabel: item.label,
          paths: item.paths,
        });
      }
    }
    const act = actions.find((a) => a.id === action);
    if (action && !act) return;
    // Focus = the schedule DATs only. Motion packs still load (schedules
    // resolve clips out of them) but must not flood the Animation lists.
    const focusPaths = act ? [...act.paths] : [];
    if (act) paths.push(...focusPaths, ...(act.motionPaths ?? []));

    const unique = [...new Set(paths)];
    // Prefix race so a shared face label never collapses two skeletons into one key.
    const key = `${race}|${unique.join('|')}`;
    if (key === lastKey.current) return;
    lastKey.current = key;

    // Determine the most informative path for the status bar. On a gear swap
    // (same race), find which slot changed and show its DAT. On a race change
    // or first entry, show the race skeleton.
    const isGearSwap = lastRace.current === race;
    let displayPath = r.base;
    if (isGearSwap && prevSelRef.current) {
      for (const s of SLOTS) {
        if (sel[s.key] !== prevSelRef.current[s.key]) {
          const item = slots[s.key]?.find((it) => it.id === sel[s.key]);
          if (item?.paths?.[0]) displayPath = item.paths[0];
        }
      }
    }
    prevSelRef.current = { ...sel };

    cbRef.current.onLoad?.({
      name: r.label,
      paths: unique,
      displayPath,
      focusPaths,
      weaponSlots,
      // The equipped weapon rests in its own battle stance (btl): App resolves
      // the right entry by the weapon's animation type after parsing it.
      battleTable: raceData.current.get(race)?.battleByType ?? null,
      parts,
      keepCamera: isGearSwap,
    });
    lastRace.current = race;
  }, [enabled, races, race, slots, slotsRace, sel, actions, action]);

  /** Apply a saved gear set (race + slot labels). Switches race if needed. */
  const applyGearSet = useCallback((entry) => {
    if (!entry?.race || !entry.gear) return;
    if (!raceData.current.has(entry.race)) {
      cbRef.current.onError?.(`Gear set race “${entry.race}” is not available.`);
      return;
    }
    if (entry.race !== race) {
      pendingGear.current = entry.gear;
      setSlotsRace('');
      lastKey.current = '';
      lastRace.current = '';
      prevSelRef.current = null;
      setRaceState(entry.race);
      return;
    }
    // Same race — map labels → ids on the live slot lists.
    if (!slots || slotsRace !== race) {
      pendingGear.current = entry.gear;
      return;
    }
    setSel((prev) => {
      const next = { ...prev };
      for (const s of SLOTS) {
        const want = entry.gear[s.key];
        const hit = want && slots[s.key]?.find((it) => it.label === want);
        if (hit) next[s.key] = hit.id;
      }
      return next;
    });
  }, [race, slots, slotsRace]);

  return {
    races, race, setRace, slots, sel, setSel,
    actionGroups, actionGroup, setActionGroup, actionEntries, action, setAction,
    applyGearSet,
  };
}

// ---------------------------------------------------------------------------

export function CharacterList({ pc }) {
  const { races, race, setRace, slots, sel, setSel, applyGearSet } = pc;
  const raceItems = (races ?? []).map((r) => ({ id: r.id, label: r.label }));
  const pick = (key) => (id) => setSel((s) => ({ ...s, [key]: id }));

  const [copied, setCopied] = useState(false);
  const lookHex = races?.length
    ? buildLookHex(race, sel, slots, races.find((r) => r.id === race))
    : null;
  const copyLook = () => {
    if (!lookHex) return;
    navigator.clipboard.writeText(lookHex).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const slotCtrl = (s) => {
    const items = slots?.[s.key];
    if (!items?.length) return null;
    // Weapon + armor: type first (Katana / Artifact / …), then the piece.
    const typed = s.section === 'Weapon' || s.section === 'Armor';
    return (
      <div className="pc-ctrl" key={s.key}>
        <span className="pc-ctrl-label">{s.label}</span>
        <Combo value={sel[s.key]} items={items} onChange={pick(s.key)} groupByType={typed} />
      </div>
    );
  };

  const section = (name) => {
    const ctrls = SLOTS.filter((s) => s.section === name).map(slotCtrl).filter(Boolean);
    if (ctrls.length === 0) return null;
    return (
      <>
        <div className="side-separator">{name}</div>
        {ctrls}
      </>
    );
  };

  return (
    <div id="tree" className="panel pc-panel">
      <div className="pc-scroll">
        {races === null && <div className="side-note">Loading character lists…</div>}
        {races?.length === 0 && <div className="side-note">No PC lists found.</div>}
        {races?.length > 0 && (
          <>
            <div className="pc-ctrl">
              <span className="pc-ctrl-label">Race</span>
              <Combo value={race} items={raceItems} onChange={setRace} />
            </div>
            {slotCtrl(SLOTS[0]) /* Face */}
            {section('Weapon')}
            {section('Armor')}
            {lookHex && (
              <>
                <div className="side-separator">Look String</div>
                <div className="pc-look-field">
                  <input
                    className="pc-look-input"
                    type="text"
                    readOnly
                    value={lookHex}
                    onClick={(e) => e.target.select()}
                  />
                  <Tooltip content={copied ? 'Copied!' : 'Copy'}>
                    <button className="pc-look-copy" onClick={copyLook}>
                      <span className="icon">{copied ? 'check' : 'content_copy'}</span>
                    </button>
                  </Tooltip>
                </div>
              </>
            )}
            <GearSetsPanel
              race={race}
              sel={sel}
              slots={slots}
              races={races}
              onApply={applyGearSet}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ── Gear sets (flat saved looks) ─────────────────────────────────────────────

function GearSetsPanel({ race, sel, slots, races, onApply }) {
  const [sets, setSets] = useState(loadGearSets);
  const [activeSet, setActiveSet] = useState(null);
  const [draft, setDraft] = useState('');
  // null | 'save' | { rename: id }
  const [mode, setMode] = useState(null);
  const draftRef = useRef(null);

  const persist = (next) => {
    setSets(next);
    saveGearSets(next);
  };

  useEffect(() => {
    if (mode && draftRef.current) {
      draftRef.current.focus();
      draftRef.current.select?.();
    }
  }, [mode]);

  const raceLabel = (id) => races.find((r) => r.id === id)?.label ?? id;

  const beginSave = () => { setMode('save'); setDraft(''); };
  const beginRename = (id, name) => { setMode({ rename: id }); setDraft(name); };
  const cancelMode = () => { setMode(null); setDraft(''); };

  const commitDraft = () => {
    const name = draft.trim();
    if (!name) { cancelMode(); return; }
    if (mode === 'save') {
      const snap = snapshotLoadout(race, sel, slots);
      const entry = {
        id: newId('set'),
        name,
        race: snap.race,
        gear: snap.gear,
        updatedAt: Date.now(),
      };
      persist([...sets, entry]);
      setActiveSet(entry.id);
      cancelMode();
      return;
    }
    if (mode?.rename) {
      persist(sets.map((s) => (s.id === mode.rename ? { ...s, name } : s)));
      cancelMode();
    }
  };

  const deleteSet = (id) => {
    persist(sets.filter((s) => s.id !== id));
    if (activeSet === id) setActiveSet(null);
  };

  const overwriteSet = (id) => {
    const snap = snapshotLoadout(race, sel, slots);
    persist(sets.map((s) => (s.id === id
      ? { ...s, race: snap.race, gear: snap.gear, updatedAt: Date.now() }
      : s)));
  };

  return (
    <div className="gs-panel">
      <div className="gs-head">
        <span className="gs-title">GearSets</span>
        <span className="gs-spacer" />
        <button type="button" className="gs-save" onClick={beginSave}>Save</button>
      </div>

      {(mode === 'save' || mode?.rename) && (
        <form className="gs-draft" onSubmit={(e) => { e.preventDefault(); commitDraft(); }}>
          <input
            ref={draftRef}
            className="gs-draft-input"
            value={draft}
            placeholder={mode === 'save' ? 'Name' : 'Rename'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') cancelMode(); }}
          />
          <Tooltip content="Confirm" placement="left">
            <button type="submit" className="gs-tool" aria-label="Confirm"><span className="icon">check</span></button>
          </Tooltip>
          <Tooltip content="Cancel" placement="left">
            <button type="button" className="gs-tool" aria-label="Cancel" onClick={cancelMode}><span className="icon">close</span></button>
          </Tooltip>
        </form>
      )}

      <div className="gs-list">
        {sets.length === 0 && !mode && (
          <div className="gs-empty">Save the current look to add a gear set.</div>
        )}
        {sets.map((s) => (
          <div
            key={s.id}
            className={`gs-row${activeSet === s.id ? ' on' : ''}`}
            onClick={() => { setActiveSet(s.id); onApply(s); }}
            onDoubleClick={(e) => { e.stopPropagation(); beginRename(s.id, s.name); }}
          >
            <span className="icon gs-kind">person</span>
            <span className="gs-name">{s.name}</span>
            <span className="gs-meta">{raceLabel(s.race)}</span>
            <span className="gs-acts" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
              <Tooltip content="Overwrite with current look" placement="top" delay={[250, 0]}>
                <button type="button" className="gs-tool" aria-label="Overwrite" onClick={() => overwriteSet(s.id)}>
                  <span className="icon">sync</span>
                </button>
              </Tooltip>
              <Tooltip content="Rename" placement="top" delay={[250, 0]}>
                <button type="button" className="gs-tool" aria-label="Rename" onClick={() => beginRename(s.id, s.name)}>
                  <span className="icon">edit</span>
                </button>
              </Tooltip>
              <Tooltip content="Delete" placement="top" delay={[250, 0]}>
                <button type="button" className="gs-tool" aria-label="Delete" onClick={() => deleteSet(s.id)}>
                  <span className="icon">close</span>
                </button>
              </Tooltip>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
