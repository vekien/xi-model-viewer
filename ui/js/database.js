/**
 * Makeshift "database" over the client's raw record DATs.
 *
 * Two record formats live here:
 *
 *  - Item DATs — fixed 0xC00-byte blocks, each byte rotated left 3 bits
 *    (Windower's ResourceExtractor calls the inverse "rotate right 5"). The
 *    plaintext block is a small typed header (layout differs per category:
 *    weapons keep DMG/Delay, armor keeps Level/Slots/Jobs, …), a string block
 *    (u32 count, count × {offset u32, flag u32}; flag 0 = text sub-string
 *    with a 0x1C prefix, flag 1 = a bare number) and, at 0x280, the 32×32
 *    paletted icon in the same texture header the models use. A few of the
 *    high-id DATs are not items at all (slip contents, position lists, id
 *    lists) and get their own small decoders below.
 *
 *  - d_msg string tables — the fixed-stride variant (quests, missions, key
 *    items, titles) and the variable-stride variant (job names, status
 *    names, equipment slots). Header byte 0x0A says whether the payload is
 *    XOR 0xFF. Each block is n × {offset, flag} then sub-strings: marker u32,
 *    and when marker === 1, 0x18 meta bytes and a NUL-terminated cp932 string.
 *    A sub-string whose marker !== 1 is a number (quest id, key-item id, …).
 *
 * `xi mv database` (xi-tools, src/xi/mv/xi_database.py) writes the same rows
 * out as JSON so the viewer can skip the 20 MB DAT reads; keep the two in
 * step when a layout changes. Nothing here touches the DOM.
 */

// ── registry ────────────────────────────────────────────────────────────────

/**
 * Item tables. `parts` are the DATs merged into one table, in id order.
 * `layout` picks the typed header decoder (see readItemHeader) or one of the
 * special block decoders for the non-item DATs.
 */
export const ITEM_TABLES = [
  {
    key: 'general', label: 'General', layout: 'general',
    parts: [
      { en: 'ROM/118/106.DAT', jp: 'ROM/0/4.DAT', range: [0, 4095] },
      { en: 'ROM/301/115.DAT', jp: 'ROM/301/114.DAT', range: [8704, 10239] },
    ],
  },
  {
    key: 'usable', label: 'Consumables', layout: 'usable',
    parts: [{ en: 'ROM/118/107.DAT', jp: 'ROM/0/5.DAT', range: [4096, 8191] }],
  },
  {
    key: 'puppet', label: 'Automaton', layout: 'puppet',
    parts: [{ en: 'ROM/118/110.DAT', jp: 'ROM/0/8.DAT', range: [8192, 8703] }],
  },
  {
    key: 'armor', label: 'Armor', layout: 'armor',
    parts: [
      { en: 'ROM/118/109.DAT', jp: 'ROM/0/7.DAT', range: [10240, 16383] },
      { en: 'ROM/286/73.DAT', jp: 'ROM/286/72.DAT', range: [23040, 28671] },
    ],
  },
  {
    key: 'weapons', label: 'Weapons', layout: 'weapon',
    parts: [{ en: 'ROM/118/108.DAT', jp: 'ROM/0/6.DAT', range: [16384, 23039] }],
  },
  {
    key: 'maze', label: 'Maze Mongers', layout: 'maze',
    parts: [{ en: 'ROM/217/21.DAT', jp: 'ROM/217/20.DAT', range: [28672, 29695] }],
  },
  {
    key: 'monst1', label: 'Monstrosity Instincts', layout: 'instinct',
    parts: [{ en: 'ROM/288/80.DAT', jp: 'ROM/288/79.DAT', range: [29696, 30719] }],
  },
  {
    key: 'roeObj', label: 'RoE Objectives', layout: 'roe',
    parts: [{ en: 'ROM/307/16.DAT', jp: 'ROM/307/15.DAT', range: [57344, 61431] }],
  },
  {
    // Listed as "Storage Slips" in the community DAT index, but the blocks
    // are (instinct item id, cost) pairs — the Monstrosity instinct pages.
    key: 'items3', label: 'Instinct Lists', layout: 'instinctList',
    parts: [{ en: 'ROM/314/89.DAT', jp: 'ROM/314/89.DAT', range: [61432, 61439] }],
  },
  {
    key: 'monst2', label: 'Monstrosity Species', layout: 'species',
    parts: [{ en: 'ROM/288/67.DAT', jp: 'ROM/288/66.DAT', range: [61440, 61951] }],
  },
  {
    key: 'roeCat', label: 'RoE Categories', layout: 'roeCat',
    parts: [{ en: 'ROM/307/24.DAT', jp: 'ROM/307/23.DAT', range: [61952, 62975] }],
  },
  {
    key: 'items4', label: 'Positions', layout: 'positions',
    parts: [{ en: 'ROM/320/26.DAT', jp: 'ROM/320/26.DAT', range: [62976, 62995] }],
  },
  {
    key: 'items5', label: 'Command Groups', layout: 'idlist',
    parts: [{ en: 'ROM/332/49.DAT', jp: 'ROM/332/47.DAT', range: [63008, 63023] }],
  },
  {
    key: 'items6', label: 'Commands', layout: 'general',
    parts: [{ en: 'ROM/332/48.DAT', jp: 'ROM/332/46.DAT', range: [63024, 63263] }],
  },
  {
    key: 'gil', label: 'Currency', layout: 'general',
    parts: [{ en: 'ROM/174/48.DAT', jp: 'ROM/0/9.DAT', range: [65535, 65535] }],
  },
];

