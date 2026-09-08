// Server NPC placements (lists/zone_npcs.json, baked by scripts/gen_zone_npcs.py
// from CatsEyeXI's npc_list) → renderable actor entries + display transforms.
//
// A look_t is 20 bytes: u16 size, then either {u8 face, u8 race} (size 1,
// "equipped": a player-style model assembled from gear) or u16 modelid (size 0,
// a monster / unique NPC DAT), then u16 head, body, hands, legs, feet, main,
// sub, ranged — each (slot << 12) | model id. Sizes 2–7 are doors, elevators,
// ships, automatons and chocobos: not player-space models, so no entry.

import { loadListOrNull } from './lists.js';

const SLOT_KEYS = ['head', 'body', 'hands', 'legs', 'feet', 'main', 'sub', 'range'];

// look race byte → characters.json race id. Tarutaru is one viewer race for
// both look races (5 ♂ / 6 ♀ — the face carries the gender), see CharacterList.
// 29–31 are the NPC-only child races (Mithra kitten, girl, boy): their gear
// tables are not baked, so the lists are indexed by model id as a best effort.
const LOOK_RACE_TO_ID = {
  1: 'HumeM', 2: 'HumeF', 3: 'ElvaanM', 4: 'ElvaanF', 5: 'Tarutaru', 6: 'Tarutaru', 7: 'Mithra', 8: 'Galka',
  29: 'LilMithra', 30: 'LilGirl', 31: 'LilBoy',
};

export const LOOK_TYPES = {
  0: 'standard', 1: 'equipped', 2: 'door', 3: 'elevator', 4: 'ship', 5: 'unknown', 6: 'automaton', 7: 'chocobo',
};

// STATUS_TYPE (server): NORMAL / UPDATE are sent to clients, everything else is
// not on screen until a script changes it. ENTITYFLAGS 0x80 hides the model.
export const STATUS_VISIBLE = new Set([0, 1]);
export const FLAG_HIDE_MODEL = 0x80;

/** Row → object, per the `fields` list in zone_npcs.json. */
export function npcRow(row) {
  const [npcid, name, x, y, z, rot, status, flags, look] = row;
  return { npcid, name, x, y, z, rot, status, flags, look };
}

export function decodeLook(hex) {
  if (typeof hex !== 'string' || hex.length < 40) return null;
  const b = new Uint8Array(20);
  for (let i = 0; i < 20; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
  const u16 = (o) => b[o] | (b[o + 1] << 8);
  const size = u16(0);
  const out = { size, type: LOOK_TYPES[size] ?? 'unknown', slots: {} };
  if (size === 1) {
    out.face = b[2];
    out.race = b[3];
    SLOT_KEYS.forEach((key, i) => { out.slots[key] = u16(4 + i * 2) & 0x0fff; });
  } else {
    out.modelId = u16(2);
  }
  return out;
}

export function npcVisible(npc) {
  return STATUS_VISIBLE.has(npc.status) && !(npc.flags & FLAG_HIDE_MODEL);
}

/**
 * The actor entry (the shape NpcList / useCharacter hand App.buildActorModel)
 * for a decoded look, or null when nothing can be drawn for it.
 *
 * `models`: zone_npcs.json `models` (model id → { fileId, dat });
 * `characters`: lists/characters.json.
 */
export function npcEntryFromLook(look, name, models, characters) {
  if (!look) return null;
  if (look.size === 0) {
    const dat = models?.[String(look.modelId)]?.dat;
    if (!dat) return null;
    return { name, paths: [dat], key: dat.toLowerCase(), modelId: look.modelId };
  }
  if (look.size !== 1) return null;
  const raceId = LOOK_RACE_TO_ID[look.race];
  const race = characters?.races?.find((r) => r.id === raceId);
  if (!race) return null;
  // Tarutaru's two look races assign different model ids to the same DAT:
  // items carry the female table's id as `midAlt` (see CharacterList).
  const alt = look.race === 6;
  const midOf = (item) => (alt && Number.isFinite(item.midAlt) ? item.midAlt : item.mid);
  const find = (key, mid, extra = () => true) => {
    const items = race.slots?.[key] ?? [];
    // A list with no model ids at all (the child races) is indexed instead;
    // an id past its end wears the first outfit rather than nothing.
    if (items.length && items.every((it) => !it.mid && !Number.isFinite(it.midAlt))) {
      return items[mid] ?? items[0];
    }
    return items.find((it) => midOf(it) === mid && extra(it)) ?? null;
  };

  const motionExtra = race.motionExtra ?? [];
  const paths = [race.base, ...motionExtra];
  const weaponSlots = {};
  let rodPaths = null;
  const face = find('face', look.face, (it) => it.lookRace == null || it.lookRace === look.race)
    ?? find('face', look.face);
  if (face?.paths?.length) paths.push(...face.paths);
  for (const key of SLOT_KEYS) {
    const item = find(key, look.slots[key]);
    if (!item?.paths?.length) continue;
    if (key === 'range' && item.rod) { rodPaths = item.paths; continue; }
    paths.push(...item.paths);
    if (key === 'main' || key === 'sub' || key === 'range') weaponSlots[key] = item.paths;
  }
  const unique = [...new Set(paths)];
  return {
    name,
    paths: unique,
    key: `${raceId}|${unique.join('|')}`,
    animOnlyPaths: motionExtra,
    weaponSlots,
    battleTable: race.battleByType ?? null,
    skirtByType: race.skirtByType ?? null,
    raceId,
    rodPaths,
  };
}

/**
 * Server position → viewer display space. The zone is drawn through
 * DISPLAY_ROT = diag(−1,−1,1) (see renderer.js), so a game-space point
 * (x, y, z) sits at (−x, −y, z) on the terrain.
 */
export function npcDisplayPos(npc) {
  return [-npc.x, -npc.y, npc.z];
}

/**
 * Column-major 3×3 yaw for an actor from the server's u8 heading. Heading
 * phi = 2π·rot/256 faces (cos phi, 0, −sin phi) in game space, i.e.
 * (−cos phi, 0, −sin phi) in display space. An entity model at rest faces its
 * local −X in display space (checked against the placed models: with no
 * rotation a figure shows its back to a camera on its +X side), and a Y
 * rotation by theta sends −X to (−cos theta, 0, sin theta), so theta = −phi.
 */
export function npcDisplayRot(rot) {
  const theta = -(2 * Math.PI * (rot & 0xff)) / 256;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return new Float32Array([c, 0, -s, 0, 1, 0, s, 0, c]);
}

// ── Data ────────────────────────────────────────────────────────────────────

let zoneNpcDataPromise = null;
let characterDataPromise = null;

/** lists/zone_npcs.json, fetched once per session (null when it is missing). */
export function loadZoneNpcData() {
  if (!zoneNpcDataPromise) {
    zoneNpcDataPromise = loadListOrNull('zone_npcs.json')
      .then((data) => {
        if (!data) zoneNpcDataPromise = null;   // let a later toggle retry
        return data;
      });
  }
  return zoneNpcDataPromise;
}

/** lists/characters.json (race skeletons + gear by model id), fetched once. */
export function loadCharacterData() {
  if (!characterDataPromise) {
    characterDataPromise = loadListOrNull('characters.json')
      .then((data) => {
        if (!data) characterDataPromise = null;
        return data;
      });
  }
  return characterDataPromise;
}
