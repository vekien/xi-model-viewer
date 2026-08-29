// DAT structure inspector — the Assets > Data view's parser.
//
// Walks the 16-byte section headers (tag + packed info word) and rebuilds the
// directory tree the client sees: 0x01 pushes a folder, 0x00 pops it, everything
// else is a resource belonging to the folder it was declared in. Resources are
// *listed*, not decoded — for the handful of well-known types a few header
// fields are peeked (texture dimensions, joint counts, sound ids) so the row
// can say what the thing is without printing its payload.
//
// The size field is 19 bits, not 20 — confirmed against the retail client's
// chunk walker (see xi-tools xi/common/xi_section.py for the nine call
// sites). Bits 26+ are flags: is_shadow, is_extracted, ver_num, is_virtual.

import { inspectAsHex, inspectUserDat } from './userdat.js';

/** Section type-code -> name (xi-tools SECTION_TYPE_NAMES / xim SectionType). */
export const SECTION_TYPE_NAMES = {
  0x00: 'End', 0x01: 'Directory', 0x04: 'Table', 0x05: 'ParticleGenerator',
  0x06: 'Route', 0x07: 'EffectRoutine', 0x19: 'ParticleKeyFrameData',
  0x1C: 'ZoneDef', 0x1F: 'ParticleMesh', 0x20: 'Texture', 0x21: 'SpriteSheetMesh',
  0x25: 'WeightedMesh', 0x29: 'Skeleton', 0x2A: 'SkeletonMesh',
  0x2B: 'SkeletonAnimation', 0x2E: 'ZoneMesh', 0x2F: 'Environment',
  0x30: 'UiMenu', 0x31: 'UiElementGroup', 0x36: 'ZoneInteractions',
  0x3D: 'SoundEffectPointer', 0x3E: 'PointList', 0x45: 'Info', 0x49: 'SpellList',
  0x4A: 'Path', 0x53: 'AbilityList', 0x54: 'WeaponTrace', 0x5D: 'BumpMap',
  0x5E: 'Blur',
};

/** Material icon per type, for the structure rows. */
export const SECTION_TYPE_ICONS = {
  0x05: 'auto_awesome', 0x06: 'route', 0x07: 'schedule', 0x19: 'timeline',
  0x1C: 'map', 0x1F: 'change_history', 0x20: 'image', 0x21: 'grid_view',
  0x25: 'water', 0x29: 'accessibility_new', 0x2A: 'deployed_code',
  0x2B: 'animation', 0x2E: 'landscape', 0x2F: 'cloud', 0x30: 'menu',
  0x31: 'widgets', 0x36: 'touch_app', 0x3D: 'graphic_eq', 0x3E: 'scatter_plot',
  0x45: 'info', 0x49: 'auto_fix_high', 0x4A: 'polyline', 0x53: 'bolt',
  0x54: 'gesture', 0x5D: 'texture', 0x5E: 'blur_on',
};

export const typeName = (code) =>
  SECTION_TYPE_NAMES[code] ?? `0x${code.toString(16).toUpperCase().padStart(2, '0')}`;

const printable = (s) => [...s].every((c) => c >= ' ' && c <= '~');
const fourcc = (bytes, p) => {
  let s = '';
  for (let i = 0; i < 4; i++) {
    const c = bytes[p + i];
    s += c === 0 ? '' : (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '·');
  }
  return s;
};
const strAt = (bytes, p, n) => {
  let s = '';
  for (let i = 0; i < n; i++) {
    const c = bytes[p + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
};

// ── per-type header peeks ────────────────────────────────────────────────────
// Each returns a short human string (or null). All reads are bounds-guarded by
// the DataView; a RangeError just means "no detail".

function peekTexture(bytes, dv, s) {
  const d = s.dataStart;
  const texType = bytes[d];
  // 0x01/0x05 = paletted (same layout as 0x91); see zone.js parseTexture.
  if (![0x01, 0x05, 0x81, 0x91, 0xA1, 0xB1].includes(texType)) {
    // Still mark clickable via section id — open path may resolve it later.
    return { text: null, textureName: null, isTexture: true };
  }
  const name = strAt(bytes, d + 1, 0x10).trim();
  const width = dv.getUint32(d + 0x15, true);
  const height = dv.getUint32(d + 0x19, true);
  const bitCount = dv.getUint16(d + 0x1F, true);
  let format;
  if (texType === 0xA1) {
    const cc = strAt(bytes, d + 0x39, 4);
    format = cc === '1TXD' ? 'DXT1' : cc === '3TXD' ? 'DXT3' : cc === '5TXD' ? 'DXT5' : 'DXT?';
  } else {
    format = bitCount === 32 ? 'RGBA32' : `palette ${bitCount}bpp`;
  }
  const label = name || null;
  const dims = width > 0 && height > 0 ? `${width}×${height} ${format}` : format;
  return {
    text: label ? `${label} · ${dims}` : dims,
    textureName: label,
    isTexture: true,
  };
}

/** Interp mode labels (xiclient CameraSmoothType / xi-tools scene docs). */
const ROUTE_MODES = {
  0: 'linear', 1: 'decel', 2: 'accel', 3: 'decel-accel', 4: 's-curve',
};

/**
 * 0x06 Route — camera path (scene DAT) or start→end segment list.
 * Layout: 32B header (count@+0x10, mode@+0x14) + N×48B keyframes
 * (eye xyz, focal length, look-at xyz, roll, time 0..1, 12B pad).
 * Some retail rows stash flags in count's high half — use low 16 bits and
 * clamp by section size (see ROM/490/0.DAT a001).
 */
export function parseInspectRoute(buffer, offset) {
  const bytes = buffer instanceof Uint8Array
    ? buffer
    : new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = offset | 0;
  if (start + 0x30 > bytes.length) return null;
  const meta = dv.getUint32(start + 4, true);
  const size = ((meta >>> 7) & 0x7ffff) * 0x10;
  const dataStart = start + 0x10;
  const bodyEnd = Math.min(start + size, bytes.length);
  if (bodyEnd - dataStart < 32) return null;
  let count = dv.getUint32(dataStart + 0x10, true) & 0xffff;
  const mode = dv.getUint32(dataStart + 0x14, true);
  const maxBySize = Math.floor((bodyEnd - dataStart - 32) / 48);
  if (count > maxBySize) count = maxBySize;
  if (count <= 0 || count > 4096) return null;
  const keys = [];
  for (let i = 0; i < count; i++) {
    const o = dataStart + 32 + i * 48;
    if (o + 48 > bodyEnd) break;
    keys.push({
      eye: [
        dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true),
      ],
      focal: dv.getFloat32(o + 12, true),
      look: [
        dv.getFloat32(o + 16, true), dv.getFloat32(o + 20, true), dv.getFloat32(o + 24, true),
      ],
      roll: dv.getFloat32(o + 28, true),
      time: dv.getFloat32(o + 32, true),
    });
  }
  if (!keys.length) return null;
  const id = fourcc(bytes, start).trim();
  return { id, mode, modeName: ROUTE_MODES[mode] ?? `mode ${mode}`, keys };
}

/** Vertical FOV degrees from Route focal length (client: 2·atan2(192, focal)). */
export function routeFocalToFov(focal) {
  if (!(focal > 0)) return null;
  return (2 * Math.atan2(192, focal) * 180) / Math.PI;
}

function peekRoute(bytes, dv, s) {
  const route = parseInspectRoute(bytes, s.start);
  if (!route) return { text: null, isRoute: true };
  const n = route.keys.length;
  const still = n === 1 ? 'still' : `${n} keys`;
  const f0 = route.keys[0]?.focal;
  const fov = routeFocalToFov(f0);
  const fovTxt = fov != null ? ` · FOV ${fov.toFixed(0)}°` : '';
  return {
    text: `${still} · ${route.modeName}${fovTxt}`,
    isRoute: true,
  };
}

/** 0x5D — 8-bit height field; xim converts to a tangent-space normal map. */
function peekBumpMap(bytes, dv, s) {
  const d = s.dataStart;
  if (d + 0x20 > bytes.length) return { text: null, textureName: null, isTexture: true };
  const width = dv.getUint16(d + 4, true);
  const height = dv.getUint16(d + 6, true);
  const name = strAt(bytes, d + 0x10, 0x10).trim();
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192) {
    return { text: name || null, textureName: name || null, isTexture: true };
  }
  const dims = `${width}×${height} height→normal`;
  return {
    text: name ? `${name} · ${dims}` : dims,
    textureName: name || null,
    isTexture: true,
  };
}

