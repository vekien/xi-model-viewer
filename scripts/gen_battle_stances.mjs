// Regenerates the BATTLE_STANCE_NAMES table in ui/src/CharacterList.jsx.
//
// A Battle: * action is one battle stance DAT, indexed in the race's
// `battleByType` by the `info.weaponAnimationType` of the weapon that uses it.
// That type lives in the weapon's own race-specific model and the races do not
// agree on it, so the only way to name a stance is to read every main-hand DAT
// in the race's list and group them by the type they report.
//
//   XI_GAME_DIR="C:/.../FINAL FANTASY XI" node scripts/gen_battle_stances.mjs
//
// Prints the table; paste it over the one in CharacterList.jsx.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { parseEntity } = await import(pathToFileURL(path.join(ROOT, 'ui/js/dat.js')));

const GAME = process.env.XI_GAME_DIR ?? process.argv[2];
if (!GAME) { console.error('set XI_GAME_DIR (or pass the game dir as argv[1])'); process.exit(1); }

const chars = JSON.parse(fs.readFileSync(path.join(ROOT, 'ui/public/lists/characters.json'), 'utf8'));
const BS = String.fromCharCode(92);

const typeOf = (rel) => {
  try {
    const b = fs.readFileSync(path.join(GAME, rel.split(BS).join('/')));
    return parseEntity(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), rel)
      .info?.weaponAnimationType ?? null;
  } catch { return null; }
};

// List group -> display name, in the order a label should read them.
const NAMES = new Map([
  ['Hand-to-hand', 'Hand-to-Hand'], ['Dagger', 'Dagger'], ['Sword', 'Sword'],
  ['G.Sword', 'Great Sword'], ['Axe', 'Axe'], ['G.Axe', 'Great Axe'],
  ['Scythe', 'Scythe'], ['Polearm', 'Polearm'], ['Katana', 'Katana'],
  ['G.Katana', 'Great Katana'], ['Club', 'Club'], ['Staff', 'Staff'],
]);
// Retail mislabels the odd weapon (one sword reports the great sword type).
// A class has to reach this share of a type to be named by it.
const SHARE = 0.05;

const rows = [];
for (const race of chars.races) {
  const main = race.slots?.main ?? [];
  const byType = race.battleByType ?? [];
  if (!main.length || !byType.length) continue;

  const counts = new Map();   // type -> group -> n
  for (const item of main) {
    if (!NAMES.has(item.group)) continue;
    for (const p of item.paths ?? []) {
      const t = typeOf(p);
      if (t == null || t === 255) continue;
      if (!counts.has(t)) counts.set(t, new Map());
      const h = counts.get(t);
      h.set(item.group, (h.get(item.group) ?? 0) + 1);
    }
  }

  const cells = [];
  for (let t = 0; t < byType.length; t++) {
    // A type whose DAT is the type 0 fallback is not a stance of its own; the
    // bake never emits an action for it.
    if (t > 0 && byType[t] === byType[0]) continue;
    const h = counts.get(t);
    if (!h) { if (t === 10) cells.push(`${t}: 'Unarmed'`); continue; }
    const total = [...h.values()].reduce((a, b) => a + b, 0);
    const named = [...NAMES.keys()].filter((g) => (h.get(g) ?? 0) / total >= SHARE).map((g) => NAMES.get(g));
    if (named.length) cells.push(`${t}: '${named.join(' / ')}'`);
  }
  rows.push(`  ${race.id}: { ${cells.join(', ')} },`);
}
console.log('const BATTLE_STANCE_NAMES = {');
console.log(rows.join('\n'));
console.log('};');
