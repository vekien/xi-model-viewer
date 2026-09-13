// DATs the browser can name without opening them: the record tables the
// Database page decodes (item tables, d_msg string tables) plus a short list of
// string/lookup DATs that have no viewer of their own. Keys are the FTABLE
// path form (`ROM/118/106.DAT`, uppercase, forward slashes).
//
// Kept static and derived from the database registry so a table added there
// (`items7`, 10 September 2026) is labelled here without a second edit.

import { ITEM_TABLES, DMSG_GROUPS } from '../database.js';

/** Database layout → DAT Browser badge. */
const ITEM_LAYOUT_LABELS = {
  general: 'Items', usable: 'Items', puppet: 'Items', maze: 'Items', instinct: 'Items',
  roe: 'Items', instinctList: 'Items', species: 'Items', roeCat: 'Items', idlist: 'Items',
  positions: 'Data',
  armor: 'Armor', weapon: 'Weapons',
};

/**
 * DATs outside the database registry with a known role. XISTRING pools are the
 * client's menu/system strings (xi-tools docs/dats/ROM_97_menu_strings.md); the
 * ROM/27 pair are the monster ability name tables (JP / EN); the ROM/327 and
 * ROM/384 files are the emote command table and the two small lookup tables
 * registered at file ids 96–98 (ROM/384/118 arrived with the 10 September
 * 2026 update).
 */
export const EXTRA_KNOWN_DATS = [
  ['ROM/97/8.DAT', 'Strings'], ['ROM/97/18.DAT', 'Strings'], ['ROM/97/19.DAT', 'Strings'],
  ['ROM/97/20.DAT', 'Strings'], ['ROM/97/21.DAT', 'Strings'], ['ROM/97/22.DAT', 'Strings'],
  ['ROM/97/23.DAT', 'Strings'], ['ROM/97/36.DAT', 'Strings'], ['ROM/97/39.DAT', 'Strings'],
  ['ROM/97/41.DAT', 'Strings'], ['ROM/97/48.DAT', 'Strings'],
  ['ROM/27/79.DAT', 'Strings'], ['ROM/27/80.DAT', 'Strings'],
  ['ROM/327/122.DAT', 'Data'], ['ROM/384/118.DAT', 'Data'], ['ROM/384/119.DAT', 'Data'],
];

export function knownDatKey(path) {
  const p = String(path || '').replace(/\\/g, '/');
  const m = p.match(/(rom\d*\/\d+\/\d+\.dat)$/i);
  return (m ? m[1] : p).toUpperCase();
}

let _labels = null;
let _itemTables = null;

function build() {
  _labels = new Map();
  _itemTables = new Map();
  for (const t of ITEM_TABLES) {
    const label = ITEM_LAYOUT_LABELS[t.layout] ?? 'Items';
    for (const part of t.parts) {
      for (const rel of [part.en, part.jp]) {
        if (!rel) continue;
        const k = knownDatKey(rel);
        _labels.set(k, label);
        if (!_itemTables.has(k)) _itemTables.set(k, { ...t, lang: rel === part.jp && rel !== part.en ? 'jp' : 'en' });
      }
    }
  }
  for (const g of DMSG_GROUPS) {
    for (const t of g.tables) {
      for (const part of t.parts) {
        for (const rel of [part.en, part.jp]) if (rel) _labels.set(knownDatKey(rel), 'Strings');
      }
    }
  }
  for (const [rel, label] of EXTRA_KNOWN_DATS) _labels.set(knownDatKey(rel), label);
}

/** path → badge label for every DAT named above. */
export function knownDatLabels() {
  if (!_labels) build();
  return _labels;
}

/** The database item table a DAT path belongs to (with `lang`), or null. */
export function itemTableForPath(path) {
  if (!_itemTables) build();
  return _itemTables.get(knownDatKey(path)) ?? null;
}
