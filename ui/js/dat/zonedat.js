// Zone script DATs — the three per-zone companions to the model DAT:
//   NPC list  (entity names):  packed 32-byte records, char[28] name + u32 serverId
//   Events    (evte bytecode): actor blocks of event entry points + opcodes
//   Dialog    (event messages): XOR-0x80 string table with FFXI control codes
//
// Ports of xi-tools xi/event/xi_event.py and xi/dialog/xi_dialog.py
// (opcode size tables from the client's EventDisassembler.cpp; string decode
// tables from Shining Fantasia's Shift_JIS.ts). The zone-id ↔ file-id formulas
// mirror xi/zone/xi_inject.py.

// ── zone-id ↔ file-id math ──────────────────────────────────────────────────

const MODEL_BASE_HI = 0x147b3;   // model file id of zone 0x100

export function zoneForFileId(fid) {
  const inRange = (base, kind) => {
    if (fid >= base && fid < base + 0x100) return { zoneId: fid - base, kind };
    const hi = MODEL_BASE_HI + (base === 5820 ? 1100 : base === 6420 ? 1700 : 2600);
    if (fid >= hi && fid < hi + 0x100) return { zoneId: 0x100 + fid - hi, kind };
    return null;
  };
  return inRange(5820, 'events') ?? inRange(6420, 'dialog') ?? inRange(6720, 'npclist');
}

export function zoneFileIds(zoneId) {
  if (zoneId < 0x100) {
    return { events: 5820 + zoneId, dialog: 6420 + zoneId, npclist: 6720 + zoneId };
  }
  const m = MODEL_BASE_HI + (zoneId - 0x100);
  return { events: m + 1100, dialog: m + 1700, npclist: m + 2600 };
}

// ── format sniffing ─────────────────────────────────────────────────────────

/** 'dialog' | 'events' | 'npclist' | null for a non-sectioned DAT. */
export function sniffZoneDat(bytes) {
  const n = bytes.byteLength;
  if (n >= 8 && ((bytes[0] | (bytes[1] << 8) | (bytes[2] << 16)) + 4 === n)) return 'dialog';

  if (n >= 12) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, n);
    const bc = dv.getUint32(0, true);
    if (bc >= 1 && bc < 65536 && 4 + 4 * bc <= n) {
      let total = 4 + 4 * bc;
      for (let i = 0; i < bc; i++) total += dv.getUint32(4 + 4 * i, true);
      if (total === n) return 'events';
    }
  }

  if (n >= 32 && n % 32 === 0) {
    // Sample records: printable ASCII name + server id with the high byte set.
    const count = Math.min(8, n / 32);
    let ok = 0;
    for (let r = 0; r < count; r++) {
      const off = r * 32;
      let printable = true;
      let len = 0;
      for (let i = 0; i < 28; i++) {
        const c = bytes[off + i];
        if (c === 0) break;
        len++;
        if (c < 0x20 || c >= 0x7f) { printable = false; break; }
      }
      const sid = bytes[off + 28] | (bytes[off + 29] << 8) | (bytes[off + 30] << 16) | (bytes[off + 31] << 24);
      if (printable && len > 0 && (sid & 0xff000000) !== 0) ok++;
    }
    if (ok >= Math.max(1, count * 0.6)) return 'npclist';
  }
  return null;
}

// ── NPC list ────────────────────────────────────────────────────────────────

const SJIS = new TextDecoder('shift_jis');

export function parseNpcList(bytes) {
  const npcs = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = Math.floor(bytes.byteLength / 32);
  for (let r = 0; r < total; r++) {
    const off = r * 32;
    let end = off;
    while (end < off + 28 && bytes[end] !== 0) end++;
    const name = SJIS.decode(bytes.subarray(off, end)).trim();
    const id = dv.getUint32(off + 28, true);
    if (name && id) npcs.push({ index: r, id, name });
  }
  return npcs;
}

/** {serverId: name} for labeling event actors. */
export function npcNameMap(npcs) {
  const m = new Map();
  for (const n of npcs) if (!m.has(n.id)) m.set(n.id, n.name);
  return m;
}