function peekSkeleton(bytes, dv, s) {
  const joints = bytes[s.dataStart + 0x02];
  return { text: `${joints} joints` };
}

function peekSkeletonMesh(bytes, dv, s) {
  // 6 flag bytes, i32 instr offset, 2 bytes, i32 joint-array offset, u16 count.
  const joints = dv.getUint16(s.dataStart + 16, true);
  return joints ? { text: `${joints} joints` } : null;
}

function peekAnimation(bytes, dv, s) {
  const joints = dv.getUint16(s.dataStart + 2, true);
  const frames = dv.getUint16(s.dataStart + 4, true);
  return { text: `${frames} frames · ${joints} joints` };
}

/** 0x07 — the routine's 0x05 commands reference clips/generators by 4-char tag. */
function peekRoutine(bytes, dv, s) {
  if (s.size < 0x30) return null;
  // Data offset 0x10 holds four u32s (s1, sec2, s3, tot); sec2 — the command
  // list pointer, data-relative — is the second, so it sits at data +0x14.
  const sec2 = dv.getInt32(s.dataStart + 0x14, true);
  let p = s.dataStart + (sec2 - 16);
  const end = s.start + s.size;
  const refs = [];
  let ops = 0;
  for (let guard = 0; guard < 128 && p + 8 <= end && p >= s.dataStart; guard++) {
    const op = bytes[p];
    if (op === 0x00) break;
    ops++;
    if (op === 0x05 && p + 12 <= end) {
      const ref = fourcc(bytes, p + 8).trim();
      if (ref && printable(ref)) refs.push(ref);
    }
    const n = (bytes[p + 1] | (bytes[p + 2] << 8)) & 0x1f;
    p += Math.max(1, n) * 4;
  }
  if (!ops) return null;
  const shown = refs.slice(0, 6).join(' ') + (refs.length > 6 ? ' …' : '');
  const cmds = `${ops} cmd${ops === 1 ? '' : 's'}`;
  return { text: refs.length ? `${cmds} → ${shown}` : cmds };
}

function peekSoundPointer(bytes, dv, s) {
  if (!strAt(bytes, s.dataStart, 8).startsWith('SeSep')) return null;
  const soundId = dv.getUint32(s.dataStart + 8, true);
  const folder = String(Math.floor(soundId / 1000)).padStart(3, '0');
  const file = String(soundId).padStart(6, '0');
  return {
    text: `sound ${soundId} → se/${folder}/${file}.spw`,
    isSound: true,
    soundId,
  };
}

function peekSpriteSheet(bytes, dv, s) {
  const numMesh = dv.getUint16(s.dataStart + 2, true);
  const tex = strAt(bytes, s.dataStart + 8, 0x10).trim();
  return { text: tex ? `${numMesh} sprites · ${tex}` : `${numMesh} sprites` };
}

/**
 * 0x30 UiMenu — window / control layout (not pixel sprites).
 * Same shape as xi-tools `xi ui layout menu-pos`:
 *   +0x00  name[16]     e.g. "menu    race3"
 *   +0x10  u8 type?
 *   +0x11  u8 numElements
 *   +0x20  frame element, then element[0..]
 * Element: u16 size, i16 x, i16 y, …, i16 w @+10, i16 h @+12, u8 index @+16,
 *          i8 prev @+19, i8 next @+20.
 */
export function parseInspectUiMenu(buffer, offset) {
  const bytes = buffer instanceof Uint8Array
    ? buffer
    : new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = offset | 0;
  if (start + 0x30 > bytes.length) return null;
  const meta = dv.getUint32(start + 4, true);
  const type = meta & 0x7f;
  if (type !== 0x30 && type !== 0) {
    // Allow call without type check when offset is known-good; still need size.
  }
  const size = ((meta >>> 7) & 0x7ffff) * 0x10;
  const bodyEnd = Math.min(start + (size > 0 ? size : 0x100), bytes.length);
  const dataStart = start + 0x10;
  if (dataStart + 0x30 > bodyEnd) return null;

  const nameRaw = strAt(bytes, dataStart, 0x10);
  const name = nameRaw.replace(/\s+/g, ' ').trim();
  const maybeType = bytes[dataStart + 0x10];
  const numElements = bytes[dataStart + 0x11];
  if (numElements > 64) return null;

  // xiclient ButtonDefinitionHeader / FrameDefinitionHeader (see ffximain.md).
  // Nav Up/Down/Left/Right are ButtonIDs (i8), not array indices.
  const readEl = (off) => {
    if (off + 22 > bodyEnd) return null;
    const elSize = dv.getUint16(off, true);
    if (elSize < 22 || elSize > 0x800 || off + elSize > bytes.length) return null;
    const x = dv.getInt16(off + 2, true);
    const y = dv.getInt16(off + 4, true);
    const cursorX = dv.getInt16(off + 6, true);
    const cursorY = dv.getInt16(off + 8, true);
    const width = dv.getInt16(off + 10, true);
    const height = dv.getInt16(off + 12, true);
    const buttonId = elSize >= 20 ? dv.getInt16(off + 18, true) : null;
    const i8 = (o) => (bytes[o] << 24) >> 24;
    const navU = elSize >= 24 ? i8(off + 23) : null;
    const navD = elSize >= 25 ? i8(off + 24) : null;
    const navL = elSize >= 26 ? i8(off + 25) : null;
    const navR = elSize >= 27 ? i8(off + 26) : null;
    // Title text id: u16 immediately before first "menu    " string in the tail.
    let titleId = null;
    let textNs = null;
    if (elSize >= 36) {
      const slice = bytes.subarray(off, off + elSize);
      let j = -1;
      for (let p = 32; p + 8 < slice.length; p++) {
        if (slice[p] === 0x6d && slice[p + 1] === 0x65 && slice[p + 2] === 0x6e && slice[p + 3] === 0x75) {
          j = p;
          break;
        }
      }
      if (j >= 2) {
        titleId = dv.getUint16(off + j - 2, true);
        textNs = strAt(bytes, off + j, 16).replace(/\s+/g, ' ').trim();
      }
    }
    const navLinked = [navU, navD, navL, navR].some((v) => v != null && v !== -1);
    return {
      offset: off,
      size: elSize,
      x, y, width, height,
      cursorX, cursorY,
      buttonId,
      navU, navD, navL, navR,
      titleId,
      textNs,
      // legacy columns (old guess); kept so older UI does not crash
      index: buttonId,
      prev: navU,
      next: navD,
      selectable: navLinked,
    };
  };

  const frameOff = dataStart + 0x20; // +48 from section start
  const frame = readEl(frameOff);
  if (!frame) return null;

  const elements = [];
  let off = frame.offset + frame.size;
  for (let i = 0; i < numElements; i++) {
    const el = readEl(off);
    if (!el) break;
    elements.push(el);
    off += el.size;
  }

  const id = fourcc(bytes, start).trim();
  // "menu    race3" → bare name race3
  const bare = name.length > 5 && name.toLowerCase().startsWith('menu')
    ? name.slice(4).trim()
    : name;

  return {
    id,
    name,
    bareName: bare || name || id,
    maybeType,
    numElements,
    frame,
    elements,
    offset: start,
    size: size || (off - start),
  };
}

function peekUiMenu(bytes, dv, s) {
  const menu = parseInspectUiMenu(bytes, s.start);
  if (!menu) return { text: null, isUiMenu: true };
  const n = 1 + menu.elements.length; // frame + children
  const f = menu.frame;
  const box = `${f.width}×${f.height} @ (${f.x},${f.y})`;
  const label = menu.bareName || menu.name || menu.id;
  return {
    text: `${label} · ${n} box${n === 1 ? '' : 'es'} · ${box}`,
    isUiMenu: true,
  };
}

