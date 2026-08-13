// Sniff a DAT (or audio/png) buffer and pick the viewer that should open it.
// Used by Assets > File Browser so a click routes to zone / entity / image /
// music / sfx / effect / data instead of always calling parseEntity.

import { sniffZoneDat } from './zonedat.js';
import { matchTablePath } from './ftable.js';

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

  if (/\.bgw$/i.test(lower) || strAt(bytes, 0, 12).startsWith('BGMStream')) {
    return { kind: 'music', label: 'Music stream' };
  }
  if (/\.spw$/i.test(lower) || strAt(bytes, 0, 8).startsWith('SeWave')) {
    return { kind: 'sfx', label: 'Sound effect' };
  }
  if (/\.png$/i.test(lower) || isPng(bytes)) {
    return { kind: 'image', label: 'Image' };
  }

  const counts = sectionTypeCounts(bytes);
  if (counts) {
    const has = (t) => (counts.get(t) ?? 0) > 0;
    // Zone geometry / placements win over everything else in the same DAT.
    if (has(0x2e) || has(0x1c)) return { kind: 'zone', label: 'Zone' };
    // Skinned actors (NPCs, PCs, gear, monsters).
    if (has(0x29) || has(0x2a)) return { kind: 'entity', label: 'Model' };
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
    return { kind: 'data', label: labels[zkind] ?? zkind, dataKind: zkind };
  }

  return { kind: 'unknown', label: 'Unknown DAT' };
}