// ── Event DAT (evte) ────────────────────────────────────────────────────────
// Opcode length table from the client's EventDisassembler.cpp — index = opcode,
// value = total instruction length incl. the opcode byte; 0 = variable/unknown.

const FIXED_SIZES = [
  1, 3, 8, 5, 3, 3, 3, 5, 5, 5, 5, 3, 3, 5, 5, 5,
  5, 5, 3, 5, 5, 5, 7, 7, 7, 5, 3, 1, 3, 3, 5, 0,
  2, 1, 2, 1, 7, 1, 1, 7, 7, 7, 6, 7, 13, 13, 1, 6,
  1, 0, 3, 2, 3, 3, 7, 9, 3, 3, 7, 11, 7, 7, 7, 7,
  9, 9, 1, 2, 5, 17, 0, 0, 3, 7, 9, 7, 1, 1, 6, 3,
  13, 13, 15, 13, 13, 15, 5, 3, 1, 0, 0, 0, 0, 5, 5, 0,
  0, 2, 17, 3, 11, 11, 0, 5, 1, 4, 7, 9, 9, 7, 7, 1,
  1, 0, 0, 11, 2, 0, 5, 5, 1, 0, 0, 5, 6, 3, 0, 1,
  5, 6, 7, 3, 1, 1, 6, 2, 2, 3, 1, 25, 0, 5, 1, 1,
  1, 3, 6, 3, 6, 3, 1, 5, 1, 5, 1, 1, 3, 0, 2, 17,
  15, 15, 15, 15, 2, 2, 0, 0, 6, 3, 17, 0, 0, 12, 0, 8,
  12, 4, 0, 0, 0, 4, 0, 0, 27, 8, 13, 17, 15, 15, 3, 0,
  3, 5, 0, 7, 11, 17, 15, 15, 7, 1, 0, 0, 0, 17, 15, 15,
  17, 15, 15, 6, 0, 17, 15, 15, 0, 2,
];

const SUB_TABLES = {
  0x59: [0, { 0: 4, 1: 8, 2: 4, 3: 8, 4: 8, 5: 7, 6: 6, 7: 4, 8: 8 }],
  0x8c: [0, { 0: 8, 1: 2, 2: 12, 3: 10, 4: 10, 5: 14 }],
  0x9d: [8, { 0: 8, 1: 8, 2: 6, 3: 8, 4: 8, 5: 8, 6: 8, 7: 6, 8: 23, 9: 9, 10: 10, 11: 10, 12: 8, 13: 10, 14: 10, 15: 10, 16: 10 }],
  0xac: [0, { 0: 4, 1: 4, 2: 6, 3: 6, 4: 8 }],
  0xae: [6, { 0: 6, 1: 8, 2: 8, 3: 8, 4: 8, 5: 10, 6: 6, 7: 10, 8: 10 }],
  0x71: [0, { 0: 2, 1: 2, 2: 2, 3: 4, 0x10: 4, 0x11: 4, 0x13: 4, 0x12: 6, 0x20: 16, 0x21: 2, 0x30: 4, 0x31: 4, 0x32: 6, 0x40: 4, 0x41: 8 }],
  0x5f: [0, { 0: 2, 1: 2, 2: 6, 3: 16, 4: 16, 5: 18, 6: 18, 7: 14 }],
  0x7a: [0, { 0: 6, 1: 7, 2: 6, 3: 2, 4: 8, 5: 6 }],
  0x7e: [6, { 0: 6, 1: 6, 2: 6, 3: 16, 4: 6, 5: 6, 6: 18, 7: 8, 8: 6 }],
  0xb3: [2, { 0: 4, 1: 14, 2: 2, 3: 4, 4: 4, 5: 18, 6: 4, 7: 4, 8: 2, 9: 4 }],
  0xb4: [0, { 0: 20, 1: 6, 2: 6, 3: 2, 4: 6, 5: 3, 6: 3, 7: 4, 8: 2, 9: 4, 10: 4, 11: 2, 12: 4, 13: 2, 14: 2, 15: 6, 0x10: 6, 0x11: 6, 0x12: 6, 0x13: 20, 0x14: 12, 0x15: 2 }],
  0xb6: [4, { 0: 4, 1: 4, 2: 4, 3: 4, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4, 9: 4, 10: 4, 11: 20, 12: 4, 13: 14, 14: 16, 15: 4, 0x10: 2, 0x11: 4, 0x12: 2, 0x13: 2, 0x14: 6, 0x15: 6 }],
  0xb7: [0, { 0: 10, 1: 8, 2: 8, 3: 8, 4: 8 }],
  0xcc: [4, { 0: 10, 1: 10, 2: 14, 3: 10, 0x10: 6, 0x11: 4, 0x20: 4 }],
  0xd4: [2, { 0: 2, 1: 8, 2: 2, 3: 6, 4: 12, 5: 12 }],
  0xd8: [6, { 0: 6, 1: 8, 2: 8, 3: 8, 4: 12 }],
};