/** d_msg tables. `subs` names the sub-strings when the layout is known. */
const QUEST_SUBS = ['id', 'name', 'description'];
const HELP_SUBS = ['name', 'help'];

const dm = (key, label, en, jp, subs) => ({ key, label, subs, parts: [{ en, jp }] });

export const DMSG_GROUPS = [
  {
    key: 'quests', label: 'Quests', icon: 'assignment',
    tables: [
      dm('q_sandoria', "San d'Oria", 'ROM/176/60.DAT', 'ROM/176/46.DAT', QUEST_SUBS),
      dm('q_bastok', 'Bastok', 'ROM/176/61.DAT', 'ROM/176/47.DAT', QUEST_SUBS),
      dm('q_windurst', 'Windurst', 'ROM/176/62.DAT', 'ROM/176/48.DAT', QUEST_SUBS),
      dm('q_jeuno', 'Jeuno', 'ROM/176/63.DAT', 'ROM/176/49.DAT', QUEST_SUBS),
      dm('q_other', 'Other Areas', 'ROM/176/64.DAT', 'ROM/176/50.DAT', QUEST_SUBS),
      dm('q_toau', 'Aht Urhgan', 'ROM/176/66.DAT', 'ROM/176/52.DAT', QUEST_SUBS),
      dm('q_wotg', 'Wings of the Goddess', 'ROM/196/6.DAT', 'ROM/196/3.DAT', QUEST_SUBS),
      dm('q_abyssea', 'Abyssea', 'ROM/242/64.DAT', 'ROM/242/63.DAT', QUEST_SUBS),
      dm('q_assault', 'Assault', 'ROM/176/72.DAT', 'ROM/176/58.DAT', QUEST_SUBS),
      dm('q_campaign', 'Campaign Ops', 'ROM/196/8.DAT', 'ROM/196/5.DAT', QUEST_SUBS),
      dm('q_adoulin', 'Adoulin', 'ROM/293/70.DAT', 'ROM/293/67.DAT', QUEST_SUBS),
      dm('q_coalition', 'Coalition Assignments', 'ROM/293/71.DAT', 'ROM/293/68.DAT', QUEST_SUBS),
    ],
  },
  {
    key: 'missions', label: 'Missions', icon: 'flag',
    tables: [
      dm('m_sandoria', "San d'Oria", 'ROM/176/67.DAT', 'ROM/176/53.DAT', QUEST_SUBS),
      dm('m_bastok', 'Bastok', 'ROM/176/68.DAT', 'ROM/176/54.DAT', QUEST_SUBS),
      dm('m_windurst', 'Windurst', 'ROM/176/69.DAT', 'ROM/176/55.DAT', QUEST_SUBS),
      dm('m_zilart', 'Rise of the Zilart', 'ROM/176/70.DAT', 'ROM/176/56.DAT', QUEST_SUBS),
      dm('m_cop', 'Chains of Promathia', 'ROM/176/71.DAT', 'ROM/176/57.DAT', QUEST_SUBS),
      dm('m_toau', 'Aht Urhgan', 'ROM/176/73.DAT', 'ROM/176/59.DAT', QUEST_SUBS),
      dm('m_wotg', 'Wings of the Goddess', 'ROM/196/7.DAT', 'ROM/196/4.DAT', QUEST_SUBS),
      dm('m_acp', 'A Crystalline Prophecy', 'ROM/222/18.DAT', 'ROM/222/17.DAT', QUEST_SUBS),
      dm('m_amk', "A Moogle Kupo d'Etat", 'ROM/223/12.DAT', 'ROM/223/10.DAT', QUEST_SUBS),
      dm('m_asa', 'A Shantotto Ascension', 'ROM/223/13.DAT', 'ROM/223/11.DAT', QUEST_SUBS),
      dm('m_adoulin', 'Seekers of Adoulin', 'ROM/293/69.DAT', 'ROM/293/66.DAT', QUEST_SUBS),
      dm('m_rov', "Rhapsodies of Vana'diel", 'ROM/333/4.DAT', 'ROM/333/3.DAT', QUEST_SUBS),
    ],
  },
  {
    key: 'strings', label: 'Names & Text', icon: 'text_snippet',
    tables: [
      dm('keyitems', 'Key Items', 'ROM/175/35.DAT', 'ROM/175/34.DAT', ['id', 'category', 'unk2', 'unk3', 'name', 'plural', 'description']),
      dm('titles', 'Titles', 'ROM/180/78.DAT', 'ROM/180/77.DAT', ['name']),
      dm('jobs', 'Jobs', 'ROM/165/86.DAT', 'ROM/165/86.DAT', ['name']),
      dm('spells', 'Spell Names', 'ROM/181/73.DAT', 'ROM/181/69.DAT', ['name']),
      dm('spellHelp', 'Spell Help', 'ROM/181/75.DAT', 'ROM/181/71.DAT', HELP_SUBS),
      dm('abilities', 'Ability Names', 'ROM/181/72.DAT', 'ROM/181/68.DAT', ['name']),
      dm('abilityHelp', 'Ability Help', 'ROM/181/74.DAT', 'ROM/181/70.DAT', HELP_SUBS),
      dm('bluHelp', 'Blue Magic Help', 'ROM/166/116.DAT', 'ROM/166/115.DAT', HELP_SUBS),
      dm('status', 'Status Names', 'ROM/180/102.DAT', 'ROM/180/101.DAT', ['name', 'adjective']),
      dm('mounts', 'Mounts', 'ROM/351/84.DAT', 'ROM/351/82.DAT', ['name', 'keyItem']),
      dm('mountHelp', 'Mount Help', 'ROM/351/85.DAT', 'ROM/351/83.DAT', HELP_SUBS),
      dm('monsterFamilies', 'Monster Families', 'ROM/188/38.DAT', 'ROM/188/37.DAT', ['name', 'plural']),
      dm('slots', 'Equipment Slots', 'ROM/175/33.DAT', 'ROM/175/32.DAT', ['name']),
      dm('augments', 'Augment Attributes', 'ROM/220/58.DAT', 'ROM/220/57.DAT', ['format']),
      dm('merits', 'Merit Points', 'ROM/169/75.DAT', 'ROM/169/74.DAT', ['text']),
      dm('jobPoints', 'Job Points', 'ROM/314/62.DAT', 'ROM/314/61.DAT', ['text']),
      dm('jobGifts', 'Job Point Gifts', 'ROM/324/59.DAT', 'ROM/324/58.DAT', ['text']),
      dm('soulplates', 'Soulplate Attributes', 'ROM/187/70.DAT', 'ROM/187/67.DAT', ['text']),
      dm('trust', 'Trust Messages', 'ROM/311/74.DAT', 'ROM/311/73.DAT', ['text']),
      dm('emoteHelp', 'Emote Help', 'ROM/327/124.DAT', 'ROM/327/123.DAT', ['text']),
      dm('chatHelp', 'Chat Commands', 'ROM/173/89.DAT', 'ROM/173/88.DAT', ['text']),
      dm('mazeRunes', 'Maze Rune Help', 'ROM/219/86.DAT', 'ROM/219/85.DAT', HELP_SUBS),
      dm('headings', 'Headings', 'ROM/165/81.DAT', 'ROM/165/67.DAT', ['name']),
      dm('servers', 'Server Names', 'ROM/333/34.DAT', 'ROM/333/33.DAT', ['name']),
    ],
  },
];

