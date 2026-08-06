// Bakes the AltanaViewer-format CSV lists into the viewer's own JSON lists.
//
//   node dev/bake-lists.mjs [--src <ListsDir>] [--battle <battle.json>] [--out <dir>]
//
// Defaults: --src ui/public/lists (the repo snapshot; point at
// D:\xidata\AltanaViewer-main\List to re-import from AltanaViewer upstream),
// --battle dev/battle-table.json, --out ui/public/lists.
//
// Emits (everything the app needs, fully resolved — no spec grammar at runtime):
//   characters.json  races (base skeleton DAT, per-weapon-type battle idles),
//                    per-race gear/face slot items, and the action list with
//                    Basic + per-weapon-type Battle entries baked in and every
//                    Motion.csv mapping resolved to concrete DAT paths.
//   npcs.json        NPC categories/entries (variants + companion base DATs).
//   music.json       track display names keyed `<soundRoot>_<NNN>`.
//   sfx.json         SFX folder + effect display names.
//   floors.json      floor texture list (zone label, DAT spec, fourcc).
//
// gear-models.json (DAT -> equipment model id, per race/slot) is generated from
// FFXiMain.dll + FTABLE via xi-tools — see dev/gear-models.py. It supplies each
// item's `mid`, which the look string needs; without it a look can only carry the
// list row index, i.e. a look for the wrong gear.
//
// battle-table.json (weaponAnimationType -> battle DAT, per race) is generated
// from FFXiMain.dll + FTABLE via xi-tools:
//   uv run python -c "from xi.entity.anim.xi_motion_tables import *; ..."
// (see git history of ui/public/lists/PC/battle.json for the exact snippet).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expandPathSpec, parseRaceIndex, parseSlotCsv, parseMotionCsv, attachMotions,
  baseMotionCompanions,
} from '../ui/js/pclists.js';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const SRC = arg('src', join(root, 'ui', 'public', 'lists'));
const BATTLE = arg('battle', join(root, 'dev', 'battle-table.json'));
const OUT = arg('out', join(root, 'ui', 'public', 'lists'));

const rd = (p) => { try { return readFileSync(join(SRC, p), 'utf8'); } catch { return null; } };

// Pretty-print for hand-editing: nested structure is indented, but leaf objects
// that fit (gear items, actions, npc entries) stay on one line each.
const INLINE = 160;
function pretty(v, indent = '') {
  const compact = JSON.stringify(v);
  if (compact === undefined) return 'null';
  if (compact.length <= INLINE || typeof v !== 'object' || v === null) return compact;
  const pad = indent + '  ';
  if (Array.isArray(v)) {
    return `[\n${v.map((x) => pad + pretty(x, pad)).join(',\n')}\n${indent}]`;
  }
  return `{\n${Object.entries(v).map(([k, x]) => `${pad}${JSON.stringify(k)}: ${pretty(x, pad)}`).join(',\n')}\n${indent}}`;
}

const write = (name, data) => {
  writeFileSync(join(OUT, name), pretty(data) + '\n');
  console.log(`wrote ${name}`);
};

// --- characters.json --------------------------------------------------------

const SLOTS = [
  ['face', 'Face'], ['main', 'Main'], ['sub', 'Sub'], ['range', 'Range'],
  ['head', 'Head'], ['body', 'Body'], ['hands', 'Hands'], ['legs', 'Legs'], ['feet', 'Feet'],
];

// weaponAnimationType -> battle-stance display name (one style per type).
const WEAPON_STYLE = {
  0: 'Club / Staff', 1: 'Sword', 2: 'Hand-to-Hand', 3: 'Dagger', 4: 'Great Sword',
  5: 'Axe / Scythe', 6: 'Katana', 7: 'Kunai', 8: 'Polearm',
};

const battleTable = existsSync(BATTLE) ? JSON.parse(readFileSync(BATTLE, 'utf8')) : {};

// DAT -> equipment model id, per race/slot (dev/gear-models.py, from FFXiMain.dll +
// FTABLE via xi-tools). The CSVs carry no model id, but a look string encodes each
// worn slot as (slotIndex << 12) | modelId — so every item needs its real `mid` or the
// composer can only emit a row index, which is a look for the WRONG gear.
const GEAR_MODELS = join(root, 'dev', 'gear-models.json');
const gearModels = existsSync(GEAR_MODELS) ? JSON.parse(readFileSync(GEAR_MODELS, 'utf8')) : {};
if (!existsSync(GEAR_MODELS)) {
  console.warn(`! ${GEAR_MODELS} missing — items will have no model id and look strings `
    + `will be wrong. Regenerate it with: uv run python dev/gear-models.py (in xi-tools)`);
}

/**
 * Attach each item's real equipment model id (`mid`), keyed by its first DAT path.
 *
 * Tarutaru is one viewer race spanning two LOOK races (5 male / 6 female — its "gender" is
 * only the face), and the two equipment tables give the same armour DAT *different* model
 * ids. Such races also get `midAlt` (the female table's id), and their face items get the
 * `lookRace` that DAT belongs to, so the composer can emit a self-consistent look.
 */
