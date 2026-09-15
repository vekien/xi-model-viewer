// Weapon-slot visibility, as the client's scheduler drives it.
//
// Evidence (research/external in xi-tools):
//   FFXI-PS2/src/main/miyagawa/effect/ymschdecript.cpp — YmSchedulerTask tag
//   handlers of the PS2 client; FFXI-PS2/src/main/actor/xisklactor.cpp —
//   XiSkeletonActor::ShowWeapon/HideWeapon; xim EffectRoutineParser.kt,
//   EffectRoutineInstance.kt and ActorModel.getHiddenSlotIds.
//
// Slots are the weapon meshes `wep0` (main), `wep1` (sub) and `wep2` (ranged):
// ShowWeapon/HideWeapon(wep_no) flag the osm whose id is 'wep' + digit. On an
// idle system motion the client does ShowWeapon(0), ShowWeapon(1),
// HideWeapon(2) (xisklactor.cpp:1740) — hands shown, ranged stowed is the rest
// state everything below departs from.
//
// Tags (offsets are into the 4-byte-word command; +4 u16 is the delay after
// it, +6 u16 its duration, like every scheduler tag):
//   0x75 ShowHideWeapon  +8 u32 hidden, +0xc s16 slot, +0xe s16 ifEngaged.
//        ifEngaged: only when GetGameStatus() == 1 (engaged). Duration 0:
//        immediate Show/Hide. Duration > 0: a HideWepControl task hides the
//        slot and, when its life runs out, shows it again if `hidden` was 0.
//   0x76 / 0x77 StartRanged / FinishRanged  +8 u32 subtype. Run the actor's
//        `lc`/`ls` routine named by the ranged weapon's range type (two
//        decimal digits): the bow/gun/instrument motion, which carries the
//        visibility tags of its own.
//   0x89 LockConstrainDrive  duration only. IsConstrain(1, 1) on the actor
//        for the window, IsConstrain(0, 1) after: the ranged weapon is driven
//        to the hand. xim renders it as DisplayRangedModelRoutine — ranged
//        shown, hands hidden — for duration/2 frames, and so does this.
//   0xA3 (not in the PS2 client; xim ToggleModelVisibilityRoutine)
//        +8 u32 hidden, +0xc u16 slot. An actor-level toggle applied last.
//   0x78 plays a sound (xim calls it DisplayDead); it does not touch weapons.
//
// The shared helpers in ROM/0/0.DAT are where most of the 0x75s live:
//   hwmg  hide main+sub if engaged, hide ranged   ← every ca*/sh* cast schedule
//   hwso  show ranged, hide main+sub if engaged   ← calg/shlg (ranged attack), lc01/lc02, ls01–ls06
//   hwat  show main+sub, hide ranged              ← run on disengage (xiatelnet.cpp)
//   hwpc  hide ranged                             ← init/pop
// and the race DAT's lc00/ls00/lc10/lc11/ls10/ls11 carry their own.

export const SLOT = { main: 0, sub: 1, range: 2 };

/** Scheduler tags that change weapon visibility (or link the routine that does). */
export const VIS_OPS = new Set([0x75, 0x76, 0x77, 0x89, 0xa3]);

/**
 * Decode one visibility tag at byte offset `p` (the op byte) into a command
 * `{ op, delay, dur, hidden, slot, ifEngaged, subtype }`. `at` is the tag's
 * start on the routine clock (60/s ticks). Null when the entry is truncated.
 */
export function readVisCommand(bytes, p, op, at, end) {
  const u16 = (o) => bytes[o] | (bytes[o + 1] << 8);
  const u32 = (o) => (u16(o) | (u16(o + 2) << 16)) >>> 0;
  const s16 = (o) => (u16(o) << 16) >> 16;
  switch (op) {
    case 0x75:
      if (p + 16 > end) return null;
      return { op, delay: at, dur: u16(p + 6), hidden: u32(p + 8) === 1, slot: s16(p + 12), ifEngaged: s16(p + 14) !== 0 };
    case 0xa3:
      if (p + 16 > end) return null;
      return { op, delay: at, dur: 0, hidden: u32(p + 8) === 1, slot: s16(p + 12), ifEngaged: false };
    case 0x76:
    case 0x77:
      if (p + 12 > end) return null;
      return { op, delay: at, dur: u16(p + 6), subtype: u32(p + 8) };
    case 0x89:
      if (p + 8 > end) return null;
      return { op, delay: at, dur: u16(p + 6) };
    default:
      return null;
  }
}