/**
 * 0x31 UiElementGroup — image-set / layout blob (title packs: one giant group).
 * Header matches images.js set shape:
 *   +0x00  name[16]      category(8)+name(8)  e.g. "menu    lobbywin"
 *   +0x10  u8
 *   +0x11  texture[16]   atlas ref (may be external)
 * Body: 01 00 sprite records (parseLayoutSprites).
 */
export function parseInspectUiElementGroup(buffer, offset) {
  const bytes = buffer instanceof Uint8Array
    ? buffer
    : new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = offset | 0;
  if (start + 0x20 > bytes.length) return null;
  const meta = dv.getUint32(start + 4, true);
  const type = meta & 0x7f;
  if (type !== 0x31 && type !== 0) {
    // still parse if caller knows the offset
  }
  const size = ((meta >>> 7) & 0x7ffff) * 0x10;
  if (size < 0x20) return null;
  const dataStart = start + 0x10;
  const bodyEnd = Math.min(start + size, bytes.length);

  const setRaw = strAt(bytes, dataStart, 0x10);
  const setCategory = setRaw.slice(0, 8).trim();
  const setName = (setRaw.slice(8, 16).trim() || setCategory);
  const setLabel = [setCategory, setName].filter(Boolean).join(' / ') || fourcc(bytes, start).trim();
  const textureRef = strAt(bytes, dataStart + 0x11, 0x10).replace(/\s+/g, ' ').trim();

  // Lazy import avoided — inline the same 01 00 walk as images.parseLayoutSprites
  // so inspect.js stays free of the image viewer module graph.
  const marks = [];
  for (let pos = dataStart; pos + 20 < bodyEnd; pos++) {
    if (bytes[pos] !== 0x01 || bytes[pos + 1] !== 0x00) continue;
    const typ = bytes[pos + 2];
    const sub = bytes[pos + 3];
    if (typ >= 0x10 || sub >= 0x10) continue;
    let ok = true;
    for (let i = 0; i < 16; i++) {
      const b = bytes[pos + 4 + i];
      if (b < 0x20 || b >= 0x7f) { ok = false; break; }
    }
    if (!ok) continue;
    const parent = strAt(bytes, pos + 4, 8).trim();
    const name = strAt(bytes, pos + 12, 8).trim();
    if (!name) continue;
    marks.push({ hdr: pos, payload: pos + 20, parent, name });
    pos += 19;
  }

  const u16 = (o) => bytes[o] | (bytes[o + 1] << 8);
  const sprites = [];
  const ownerCounts = new Map();
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    const stop = i + 1 < marks.length ? marks[i + 1].hdr : bodyEnd;
    const length = stop - m.payload;
    if (length < 24) continue;
    let pre = length === 42 ? 1 : (length === 41 ? 0 : 0);
    if (length !== 41 && length !== 42) {
      if (u16(m.payload) > 4096) pre = 1;
    }
    const base = m.payload + pre;
    if (base + 24 > stop) continue;
    const dest = [];
    for (let k = 0; k < 8; k++) dest.push(u16(base + k * 2));
    const srcW = u16(base + 16);
    const srcH = u16(base + 18);
    const srcX = u16(base + 20);
    const srcY = u16(base + 22);
    if (srcW >= 2048 || srcH >= 2048) continue;
    if (Math.max(...dest) >= 4096) continue;
    const owner = i + 1 < marks.length ? marks[i + 1].name : m.name;
    ownerCounts.set(owner, (ownerCounts.get(owner) || 0) + 1);
    sprites.push({
      index: sprites.length,
      header: m.name,
      parent: m.parent,
      owner,
      offset: base,
      length,
      dest: {
        x0: dest[0], y0: dest[1], x1: dest[2], y1: dest[3],
        x2: dest[4], y2: dest[5], x3: dest[6], y3: dest[7],
      },
      src: { w: srcW, h: srcH, x: srcX, y: srcY },
    });
  }

  const owners = [...ownerCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  return {
    id: fourcc(bytes, start).trim(),
    setCategory,
    setName,
    setLabel,
    textureRef,
    sprites,
    owners,
    markCount: marks.length,
    offset: start,
    size,
  };
}

function peekUiElementGroup(bytes, dv, s) {
  const g = parseInspectUiElementGroup(bytes, s.start);
  if (!g) return { text: null, isUiElementGroup: true };
  const top = g.owners.slice(0, 3).map((o) => o.name).join(' ');
  const label = g.setLabel || g.id || 'group';
  const tex = g.textureRef ? ` · tex ${g.textureRef}` : '';
  return {
    text: `${label} · ${g.sprites.length} sprites${tex}${top ? ` · ${top}` : ''}`,
    isUiElementGroup: true,
  };
}

function peekParticleMesh(bytes, dv, s) {
  const total = bytes[s.dataStart + 4] + bytes[s.dataStart + 5];
  return total ? { text: `${total} mesh${total === 1 ? '' : 'es'}` } : null;
}

function peekKeyFrames(bytes, dv, s) {
  const end = s.start + s.size;
  let n = 0;
  for (let p = s.dataStart; p + 8 <= end && n < 4096; p += 8) {
    n++;
    if (dv.getFloat32(p, true) === 1) break;
  }
  return n ? { text: `${n} keys` } : null;
}

function peekInfo(bytes, dv, s) {
  const type = bytes[s.dataStart + 3];
  const sub = bytes[s.dataStart + 4];
  return { text: `weapon anim ${type}/${sub}` };
}

/** 0x2E — the mesh name sits at +0x20 in plaintext even in encrypted zones. */
function peekZoneMesh(bytes, dv, s) {
  const name = strAt(bytes, s.start + 0x20, 0x10).trim();
  return name.length >= 2 && printable(name) ? { text: name } : null;
}

/** 0x1C — placement table; count is readable before decrypt. */
function peekZoneDef(bytes, dv, s) {
  const nodeCount = dv.getUint32(s.dataStart + 4, true) & 0x00FFFFFF;
  if (nodeCount <= 0 || nodeCount > 200000) return { text: null, isZoneDef: true };
  return {
    text: `${nodeCount.toLocaleString()} placement${nodeCount === 1 ? '' : 's'}`,
    isZoneDef: true,
  };
}

/**
 * Menu tables in ROM/118/114.DAT (and similar): type 0x04 Table (mnc2/mon_/levc),
 * 0x49 SpellList (mgc_), 0x53 AbilityList (comm). Layout from xi-tools mnc2-pos /
 * ui spells (record sizes after the 16-byte section header).
 */
