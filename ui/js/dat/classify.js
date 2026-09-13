// Sniff a DAT (or audio/png) buffer and pick the viewer that should open it.
// Used by Assets > File Browser so a click routes to zone / entity / image /
// music / sfx / effect / data instead of always calling parseEntity.

import { sniffZoneDat } from './zonedat.js';
import { matchTablePath } from './ftable.js';
import { matchUserPath } from './userdat.js';
import { itemTableForPath, knownDatLabels, knownDatKey } from './known.js';
import { sniffItemDat, itemFormat } from '../database.js';

const strAt = (bytes, p, n) => {
  let s = '';
  for (let i = 0; i < n && p + i < bytes.length; i++) {
    const c = bytes[p + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
};

const isPng = (bytes) =>
  bytes.length >= 8
  && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;

/**
 * Walk 16-byte section headers and tally type codes. Returns null when the
 * file is not a believable section container (same 90% coverage rule as
 * inspectDat).
 */
function sectionTypeCounts(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.byteLength;
  const counts = new Map();
  let pos = 0;
  let n = 0;
  while (pos + 16 <= len) {
    const meta = dv.getUint32(pos + 4, true);
    const type = meta & 0x7f;
    const size = ((meta >>> 7) & 0x7ffff) * 0x10;
    if (size <= 0 || pos + size > len) break;
    counts.set(type, (counts.get(type) ?? 0) + 1);
    n++;
    pos += size;
  }
  if (n === 0 || pos < len * 0.9) return null;
  return counts;
}

/**
 * @returns {{ kind: 'zone'|'entity'|'image'|'music'|'sfx'|'effect'|'data'|'unknown',
 *             label: string,
 *             dataKind?: string }}
 */
export function classifyDat(buffer, path = '') {
  const bytes = buffer instanceof Uint8Array
    ? buffer
    : new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  const lower = String(path || '').toLowerCase().replace(/\//g, '\\');

  if (matchTablePath(path || lower)) {
    return { kind: 'data', label: 'File table', dataKind: 'ftable' };
  }

  // Per-character saves: macros, config, chat state. Nothing renderable,
  // and the section walker only produces noise for them.
  if (matchUserPath(path || lower)) {
    return { kind: 'data', label: 'Character save', dataKind: 'user' };
  }

  if (/\.bgw$/i.test(lower) || strAt(bytes, 0, 12).startsWith('BGMStream')) {
    return { kind: 'music', label: 'Music stream' };
  }
  if (/\.spw$/i.test(lower) || strAt(bytes, 0, 8).startsWith('SeWave')) {
    return { kind: 'sfx', label: 'Sound effect' };
  }
  if (/\.png$/i.test(lower) || isPng(bytes)) {
    return { kind: 'image', label: 'Image' };
  }

  if (strAt(bytes, 0, 8) === 'XISTRING') {
    return { kind: 'data', label: 'XISTRING menu strings', dataKind: 'xistring' };
  }
  if (strAt(bytes, 0, 5) === 'd_msg') {
    return { kind: 'data', label: 'd_msg string table', dataKind: 'dmsg' };
  }

  // Item record tables: the ones the Database page knows by path first (so
  // the label carries the table name), then any file whose bytes are laid out
  // as item records — 0xC00-byte (legacy) or 0x1400-byte (retail, 10 Sept
  // 2026) blocks each ending in 0xFF.
  const itemTable = itemTableForPath(path || lower);
  if (itemTable) {
    const stride = sniffItemDat(bytes);
    const fmt = stride ? ` · ${itemFormat(stride)} 0x${stride.toString(16)}` : '';
    return {
      kind: 'data', label: `Item table — ${itemTable.label}${fmt}`, dataKind: 'items',
      table: itemTable.key, lang: itemTable.lang, stride: stride || null,
    };
  }
  const itemStride = sniffItemDat(bytes);
  if (itemStride) {
    return {
      kind: 'data', label: `Item table (${itemFormat(itemStride)}, 0x${itemStride.toString(16)}-byte records)`,
      dataKind: 'items', stride: itemStride,
    };
  }

  const counts = sectionTypeCounts(bytes);
  if (counts) {
    const has = (t) => (counts.get(t) ?? 0) > 0;
    // Skinned actors (NPCs, PCs, gear, monsters). Tested BEFORE the zone
    // sections: 23 DATs game-wide carry both a skeleton/mesh and zone
    // placements (the Sunbreeze and Harvest Festival NPCs, Lair Reive,
    // ROM/146/71, ROM9/2/49 …), and every one of them is a model — no entry in
    // zones.json has a 0x29/0x2A. With the zone test first they all opened as a
    // Zone that draws nothing.
    if (has(0x29) || has(0x2a)) return { kind: 'entity', label: 'Model' };
    // Zone geometry / placements win over everything else in the same DAT.
    if (has(0x2e) || has(0x1c)) return { kind: 'zone', label: 'Zone' };
    // Spell/ability VFX: routines + particle generators/meshes.
    if (has(0x07) && (has(0x05) || has(0x1f) || has(0x19))) {
      return { kind: 'effect', label: 'Effect' };
    }
    // UI image-set DATs (0x31 sets over 0x20 atlases), or texture-only packs.
    if (has(0x31) && has(0x20)) return { kind: 'image', label: 'Image set' };
    if (has(0x20) && !has(0x2b) && !has(0x05) && !has(0x07)) {
      return { kind: 'image', label: 'Textures' };
    }
    // Lone animation / skeleton scraps still go through the entity path.
    if (has(0x2b)) return { kind: 'entity', label: 'Animation' };
  }

  const zkind = sniffZoneDat(bytes);
  if (zkind) {
    const labels = { npclist: 'NPC list', events: 'Events', dialog: 'Dialog' };
    // The monster ability name tables share the dialog format but are not
    // zone dialog; name them from the known-DAT list when it has them.
    const known = knownDatLabels().get(knownDatKey(path || lower));
    if (zkind === 'dialog' && known === 'Strings') {
      return { kind: 'data', label: 'String table (dialog format)', dataKind: zkind };
    }
    return { kind: 'data', label: labels[zkind] ?? zkind, dataKind: zkind };
  }

  return { kind: 'unknown', label: 'Unknown DAT' };
}