function variableOpcodeSize(op, sub) {
  switch (op) {
    case 0x1f: return sub === 0 ? 8 : 2;
    case 0x31: return sub === 0 ? 10 : 2;
    case 0x46: return sub === 2 ? 4 : 2;
    case 0x47: return sub === 0 ? 10 : 2;
    case 0x5a: return sub === 0 ? 8 : 2;
    case 0x5b: case 0x66: return 15;
    case 0x5c: return sub <= 7 ? 4 : 6;
    case 0x60: return sub <= 1 ? 4 : sub === 2 ? 6 : 2;
    case 0x72: return sub === 0 ? 4 : 6;
    case 0x75: return sub === 0 ? 4 : 2;
    case 0x79: return sub === 1 ? 12 : 10;
    case 0xa6: return sub === 2 ? 4 : 2;
    case 0xa7: return sub === 1 ? 4 : 2;
    case 0xab: return sub === 0x11 ? 4 : 2;
    case 0xb2: return sub === 0 ? 2 : 4;
    case 0xbf: return (sub === 0 || sub === 0x60) ? 8 : 10;
    case 0xc2: return sub === 1 ? 4 : sub === 2 ? 6 : 2;
    default: {
      const t = SUB_TABLES[op];
      if (!t) return 0;
      return t[1][sub] ?? t[0];
    }
  }
}

function opcodeSize(op, sub) {
  if (op >= 0xda) return 0;
  const fixed = FIXED_SIZES[op];
  return fixed !== 0 ? fixed : variableOpcodeSize(op, sub);
}

export const EVENT_OPCODE_NAMES = {
  0x00: 'noop', 0x01: 'set_exec', 0x02: 'if', 0x03: 'get_store',
  0x05: 'set_one', 0x06: 'set_zero', 0x07: 'add', 0x08: 'sub',
  0x09: 'set_bit', 0x0a: 'clr_bit', 0x0b: 'inc', 0x0c: 'dec',
  0x1a: 'jump', 0x1b: 'break_jump', 0x1c: 'wait_time', 0x1d: 'print_msg',
  0x1e: 'look_talk', 0x1f: 'set_pos', 0x20: 'lock_player', 0x21: 'end',
  0x23: 'wait_dismiss', 0x24: 'dialog_menu', 0x25: 'wait_select',
  0x2b: 'print_msg2', 0x2c: 'load_task', 0x2d: 'zone_task',
  0x2e: 'cancel_clr', 0x2f: 'render_flags', 0x31: 'set_pos2',
  0x34: 'load_zone', 0x35: 'load_zone2', 0x36: 'set_pos3', 0x37: 'set_pos4',
  0x38: 'event_mode', 0x39: 'set_dir', 0x3a: 'yaw_float', 0x3b: 'get_pos',
  0x3e: 'bit_branch', 0x40: 'menu_flag', 0x41: 'menu_flag2',
  0x42: 'cancel_set', 0x43: 'notify_server', 0x44: 'entity_valid_branch',
  0x45: 'start_task', 0x46: 'camera', 0x47: 'update_pos_sv',
  0x48: 'print_msg3', 0x49: 'print_msg4', 0x4a: 'look_at', 0x4b: 'set_yaw',
  0x4c: 'open_door', 0x4d: 'close_door', 0x50: 'end_task',
  0x51: 'end_zone_task', 0x52: 'end_task2', 0x53: 'wait_task',
  0x54: 'wait_zone_task', 0x55: 'wait_main_task', 0x57: 'frame_delay',
  0x58: 'yield', 0x5b: 'sched_ext', 0x5c: 'music', 0x5d: 'music_vol',
  0x5e: 'stop_action', 0x63: 'anim_wait', 0x66: 'sched_ext2',
  0x67: 'hide_hud', 0x68: 'show_hud', 0x69: 'sound_vol', 0x6a: 'sound_vol2',
  0x6e: 'emote_anim', 0x73: 'cast_magic', 0x77: 'set_time', 0x78: 'reset_time',
  0x7b: 'stop_talking', 0xaf: 'get_camera', 0xb0: 'print_msg5', 0xba: 'set_entity_pos',
};

