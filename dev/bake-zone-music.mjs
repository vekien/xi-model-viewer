// Bakes the server's zone_settings table into the viewer's zone_music.json.
//
//   node dev/bake-zone-music.mjs [--sql <zone_settings.sql>] [--game <FFXI dir>]
//                               [--music <music.json>] [--out <zone_music.json>]
//
// zone_settings carries four BGM ids per zone: music_day, music_night,
// battlesolo and battlemulti. An id of 0 means genuine silence, not "missing" —
// Valkurm Dunes and Qufim Island ship no daytime track, which is why they feel
// so empty. That distinction is preserved as an explicit null.
//
// A BGM id is just a file number; the track lives at
// <root>/win/music/data/music<NNN>.bgw where <root> is whichever sound folder
// happens to carry it. Numbers are NOT unique across roots (music181 differs
// between sound2 and sound5), so the root is resolved by scanning the install.
// Later roots win, matching how expansions override base content — though no id
// actually referenced by a zone currently collides.

import fs from 'node:fs';
import path from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const SQL = arg('sql', 'D:/xi-server/sql/zone_settings.sql');
const GAME = arg('game', 'C:/Program Files (x86)/PlayOnline/SquareEnix/FINAL FANTASY XI');
const MUSIC = arg('music', 'ui/public/lists/music.json');
const OUT = arg('out', 'ui/public/lists/zone_music.json');

// ── which sound root holds each music number ───────────────────────────────
const SOUND_ROOTS = ['sound', 'sound2', 'sound3', 'sound4', 'sound5', 'sound6', 'sound7', 'sound8', 'sound9'];
const rootByNum = new Map();
for (const root of SOUND_ROOTS) {
  const dir = path.join(GAME, root, 'win', 'music', 'data');
  let files = [];
  try { files = fs.readdirSync(dir); } catch { continue; }
  for (const f of files) {
    const m = /^music(\d+)\.bgw$/i.exec(f);
    if (m) rootByNum.set(String(Number(m[1])), { root, file: f });
  }
}

let names = {};
try { names = JSON.parse(fs.readFileSync(MUSIC, 'utf8')).names ?? {}; } catch { /* names are optional */ }

/** Resolve a BGM id to a playable track, or null for "no music". */
function track(id) {
  if (!id) return null;
  const hit = rootByNum.get(String(id));
  if (!hit) return { id, root: null, file: null, name: null, missing: true };
  const key = `${hit.root}_${String(id).padStart(3, '0')}`;
  return { id, root: hit.root, file: hit.file, name: names[key] ?? null };
}

// ── parse the INSERT rows ──────────────────────────────────────────────────
// VALUES (zoneid, zonetype, zoneip, zoneport, name, music_day, music_night,
//         battlesolo, battlemulti, restriction, tax, misc)
const sql = fs.readFileSync(SQL, 'utf8');
const ROW = /INSERT INTO `zone_settings` VALUES \((\d+),(\d+),'[^']*',(\d+),'([^']*)',(\d+),(\d+),(\d+),(\d+),/g;

const out = {};
let rows = 0, withDay = 0, silentDay = 0, missing = 0;
for (const m of sql.matchAll(ROW)) {
  const [, zoneid, , , rawName, day, night, solo, party] = m;
  rows++;
  const entry = {
    name: rawName.replace(/_/g, ' '),
    day: track(+day),
    night: track(+night),
    battleSolo: track(+solo),
    battleParty: track(+party),
  };
  if (entry.day) withDay++; else silentDay++;
  for (const t of [entry.day, entry.night, entry.battleSolo, entry.battleParty]) {
    if (t?.missing) missing++;
  }
  out[zoneid] = entry;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);

console.log(`zone_music.json: ${rows} zones -> ${OUT}`);
console.log(`  music roots scanned : ${[...new Set([...rootByNum.values()].map((v) => v.root))].join(', ')}`);
console.log(`  distinct BGM files  : ${rootByNum.size}`);
console.log(`  zones with day BGM  : ${withDay}   silent by day: ${silentDay}`);
if (missing) console.log(`  ids with no file    : ${missing} (left resolvable at runtime)`);