/** Tree shown in the explorer: Items then the d_msg groups. */
export const DB_TREE = [
  {
    key: 'items', label: 'Items', icon: 'inventory_2',
    tables: ITEM_TABLES.map((t) => ({ ...t, kind: 'items' })),
  },
  ...DMSG_GROUPS.map((g) => ({ ...g, tables: g.tables.map((t) => ({ ...t, kind: 'dmsg' })) })),
];

export function findDbTable(key) {
  for (const g of DB_TREE) {
    const t = g.tables.find((x) => x.key === key);
    if (t) return { ...t, group: g.key, groupLabel: g.label };
  }
  return null;
}

/** Game-relative DAT paths for a table in one language. */
export function tablePaths(table, lang = 'en') {
  return table.parts.map((p) => p[lang] || p.en);
}

// ── item enums ──────────────────────────────────────────────────────────────

export const JOB_ABBR = [
  'NONE', 'WAR', 'MNK', 'WHM', 'BLM', 'RDM', 'THF', 'PLD', 'DRK', 'BST', 'BRD',
  'RNG', 'SAM', 'NIN', 'DRG', 'SMN', 'BLU', 'COR', 'PUP', 'DNC', 'SCH', 'GEO', 'RUN',
];
const ALL_JOBS_MASK = 0x007ffffe;

export const SLOT_NAMES = [
  'Main', 'Sub', 'Range', 'Ammo', 'Head', 'Body', 'Hands', 'Legs', 'Feet',
  'Neck', 'Waist', 'L.Ear', 'R.Ear', 'L.Ring', 'R.Ring', 'Back',
];

export const RACE_NAMES = [
  null, 'Hume ♂', 'Hume ♀', 'Elvaan ♂', 'Elvaan ♀', 'Tarutaru ♂', 'Tarutaru ♀', 'Mithra', 'Galka',
];
const ALL_RACES_MASK = 0x1fe;

export const SKILL_NAMES = {
  0: 'None', 1: 'Hand-to-Hand', 2: 'Dagger', 3: 'Sword', 4: 'Great Sword', 5: 'Axe',
  6: 'Great Axe', 7: 'Scythe', 8: 'Polearm', 9: 'Katana', 10: 'Great Katana', 11: 'Club',
  12: 'Staff', 25: 'Archery', 26: 'Marksmanship', 27: 'Throwing', 41: 'Fishing',
  48: 'Fishing Rod', 49: 'Ammo', 50: 'Instrument', 51: 'Bait', 52: 'Grip', 53: 'Pet Food',
  54: 'Handbell', 55: 'Bell',
};