export function parseInspectDataTable(buffer, offset) {
  const bytes = buffer instanceof Uint8Array
    ? buffer
    : new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = offset | 0;
  if (start + 0x20 > bytes.length) return null;
  const meta = dv.getUint32(start + 4, true);
  const type = meta & 0x7f;
  const size = ((meta >>> 7) & 0x7ffff) * 0x10;
  const bodyEnd = Math.min(start + (size > 0 ? size : 0), bytes.length);
  const dataStart = start + 0x10;
  if (dataStart >= bodyEnd) return null;
  const id = fourcc(bytes, start).trim() || typeName(type);
  const payload = bodyEnd - dataStart;

  // ── SpellList (mgc_) ─────────────────────────────────────────────────────
  if (type === 0x49 || id === 'mgc_') {
    const recSize = 0x64;
    const maxN = Math.floor(payload / recSize);
    const columns = [
      { key: 'idx', label: '#' },
      { key: 'name', label: 'Name', external: true, externalDat: 'ROM/181/73.DAT' },
      { key: 'id', label: 'id' },
      { key: 'mp', label: 'MP' },
      { key: 'w2', label: '+2' },
      { key: 'b0c', label: '+0C' },
      { key: 'b0d', label: '+0D' },
      { key: 'u46', label: '+46' },
      { key: 'raw', label: 'raw[0:16]' },
    ];
    const rows = [];
    for (let i = 0; i < maxN; i++) {
      const off = dataStart + i * recSize;
      const recId = dv.getUint16(off, true);
      if (recId === 0 || recId === 0xffff) continue;
      const hex = [];
      for (let b = 0; b < 16; b++) hex.push(bytes[off + b].toString(16).padStart(2, '0'));
      rows.push({
        idx: i,
        name: '',
        id: recId,
        w2: dv.getUint16(off + 2, true),
        b0c: bytes[off + 0x0c],
        b0d: bytes[off + 0x0d],
        mp: dv.getUint16(off + 0x44, true),
        u46: dv.getUint16(off + 0x46, true),
        raw: hex.join(' '),
        _offset: off,
      });
    }
    return {
      kind: 'spellList',
      id,
      type,
      title: 'SpellList',
      subtitle: `${rows.length.toLocaleString()} spells · 0x${recSize.toString(16)} × ${maxN}`,
      columns,
      rows,
      offset: start,
      size: size || payload + 0x10,
      nameDat: 'ROM/181/73.DAT',
      nameDatLabel: 'Spell_Names',
      note: 'Names from ROM/181/73.DAT (d_msg). MP at +0x44 is plaintext; other fields still undecoded.',
    };
  }

  // ── AbilityList (comm) ───────────────────────────────────────────────────
  if (type === 0x53 || id === 'comm') {
    const recSize = 0x30;
    const maxN = Math.floor(payload / recSize);
    const columns = [
      { key: 'idx', label: '#' },
      { key: 'name', label: 'Name', external: true, externalDat: 'ROM/181/72.DAT' },
      { key: 'id', label: 'id' },
      { key: 'b2', label: '+2' },
      { key: 'b3', label: '+3' },
      { key: 'w4', label: '+4' },
      { key: 'w8', label: '+8' },
      { key: 'b0e', label: '+0E' },
      { key: 'b0f', label: '+0F' },
      { key: 'raw', label: 'raw[0:16]' },
    ];
    const rows = [];
    for (let i = 0; i < maxN; i++) {
      const off = dataStart + i * recSize;
      const recId = dv.getUint16(off, true);
      if (recId === 0 || recId === 0xffff) continue;
      const hex = [];
      for (let b = 0; b < 16; b++) hex.push(bytes[off + b].toString(16).padStart(2, '0'));
      rows.push({
        idx: i,
        name: '',
        id: recId,
        b2: bytes[off + 2],
        b3: bytes[off + 3],
        w4: dv.getUint16(off + 4, true),
        w8: dv.getUint16(off + 8, true),
        b0e: bytes[off + 0x0e],
        b0f: bytes[off + 0x0f],
        raw: hex.join(' '),
        _offset: off,
      });
    }
    return {
      kind: 'abilityList',
      id,
      type,
      title: 'AbilityList',
      subtitle: `${rows.length.toLocaleString()} abilities · 0x${recSize.toString(16)} × ${maxN}`,
      columns,
      rows,
      offset: start,
      size: size || payload + 0x10,
      nameDat: 'ROM/181/72.DAT',
      nameDatLabel: 'Ability_Names',
      note: 'Names from ROM/181/72.DAT (d_msg). Fixed 0x30 records; field meanings partially known.',
    };
  }

  // ── Generic Table (0x04): mon_ / levc as u16 arrays; mnc2 as u16 index ────
  if (type === 0x04 || id === 'mnc2' || id === 'mon_' || id === 'levc') {
    const count = Math.floor(payload / 2);
    const values = [];
    for (let i = 0; i < count; i++) {
      values.push(dv.getUint16(dataStart + i * 2, true));
    }
    // Compact view: rows of 8 values
    const columns = [
      { key: 'base', label: 'idx' },
      { key: 'c0', label: '+0' },
      { key: 'c1', label: '+1' },
      { key: 'c2', label: '+2' },
      { key: 'c3', label: '+3' },
      { key: 'c4', label: '+4' },
      { key: 'c5', label: '+5' },
      { key: 'c6', label: '+6' },
      { key: 'c7', label: '+7' },
    ];
    const rows = [];
    for (let i = 0; i < values.length; i += 8) {
      const row = { base: i };
      for (let c = 0; c < 8; c++) {
        row[`c${c}`] = values[i + c] != null ? values[i + c] : '';
      }
      rows.push(row);
    }
    const nonzero = values.filter((v) => v !== 0).length;
    const kindNote = id === 'mnc2'
      ? 'Indexed model/animation tables (u16 words; often offsets into later data).'
      : id === 'mon_'
        ? 'uint16 lookup table.'
        : id === 'levc'
          ? 'uint16 level/curve table.'
          : 'Generic table section (shown as u16 words).';
    return {
      kind: 'table',
      id,
      type,
      title: 'Table',
      subtitle: `${values.length.toLocaleString()} × u16 · ${nonzero.toLocaleString()} nonzero`,
      columns,
      rows,
      offset: start,
      size: size || payload + 0x10,
      note: kindNote,
      values,
    };
  }

  return null;
}

function peekDataTable(bytes, dv, s) {
  const t = parseInspectDataTable(bytes, s.start);
  if (!t) return { text: null, isDataTable: true };
  return {
    text: t.subtitle || `${t.rows?.length ?? 0} rows`,
    isDataTable: true,
  };
}

const PEEKS = {
  0x04: peekDataTable,
  0x06: peekRoute,
  0x07: peekRoutine,
  0x19: peekKeyFrames,
  0x1C: peekZoneDef,
  0x1F: peekParticleMesh,
  0x20: peekTexture,
  0x21: peekSpriteSheet,
  0x29: peekSkeleton,
  0x2A: peekSkeletonMesh,
  0x2B: peekAnimation,
  0x2E: peekZoneMesh,
  0x30: peekUiMenu,
  0x31: peekUiElementGroup,
  0x3D: peekSoundPointer,
  0x45: peekInfo,
  0x49: peekDataTable,
  0x53: peekDataTable,
  0x5D: peekBumpMap,
};

// ── high-poly character-creation formats (RT/SHAPE, DMB, SQLE) ────────────────
// These are not 16-byte section containers. We still build a sections-shaped
// doc so DataViewer can show Structure / File / Contents + the multi-DAT dropdown.

const i32le = (dv, o) => (o >= 0 && o + 4 <= dv.byteLength ? dv.getInt32(o, true) : 0);

function res(id, name, icon, size, offset, detail = null, extra = {}) {
  return {
    kind: 'res', id, type: -1, name, icon, size, offset,
    flags: [], detail, textureName: null, isTexture: false, isSkeleton: false, ...extra,
  };
}

/**
 * Parse a joint list from a DAT buffer for the Data Struct skeleton viewer.
 * kind 'entity' — section 0x29 at `offset` (section start).
 * kind 'sqle'   — SQLE type-11 chunk at `offset`.
 * Returns [{ parent, rot?, trans }] or null.
 */
export function parseInspectSkeleton(buffer, kind, offset) {
  // Preserve byteOffset when given a Uint8Array view (not only raw ArrayBuffer).
  const bytes = buffer instanceof Uint8Array
    ? buffer
    : new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (kind === 'sqle') {
    const ofs = offset | 0;
    if (ofs + 104 > bytes.length) return null;
    if (bytes[ofs] !== 0x53 || bytes[ofs + 1] !== 0x51
      || bytes[ofs + 2] !== 0x4c || bytes[ofs + 3] !== 0x45) return null;
    const boneCount = i32le(dv, ofs + 96);
    if (boneCount <= 0 || boneCount > 1024) return null;
    const rec = ofs + 100;
    if (rec + boneCount * 64 > bytes.length) return null;
    const joints = [];
    for (let b = 0; b < boneCount; b++) {
      const o = rec + b * 64;
      joints.push({
        parent: i32le(dv, o + 60),
        rot: [
          dv.getFloat32(o + 12, true), dv.getFloat32(o + 16, true),
          dv.getFloat32(o + 20, true), dv.getFloat32(o + 24, true),
        ],
        trans: [
          dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true),
        ],
      });
    }
    return joints;
  }
  // Entity 0x29 — offset is the 16-byte section header start.
  const dataStart = (offset | 0) + 0x10;
  if (dataStart + 4 > bytes.length) return null;
  const numJoints = bytes[dataStart + 0x02];
  if (numJoints <= 0 || numJoints > 250) return null;
  let p = dataStart + 0x04;
  const joints = [];
  for (let i = 0; i < numJoints; i++) {
    if (p + 1 + 1 + 16 + 12 > bytes.length) return null;
    const maybeParent = bytes[p];
    p += 2;
    const rot = [
      dv.getFloat32(p, true), dv.getFloat32(p + 4, true),
      dv.getFloat32(p + 8, true), dv.getFloat32(p + 12, true),
    ];
    p += 16;
    const trans = [
      dv.getFloat32(p, true), dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true),
    ];
    p += 12;
    joints.push({ parent: maybeParent === i ? -1 : maybeParent, rot, trans });
  }
  return joints;
}

