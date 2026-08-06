// Image DATs — the "Images" asset browser's reader.
//
// Two flavours turn up across the 1444 baked entries:
//
//   * 1375 files hold 0x20 textures plus 0x31 "image set" records. The 0x31
//     names use the same `category(8) + name(8)` padding as textures, which is
//     where AltanaView's two-column Image Set list comes from.
//   * 66 files (misc.csv's ROM/172/90-127 block) are not DATs at all — they are
//     plain PNGs. Section parsing "succeeds" on them by reading PNG bytes as a
//     header, so they have to be caught by signature first.
//
// The remaining handful carry neither and read as empty.
//
// A 0x31 record is:
//     +0x00  name[16]        category(8) + name(8), space padded
//     +0x10  u8
//     +0x11  texture[16]     the 0x20 it draws from, category upper-cased
//     +0x21  per-image records
// The reference matters because several sets commonly share one atlas — the end
// credits use six sets (`mvcr1`…`mvcr6`) over a single `movcredi` texture, so
// matching set name to texture name would strand them.

import { parseSections, parseDatTextures } from './zone.js';

export const IMAGE_PNG = 0x0d;
export const IMAGE_SET = 0x31;

const strAt = (bytes, offset, len) => {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = bytes[offset + i];
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
};

/** Split a padded `category(8) + name(8)` id into its two halves. */
export function splitSetName(raw) {
  const category = raw.slice(0, 8).trim();
  const name = raw.slice(8, 16).trim();
  return { category, name: name || category, raw };
}

/**
 * Read an image DAT.
 *
 * @returns {{kind: 'png', png: Uint8Array}
 *          |{kind: 'sets', sets: Array, textures: Map}
 *          |{kind: 'empty'}}
 */
export function parseImageDat(datBuffer) {
  const bytes = new Uint8Array(datBuffer instanceof ArrayBuffer ? datBuffer : datBuffer.buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Signature first: section parsing does not fail on these, it just invents a
  // section, so checking the type code would never catch them.
  if (isPng(bytes)) return { kind: 'png', png: bytes };

  let sections;
  try {
    sections = parseSections(dv);
  } catch {
    return { kind: 'empty' };
  }

  const textures = parseDatTextures(datBuffer);
  const sets = [];
  for (const s of sections) {
    if (s.typeCode !== IMAGE_SET) continue;
    const { category, name, raw } = splitSetName(strAt(bytes, s.dataStart, 16));
    if (!name) continue;
    const textureRef = strAt(bytes, s.dataStart + 0x11, 16).trimEnd();
    sets.push({ category, name, raw, textureRef, id: s.id, size: s.size });
  }

  if (!sets.length && !textures.size) return { kind: 'empty' };
  return { kind: 'sets', sets, textures };
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const isPng = (bytes) => bytes.length >= 8 && PNG_MAGIC.every((b, i) => bytes[i] === b);

/**
 * The texture an image set draws from. The set's own reference wins — the name
 * is upper-cased in the category half, so matching is case-insensitive. Falls
 * back to the set's name for the few records that carry no usable reference.
 */
export function textureForSet(set, textures) {
  const byRef = set.textureRef && findTexture(textures, set.textureRef);
  if (byRef) return byRef;
  if (textures.has(set.raw)) return textures.get(set.raw);
  return findTexture(textures, set.raw) ?? findByBareName(textures, set.name);
}

function findTexture(textures, padded) {
  const wanted = padded.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const [key, tex] of textures) {
    if (key.trim().toLowerCase().replace(/\s+/g, ' ') === wanted) return tex;
  }
  return null;
}

function findByBareName(textures, name) {
  const wanted = name.toLowerCase();
  for (const [key, tex] of textures) {
    if (key.slice(8).trim().toLowerCase() === wanted) return tex;
  }
  return null;
}

/** Textures with no image set claiming them — shown so nothing is hidden. */
export function unclaimedTextures(sets, textures) {
  const claimed = new Set();
  for (const s of sets) {
    const tex = textureForSet(s, textures);
    if (tex) claimed.add(tex);
  }
  return [...textures.values()].filter((t) => !claimed.has(t));
}