// Opcode → byte offset of its dialog-index work-selector (from opcode start).
const DIALOG_OPCODES = { 0x1d: 1, 0x24: 1, 0x2b: 5, 0x48: 1, 0x49: 1, 0xb0: 10 };
const ZONE_OPCODES = { 0x34: 1, 0x35: 1 };
const CUTSCENE_OPCODES = new Set([0x38, 0x46, 0x67]);
const PRINT_OPCODES = new Set([0x1d, 0x2b, 0x48, 0x49, 0xb0]);
const MENU_OPCODES = new Set([0x24, 0x25, 0x40, 0x41, 0x7f]);
const DOOR_OPCODES = new Set([0x4c, 0x4d]);
const CAST_OPCODES = new Set([0x73, 0xc4]);

// Byte offsets (within raw args, AFTER the opcode byte) of 4-byte actor ids.
const ACTOR_ARG_OPCODES = {
  0x45: [2, 6], 0x62: [2, 6], 0x52: [2, 6], 0x55: [2, 6],
  0x2c: [0, 4], 0x2d: [0, 4],
  0x50: [0, 4], 0x51: [0, 4], 0x53: [0, 4], 0x54: [0, 4],
  0x1e: [0], 0x4a: [0, 4], 0x4b: [0], 0x4e: [1], 0x6c: [0], 0x6e: [0],
  0x2b: [0], 0x73: [0, 4], 0xc4: [0, 4],
};

const ACTOR_MAGIC = new Map([
  [0x7fffffc0, 'local player'], [0x7ffffff0, 'local player'], [0x7ffffff9, 'local player'],
  [0x7ffffff8, 'event entity'],
]);
[0x7fffffc1, 0x7fffffc2, 0x7fffffc3, 0x7fffffc4, 0x7fffffc5]
  .forEach((v, i) => ACTOR_MAGIC.set(v, `party member ${i + 1}`));
[0x7fffffc6, 0x7fffffc7, 0x7fffffc8, 0x7fffffc9, 0x7fffffca, 0x7fffffcb]
  .forEach((v, i) => ACTOR_MAGIC.set(v, `alliance member ${i + 10}`));
[0x7fffffcc, 0x7fffffcd, 0x7fffffce, 0x7fffffcf, 0x7fffffd0, 0x7fffffd1]
  .forEach((v, i) => ACTOR_MAGIC.set(v, `alliance member ${i + 20}`));

export function actorLabel(aid, names = null) {
  if (ACTOR_MAGIC.has(aid)) return ACTOR_MAGIC.get(aid);
  const named = names?.get(aid);
  if (named) return named;
  if (aid & 0xff000000) return `NPC #${aid & 0x3ff}`;
  return null;
}