export const ITEM_TYPES = {
  0: 'Nothing', 1: 'Item', 2: 'Quest Item', 3: 'Fish', 4: 'Weapon', 5: 'Armor', 6: 'Linkshell',
  7: 'Usable', 8: 'Crystal', 10: 'Furnishing', 11: 'Plant', 12: 'Flowerpot', 13: 'Puppet Item',
  14: 'Mannequin', 15: 'Book', 16: 'Racing Form', 17: 'Betting Slip', 18: 'Soul Plate',
  19: 'Reflector', 20: 'Log', 21: 'Lottery Ticket', 22: 'Maze Tabula M', 23: 'Maze Tabula R',
  24: 'Maze Voucher', 25: 'Maze Rune', 26: 'Evolith', 27: 'Storage Slip', 28: 'Legion Pass',
  29: 'Meeble Burrows', 30: 'Instinct', 31: 'Chocobo Food', 33: 'Monipulator',
};

export const ITEM_FLAGS = [
  [0x0001, 'Wall Hanging'], [0x0002, 'Flag 0x02'], [0x0004, 'Mystery Box'], [0x0008, 'MC'],
  [0x0010, 'Inscribable'], [0x0020, 'No Auction'], [0x0040, 'Scroll'], [0x0080, 'Linkshell'],
  [0x0100, 'Can Use'], [0x0200, 'Can Trade NPC'], [0x0400, 'Can Equip'], [0x0800, 'No Sale'],
  [0x1000, 'No Delivery'], [0x2000, 'Ex'], [0x4000, 'No Trade PC'], [0x8000, 'Rare'],
];

/** Element icons the client draws for 0xEF 0x1F..0x26 in item text. */
export const ELEMENT_GLYPHS = ['Fire', 'Ice', 'Wind', 'Earth', 'Lightning', 'Water', 'Light', 'Dark'];

export function jobsLabel(mask) {
  if (!mask) return '';
  if ((mask & ALL_JOBS_MASK) === ALL_JOBS_MASK) return 'All Jobs';
  const out = [];
  for (let i = 1; i < JOB_ABBR.length; i++) if (mask & (1 << i)) out.push(JOB_ABBR[i]);
  return out.join(' ');
}

export function slotsLabel(mask) {
  if (!mask) return '';
  const out = [];
  for (let i = 0; i < SLOT_NAMES.length; i++) if (mask & (1 << i)) out.push(SLOT_NAMES[i]);
  return out.join(' / ');
}

export function racesLabel(mask) {
  if (!mask) return '';
  if ((mask & ALL_RACES_MASK) === ALL_RACES_MASK) return 'All Races';
  const out = [];
  for (let i = 1; i < RACE_NAMES.length; i++) if (mask & (1 << i)) out.push(RACE_NAMES[i]);
  return out.join(', ');
}

export function flagsLabel(flags) {
  return ITEM_FLAGS.filter(([bit]) => flags & bit).map(([, name]) => name).join(', ');
}

// ── bytes & text ────────────────────────────────────────────────────────────

export const ITEM_BLOCK = 0xc00;
const ICON_OFFSET = 0x280;

/** Rotate every byte left by 3 (the client's item "encryption"). */
export function decodeItemBlock(src, dst = new Uint8Array(src.length)) {
  for (let i = 0; i < src.length; i++) {
    const b = src[i];
    dst[i] = ((b << 3) | (b >> 5)) & 0xff;
  }
  return dst;
}

/** cp932 decode with graceful fallback. */
export function decodeCp932(u8) {
  if (!u8?.length) return '';
  try {
    return new TextDecoder('shift_jis').decode(u8);
  } catch {
    let s = '';
    for (let i = 0; i < u8.length; i++) {
      const c = u8[i];
      if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c);
      else if (c === 0x0a) s += '\n';
    }
    return s;
  }
}

/**
 * Item text carries client-side glyph codes that are not Shift-JIS: 0xEF
 * 0x1F..0x26 are the eight element icons ("� -20" in a naive decode is
 * Ice-20). Anything else in the 0xEF/0xFD lead-byte space is dropped rather
 * than left as U+FFFD.
 */
export function decodeItemText(u8) {
  if (!u8?.length) return '';
  let out = '';
  let run = 0;
  const flush = (end) => {
    if (end > run) out += decodeCp932(u8.subarray(run, end));
  };
  for (let i = 0; i < u8.length; i++) {
    const c = u8[i];
    if (c === 0xef && i + 1 < u8.length) {
      const k = u8[i + 1] - 0x1f;
      flush(i);
      if (k >= 0 && k < ELEMENT_GLYPHS.length) out += ELEMENT_GLYPHS[k];
      i += 1;
      run = i + 1;
    } else if (c === 0xfd && i + 1 < u8.length) {
      // Auto-translate bracket; the payload is a 4-byte id we can't resolve.
      flush(i);
      i += Math.min(4, u8.length - 1 - i);
      run = i + 1;
    }
  }
  flush(u8.length);
  return out;
}

function cstrBytes(block, at) {
  if (at >= block.length) return null;
  let end = at;
  while (end < block.length && block[end] !== 0) end++;
  return block.subarray(at, end);
}

/** Hex dump of block[start, start+len) as space-separated bytes. */
export function hexOf(block, start = 0, len = 0x40) {
  const end = Math.min(block.length, start + len);
  let s = '';
  for (let i = start; i < end; i++) s += (i > start ? ' ' : '') + block[i].toString(16).padStart(2, '0');
  return s;
}

export function bytesToBase64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ── item blocks ─────────────────────────────────────────────────────────────