function packCreationDoc({ label, magic, root, summary, fileSize, warnings = [] }) {
  const flat = [];
  const walk = (n) => {
    for (const c of n.children ?? []) {
      if (c.kind === 'res') flat.push(c);
      else walk(c);
    }
  };
  walk(root);
  return {
    kind: 'sections',
    format: 'creation',
    formatLabel: label,
    magic,
    root,
    sectionCount: flat.length,
    dirCount: (root.children ?? []).filter((c) => c.kind === 'dir').length,
    maxDepth: 2,
    summary,
    coveredBytes: fileSize,
    fileSize,
    warnings,
  };
}

/** SQLE chunks embedded in mesh DATs (type 11 = skeleton, 21 = skin). */
function findSqleChunks(bytes, dv) {
  const out = [];
  for (let ofs = 0; ofs + 104 <= bytes.length; ofs += 16) {
    if (bytes[ofs] === 0x53 && bytes[ofs + 1] === 0x51
      && bytes[ofs + 2] === 0x4c && bytes[ofs + 3] === 0x45) {
      out.push({ ofs, type: dv.getUint16(ofs + 10, true) });
    }
  }
  return out;
}

function inspectSqleMotion(bytes, dv, fileSize) {
  if (bytes.length < 4 || bytes[0] !== 0x53 || bytes[1] !== 0x51
    || bytes[2] !== 0x4c || bytes[3] !== 0x45) return null;
  // Header is ASCII with embedded NULs between fields — don't stop at \\0.
  let header = '';
  const n = Math.min(200, bytes.length);
  for (let i = 0; i < n; i++) {
    const c = bytes[i];
    header += (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : ' ';
  }
  const m = header.match(/MOTION:\s*([^,]+),\s*time=([\d.eE+-]+),\s*size=(\d+),\s*frames=(\d+)/);
  if (!m) {
    // Non-motion SQLE (rare standalone) — still label it.
    return packCreationDoc({
      label: 'SQLE chunk',
      magic: 'SQLE',
      root: {
        kind: 'dir', id: '(root)', children: [
          res('SQLE', 'SQLE', 'data_object', fileSize, 0, 'no MOTION header'),
        ],
      },
      summary: [{ type: 'sqle', name: 'SQLE', icon: 'data_object', count: 1, bytes: fileSize }],
      fileSize,
    });
  }
  const kindName = m[1].trim();
  const kind = kindName.includes('PBChannel') ? 'PBChannel'
    : kindName.includes('FrameChannel') ? 'FrameChannel' : kindName;
  const duration = parseFloat(m[2]);
  const channels = +m[3];
  const frames = +m[4];
  const fps = kind === 'FrameChannel' ? 60 : 30;
  const children = [
    res('hdr', 'Header', 'info', 0x74, 0, kind),
    res('meta', 'Motion', 'animation', fileSize - 0x74, 0x74,
      `${frames} frames · ${channels} channels · ~${fps} fps · ${duration.toFixed(2)}s header`),
  ];
  return packCreationDoc({
    label: `Creation motion (${kind})`,
    magic: 'SQLE',
    root: { kind: 'dir', id: '(root)', children },
    summary: [
      { type: 'motion', name: kind, icon: 'animation', count: 1, bytes: fileSize },
      { type: 'ch', name: 'Channels', icon: 'tune', count: channels, bytes: 0 },
      { type: 'fr', name: 'Frames', icon: 'timer', count: frames, bytes: 0 },
    ],
    fileSize,
  });
}

function inspectDmb(bytes, dv, fileSize) {
  if (bytes.length < 0x100 || bytes[0] !== 0x44 || bytes[1] !== 0x4d
    || bytes[2] !== 0x42 || bytes[3] !== 0) return null;
  const texChildren = [];
  let texBytes = 0;
  for (let ofs = 0x20; ofs + 0x460 < bytes.length; ofs += 16) {
    const w = i32le(dv, ofs + 0x40);
    const h = i32le(dv, ofs + 0x44);
    const bpp = i32le(dv, ofs + 0x48);
    if (w < 16 || h < 16 || w > 2048 || h > 2048) continue;
    if (bpp !== 3 && bpp !== 4) continue;
    const payload = w * h * bpp;
    if (ofs + 0x60 + payload > bytes.length) continue;
    texBytes += 0x60 + payload;
    texChildren.push(res(
      `tex${texChildren.length}`,
      'Texture',
      'image',
      0x60 + payload,
      ofs,
      `${w}×${h} ${bpp === 4 ? 'RGBA' : 'RGB'}`,
      { isTexture: true, textureName: `dmb_${texChildren.length}` },
    ));
  }
  // Named shape.sqo strings for the material↔mesh binding list.
  const shapeNames = [];
  for (let ofs = 0; ofs < bytes.length;) {
    if (bytes[ofs] < 0x20 || bytes[ofs] > 0x7e) { ofs++; continue; }
    const start = ofs;
    while (ofs < bytes.length && bytes[ofs] >= 0x20 && bytes[ofs] <= 0x7e) ofs++;
    if (ofs >= bytes.length || bytes[ofs] !== 0 || ofs - start < 8) continue;
    const s = strAt(bytes, start, ofs - start);
    const lower = s.toLowerCase();
    if (lower.endsWith('shape.sqo')) {
      const slash = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\'));
      shapeNames.push(s.slice(slash + 1, s.length - 4));
    }
    ofs++;
  }
  const children = [
    res('DMB', 'DMB header', 'description', 0x20, 0, 'material / texture container'),
    ...texChildren,
  ];
  if (shapeNames.length) {
    children.push({
      kind: 'dir',
      id: 'shapes',
      children: shapeNames.map((n, i) => res(n.slice(0, 4) || `s${i}`, 'Shape ref', 'category', 0, 0, n)),
    });
  }
  const summary = [
    { type: 'tex', name: 'Texture', icon: 'image', count: texChildren.length, bytes: texBytes },
  ];
  if (shapeNames.length) {
    summary.push({ type: 'shp', name: 'Shape refs', icon: 'category', count: shapeNames.length, bytes: 0 });
  }
  return packCreationDoc({
    label: 'Creation material (DMB)',
    magic: 'DMB',
    root: { kind: 'dir', id: '(root)', children },
    summary,
    fileSize,
  });
}

function inspectRtShape(bytes, dv, fileSize) {
  // Mesh blocks: i32 type=4 at +0, "RT" at +8, "SHAPE:" ASCII nearby.
  if (bytes.length < 0x60) return null;
  if (i32le(dv, 0) !== 4) return null;
  if (bytes[8] !== 0x52 || bytes[9] !== 0x54) return null; // RT

  const shapes = [];
  let shapeOfs = 0;
  while (shapeOfs + 0x60 < bytes.length && i32le(dv, shapeOfs) === 4
    && bytes[shapeOfs + 8] === 0x52 && bytes[shapeOfs + 9] === 0x54) {
    let textOfs = -1;
    const end = Math.min(shapeOfs + 256, bytes.length - 6);
    for (let o = shapeOfs; o < end; o++) {
      if (bytes[o] === 0x53 && bytes[o + 1] === 0x48 && bytes[o + 2] === 0x41
        && bytes[o + 3] === 0x50 && bytes[o + 4] === 0x45 && bytes[o + 5] === 0x3a) {
        textOfs = o;
        break;
      }
    }
    const blockSize = i32le(dv, shapeOfs + 4);
    let detail = null;
    if (textOfs >= 0) {
      const text = strAt(bytes, textOfs, 120);
      const m = text.match(/SHAPE:\s*TriStrip ver\.2,\s*(\d+)\s*tris,\s*(\d+)\s*codes,\s*(\d+)\s*verts/);
      if (m) detail = `${m[3]} verts · ${m[1]} tris · ${m[2]} codes`;
      else detail = text.split('\0')[0].slice(0, 60);
    }
    shapes.push(res(
      `shp${shapes.length}`,
      'RT/SHAPE',
      'deployed_code',
      Math.max(blockSize, 0x60),
      shapeOfs,
      detail,
    ));
    const rawEnd = shapeOfs + Math.max(blockSize, 0x60);
    let next = -1;
    const searchEnd = Math.min(rawEnd + 0x90, bytes.length - 0x60);
    for (let o = (rawEnd + 0x20 + 3) & ~3; o <= searchEnd; o += 4) {
      if (i32le(dv, o) === 4 && bytes[o + 8] === 0x52 && bytes[o + 9] === 0x54) {
        next = o;
        break;
      }
    }
    if (next <= shapeOfs) break;
    shapeOfs = next;
  }
  if (!shapes.length) return null;

  const sqle = findSqleChunks(bytes, dv);
  const sqleChildren = [];
  for (const c of sqle) {
    const type = c.type;
    let name = `SQLE type ${type}`;
    let icon = 'data_object';
    let detail = null;
    if (type === 11) {
      name = 'Skeleton';
      icon = 'accessibility_new';
      const bones = i32le(dv, c.ofs + 96);
      if (bones > 0 && bones < 2048) detail = `${bones} bones`;
      sqleChildren.push(res(`sqle${c.ofs.toString(16)}`, name, icon, 104, c.ofs, detail, {
        isSkeleton: true, skeletonKind: 'sqle',
      }));
      continue;
    } else if (type === 21) {
      name = 'Skin clusters';
      icon = 'grain';
      const clusters = i32le(dv, c.ofs + 96);
      if (clusters > 0 && clusters < 4096) detail = `${clusters} clusters`;
    }
    sqleChildren.push(res(`sqle${c.ofs.toString(16)}`, name, icon, 104, c.ofs, detail));
  }

  const children = [
    { kind: 'dir', id: 'shapes', children: shapes },
  ];
  if (sqleChildren.length) {
    children.push({ kind: 'dir', id: 'sqle', children: sqleChildren });
  }

  const shapeBytes = shapes.reduce((s, r) => s + r.size, 0);
  const summary = [
    { type: 'shape', name: 'RT/SHAPE', icon: 'deployed_code', count: shapes.length, bytes: shapeBytes },
  ];
  const skel = sqle.filter((c) => c.type === 11).length;
  const skin = sqle.filter((c) => c.type === 21).length;
  if (skel) summary.push({ type: 'skel', name: 'Skeleton (SQLE)', icon: 'accessibility_new', count: skel, bytes: 0 });
  if (skin) summary.push({ type: 'skin', name: 'Skin (SQLE)', icon: 'grain', count: skin, bytes: 0 });

  return packCreationDoc({
    label: 'Creation mesh (RT/SHAPE)',
    magic: 'RT/SHAPE',
    root: { kind: 'dir', id: '(root)', children },
    summary,
    fileSize,
  });
}

/**
 * High-poly creation DAT (mesh / material / motion). Returns null when the
 * buffer is none of those formats.
 */
export function inspectCreationDat(buffer) {
  const bytes = new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fileSize = bytes.byteLength;
  return inspectSqleMotion(bytes, dv, fileSize)
    || inspectDmb(bytes, dv, fileSize)
    || inspectRtShape(bytes, dv, fileSize);
}

// ── the walk ─────────────────────────────────────────────────────────────────

/**
 * Inspect a DAT buffer. Returns:
 *   kind 'sections' — { root, sectionCount, dirCount, maxDepth, summary, coveredBytes, fileSize, warnings }
 *   kind 'other'    — { label, magic, fileSize } for audio/table/whatever DATs
 * `root` is { kind:'dir', id, children:[dir|res] }; a res is
 * { kind:'res', id, type, name, icon, size, offset, flags, detail, textureName }.
 */
/**
 * Decode one XISTRING payload for display.
 * ASCII + SJIS (81 40 fullwidth space, JP text) + FFXI UI controls:
 *   FA 40 8B …  → {n}   numeric runtime value
 *   FA 40 8C …  → {s}   string runtime value
 *   FA 40 83 …  → {#}   plural / branch selector
 *   FA 40 86 nn + nn bytes → singular form text
 *   FA 40 84 nn + nn bytes → plural form text
 *   ED 40 xx    → {icon:XX}  (e.g. ED 40 2F = PS button glyph)
 *   %s %c %d    kept as printf-style placeholders
 */
function decodeXistringBytes(u8) {
  if (!u8?.length) return '';
  let out = '';
  let i = 0;
  const n = u8.length;
  const pushAsciiRun = () => {
    const start = i;
    while (i < n) {
      const c = u8[i];
      if (c === 0) break;
      if (c === 0x0a || c === 0x0d || c === 0x09) break;
      if (c >= 0x20 && c < 0x7f) { i++; continue; }
      break;
    }
    if (i > start) out += String.fromCharCode(...u8.subarray(start, i));
  };
  while (i < n) {
    const c = u8[i];
    if (c === 0) break;
    if (c === 0x0a) { out += '\n'; i++; continue; }
    if (c === 0x0d) { i++; continue; }
    if (c === 0x09) { out += '\t'; i++; continue; }

    // FA 40 — UI param / grammar controls (not SJIS)
    if (c === 0xfa && i + 1 < n && u8[i + 1] === 0x40) {
      const op = i + 2 < n ? u8[i + 2] : 0;
      if (op === 0x8b) {
        // FA 40 8B 01 81  — numeric insert
        i += 5;
        if (i <= n && u8[i - 1] !== 0x81) {
          // fallback: skip FA 40 8B + up to 3 high/control bytes
          i = Math.min(n, i - 5 + 3);
          while (i < n && u8[i] >= 0x80) i++;
        }
        out += '{n}';
        continue;
      }
      if (op === 0x8c) {
        // FA 40 8C 03 81 80 / 80 80 — string insert
        i += 6;
        if (i > n) i = n;
        out += '{s}';
        continue;
      }
      if (op === 0x83) {
        // FA 40 83 01 81 03 81 80 — plural selector before 86/84 forms (8 bytes)
        i += 8;
        if (i > n) i = n;
        out += '{#}';
        continue;
      }
      if (op === 0x86 || op === 0x84) {
        // FA 40 86/84 NN + form text. NN is a form id; length is unreliable for
        // 86, so take printable run until the next FA/ED/NUL. For 84, prefer NN
        // bytes when they are a clean ASCII word (shared suffix stays outside).
        const nn = i + 3 < n ? u8[i + 3] : 0;
        const start = i + 4;
        let end = start;
        if (op === 0x84 && nn > 0 && start + nn <= n) {
          let ok = true;
          for (let k = start; k < start + nn; k++) {
            const b = u8[k];
            if (b < 0x20 || b >= 0x7f) { ok = false; break; }
          }
          if (ok) end = start + nn;
        }
        if (end === start) {
          while (end < n) {
            const b = u8[end];
            if (b === 0) break;
            if (b === 0xfa || b === 0xed) break;
            if (b >= 0x20 && b < 0x7f) { end++; continue; }
            if (b === 0x0a || b === 0x0d) break;
            break;
          }
        }
        const form = decodeXistringPlain(u8.subarray(start, end));
        if (op === 0x86) out += form || '{sg}';
        else out += '|' + (form || '{pl}');
        i = end;
        continue;
      }
      // unknown FA 40 op — skip FA 40 op and following high bytes
      i += 3;
      while (i < n && u8[i] >= 0x80) i++;
      out += '{?}';
      continue;
    }

    // ED 40 — special icon glyph (PS button etc.); following byte is normal text
    if (c === 0xed && i + 1 < n && u8[i + 1] === 0x40) {
      i += 2;
      out += '{PS}';
      continue;
    }

    // SJIS fullwidth space 81 40
    if (c === 0x81 && i + 1 < n && u8[i + 1] === 0x40) {
      out += '　';
      i += 2;
      continue;
    }

    // Other SJIS 2-byte (lead 81–9F, E0–FC except FA/ED handled above)
    if (((c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xfc)) && i + 1 < n) {
      const trail = u8[i + 1];
      if (trail >= 0x40 && trail !== 0x7f && trail <= 0xfc) {
        try {
          out += new TextDecoder('shift_jis').decode(u8.subarray(i, i + 2));
        } catch {
          out += '·';
        }
        i += 2;
        continue;
      }
    }

    if (c >= 0x20 && c < 0x7f) {
      pushAsciiRun();
      continue;
    }

    // stray high / control
    out += '·';
    i++;
  }
  return out;
}

/** Plain SJIS/ASCII decode for grammar-form payloads (no FA/ED recursion needed usually). */
function decodeXistringPlain(u8) {
  if (!u8?.length) return '';
  let hasHigh = false;
  for (let i = 0; i < u8.length; i++) {
    if (u8[i] >= 0x80) { hasHigh = true; break; }
  }
  try {
    return new TextDecoder(hasHigh ? 'shift_jis' : 'latin1').decode(u8);
  } catch {
    let s = '';
    for (let i = 0; i < u8.length; i++) {
      const c = u8[i];
      if (c === 0) break;
      if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c);
    }
    return s;
  }
}