const isPrintableFourcc = (v) => {
  for (let i = 0; i < 4; i++) {
    const c = (v >>> (8 * i)) & 0xff;
    if (c < 0x20 || c >= 0x7f) return false;
  }
  return true;
};
const fourccStr = (v) => String.fromCharCode(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);

/** 2-byte work-selector at scene[pos]: 0x8000|idx → refs[idx], else -1. */
function resolveWorkSelector(scene, pos, refs) {
  if (pos + 1 >= scene.length) return -1;
  const v = scene[pos] | (scene[pos + 1] << 8);
  if ((v & 0x8000) && (v & 0x7fff) < refs.length) return refs[v & 0x7fff];
  return -1;
}

function disassembleEvent(scene, start, refs, eventId, names) {
  const opcodes = [];
  const dialogIds = [];
  let isCutscene = false;
  const seen = new Set();
  let pos = start;
  let limit = 8192;

  while (pos < scene.length && limit-- > 0 && !seen.has(pos)) {
    seen.add(pos);
    const op = scene[pos];
    const sub = pos + 1 < scene.length ? scene[pos + 1] : 0;
    const step = opcodeSize(op, sub);
    if (step < 1 || pos + step > scene.length) break;

    let dialogRef = -1;
    if (op in DIALOG_OPCODES) {
      dialogRef = resolveWorkSelector(scene, pos + DIALOG_OPCODES[op], refs);
      if (dialogRef >= 0 && !dialogIds.includes(dialogRef)) dialogIds.push(dialogRef);
    }
    let zoneRef = -1;
    if (op in ZONE_OPCODES) zoneRef = resolveWorkSelector(scene, pos + ZONE_OPCODES[op], refs);

    const rawArgs = scene.subarray(pos + 1, pos + step);
    const actors = [];
    for (const off of ACTOR_ARG_OPCODES[op] ?? []) {
      if (off + 4 > rawArgs.length) continue;
      const aid = (rawArgs[off] | (rawArgs[off + 1] << 8) | (rawArgs[off + 2] << 16) | (rawArgs[off + 3] << 24)) >>> 0;
      const label = actorLabel(aid, names);
      if (label) actors.push({ id: aid, label });
    }

    opcodes.push({
      offset: pos - start, op,
      name: EVENT_OPCODE_NAMES[op] ?? `unk_${op.toString(16).padStart(2, '0')}`,
      step, dialogRef, zoneRef, actors,
      args: Array.from(rawArgs, (b) => b.toString(16).padStart(2, '0')).join(' '),
    });
    if (CUTSCENE_OPCODES.has(op)) isCutscene = true;
    if (op === 0x21) break;
    pos += step;
  }

  return { eventId, offset: start, opcodes, isCutscene, dialogIds: dialogIds.sort((a, b) => a - b) };
}

export const EVENT_CATEGORIES = ['Cutscene', 'Menu', 'Dialogue', 'Door', 'Magic', 'Script', 'Empty'];

export function categorizeEvent(ev) {
  const ops = new Set(ev.opcodes.map((o) => o.op));
  if ([...ops].some((o) => CUTSCENE_OPCODES.has(o))) return 'Cutscene';
  if ([...ops].some((o) => MENU_OPCODES.has(o))) return 'Menu';
  if ([...ops].some((o) => PRINT_OPCODES.has(o))) return 'Dialogue';
  if ([...ops].some((o) => DOOR_OPCODES.has(o))) return 'Door';
  if ([...ops].some((o) => CAST_OPCODES.has(o))) return 'Magic';
  if (ev.opcodes.some((o) => o.op !== 0x21)) return 'Script';
  return 'Empty';
}

/**
 * Parse an event DAT into actor blocks. `names` (serverId → name, from the
 * zone's NPC list) labels actors and opcode operands when available.
 */