/** Sub-string layouts per client language. EN: name, article flag, log name, plural, description. */
const EN_SUBS = ['name', 'article', 'logName', 'logPlural', 'description'];
const JP_SUBS = ['name', 'description'];

/**
 * Locate the item string block: the first offset whose u32 count is small and
 * whose first entry points straight past the entry table. Layouts differ per
 * DAT (general 0x18, usable 0x1C, armor 0x2C, weapon 0x38, …) but this sniff
 * works for all of them, including the ones with no known header.
 */
function findStringBlock(dv) {
  for (let off = 0x08; off <= 0x80; off += 2) {
    const n = dv.getUint32(off, true);
    if (n < 1 || n > 8) continue;
    const first = dv.getUint32(off + 4, true);
    if (first !== 4 + n * 8) continue;
    let ok = true;
    for (let i = 0; i < n; i++) {
      const o = dv.getUint32(off + 4 + i * 8, true);
      const f = dv.getUint32(off + 8 + i * 8, true);
      if (o < first || off + o + 4 > ICON_OFFSET || f > 1) { ok = false; break; }
    }
    if (ok) return { off, n };
  }
  return null;
}

function readStrings(dv, block, sb) {
  const subs = [];
  for (let i = 0; i < sb.n; i++) {
    const o = dv.getUint32(sb.off + 4 + i * 8, true);
    const f = dv.getUint32(sb.off + 8 + i * 8, true);
    if (f === 0) subs.push(decodeItemText(cstrBytes(block, sb.off + o + 0x1c)));
    else subs.push(dv.getUint32(sb.off + o, true));
  }
  return subs;
}

const u16 = (dv, o) => dv.getUint16(o, true);
const u32 = (dv, o) => dv.getUint32(o, true);
const i32 = (dv, o) => dv.getInt32(o, true);

/** Layouts that are real item records (header + strings + icon). */
export const ITEM_LAYOUTS = new Set(['general', 'usable', 'puppet', 'armor', 'weapon', 'maze', 'instinct', 'roe']);

/** Typed header fields for a decoded block; layout name from ITEM_TABLES. */
function readItemHeader(dv, layout) {
  const h = {
    id: u32(dv, 0x00),
    flags: u16(dv, 0x04),
    stack: u16(dv, 0x06),
    type: u16(dv, 0x08),
    resourceId: u16(dv, 0x0a),
    targets: u16(dv, 0x0c),
  };
  if (layout === 'armor' || layout === 'weapon') {
    h.level = u16(dv, 0x0e);
    h.slots = u16(dv, 0x10);
    h.races = u16(dv, 0x12);
    h.jobs = u32(dv, 0x14);
    h.superiorLevel = u16(dv, 0x18);
  }
  if (layout === 'armor') {
    h.shieldSize = u16(dv, 0x1a);
    h.maxCharges = u16(dv, 0x1c);
    h.castTime = u16(dv, 0x1e);
    h.useDelay = u16(dv, 0x20);
    h.reuseDelay = u16(dv, 0x22);
    h.itemLevel = u16(dv, 0x26);
  } else if (layout === 'weapon') {
    h.damage = u16(dv, 0x1c);
    h.delay = u16(dv, 0x1e);
    h.dps = u16(dv, 0x20);
    h.skill = dv.getUint8(0x22);
    h.jugSize = dv.getUint8(0x23);
    h.maxCharges = u16(dv, 0x28);
    h.castTime = u16(dv, 0x2a);
    h.useDelay = u16(dv, 0x2c);
    h.reuseDelay = u16(dv, 0x2e);
    // Relic/mythic/empyrean tiers all point at the chain's first item here
    // (every Excalibur → 18276); 0 for everything else.
    h.baseItemId = u16(dv, 0x30);
    h.itemLevel = u16(dv, 0x32);
  } else if (layout === 'usable') {
    h.castTime = u16(dv, 0x0e);
  } else if (layout === 'puppet') {
    h.puppetSlot = u16(dv, 0x0e);
    h.elementCharge = u32(dv, 0x10);
  } else if (layout === 'instinct') {
    h.level = u16(dv, 0x0e);
    h.instinctCost = u16(dv, 0x18);
  }
  return h;
}

/**
 * Raw (un-derived) row for one decoded item block, or null for an unused
 * slot. This is exactly what `xi mv database` writes to JSON; hydrateItemRow
 * adds the display fields.
 */
export function rawItemRow(block, layout, lang = 'en') {
  const dv = new DataView(block.buffer, block.byteOffset, block.byteLength);
  if (ITEM_LAYOUTS.has(layout)) {
    const h = readItemHeader(dv, layout);
    const sb = findStringBlock(dv);
    if (!sb) return null;
    const subs = readStrings(dv, block, sb);
    const strings = {};
    const subNames = lang === 'jp' ? JP_SUBS : EN_SUBS;
    subs.forEach((s, k) => { strings[subNames[k] ?? `sub${k}`] = s; });
    const name = typeof strings.name === 'string' ? strings.name : '';
    if (!name || /^\.+$/.test(name.trim())) return null;
    return { ...h, strings, stringOffset: sb.off };
  }
  const id = u32(dv, 0x00);
  if (!id) return null;
  return { id, block: bytesToBase64(block) };
}