/**
 * Menu / lobby / config string tables (`XISTRING` — ROM/97/*.DAT, some ROM/165, etc.).
 * Index is 12 bytes/entry at 0x38; offsets are relative to the string blob base.
 * See xi-tools docs/dats/ROM_97_menu_strings.md.
 */
/**
 * Attach d_msg names onto a SpellList / AbilityList table (by row idx).
 * Mutates rows in place; returns the table.
 */
export function attachDataTableNames(table, dmsgDoc) {
  if (!table?.rows || !dmsgDoc?.entries) return table;
  const byIdx = new Map();
  for (const e of dmsgDoc.entries) {
    const t = e.text || e.texts?.find((x) => x && String(x).trim()) || '';
    if (t) byIdx.set(e.index, t);
  }
  let hit = 0;
  for (const row of table.rows) {
    const name = byIdx.get(row.idx);
    if (name) {
      row.name = name;
      hit++;
    }
  }
  table.namesAttached = hit;
  table.nameSource = dmsgDoc.magic || 'd_msg';
  return table;
}

/**
 * Fixed-stride d_msg string tables (spell/ability names & help, key items, …).
 * Header at 0x10: file_size, table_offset, table_size(=0), stride, …, num.
 * Optional XOR bitmask on the block region (0xFF for key items). Auto-detected.
 * See xi-tools xi/common/xi_dmsg.py.
 */