export function parseEventDat(bytes, names = null) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blockCount = dv.getUint32(0, true);
  if (blockCount > 65535 || 4 + 4 * blockCount > bytes.byteLength) {
    throw new Error(`implausible blockCount ${blockCount} — not an event DAT`);
  }
  const sizes = [];
  for (let i = 0; i < blockCount; i++) sizes.push(dv.getUint32(4 + 4 * i, true));

  const actors = [];
  let pos = 4 + 4 * blockCount;
  for (let bi = 0; bi < blockCount; bi++) {
    const block = bytes.subarray(pos, pos + sizes[bi]);
    const bdv = new DataView(block.buffer, block.byteOffset, block.byteLength);
    pos += sizes[bi];
    try {
      let bp = 0;
      const actorId = bdv.getUint32(bp, true); bp += 4;
      const eventCount = bdv.getUint32(bp, true); bp += 4;
      const offsets = [];
      for (let i = 0; i < eventCount; i++) { offsets.push(bdv.getUint16(bp, true)); bp += 2; }
      const eventIds = [];
      for (let i = 0; i < eventCount; i++) { eventIds.push(bdv.getUint16(bp, true)); bp += 2; }
      const refCount = bdv.getUint32(bp, true); bp += 4;
      const refs = [];
      for (let i = 0; i < refCount; i++) { refs.push(bdv.getUint32(bp, true)); bp += 4; }
      const sceneSize = bdv.getInt32(bp, true); bp += 4;
      const scene = block.subarray(bp, bp + sceneSize);

      const events = [];
      for (let i = 0; i < eventCount; i++) {
        if (eventIds[i] === 0xffff || eventIds[i] === 0xfffe) continue;
        const ev = disassembleEvent(scene, offsets[i], refs, eventIds[i], names);
        ev.category = categorizeEvent(ev);
        events.push(ev);
      }

      actors.push({
        actorId,
        label: actorLabel(actorId, names) ?? `0x${actorId.toString(16).toUpperCase().padStart(8, '0')}`,
        refCount, events,
        refFourccs: [...new Set(refs.filter(isPrintableFourcc).map(fourccStr))],
      });
    } catch { /* malformed block — skip, keep the rest */ }
  }
  return actors;
}

// ── Dialog DAT (event messages) ─────────────────────────────────────────────
// De-obfuscate (XOR 0x80 from byte 4), split by the u32 offset table, decode
// each string: FFXI treats 0x01 and everything ≥ 0x7F as a 2-byte lead; control
// codes come from the SPECIAL tables; the rest is Shift-JIS text.

const isTwoByteLead = (b) => b === 0x01 || b >= 0x7f;

// cval < 0x20 → [code, paramBytes] (codes: see CODE_NAMES in xi _sjis_data).
const LOW_SPECIAL = {
  0x00: [3, 0], 0x02: [4, 2], 0x03: [5, 2], 0x05: [6, 1], 0x07: [2, 0],
  0x08: [7, 0], 0x09: [8, 0], 0x0a: [9, 1], 0x0b: [2, 0], 0x0c: [10, 1],
  0x0d: [11, 1], 0x0e: [12, 1], 0x10: [13, 1], 0x11: [14, 1], 0x12: [15, 1],
  0x13: [1, 1], 0x14: [16, 1], 0x15: [2, 0], 0x16: [17, 1], 0x17: [1, 1],
  0x18: [19, 1], 0x19: [20, 1], 0x1a: [18, 1], 0x1c: [21, 1], 0x1d: [22, 1],
  0x1e: [1, 1], 0x1f: [1, 1],
};

// 0x7Fxx: default [1, 0]; these are the exceptions.
const SEVENF_SPECIAL = {
  0x34: [1, 1], 0x35: [1, 1], 0x36: [1, 1], 0x38: [1, 2], 0x80: [1, 1],
  0x81: [1, 1], 0x84: [23, 1], 0x85: [24, 0], 0x86: [25, 1], 0x87: [26, 1],
  0x88: [27, 1], 0x8f: [28, 1], 0x90: [29, 0], 0x91: [30, 0], 0x92: [31, 1],
  0x93: [32, 0], 0x94: [33, 1], 0x95: [34, 1], 0x96: [35, 1], 0x97: [36, 1],
  0x99: [37, 1], 0xa0: [1, 1], 0xa1: [1, 1], 0xa2: [1, 1], 0xa3: [1, 1],
  0xa4: [1, 1], 0xa5: [1, 1], 0xa6: [1, 1], 0xa7: [1, 1], 0xa8: [1, 1],
  0xa9: [1, 1], 0xaa: [1, 1], 0xab: [1, 1], 0xac: [1, 1], 0xb0: [1, 1],
  0xb1: [1, 1], 0xb4: [1, 1], 0xb5: [1, 1],
};

