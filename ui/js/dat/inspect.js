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
  return { text: `sound ${soundId} → se/${folder}/${file}.spw` };
}

function peekSpriteSheet(bytes, dv, s) {
  const numMesh = dv.getUint16(s.dataStart + 2, true);
  const tex = strAt(bytes, s.dataStart + 8, 0x10).trim();
  return { text: tex ? `${numMesh} sprites · ${tex}` : `${numMesh} sprites` };
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

const PEEKS = {
  0x07: peekRoutine,
  0x19: peekKeyFrames,
  0x1F: peekParticleMesh,
  0x20: peekTexture,
  0x21: peekSpriteSheet,
  0x29: peekSkeleton,
  0x2A: peekSkeletonMesh,
  0x2B: peekAnimation,
  0x2E: peekZoneMesh,
  0x3D: peekSoundPointer,
  0x45: peekInfo,
};

// ── the walk ─────────────────────────────────────────────────────────────────

/**
 * Inspect a DAT buffer. Returns:
 *   kind 'sections' — { root, sectionCount, dirCount, maxDepth, summary, coveredBytes, fileSize, warnings }
 *   kind 'other'    — { label, magic, fileSize } for audio/table/whatever DATs
 * `root` is { kind:'dir', id, children:[dir|res] }; a res is
 * { kind:'res', id, type, name, icon, size, offset, flags, detail, textureName }.
 */
export function inspectDat(buffer) {
  const bytes = new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.byteLength;
  const fileSize = len;

  // DATs that aren't section containers at all.
  const head8 = strAt(bytes, 0, 8);
  if (head8.startsWith('SeWave')) return { kind: 'other', label: 'Sound sample (SeWave)', magic: 'SeWave', fileSize };
  if (strAt(bytes, 0, 12).startsWith('BGMStream')) return { kind: 'other', label: 'Music stream (BGMStream)', magic: 'BGMStream', fileSize };

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
      let isTexture = type === 0x20;
      const peek = PEEKS[type];
      if (peek) {
        try {
          const r = peek(bytes, dv, { start: pos, size, dataStart: pos + 0x10 });
          detail = r?.text ?? null;
          textureName = r?.textureName ?? null;
          if (r?.isTexture) isTexture = true;
        } catch { /* malformed header — list it plain */ }
      }
      // Structure tree shows the 4-char section id; use it as a lookup key when
      // the embedded name is missing so Texture rows stay clickable.
      if (isTexture && !textureName && id.trim()) textureName = id.trim();
      stack[stack.length - 1].children.push({
        kind: 'res', id, type, name: typeName(type),
        icon: SECTION_TYPE_ICONS[type] ?? 'data_object',
        size, offset: pos, flags, detail, textureName, isTexture,
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
    return {
      kind: 'other',
      label: 'Not a sectioned resource DAT',
      magic: printable(head8) && head8.trim() ? head8.trim() : null,
      fileSize,
    };
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