export function inspectDmsg(buffer) {
  const bytes = new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fileSize = bytes.byteLength;
  if (fileSize < 0x40) return null;
  if (strAt(bytes, 0, 5) !== 'd_msg') return null;

  const declaredSize = dv.getUint32(0x14, true);
  const tableOffset = dv.getUint32(0x18, true);
  const tableSize = dv.getUint32(0x1c, true);
  const stride = dv.getUint32(0x20, true);
  const num = dv.getUint32(0x28, true);

  if (tableSize !== 0) return null; // variable-stride variant not supported here
  if (!(stride >= 16 && stride <= 0x10000)) return null;
  if (!(num > 0 && num <= 100_000)) return null;
  if (!(tableOffset >= 0x20 && tableOffset < fileSize)) return null;
  if (tableOffset + num * stride > fileSize + stride) {
    // allow slight overshoot then clamp
  }
  if (tableOffset + Math.min(num, 1) * stride > fileSize) return null;

  const scoreBitmask = (bm) => {
    let good = 0;
    const limit = Math.min(num, 80);
    for (let i = 0; i < limit; i++) {
      const base = tableOffset + i * stride;
      if (base + stride > fileSize) break;
      const block = new Uint8Array(stride);
      for (let j = 0; j < stride; j++) {
        const b = bytes[base + j];
        block[j] = bm ? (b ^ bm) : b;
      }
      const texts = dmsgBlockTexts(block);
      if (texts.some((t) => /[A-Za-z\u3040-\u30ff\u4e00-\u9fff]/.test(t))) good++;
    }
    return good;
  };

  const score0 = scoreBitmask(0);
  const scoreFf = scoreBitmask(0xff);
  const bitmask = scoreFf > score0 + 5 ? 0xff : 0;

  const entries = [];
  const warnings = [];
  if (declaredSize && declaredSize !== fileSize) {
    warnings.push(`header size ${declaredSize.toLocaleString()} ≠ file ${fileSize.toLocaleString()}`);
  }

  const actualNum = Math.min(num, Math.floor((fileSize - tableOffset) / stride));
  for (let i = 0; i < actualNum; i++) {
    const base = tableOffset + i * stride;
    const block = new Uint8Array(stride);
    for (let j = 0; j < stride; j++) {
      const b = bytes[base + j];
      block[j] = bitmask ? (b ^ bitmask) : b;
    }
    const texts = dmsgBlockTexts(block);
    // Key items put the name in a later sub-slot; pick first non-empty as primary.
    const primary = texts.find((t) => t && t.trim()) || texts[0] || '';
    entries.push({
      index: i,
      offset: base,
      text: primary,
      texts, // all sub-strings (name, plural, desc, …)
      byteLength: primary.length,
    });
  }

  return {
    kind: 'dmsg',
    label: 'd_msg string table',
    magic: 'd_msg',
    fileSize,
    declaredSize,
    tableOffset,
    stride,
    bitmask,
    count: entries.length,
    entries,
    warnings,
  };
}

/** Extract cp932 text sub-strings from one de-XOR'd d_msg block. */
function dmsgBlockTexts(block) {
  const dv = new DataView(block.buffer, block.byteOffset, block.byteLength);
  if (block.length < 4) return [];
  const n = dv.getUint32(0, true);
  if (n <= 0 || n > 64) return [];
  const texts = [];
  for (let i = 0; i < n; i++) {
    const eo = 4 + i * 8;
    if (eo + 8 > block.length) break;
    const off = dv.getUint32(eo, true);
    if (off < 4 || off + 4 > block.length) continue;
    const marker = dv.getUint32(off, true);
    if (marker !== 1) continue;
    const sp = off + 4 + 0x18;
    if (sp >= block.length) continue;
    let end = sp;
    while (end < block.length && block[end] !== 0) end++;
    if (end <= sp) {
      texts.push('');
      continue;
    }
    texts.push(decodeCp932(block.subarray(sp, end)));
  }
  return texts;
}