/**
 * Stats the client only states in prose ("DEF:123 HP+57 STR+26 …"). Pulled
 * out so armor/weapon rows can carry DEF/HP/STR… columns; everything else
 * the regex catches lands in `other`.
 */
const CORE_STATS = ['DEF', 'DMG', 'Delay', 'HP', 'MP', 'STR', 'DEX', 'VIT', 'AGI', 'INT', 'MND', 'CHR'];
const STAT_RE = /("[^"]+"|[A-Za-z][A-Za-z.' ]{0,28}?)\s*([:+-])\s*([+-]?)(\d+)(%?)/g;

export function parseStats(desc) {
  const stats = {};
  const other = [];
  if (!desc) return { stats, other };
  const text = desc.replace(/\n/g, ' ');
  let m;
  STAT_RE.lastIndex = 0;
  while ((m = STAT_RE.exec(text))) {
    const name = m[1].replace(/^"|"$/g, '').trim();
    if (!name) continue;
    const sign = (m[2] === '-' || m[3] === '-') ? -1 : 1;
    const value = sign * Number(m[4]);
    const shown = (sign < 0 ? '-' : (m[2] === ':' && !m[3] ? '' : '+')) + m[4] + m[5];
    const core = CORE_STATS.find((c) => c.toLowerCase() === name.toLowerCase());
    if (core) {
      if (stats[core] == null) stats[core] = value;
    } else {
      other.push(`${name}${m[2] === ':' ? ':' : ''}${shown}`);
    }
  }
  return { stats, other };
}

// ── special (non-item) block decoders ───────────────────────────────────────

/**
 * Structured view of one non-item block. Returns { summary, columns, rows,
 * name? } — `rows` are plain objects keyed by `columns[].key`.
 */
export function decodeSpecialBlock(block, layout) {
  const dv = new DataView(block.buffer, block.byteOffset, block.byteLength);
  switch (layout) {
    case 'instinctList': {
      // u16 count at 0x04, then count × (u16 instinct item id, u16 cost) —
      // ids resolve in the Monstrosity Instincts table (29699 = Rabbit Ins. I).
      const count = u16(dv, 0x04);
      const rows = [];
      for (let i = 0; i < count && 0x08 + i * 4 + 4 <= block.length; i++) {
        rows.push({ n: i, instinctId: u16(dv, 0x08 + i * 4), cost: u16(dv, 0x0a + i * 4) });
      }
      return {
        summary: `${count} instincts`,
        columns: [{ key: 'n', label: '#' }, { key: 'instinctId', label: 'Instinct id' }, { key: 'cost', label: 'Cost' }],
        rows,
      };
    }
    case 'positions': {
      // 0x14-byte records from 0x08: u16 zone, u16 seq, i32 x, i32 y, i32 z, u32 n.
      const rows = [];
      for (let o = 0x08; o + 0x14 <= block.length; o += 0x14) {
        const zone = u16(dv, o);
        if (!zone) break;
        rows.push({
          zone, seq: u16(dv, o + 2),
          x: i32(dv, o + 4) / 1000, y: i32(dv, o + 8) / 1000, z: i32(dv, o + 12) / 1000,
          n: u32(dv, o + 16),
        });
      }
      return {
        summary: `${rows.length} positions`,
        columns: [
          { key: 'zone', label: 'Zone' }, { key: 'seq', label: 'Seq' },
          { key: 'x', label: 'X' }, { key: 'y', label: 'Y' }, { key: 'z', label: 'Z' }, { key: 'n', label: 'N' },
        ],
        rows,
      };
    }
    case 'idlist': {
      // u16 unk, u16 count at 0x04, then count × u32 item id.
      const unk = u16(dv, 0x04);
      const count = u16(dv, 0x06);
      const rows = [];
      for (let i = 0; i < count && 0x08 + i * 4 + 4 <= block.length; i++) {
        rows.push({ n: i, itemId: u32(dv, 0x08 + i * 4) });
      }
      return {
        summary: `${count} ids (flag ${unk})`,
        columns: [{ key: 'n', label: '#' }, { key: 'itemId', label: 'Item id' }],
        rows,
      };
    }
    case 'roeCat': {
      // u32 count at 0x04, then 0x10-byte records: u32 id, u16 a, u16 b.
      const count = u32(dv, 0x04);
      const rows = [];
      for (let i = 0; i < count && 0x08 + i * 0x10 + 0x10 <= block.length; i++) {
        const o = 0x08 + i * 0x10;
        rows.push({ n: i, id: u32(dv, o), a: u16(dv, o + 4), b: u16(dv, o + 6) });
      }
      return {
        summary: `${count} objectives`,
        columns: [{ key: 'n', label: '#' }, { key: 'id', label: 'Id' }, { key: 'a', label: 'A' }, { key: 'b', label: 'B' }],
        rows,
      };
    }
    case 'species': {
      // u16 at 0x04, ASCII name at 0x06, stat table from 0x2E.
      const nameBytes = cstrBytes(block, 0x06);
      const name = nameBytes ? decodeCp932(nameBytes) : '';
      const rows = [];
      for (let o = 0x2e; o + 2 <= 0x80; o += 2) {
        const v = u16(dv, o);
        if (v) rows.push({ off: `0x${o.toString(16)}`, value: v, hex: v.toString(16).padStart(4, '0') });
      }
      return {
        name,
        summary: name || `species ${u32(dv, 0)}`,
        columns: [{ key: 'off', label: 'Offset' }, { key: 'value', label: 'Value' }, { key: 'hex', label: 'Hex' }],
        rows,
      };
    }
    default:
      return { summary: '', columns: [], rows: [] };
  }
}

