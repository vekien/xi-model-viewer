/**
 * Bakes `dev/gear-names.json` — a display name for every gear model id, so the
 * composer can label rows the AltanaViewer CSVs left unnamed.
 *
 * Those rows currently fall back to their DAT path ("183/67", "Unknown Scythe"),
 * because the CSV row carries a spec and no label. The game's own answer lives
 * in the server's `item_equipment` table, which maps each item to the model it
 * draws (`MId`); the pretty name comes from the BigDats item dump, keyed by
 * item id. Join the two and you get model id -> item name.
 *
 * Only ever consulted for rows `parseSlotCsv` marked `auto` — curated labels
 * such as "Melee Cyclas (MNK Relic)" are never overwritten.
 *
 *   node dev/gear-names.mjs
 *   node dev/gear-names.mjs --sql <item_equipment.sql> --items <items.json>
 *
 * Re-run whenever the server's item table changes: custom items land here too,
 * so a private-server model gets named the same way a retail one does.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const SQL = arg('sql', 'D:\\xi-server\\sql\\item_equipment.sql');
const ITEMS = arg('items', 'D:\\xi-tools\\thirdparty\\big data\\BigDats\\json\\items.json');
const OUT = arg('out', join(root, 'dev', 'gear-names.json'));

// item_equipment.slot is an equip-slot bitmask; our slot keys and the look
// string's slot nibble both key off it.
const SLOTS = [
  { key: 'main', bit: 1, nibble: 6 },
  { key: 'sub', bit: 2, nibble: 7 },
  { key: 'range', bit: 4, nibble: 8 },
  { key: 'head', bit: 16, nibble: 1 },
  { key: 'body', bit: 32, nibble: 2 },
  { key: 'hands', bit: 64, nibble: 3 },
  { key: 'legs', bit: 128, nibble: 4 },
  { key: 'feet', bit: 256, nibble: 5 },
];

/** (itemId,'name',level,ilevel,jobs,MId,shieldSize,scriptType,slot,...) */
const ROW_RE = /\((\d+),'((?:[^'\\]|\\.)*)',(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),/g;

const titleCase = (s) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const sql = readFileSync(SQL, 'utf8');
const rows = [];
for (let m; (m = ROW_RE.exec(sql)); ) {
  rows.push({ itemId: +m[1], internal: m[2], mid: +m[6], slot: +m[9] });
}

const pretty = new Map();
for (const it of JSON.parse(readFileSync(ITEMS, 'utf8'))) pretty.set(it.id, it.name);

// slotKey -> modelId -> { itemId, name }. Lowest item id wins: model ids are
// shared across a family ("Izayoi", "Izayoi +1", "Kogitsunemaru"), and the base
// item reads better as the model's name than whichever variant sorted first.
const names = {};
let encoded = 0;
for (const r of rows) {
  if (!r.mid) continue;
  for (const s of SLOTS) {
    if (!(r.slot & s.bit)) continue;
    // Some rows store MId pre-shifted as (slotNibble << 12) | model, the same
    // packing the look string uses. Unpack only when the nibble agrees with the
    // slot, so a genuinely large model id is never truncated.
    let model = r.mid;
    if (model >= 0x1000 && model >>> 12 === s.nibble) { model &= 0x0fff; encoded++; }
    const bucket = (names[s.key] ??= {});
    const prev = bucket[model];
    if (!prev || r.itemId < prev.itemId) {
      bucket[model] = { itemId: r.itemId, name: pretty.get(r.itemId) ?? titleCase(r.internal) };
    }
  }
}

const out = {};
let total = 0;
for (const s of SLOTS) {
  const bucket = names[s.key];
  if (!bucket) continue;
  out[s.key] = Object.fromEntries(
    Object.keys(bucket).map(Number).sort((a, b) => a - b).map((k) => [k, bucket[k].name]),
  );
  total += Object.keys(bucket).length;
}

writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
console.log(`parsed ${rows.length} item_equipment rows (${encoded} slot-packed MIds unpacked)`);
console.log(`wrote ${OUT} — ${total} model names across ${Object.keys(out).length} slots`);