/** Best-effort cp932 (Shift-JIS) decode for d_msg payloads. */
function decodeCp932(u8) {
  if (!u8?.length) return '';
  try {
    return new TextDecoder('shift_jis').decode(u8);
  } catch {
    try {
      return new TextDecoder('latin1').decode(u8);
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
}

export function inspectXistring(buffer) {
  const bytes = new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fileSize = bytes.byteLength;
  if (fileSize < 0x38) return null;
  if (strAt(bytes, 0, 8) !== 'XISTRING') return null;

  const declaredSize = dv.getUint32(0x20, true);
  const count = dv.getUint32(0x24, true);
  const indexBytes = dv.getUint32(0x28, true);
  const secondaryOff = dv.getUint32(0x2c, true);
  const idWord = dv.getUint32(0x34, true);

  if (count <= 0 || count > 100_000) return null;
  if (indexBytes !== 0 && indexBytes !== count * 12) {
    // tolerate mismatch but require room for the index
  }
  const indexBase = 0x38;
  const blobBase = indexBase + count * 12;
  if (blobBase > fileSize) return null;

  const warnings = [];
  if (declaredSize && declaredSize !== fileSize) {
    warnings.push(`header size ${declaredSize.toLocaleString()} ≠ file ${fileSize.toLocaleString()}`);
  }

  const entries = [];
  for (let i = 0; i < count; i++) {
    const io = indexBase + i * 12;
    if (io + 12 > fileSize) {
      warnings.push(`index truncated at entry ${i}`);
      break;
    }
    // 12-byte row: offset u32, length u16, flags u16, extra u32 (usually 0).
    // Older notes treated length as u32 — the high half is actually flags
    // (e.g. 0x00010023 → length 35, flag 1 for strings with FA 40 controls).
    const off = dv.getUint32(io, true);
    const length = dv.getUint16(io + 4, true);
    const flags = dv.getUint16(io + 6, true);
    const extra = dv.getUint32(io + 8, true);
    const abs = blobBase + off;
    let text = '';
    let rawLen = 0;
    if (length > 0 && abs < fileSize) {
      const end = Math.min(abs + length, fileSize);
      const slice = bytes.subarray(abs, end);
      let n = slice.length;
      while (n > 0 && slice[n - 1] === 0) n--;
      rawLen = n;
      text = decodeXistringBytes(slice.subarray(0, n));
    } else if (length === 0) {
      text = '';
    } else {
      warnings.push(`entry ${i}: offset 0x${off.toString(16)} past blob`);
    }
    entries.push({
      index: i,
      offset: abs,
      blobOffset: off,
      length,
      flags,
      extra,
      text,
      byteLength: rawLen,
    });
  }

  return {
    kind: 'xistring',
    label: 'XISTRING menu strings',
    magic: 'XISTRING',
    fileSize,
    declaredSize,
    count: entries.length,
    indexBytes: count * 12,
    secondaryOff,
    idWord,
    blobBase,
    entries,
    warnings,
  };
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {string} [path]  lets USER save files be recognised by name
 */
export function inspectDat(buffer, path = '') {
  const bytes = new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.byteLength;
  const fileSize = len;

  // DATs that aren't section containers at all.
  const head8 = strAt(bytes, 0, 8);
  if (head8.startsWith('SeWave')) return { kind: 'other', label: 'Sound sample (SeWave)', magic: 'SeWave', fileSize };
  if (strAt(bytes, 0, 12).startsWith('BGMStream')) return { kind: 'other', label: 'Music stream (BGMStream)', magic: 'BGMStream', fileSize };

  // Per-character saves under USER\ — named formats, never section walks.
  const user = inspectUserDat(bytes, path);
  if (user) return user;

  const xistring = inspectXistring(buffer);
  if (xistring) return xistring;

  const dmsg = inspectDmsg(buffer);
  if (dmsg) return dmsg;

  // Character-creation formats (before the section walker confuses them).
  const creation = inspectCreationDat(buffer);
  if (creation) return creation;

  const warnings = [];
  const root = { kind: 'dir', id: '(root)', children: [] };
  const stack = [root];
  let pos = 0;
  let sectionCount = 0;
  let dirCount = 0;
  let maxDepth = 0;
  const summary = new Map();   // type code -> { count, bytes }

  while (pos + 16 <= len) {
    const meta = dv.getUint32(pos + 4, true);
    const type = meta & 0x7f;
    const size = ((meta >>> 7) & 0x7ffff) * 0x10;   // 19-bit size, 16-byte units
    if (size <= 0) {
      if (len - pos > 16) warnings.push(`walk stopped at 0x${pos.toString(16)} — zero-size section`);
      break;
    }
    if (pos + size > len) {
      warnings.push(`section at 0x${pos.toString(16)} runs past end of file (truncated?)`);
      break;
    }
    const id = fourcc(bytes, pos);
    const flags = [];
    if (meta & (1 << 26)) flags.push('shadow');
    if (meta & (1 << 27)) flags.push('extracted');
    const ver = (meta >>> 28) & 0x7;
    if (ver) flags.push(`v${ver}`);
    if (meta & (1 << 31)) flags.push('virtual');

    if (type === 0x01) {
      const dir = { kind: 'dir', id, children: [] };
      stack[stack.length - 1].children.push(dir);
      stack.push(dir);
      dirCount++;
      if (stack.length - 1 > maxDepth) maxDepth = stack.length - 1;
    } else if (type === 0x00) {
      if (stack.length > 1) stack.pop();
    } else {
      let detail = null;
      let textureName = null;
      let isTexture = type === 0x20 || type === 0x5D;
      let isSound = type === 0x3D;
      let isZoneDef = type === 0x1C;
      let isRoute = type === 0x06;
      let isUiMenu = type === 0x30;
      let isUiElementGroup = type === 0x31;
      let isDataTable = type === 0x04 || type === 0x49 || type === 0x53;
      const isParticleGenerator = type === 0x05;
      let soundId = null;
      const peek = PEEKS[type];
      if (peek) {
        try {
          const r = peek(bytes, dv, { start: pos, size, dataStart: pos + 0x10 });
          detail = r?.text ?? null;
          textureName = r?.textureName ?? null;
          if (r?.isTexture) isTexture = true;
          if (r?.isSound) isSound = true;
          if (r?.isZoneDef) isZoneDef = true;
          if (r?.isRoute) isRoute = true;
          if (r?.isUiMenu) isUiMenu = true;
          if (r?.isUiElementGroup) isUiElementGroup = true;
          if (r?.isDataTable) isDataTable = true;
          if (r?.soundId != null) soundId = r.soundId;
        } catch { /* malformed header — list it plain */ }
      }
      // Structure tree shows the 4-char section id; use it as a lookup key when
      // the embedded name is missing so Texture rows stay clickable.
      if (isTexture && !textureName && id.trim()) textureName = id.trim();
      const isSkeleton = type === 0x29;
      stack[stack.length - 1].children.push({
        kind: 'res', id, type, name: typeName(type),
        icon: SECTION_TYPE_ICONS[type] ?? 'data_object',
        size, offset: pos, flags, detail, textureName, isTexture,
        isSkeleton, skeletonKind: isSkeleton ? 'entity' : null,
        isSound, soundId, isZoneDef, isParticleGenerator, isRoute, isUiMenu,
        isUiElementGroup, isDataTable,
      });
      const agg = summary.get(type) ?? { count: 0, bytes: 0 };
      agg.count++; agg.bytes += size;
      summary.set(type, agg);
    }

    sectionCount++;
    pos += size;
  }

  const coveredBytes = pos;
  // A believable container covers (nearly) the whole file. Anything else — item
  // tables, dialog text, FTABLE — walks a step or two into garbage and stops.
  if (sectionCount === 0 || coveredBytes < len * 0.9) {
    // Section walk may partially chew a creation DAT; prefer the dedicated view.
    const cr = inspectCreationDat(buffer);
    if (cr) return cr;
    // No structure to show, so show the bytes — better than a dead end when
    // you are working out what an unfamiliar DAT actually holds.
    return inspectAsHex(bytes, {
      label: 'Not a sectioned resource DAT',
      note: printable(head8) && head8.trim()
        ? `Header magic: ${head8.trim()}. No 16-byte section headers to walk.`
        : 'No 16-byte section headers to walk — a raw table, text, or stream DAT.',
    });
  }
  if (len - coveredBytes > 16) {
    warnings.push(`${(len - coveredBytes).toLocaleString()} unparsed bytes after the last section`);
  }

  const summaryRows = [...summary.entries()]
    .map(([type, agg]) => ({
      type, name: typeName(type),
      icon: SECTION_TYPE_ICONS[type] ?? 'data_object',
      count: agg.count, bytes: agg.bytes,
    }))
    .sort((a, b) => b.count - a.count || a.type - b.type);

  return {
    kind: 'sections',
    root, sectionCount, dirCount, maxDepth,
    summary: summaryRows, coveredBytes, fileSize, warnings,
  };
}

/** "12.4 KB" / "3.2 MB" — structure rows and the file card. */
export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