const DIALOG_CODE_NAMES = {
  4: 'set_x', 5: 'set_y', 6: 'skill', 7: 'player', 8: 'npc', 9: 'value',
  10: 'index', 11: 'sfx', 12: 'event_sfx', 13: 'spell', 14: 'event_spell',
  15: 'number', 16: 'time', 17: 'ability', 18: 'event_ability',
  19: 'party_member_by_id', 20: 'party_member', 21: 'event_string',
  22: 'heading', 23: 'ability_mods', 24: 'gender', 25: 'ability_plural',
  26: 'npc_plural', 27: 'npc_proper', 28: 'ability2', 29: 'npc0_gender',
  30: 'npc1_gender', 31: 'plural', 32: 'name', 33: 'two_digit',
  34: 'hex', 35: 'binary', 36: 'action_hex', 37: 'four_digit',
};

// FFXI-custom glyphs that deviate from cp932 (Shining Fantasia CHAR_OVERRIDE).
const CHAR_OVERRIDE = new Map([
  [0x005c, 0x00a5], [0x815f, 0x005c], [0x8160, 0x301c], [0x8161, 0x2016],
  [0x817c, 0x2212], [0x8191, 0x00a2], [0x8192, 0x00a3], [0x81ca, 0x00ac],
  [0x8540, 0x20ac], [0x8542, 0x201a], [0x8544, 0x201e], [0x8545, 0x2026],
  [0x8551, 0x2018], [0x8552, 0x2019], [0x8553, 0x201c], [0x8554, 0x201d],
  [0x855c, 0x0153], [0x87b2, 0x201c], [0x87b3, 0x201d],
  [0xed40, 0x23fb], [0xed41, 0x23cf],
]);
// 0x859F-0x85DE: Latin-1 accented letters À..ÿ mapped in order.
for (let i = 0; i <= 0x3f; i++) CHAR_OVERRIDE.set(0x859f + i, 0x00c0 + i);

function specialFor(cval) {
  if (cval < 0x20) return LOW_SPECIAL[cval] ?? null;
  const page = cval & 0xff00;
  if (page === 0x0100) return [1, cval & 0xff];
  if (page === 0x7f00) return SEVENF_SPECIAL[cval & 0xff] ?? [1, 0];
  if (page === 0xef00) return [1, 0];
  return null;
}