// ── rows ────────────────────────────────────────────────────────────────────

/**
 * Display fields for a raw item row. `raw` is what rawItemRow returned (or
 * the same shape from the JSON database); `part`/`idx` say where the block
 * lives so the icon can be pulled from the DAT later.
 */
export function hydrateItemRow(raw, layout, part, idx) {
  const row = { ...raw, part, idx, offset: idx * ITEM_BLOCK, layout };
  if (ITEM_LAYOUTS.has(layout)) {
    const s = raw.strings || {};
    row.name = typeof s.name === 'string' ? s.name : '';
    row.logName = s.logName ?? '';
    row.logPlural = s.logPlural ?? '';
    row.description = typeof s.description === 'string' ? s.description : '';
    const { stats, other } = parseStats(row.description);
    row.stats = stats;
    row.other = other.join('  ');
    row.typeName = ITEM_TYPES[raw.type] ?? `#${raw.type}`;
    row.jobsText = raw.jobs != null ? jobsLabel(raw.jobs) : '';
    row.slotsText = raw.slots != null ? slotsLabel(raw.slots) : '';
    row.racesText = raw.races != null ? racesLabel(raw.races) : '';
    row.skillName = raw.skill != null ? (SKILL_NAMES[raw.skill] ?? `#${raw.skill}`) : '';
    row.flagsText = flagsLabel(raw.flags);
    return row;
  }
  const block = typeof raw.block === 'string' ? base64ToBytes(raw.block) : raw.block;
  row._block = block;
  delete row.block;
  const special = decodeSpecialBlock(block, layout);
  row.special = special;
  row.name = special.name || '';
  row.summary = special.summary;
  row.hex = hexOf(block, 0, 0x40);
  return row;
}

/** Parse one item DAT (one `part`) into raw rows: [{ idx, raw }]. */
export function parseItemDatRaw(buffer, layout, lang = 'en') {
  const bytes = new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  const count = Math.floor(bytes.length / ITEM_BLOCK);
  const out = [];
  const block = new Uint8Array(ITEM_BLOCK);
  for (let i = 0; i < count; i++) {
    decodeItemBlock(bytes.subarray(i * ITEM_BLOCK, (i + 1) * ITEM_BLOCK), block);
    const raw = rawItemRow(block, layout, lang);
    if (raw) out.push({ idx: i, raw });
  }
  return { rows: out, blocks: count };
}

/**
 * Build the item table document from its parts' buffers (in registry order).
 * `buffers[i]` may be null for a missing part.
 */
export function parseItemTable(buffers, table, lang = 'en') {
  const layout = table.layout || 'general';
  const rows = [];
  let blocks = 0;
  buffers.forEach((buf, part) => {
    if (!buf) return;
    const r = parseItemDatRaw(buf, layout, lang);
    blocks += r.blocks;
    for (const { idx, raw } of r.rows) rows.push(hydrateItemRow(raw, layout, part, idx));
  });
  return { kind: 'items', layout, rows, blocks, table };
}

/** Same document from the JSON `xi mv database` wrote. */
export function itemTableFromJson(json, table) {
  const layout = table.layout || 'general';
  const rows = (json.rows || []).map((r) => hydrateItemRow(r.raw ?? r, layout, r.part ?? 0, r.idx));
  return { kind: 'items', layout, rows, blocks: json.blocks ?? rows.length, table };
}

/**
 * Decode the 32×32 icon at 0x280 of a decoded block. Same header as the model
 * textures (type 0x91, 8-bit palette, bottom-up rows); palette alpha is the
 * client's 0..0x80 range so it is doubled on the way out.
 */
export function decodeItemIcon(block) {
  const dv = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const size = dv.getUint32(ICON_OFFSET, true);
  if (!size || size < 0x40) return null;
  let p = ICON_OFFSET + 4;
  const type = block[p]; p += 1;
  if (type !== 0x91 && type !== 0x81 && type !== 0xb1 && type !== 0x01) return null;
  p += 0x10;                 // name
  p += 4;                    // 0x28
  const width = dv.getInt32(p, true); p += 4;
  const height = dv.getInt32(p, true); p += 4;
  p += 2;                    // 1
  const bitCount = dv.getUint16(p, true); p += 2;
  p += 5 * 4;                // zeros
  const paletteBits = dv.getUint32(p, true); p += 4;
  if (type === 0xb1) p += 4;
  if (width <= 0 || height <= 0 || width > 128 || height > 128) return null;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const put = (x, y, c) => {
    const o = ((height - 1 - y) * width + x) * 4;
    pixels[o] = (c >>> 16) & 0xff;
    pixels[o + 1] = (c >>> 8) & 0xff;
    pixels[o + 2] = c & 0xff;
    pixels[o + 3] = Math.min(255, ((c >>> 24) & 0xff) * 2);
  };
  if (bitCount === 32) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) { put(x, y, dv.getUint32(p, true)); p += 4; }
    }
  } else {
    const palette = new Uint32Array(256);
    if (paletteBits === 0x10) {
      for (let i = 0; i < 256; i++) {
        const v = dv.getUint16(p, true); p += 2;
        const a = (v >>> 15) & 1 ? 0x80 : 0x00;
        const cr = (((v >>> 10) & 0x1f) * 255 / 31) | 0;
        const cg = (((v >>> 5) & 0x1f) * 255 / 31) | 0;
        const cb = ((v & 0x1f) * 255 / 31) | 0;
        palette[i] = ((a << 24) | (cr << 16) | (cg << 8) | cb) >>> 0;
      }
    } else {
      for (let i = 0; i < 256; i++) { palette[i] = dv.getUint32(p, true); p += 4; }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (p >= block.length) return null;
        put(x, y, palette[block[p++]]);
      }
    }
  }
  return { width, height, data: pixels };
}