// Range type (weapon `info` byte 14) → the ranged-attack subtype it answers:
// 0 = throwing / marksmanship / archery, 1 = instrument (song), 2 = handbell.
// xim InfoSection.kt RangeType; the two-digit index names the lc/ls routine.
const RANGE_SUBTYPE = { 0: 1, 1: 1, 2: 1, 3: 0, 4: 0, 5: 0, 6: 0, 10: 2, 11: 2 };

/**
 * The `lc`/`ls` routine a StartRanged/FinishRanged tag links. The PS2 client
 * builds it from the actor's range type, zeroing it when the tag's subtype is
 * a song and the weapon is no instrument; xim (resolveRangedEffectId) fills in
 * the defaults used here: throwing ammo (05) for a ranged attack without a
 * ranged weapon, unarmed singing (00), geomancy handbell (11).
 */
export function rangedRoutineId(start, subtype, rangeType) {
  const have = (typeof rangeType === 'number' && rangeType !== 0xff) ? rangeType : null;
  let idx;
  if (subtype === 1) idx = (have != null && RANGE_SUBTYPE[have] === 1) ? have : 0;
  else if (subtype === 2) idx = 11;
  else idx = (have != null && RANGE_SUBTYPE[have] === 0) ? have : 5;
  return `${start ? 'lc' : 'ls'}${String(idx).padStart(2, '0')}`;
}

/**
 * Every visibility command a schedule runs, on one absolute clock: its own,
 * those of the routines it links (`extCalls` for the ones outside its DAT —
 * the ROM/0/0.DAT helpers — via `globalById`; plain `calls` for a shared
 * routine's own links), and those of the lc/ls routine a StartRanged /
 * FinishRanged tag picks (`schedById`, the actor's schedules; `rangeType`,
 * the ranged weapon's). Sorted by delay so a later tag wins.
 */
export function collectVis(schedule, { schedById = null, globalById = null, rangeType = null } = {}) {
  const out = [];
  const seen = new Set();
  const lookup = (id) => schedById?.get(id) ?? globalById?.get(id) ?? null;
  const walk = (r, offset, depth) => {
    if (!r || depth > 8 || seen.has(r)) return;
    seen.add(r);
    for (const v of r.vis ?? []) {
      const at = offset + v.delay;
      if (v.op === 0x76 || v.op === 0x77) {
        walk(lookup(rangedRoutineId(v.op === 0x76, v.subtype ?? 0, rangeType)), at, depth + 1);
        continue;
      }
      out.push({ ...v, delay: at });
    }
    for (const c of r.extCalls ?? r.calls ?? []) walk(lookup(c.routineId), offset + c.delay, depth + 1);
  };
  walk(schedule, 0, 0);
  out.sort((a, b) => a.delay - b.delay);
  return out;
}

/**
 * Hidden slots at routine tick `tick` (60/s), given the commands from
 * collectVis and whether the actor is engaged. Follows xim's
 * ActorModel.getHiddenSlotIds: ranged hidden by default, 0x75 overrides in
 * order (ifEngaged ones skipped when not engaged), 0xA3 toggles last, and a
 * live LockConstrainDrive window shows the ranged weapon and hides the hands
 * unless a toggle has hidden the ranged slot.
 *
 * @returns {{ hidden: Set<number>, rangedDrawn: boolean }}
 */
export function hiddenSlotsAt(vis, tick, { engaged = false } = {}) {
  const hidden = new Set([SLOT.range]);
  const toggled = new Map();
  let drawn = false;
  for (const v of vis) {
    if (v.delay > tick) continue;
    if (v.op === 0x75) {
      if (v.ifEngaged && !engaged) continue;
      // A timed hide ends by showing the slot again only when it was a
      // "hide for a while" (hidden 0); hidden 1 stays hidden.
      const hide = v.dur > 0 ? (tick < v.delay + v.dur || v.hidden) : v.hidden;
      if (hide) hidden.add(v.slot); else hidden.delete(v.slot);
    } else if (v.op === 0xa3) {
      toggled.set(v.slot, v.hidden);
    } else if (v.op === 0x89) {
      if (tick < v.delay + v.dur) drawn = true;
    }
  }
  for (const [slot, h] of toggled) { if (h) hidden.add(slot); else hidden.delete(slot); }
  if (drawn && toggled.get(SLOT.range) !== true) {
    return { hidden: new Set([SLOT.main, SLOT.sub]), rangedDrawn: true };
  }
  return { hidden, rangedDrawn: false };
}