function attachModelIds(items, raceId, slotKey) {
  const race = gearModels[raceId];
  const map = race?.slots?.[slotKey];
  const alt = race?.slotsAlt?.[slotKey];
  for (const it of items) {
    const dat = it.paths?.[0]?.replace(/\\/g, '/').toUpperCase();
    const mid = dat ? map?.[dat] : undefined;
    const midAlt = dat && alt ? alt[dat] : undefined;
    it.mid = mid ?? midAlt ?? 0;    // 0 = the race's naked base part / nothing worn
    if (midAlt !== undefined && midAlt !== it.mid) it.midAlt = midAlt;
    if (slotKey === 'face' && alt && dat) {
      // Faces are disjoint between the two tables, so the DAT alone fixes the look race.
      it.lookRace = mid !== undefined ? race.lookRace : race.lookRaceAlt;
    }
  }
  return items;
}

// Display names for models the CSVs never labelled (see dev/gear-names.mjs).
const GEAR_NAMES = join(root, 'dev', 'gear-names.json');
const gearNames = existsSync(GEAR_NAMES) ? JSON.parse(readFileSync(GEAR_NAMES, 'utf8')) : {};

// Labels that are placeholders in their own right: the source typed something,
// but it names no gear. Deliberately narrow — it must never match a curated
// label like "Melee Cyclas (MNK Relic)" or a real name containing "Unknown".
const PLACEHOLDER_LABEL = /^\d+\/\d+$|^\d+\\\d+$|^\?+$|^Unknown(\s|$)/;

/**
 * Name the rows the source never really named.
 *
 * Eligible: rows parseSlotCsv flagged `auto` (no label cell at all, so the DAT
 * path stands in) and rows whose label is itself a placeholder ("Unknown Gun",
 * "???"). Everything else is left exactly as curated — the whole point is to
 * fill gaps without trading "Healer's Briault (WHM Artifact)" for "Briault".
 *
 * `auto` is internal bookkeeping and comes off before writing.
 */
function fillAutoNames(items, slotKey) {
  const byModel = gearNames[slotKey];
  for (const it of items) {
    const fillable = it.auto || PLACEHOLDER_LABEL.test(it.label);
    if (fillable && byModel && byModel[it.mid]) it.label = byModel[it.mid];
    delete it.auto;
  }
  return items;
}

const pcIndex = rd('PC/index.csv');
if (!pcIndex) { console.error(`no PC/index.csv under ${SRC}`); process.exit(1); }