/** Decoded block for one row (for the icon and the raw hex view). */
export function itemBlockAt(buffer, idx) {
  const bytes = new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  const start = idx * ITEM_BLOCK;
  if (start + ITEM_BLOCK > bytes.length) return null;
  return decodeItemBlock(bytes.subarray(start, start + ITEM_BLOCK));
}

// ── d_msg ───────────────────────────────────────────────────────────────────

const DMSG_META = 0x18;

function dmsgSubs(blk) {
  const dv = new DataView(blk.buffer, blk.byteOffset, blk.byteLength);
  if (blk.length < 4) return [];
  const n = dv.getUint32(0, true);
  if (n <= 0 || n > 64) return [];
  const subs = [];
  for (let i = 0; i < n; i++) {
    const eo = 4 + i * 8;
    if (eo + 8 > blk.length) break;
    const off = dv.getUint32(eo, true);
    if (off < 4 || off + 4 > blk.length) { subs.push(null); continue; }
    const marker = dv.getUint32(off, true);
    if (marker === 1) subs.push(decodeItemText(cstrBytes(blk, off + 4 + DMSG_META)));
    else subs.push(marker);
  }
  return subs;
}

/** Name the sub-strings of a d_msg row from the table registry. */
export function hydrateDmsgRow(row, table) {
  const subNames = table?.subs || [];
  row.fields = {};
  (row.subs || []).forEach((s, k) => { row.fields[subNames[k] ?? `sub${k}`] = s; });
  const firstText = (row.subs || []).find((s) => typeof s === 'string' && s.trim());
  row.name = typeof row.fields.name === 'string' ? row.fields.name : (firstText ?? '');
  return row;
}

/**
 * Parse a d_msg table (fixed or variable stride) into rows of sub-strings.
 * Returns null when the buffer is not a d_msg file.
 */
export function parseDmsgTable(buffer, table = null) {
  const bytes = new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  if (bytes.length < 0x40) return null;
  if (String.fromCharCode(...bytes.subarray(0, 5)) !== 'd_msg') return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const xor = bytes[0x0a] ? 0xff : 0;
  const fileSize = Math.min(dv.getUint32(0x14, true) || bytes.length, bytes.length);
  const tableOffset = dv.getUint32(0x18, true);
  const tableSize = dv.getUint32(0x1c, true);
  const stride = dv.getUint32(0x20, true);
  const num = dv.getUint32(0x28, true);
  if (tableOffset >= fileSize) return null;

  const body = bytes.slice(tableOffset, fileSize);
  if (xor) for (let i = 0; i < body.length; i++) body[i] ^= xor;
  const bdv = new DataView(body.buffer);

  const rows = [];
  let maxSubs = 0;
  const push = (i, blk, offset) => {
    const subs = dmsgSubs(blk);
    if (subs.length > maxSubs) maxSubs = subs.length;
    rows.push({ idx: i, offset, subs, length: blk.length });
  };
  if (tableSize === 0) {
    if (!(stride > 0)) return null;
    const actual = Math.min(num, Math.floor(body.length / stride));
    for (let i = 0; i < actual; i++) {
      push(i, body.subarray(i * stride, (i + 1) * stride), tableOffset + i * stride);
    }
  } else {
    const base = tableSize;
    const actual = Math.min(num, Math.floor(tableSize / 8));
    for (let i = 0; i < actual; i++) {
      const off = bdv.getUint32(i * 8, true);
      const len = bdv.getUint32(i * 8 + 4, true);
      const s = base + off;
      if (s + len > body.length) { rows.push({ idx: i, offset: tableOffset + s, subs: [], length: 0 }); continue; }
      push(i, body.subarray(s, s + len), tableOffset + s);
    }
  }
  for (const r of rows) hydrateDmsgRow(r, table);
  return {
    kind: 'dmsg', variant: tableSize === 0 ? 'fixed' : 'variable', stride, xor, num,
    tableOffset, rows, maxSubs, table,
  };
}

/** Same document from the JSON `xi mv database` wrote. */
export function dmsgTableFromJson(json, table) {
  const rows = (json.rows || []).map((r) => hydrateDmsgRow({ ...r }, table));
  const maxSubs = rows.reduce((n, r) => Math.max(n, r.subs?.length ?? 0), 0);
  return {
    kind: 'dmsg', variant: json.variant, stride: json.stride, xor: json.xor, num: json.num,
    tableOffset: json.tableOffset, rows, maxSubs, table,
  };
}
