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
// Title / lobby packs (`lobb`, e.g. ROM/119/50.DAT) are a third shape: a few
// 0x20 textures plus ONE giant 0x31 layout blob. The blob's set header often
// points at an external atlas (`menu buttonto`), so the old reader showed a
// single broken set and hid the local textures. Those textures are surfaced as
// synthetic "texture" entries, and the 0x31 blob is parsed into sprite rows.
//
// A 0x31 *set* header (menu-style, one section per set) is:
//     +0x00  name[16]        category(8) + name(8), space padded
//     +0x10  u8
//     +0x11  texture[16]     the 0x20 it draws from, category upper-cased
//     +0x21  per-image records
//
// Inside a lobb-style 0x31 *layout* blob, sprites are:
//     01 00 <type> <subtype> parent[8] name[8] | payload
// Payload (41 bytes @+0, 42 @+1): dest quad 4×(x,y) u16 + src_w src_h src_x src_y.
// Ownership: a payload is owned by the texture name that FOLLOWS it (same rule
// as xi-tools `xi.ui.xi_core._rects_by_owner`).

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

const u16 = (bytes, off) => bytes[off] | (bytes[off + 1] << 8);

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
 *          |{kind: 'sets', sets: Array, textures: Map, sprites: Array, titlePack: boolean}
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
  const sprites = [];
  for (const s of sections) {
    if (s.typeCode !== IMAGE_SET) continue;
    const { category, name, raw } = splitSetName(strAt(bytes, s.dataStart, 16));
    if (!name) continue;
    const textureRef = strAt(bytes, s.dataStart + 0x11, 16).trimEnd();
    const set = {
      kind: 'set',
      category,
      name,
      raw,
      textureRef,
      id: s.id,
      size: s.size,
      sectionStart: s.start,
    };
    sets.push(set);

    // Sprite rows from the layout body (menu packs and title/lobb packs).
    const rows = parseLayoutSprites(bytes, s);
    for (const row of rows) {
      sprites.push({ ...row, setRaw: raw, setName: name, setCategory: category });
    }
  }

  // Bare 0x20 textures that no set claims — title packs store logos/wardrb this way.
  const claimed = new Set();
  for (const set of sets) {
    const tex = textureForSet(set, textures);
    if (tex) claimed.add(tex);
  }
  const loose = [...uniqueTextures(textures)].filter((t) => !claimed.has(t));
  for (const tex of loose) {
    const { category, name: bare } = splitTextureName(tex.name);
    // Prefer the real menu/category half when the DAT stored "menu    abxy360".
    const cat = category && category !== bare ? category : 'texture';
    sets.push({
      kind: 'texture',
      category: cat,
      name: bare,
      raw: `tex:${cat}:${bare}`,
      textureRef: tex.name,
      texture: tex, // pre-resolved so the viewer doesn't depend on map keys
      id: bare,
      size: 0,
    });
  }

  // Title/lobby pack: few (or broken) set headers + local textures, or lobb magic.
  const magic = strAt(bytes, 0, 4).toLowerCase();
  const titlePack = magic === 'lobb'
    || (loose.length > 0 && sets.filter((s) => s.kind === 'set').length <= 2);

  if (!sets.length && !textures.size) return { kind: 'empty' };
  return { kind: 'sets', sets, textures, sprites, titlePack };
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const isPng = (bytes) => bytes.length >= 8 && PNG_MAGIC.every((b, i) => bytes[i] === b);

/**
 * The texture an image set draws from. The set's own reference wins — the name
 * is upper-cased in the category half, so matching is case-insensitive. Falls
 * back to the set's name for the few records that carry no usable reference.
 * Synthetic texture entries already carry `.texture`.
 */
export function textureForSet(set, textures) {
  if (set?.texture) return set.texture;
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
    if (bareTextureName(key).toLowerCase() === wanted) return tex;
  }
  return null;
}

/**
 * FFXI UI ids are category(8)+name(8), space-padded. parseTexture keeps the
 * interior spaces (`"menu    abxy360"`), so the bare atlas id is always the
 * second half when the string is longer than 8 chars — not "first space".
 */
export function splitTextureName(name) {
  const t = (name || '').replace(/\0/g, '');
  if (t.length > 8) {
    const category = t.slice(0, 8).trim();
    const bare = t.slice(8).trim();
    return { category: category || 'texture', name: bare || category, raw: t };
  }
  const bare = t.trim();
  return { category: 'texture', name: bare, raw: bare };
}

export function bareTextureName(name) {
  return splitTextureName(name).name;
}

/** True if two texture/sprite names refer to the same atlas id. */
export function textureNamesMatch(a, b) {
  if (!a || !b) return false;
  const A = splitTextureName(a);
  const B = splitTextureName(b);
  const an = A.name.toLowerCase();
  const bn = B.name.toLowerCase();
  if (!an || !bn) return false;
  // Exact bare id (abxy360 === abxy360). Do NOT match on category — every
  // short name defaults to category "texture" and would collide.
  if (an === bn) return true;
  // Full "menu abxy360" style vs bare.
  const as = String(a).trim().toLowerCase().replace(/\s+/g, ' ');
  const bs = String(b).trim().toLowerCase().replace(/\s+/g, ' ');
  if (as === bs) return true;
  if (as.endsWith(' ' + bn) || bs.endsWith(' ' + an)) return true;
  return false;
}

/**
 * Whether a sprite's source rect can be drawn on this texture's pixel grid.
 * Drops external-atlas refs and garbage from over-eager layout parsing.
 */