const races = [];
for (const race of parseRaceIndex(pcIndex)) {
  const slots = {};
  for (const [key, file] of SLOTS) {
    const text = rd(`PC/${race.id}/${file}.csv`);
    if (text !== null) slots[key] = fillAutoNames(attachModelIds(parseSlotCsv(text), race.id, key), key);
  }

  // fillAutoNames with no slot: actions have no model ids to name from, this is
  // just here to strip the internal `auto` flag before it reaches the payload.
  const csvActs = fillAutoNames(parseSlotCsv(rd(`PC/${race.id}/Action.csv`) ?? ''), null);
  const motText = rd(`PC/${race.id}/Motion.csv`);
  attachMotions(csvActs, motText ? parseMotionCsv(motText) : []);

  // Synthesized entries the CSVs lack: Basic (race movement DAT) and one
  // Battle entry per weapon-animation type. The CSVs' single merged "Battle"
  // row is dropped — it collapsed every weapon style onto hand-to-hand.
  const battleByType = (battleTable[race.id] ?? []).map((p) => (p ? p.replace(/\//g, '\\') : null));
  // PC body motion is split across body-region slot DATs: the base holds only the
  // lower body, base+1 the upper body, base+3 the waist/skirt. These load with the
  // base for every pose so locomotion animates the whole body (see
  // baseMotionCompanions). Real PC races only — NPC-like bases (no battle table,
  // e.g. Chocobo / Little Girl) don't follow the base+N motion-slot layout.
  const motionExtra = battleByType.some(Boolean) ? baseMotionCompanions(race.base) : [];
  const actions = [
    { id: 'syn:basic', label: 'Basic', group: 'Basic', paths: [race.base], motionPaths: [] },
  ];
  const seen = new Set();
  battleByType.forEach((dat, type) => {
    const style = WEAPON_STYLE[type];
    if (!dat || !style || seen.has(dat)) return;
    seen.add(dat);
    actions.push({ id: `syn:btl${type}`, label: `Battle: ${style}`, group: 'Battle', paths: [dat], motionPaths: [] });
  });
  actions.push(...csvActs.filter((a) => !(a.group === 'Battle' && a.label === 'Battle')));

  // lookRace: the look_t race byte for this race (absent for the NPC/mount pseudo-races,
  // which have no PC equipment tables and so can't produce a look).
  const lookRace = gearModels[race.id]?.lookRace;
  races.push({ id: race.id, label: race.label, base: race.base, lookRace,
               motionExtra, battleByType, slots, actions });
}
write('characters.json', { races });

// --- npcs.json --------------------------------------------------------------
// (private copy of NpcList's category parser — the runtime one goes away)

const PATH_RE = /^\d+(\/\d+(-\d+)?){1,2}$/;

/**
 * Names for rows the source never gave one, keyed by first DAT.
 *
 * dragons.csv:4 is a bare variant list with no name cell. Resolved by DAT ->
 * entity model id (xi-tools exports/ftable/models.json) -> the mobs wearing
 * that model in the server's mob_pools: 611/783/2383 carry Azdaja, Vrtra,
 * Quetzalcoatl, Fafnir, Nidhogg, Hidhaegg and Naul — wyrm families 260-263.
 * The plain "Wyrm" entry above it is a different model set.
 */
const NPC_NAMES = {
  'ROM\\146\\70.DAT': 'Wyrm (NM)',
};

/**
 * Upstream rows that are really entries but don't parse as one. Anything left
 * over becomes a grey separator caption, so a typo here silently turns a
 * loadable model into a dead row in the list.
 *
 * A leading slash is the ROM separator typed one character early: specs read
 * `rom/dir/file`, so "/1250/78" is "1/250/78" — and ROM\250\78.DAT sits exactly
 * between its neighbours in the list (Amoeban 250/79, Murex 250/80), where
 * neither ROM\1250 nor ROM125\0 exists. The rule can only fire on a line that
 * already fails to parse, since a valid spec starts with a digit.
 */
const repairRow = (line) => line.replace(/^\/(\d)/, '$1/');

function parseCategoryCsv(text) {
  const entries = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = repairRow(rawLine.trim());
    if (!line) continue;
    const cells = line.split(',');
    // A row that is nothing but a path spec is still an entry — it has just
    // lost its name cell. Use a known name if we resolved one, else the DAT, so
    // either way it stays loadable rather than becoming a dead caption.
    if (cells.length === 1 && PATH_RE.test(cells[0].split(';')[0].trim())) {
      const variants = expandPathSpec(cells[0]);
      if (variants.length) {
        entries.push({ name: NPC_NAMES[variants[0]] ?? variants[0], variants, base: null });
        continue;
      }
    }
    if (cells.length < 2 || !PATH_RE.test(cells[0].split(';')[0].trim())) {
      entries.push({ separator: line.replace(/^,+|,+$/g, '') });
      continue;
    }
    let base = null;
    let nameCells = cells.slice(1);
    if (nameCells.length > 1 && PATH_RE.test(nameCells[nameCells.length - 1].trim())) {
      base = expandPathSpec(nameCells[nameCells.length - 1].trim())[0] ?? null;
      nameCells = nameCells.slice(0, -1);
    }
    const variants = expandPathSpec(cells[0]);
    if (variants.length === 0) continue;
    entries.push({ name: nameCells.join(',').trim(), variants, base });
  }
  return entries;
}

const npcIndex = rd('NPC/index.csv');
const categories = [];
if (npcIndex) {
  // index rows: `categoryFile,Display Name`; match file case-insensitively.
  const files = JSON.parse(rd('NPC/files.json') ?? '[]');
  const fileMap = new Map(files.map((f) => [f.toLowerCase(), f]));
  for (const line of npcIndex.split(/\r?\n/)) {
    const [file, ...nameParts] = line.trim().split(',');
    if (!file || nameParts.length === 0) continue;
    const actual = fileMap.get(`${file.toLowerCase()}.csv`) ?? `${file}.csv`;
    const text = rd(`NPC/${actual}`);
    if (text === null) continue;
    categories.push({ name: nameParts.join(','), entries: parseCategoryCsv(text) });
  }
}
write('npcs.json', { categories });

// --- music.json / sfx.json / floors.json ------------------------------------

const kvMap = (text, keyTransform = (k) => k) => {
  const out = {};
  for (const line of (text ?? '').split(/\r?\n/)) {
    const i = line.indexOf(',');
    if (i < 0) continue;
    out[keyTransform(line.slice(0, i).trim())] = line.slice(i + 1).trim();
  }
  return out;
};

write('music.json', { names: kvMap(rd('Music/names.csv')) });
write('sfx.json', { folders: kvMap(rd('SFX/folders.csv')), names: kvMap(rd('SFX/names.csv')) });

const floors = [];
for (const line of (rd('Floor.csv') ?? '').split(/\r?\n/)) {
  const cells = line.split(',');
  if (cells.length < 3) continue;
  const zone = cells[0].trim(), spec = cells[1].trim(), fourcc = cells[2].trim();
  if (!/^\d+(\/\d+){1,2}$/.test(spec) || !fourcc) continue;
  floors.push({ zone, spec, fourcc });
}
write('floors.json', floors);