/** Decode one de-obfuscated, NUL-stripped string → { text, opcodes }. */
export function decodeEventString(raw) {
  const out = [];
  const ops = [];
  let pending = [];   // raw bytes awaiting a Shift-JIS flush
  const flush = () => {
    if (pending.length) { out.push(SJIS.decode(new Uint8Array(pending))); pending = []; }
  };

  let i = 0;
  while (i < raw.length) {
    const lead = raw[i];
    let n = isTwoByteLead(lead) && i + 1 < raw.length ? 2 : 1;
    const cval = n === 2 ? (lead << 8) | raw[i + 1] : lead;
    const sp = specialFor(cval);
    if (sp) {
      if (cval === 0) break;
      flush();
      const [code, extra] = sp;
      const params = Array.from(raw.subarray(i + n, i + n + extra));
      // Inline rendering: newline, prompts (page breaks), content substitutions.
      if (cval === 0x07) out.push('\n');
      else if (cval >= 0x7f31 && cval <= 0x7f37 && cval !== 0x7f34 && cval !== 0x7f35 && cval !== 0x7f36) out.push('▼\n');
      else if (cval === 0x7f34 || cval === 0x7f35 || cval === 0x7f36) out.push(`[auto ${params[0] ?? 0}s]\n`);
      else if (code === 7) out.push('{player}');
      else if (code === 8) out.push('{npc}');
      else if (DIALOG_CODE_NAMES[code] && code >= 6) out.push(`{${DIALOG_CODE_NAMES[code]}${params.length ? ':' + params.join(',') : ''}}`);
      ops.push({
        pos: i,
        name: cval >= 0x7f00 && cval <= 0x7fff
          ? ((cval & 0xff) >= 0x31 && (cval & 0xff) <= 0x37 ? 'prompt' : `ctrl_7f${(cval & 0xff).toString(16).padStart(2, '0')}`)
          : (DIALOG_CODE_NAMES[code] ?? `ctrl_${cval.toString(16)}`),
        params,
      });
      i += n + extra;
    } else {
      if (CHAR_OVERRIDE.has(cval)) { flush(); out.push(String.fromCodePoint(CHAR_OVERRIDE.get(cval))); }
      else for (let k = 0; k < n; k++) pending.push(raw[i + k]);
      i += n;
    }
  }
  flush();
  return { text: out.join(''), opcodes: ops };
}

/** Parse an event-message (dialog) DAT → { entries, obfuscated }. */
export function parseDialogDat(bytes) {
  const n = bytes.byteLength;
  if (n < 8 || ((bytes[0] | (bytes[1] << 8) | (bytes[2] << 16)) + 4) !== n) {
    throw new Error('not an event-message table');
  }
  const b = new Uint8Array(bytes);   // copy — we de-obfuscate in place
  const obfuscated = b[3] === 0x10;
  if (obfuscated) for (let i = 4; i < n; i++) b[i] ^= 0x80;

  const dv = new DataView(b.buffer);
  const start = dv.getUint32(4, true) + 4;
  if (start < 8 || start > n) throw new Error('offset table out of range');

  const entries = [];
  let prev = 0;
  let idx = 0;
  for (let o = 4; o < start; o += 4) {
    const so = dv.getUint32(o, true) + 4;
    const no = o + 4 < start ? dv.getUint32(o + 4, true) + 4 : n;
    if (so >= n || so <= prev || no < so) break;
    prev = so;
    const raw = b.subarray(so, Math.max(so, no - 1));   // drop trailing NUL
    const { text, opcodes } = decodeEventString(raw);
    entries.push({ index: idx++, offset: so, length: raw.length, text, opcodes });
  }
  return { entries, obfuscated };
}

/**
 * Actor → event → dialog lines in playback order, for the Dialog view's
 * "By event" grouping (the level editor's Lines-tab shape). Each line keeps
 * the speaker resolved the same way as dialogSpeakers: the print op's speaker
 * operand when it has one (0x2B), else the actor whose event runs it.
 */
export function dialogConversations(actors) {
  const groups = [];
  for (const a of actors) {
    const events = [];
    for (const ev of a.events) {
      const lines = [];
      for (const op of ev.opcodes) {
        if (op.dialogRef < 0) continue;
        lines.push({ index: op.dialogRef, speaker: op.actors[0]?.label ?? a.label, op: op.name });
      }
      if (lines.length) events.push({ eventId: ev.eventId, category: ev.category, lines });
    }
    if (events.length) groups.push({ actorId: a.actorId, label: a.label, events });
  }
  return groups;
}

/**
 * dialogIndex → [speaker labels]. A print op with a speaker operand (0x2B)
 * names the talker directly; otherwise the line belongs to the actor whose
 * event prints it.
 */
export function dialogSpeakers(actors) {
  const map = new Map();
  for (const a of actors) {
    for (const ev of a.events) {
      for (const op of ev.opcodes) {
        if (op.dialogRef < 0) continue;
        const label = op.actors[0]?.label ?? a.label;
        let set = map.get(op.dialogRef);
        if (!set) map.set(op.dialogRef, (set = new Set()));
        set.add(label);
      }
    }
  }
  return map;
}