export function spriteSrcOnTexture(sprite, texture) {
  if (!sprite?.src || !texture) return false;
  const { x, y, w, h } = sprite.src;
  if (!(w > 0 && h > 0)) return false;
  // Reject placeholder / non-sprite payloads (8192×… control records, etc.).
  if (w >= 2048 || h >= 2048) return false;
  if (w > texture.width + 1 || h > texture.height + 1) return false;
  // Inclusive whole-texture style (255 on 256 / 1023 on 1024).
  const rw = (w === texture.width - 1) ? w + 1 : w;
  const rh = (h === texture.height - 1) ? h + 1 : h;
  if (x < 0 || y < 0) return false;
  if (x >= texture.width || y >= texture.height) return false;
  if (x + rw > texture.width + 1 || y + rh > texture.height + 1) return false;
  return true;
}

/** Dest quad looks like a real UI box (not a 0/4096 sentinel). */
export function spriteDestPlausible(sprite) {
  const d = sprite?.dest;
  if (!d) return false;
  const xs = [d.x0, d.x1, d.x2, d.x3];
  const ys = [d.y0, d.y1, d.y2, d.y3];
  const max = Math.max(...xs, ...ys);
  const min = Math.min(...xs, ...ys);
  if (max >= 4096) return false;
  // Degenerate zero-area after hide-patches still listed, but skip nonsense.
  if (max === 0 && min === 0) return true;
  const dw = Math.abs(d.x1 - d.x0) || Math.abs(d.x3 - d.x0);
  const dh = Math.abs(d.y2 - d.y0) || Math.abs(d.y3 - d.y0);
  if (dw > 4096 || dh > 4096) return false;
  return true;
}

/** Deduplicate Map values (same entry is keyed several ways). */
function uniqueTextures(textures) {
  return new Set(textures.values());
}

/**
 * Parse sprite records inside one 0x31 section body.
 *
 * Returns rows with following-name ownership applied when possible:
 * `owner` is the texture the payload samples; `header` is the name on the
 * record that introduced the payload.
 */
export function parseLayoutSprites(bytes, section) {
  const start = section.dataStart;
  const end = Math.min(section.start + section.size, bytes.length);
  const marks = [];

  // 01 00 <type<0x10> <subtype<0x10> parent[8] name[8]
  for (let pos = start; pos + 20 < end; pos++) {
    if (bytes[pos] !== 0x01 || bytes[pos + 1] !== 0x00) continue;
    const typ = bytes[pos + 2];
    const sub = bytes[pos + 3];
    if (typ >= 0x10 || sub >= 0x10) continue;
    const tags = bytes.subarray(pos + 4, pos + 20);
    let ok = true;
    for (let i = 0; i < 16; i++) {
      const b = tags[i];
      if (b < 0x20 || b >= 0x7f) { ok = false; break; }
    }
    if (!ok) continue;
    const parent = strAt(bytes, pos + 4, 8).trim();
    const name = strAt(bytes, pos + 12, 8).trim();
    if (!name) continue;
    marks.push({ hdr: pos, payload: pos + 20, parent, name });
    pos = pos + 19; // loop +1
  }

  const rows = [];
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    const stop = i + 1 < marks.length ? marks[i + 1].hdr : end;
    const length = stop - m.payload;
    if (length < 24) continue;

    // 41-byte payload @+0, 42-byte @+1 (xi-tools convention).
    let pre = length === 42 ? 1 : 0;
    if (length !== 41 && length !== 42) {
      // Prefer a prefix whose dest coords look like a UI quad (small u16s).
      pre = 0;
      const d0 = u16(bytes, m.payload);
      if (d0 > 4096) pre = 1;
    }
    const base = m.payload + pre;
    if (base + 24 > stop) continue;

    const dest = [];
    for (let k = 0; k < 8; k++) dest.push(u16(bytes, base + k * 2));
    const srcW = u16(bytes, base + 16);
    const srcH = u16(bytes, base + 18);
    const srcX = u16(bytes, base + 20);
    const srcY = u16(bytes, base + 22);

    // Following-name ownership: payload between mark i and i+1 is owned by
    // mark i+1's name (the texture / widget id that samples it).
    const owner = i + 1 < marks.length ? marks[i + 1].name : m.name;

    const row = {
      index: rows.length,
      header: m.name,
      parent: m.parent,
      owner,
      offset: base,
      length,
      prefix: pre,
      dest: {
        x0: dest[0], y0: dest[1],
        x1: dest[2], y1: dest[3],
        x2: dest[4], y2: dest[5],
        x3: dest[6], y3: dest[7],
      },
      src: { w: srcW, h: srcH, x: srcX, y: srcY },
    };
    // Skip obvious non-sprite control payloads early.
    if (!spriteDestPlausible(row)) continue;
    if (srcW >= 2048 || srcH >= 2048) continue;
    rows.push(row);
  }
  return rows;
}

/**
 * Sprites that **sample** a given texture (layout owner == atlas name).
 *
 * Ownership is following-name only — do NOT match on the preceding header
 * (`font ← chmkfnt` means owner is font, not chmkfnt). When `texture` is
 * given, the source rect must also fit that atlas.
 */
export function spritesForTexture(sprites, textureName, texture = null) {
  if (!sprites?.length || !textureName) return [];
  return sprites.filter((s) => {
    // Owner is the atlas this payload samples (xi-tools _rects_by_owner).
    if (!textureNamesMatch(s.owner, textureName)) return false;
    if (!spriteDestPlausible(s)) return false;
    if (texture && !spriteSrcOnTexture(s, texture)) return false;
    return true;
  });
}
