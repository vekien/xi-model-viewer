// FFXI zone DAT parser — pure JS port of xi's Python tooling, so the browser
// reads ROM/1/41.dat directly (like xim) instead of a pre-baked .glb.
//
// Pipeline: split the DAT into sections → decrypt the encrypted 0x2E (mesh) and
// 0x1C (placement) chunks using two 256-byte key tables scanned out of
// FFXiMain.dll → parse geometry, placements and textures (DXT1/DXT3/palette).
//
// Ports: src/xi/entity/anim/xi_export.py (parse_sections, Reader),
//        src/xi/zone/xi_decrypt.py        (decrypt_zone_mesh / _objects),
//        src/xi/zone/xi_export.py         (parse_zone_mesh_section, parse_zone_def),
//        src/xi/entity/mesh/xi_export.py  (parse_texture, DXT/palette decode).


// ── low-level reader ────────────────────────────────────────────────────────
class Reader {
  constructor(view, pos = 0) { this.dv = view; this.pos = pos; }
  u8()  { return this.dv.getUint8(this.pos++); }
  u16() { const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  u32() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  str(n) {
    let s = '';
    for (let i = 0; i < n; i++) { const c = this.dv.getUint8(this.pos + i); if (c === 0) break; s += String.fromCharCode(c); }
    this.pos += n; return s;
  }
}
const u32at = (dv, p) => dv.getUint32(p, true);
const strAt = (bytes, p, n) => {
  let s = '';
  for (let i = 0; i < n; i++) { const c = bytes[p + i]; if (c === 0) break; s += String.fromCharCode(c); }
  return s.trim();
};

// ── key tables from FFXiMain.dll ────────────────────────────────────────────
// Each table's own first 4 bytes are its find-signature; scan from 0x30000.
const TABLE1_SIG = [0xE2, 0xE5, 0x06, 0xA9];
const TABLE2_SIG = [0xB8, 0xC5, 0xF7, 0x84];
const SCAN_START = 0x30000, TABLE_SIZE = 0x100;

function findSig(bytes, sig, from) {
  for (let i = from; i <= bytes.length - sig.length; i++) {
    let ok = true;
    for (let j = 0; j < sig.length; j++) if (bytes[i + j] !== sig[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}

export function extractKeyTables(dllBuffer) {
  const bytes = new Uint8Array(dllBuffer);
  const i1 = findSig(bytes, TABLE1_SIG, SCAN_START);
  const i2 = findSig(bytes, TABLE2_SIG, SCAN_START);
  if (i1 < 0 || i2 < 0) throw new Error('Could not locate zone-decrypt key tables in FFXiMain.dll');
  return { table1: bytes.slice(i1, i1 + TABLE_SIZE), table2: bytes.slice(i2, i2 + TABLE_SIZE) };
}

// ── section table ───────────────────────────────────────────────────────────
const align16 = (v) => (v + 0xF) & ~0xF;

export function parseSections(dv) {
  const sections = [];
  let pos = 0;
  const len = dv.byteLength;
  while (pos + 16 <= len) {
    const meta = u32at(dv, pos + 4);
    const typeCode = meta & 0x7F;
    const size = ((meta >>> 7) & 0xFFFFF) * 0x10;
    if (size <= 0) break;
    // DatId = first 4 bytes of the header (used for link resolution between sections)
    let id = '';
    for (let i = 0; i < 4; i++) { const c = dv.getUint8(pos + i); if (c) id += String.fromCharCode(c); }
    sections.push({ id, typeCode, start: pos, size, dataStart: pos + 0x10 });
    pos = align16(pos + size);
  }
  return sections;
}

// ── 0x2E ZoneMesh decryption (keyed XOR + 8-byte block swaps) ────────────────
function decryptZoneMesh(bytes, dv, dataStart, table1, table2) {
  const ds = dataStart;
  const metadata = u32at(dv, ds);
  const totalSize = metadata & 0x00FFFFFF;
  const decodeLength = totalSize - 8;
  const mode = (metadata >>> 24) & 0xFF;

  // pass 1: keyed XOR stream (mode >= 5)
  if (mode >= 5) {
    let key = table1[bytes[ds + 5] ^ 0xF0];
    let counter = 0;
    const p = ds + 8;
    for (let i = 0; i < decodeLength; i++) {
      const kb = key % 256;
      const keyMod = (kb << 8) | kb;
      counter += 1; key += counter;
      const shift = key % 8;
      bytes[p + i] ^= (keyMod >>> shift) & 0xFF;
      counter += 1; key += counter;
    }
  }

  // pass 2: conditional swap of 8-byte blocks between the two body halves
  if (dv.getUint16(ds + 6, true) === 0xFFFF) {
    let key1 = bytes[ds + 5] ^ 0xF0;
    let key2 = table2[key1];
    const decodeCount = (decodeLength & ~0xF) >>> 1;
    let p = ds + 8, i = 0;
    while (i < decodeCount) {
      if (key2 % 2) {
        for (let j = 0; j < 8; j++) {
          const a = bytes[p + j], b = bytes[p + decodeCount + j];
          bytes[p + j] = b; bytes[p + decodeCount + j] = a;
        }
      }
      p += 8; i += 8; key1 += 9; key2 += key1;
    }
  }
}

// ── 0x1C ZoneDef decryption (XOR-0xFF body stream + 0x55 name mask) ──────────
function decryptZoneObjects(bytes, dv, section, table1) {
  const ds = section.dataStart;
  const mode = (u32at(dv, ds) >>> 24) & 0xFF;
  const nodeCount = u32at(dv, ds + 4) & 0x00FFFFFF;
  if (mode <= 0x1A) return nodeCount; // not encrypted

  // body XOR stream
  const metadata = u32at(dv, ds);
  let decodeLength = metadata & 0x00FFFFFF;
  let key = table1[((u32at(dv, ds + 4) >>> 24) & 0xFF) ^ 0xFF];
  let counter = 0, consumed = 0, p = ds + 8;
  const sectionEnd = section.start + section.size;
  if (p + decodeLength > sectionEnd) decodeLength -= (p + decodeLength) - sectionEnd;
  while (consumed < decodeLength) {
    const xorLength = ((key >>> 4) & 7) + 16;
    const applyMask = (key & 1) !== 0;
    const hasRemaining = consumed + xorLength < decodeLength;
    if (applyMask && hasRemaining) { for (let k = 0; k < xorLength; k++) { bytes[p] ^= 0xFF; p++; } }
    else { p += xorLength; }
    counter += 1; key += counter; consumed += xorLength;
  }

  // name unmask (XOR 0x55 over each object's 16-char name)
  const namePos = ds + 0x20;
  for (let i = 0; i < nodeCount; i++) {
    const base = namePos + i * 0x64;
    for (let j = 0; j < 0x10; j++) bytes[base + j] ^= 0x55;
  }
  return nodeCount;
}

// ── 0x2E geometry parse ─────────────────────────────────────────────────────
/** True if `p` looks like a submesh header (texture name + sane nverts).
 *  Prototype zones often leave the 16-byte texture name blank (all NUL/space). */
function looksLikeSubmesh(bytes, dv, p, sectionEnd, stride) {
  if (p + 20 > sectionEnd) return false;
  let printable = 0;
  let blank = true;
  for (let i = 0; i < 16; i++) {
    const c = bytes[p + i];
    if (c === 0 || c === 0x20) continue;
    blank = false;
    if (c < 0x20 || c > 0x7e) return false;
    printable++;
  }
  if (!blank && printable < 2) return false;
  const numVerts = dv.getUint16(p + 16, true);
  if (numVerts === 0 || numVerts > 20000) return false;
  if (p + 20 + numVerts * stride + 4 > sectionEnd) return false;
  // Blank-name headers still need a plausible index count after the verts.
  const niAt = p + 20 + numVerts * stride;
  const numIdx = dv.getUint16(niAt, true);
  if (numIdx === 0 || numIdx > 60000) return false;
  if (niAt + 4 + numIdx * 2 > sectionEnd) return false;
  return true;
}

function parseZoneMeshSection(bytes, dv, section) {
  const ds = section.dataStart;
  const config = u32at(dv, ds + 4) & 0xFF;
  // Bit0 = strip (xim). Some prototype MMBs leave the flag clear even when the
  // index buffer is clearly a strip (count not divisible by 3) — detect that.
  let isStrip = (config & 0x1) !== 0;
  const vertexBlend = (config & 0x2) !== 0;
  const meshName = strAt(bytes, ds + 0x10, 0x10);

  const defStart = ds + 0x20;
  const meshCount0 = u32at(dv, defStart);
  if (meshCount0 === 0) return { meshName, prims: [] }; // collision-only "hit" model

  // Modern layout (xim ZoneMeshSection): after meshCount0 + bbox0 sits
  // section1Off @ +0x3C and meshCount1 @ +0x40.
  // Pre-production / MZB-era meshes (ROM/0/28,41,42,…) often leave those zero
  // and park the data offset at +0x4C or +0x5C instead (still usually 0x60 from
  // defStart). Some large floor meshes (e.g. hole1) then carry a SECOND group:
  // after the first stream, count + bbox + pad + more submeshes.
  const offOk = (v) => v > 0 && v < section.size - 0x20;
  let section1Off = u32at(dv, ds + 0x3C);
  let meshCount1 = u32at(dv, ds + 0x40);
  // Prefer the smaller "near header" offsets first — +0x5C can be a large
  // second-region pointer (see dual-group parse below), not the primary start.
  if (!offOk(section1Off) || section1Off > 0x200) {
    for (const at of [0x4c, 0x5c, 0x50, 0x58]) {
      const alt = u32at(dv, ds + at);
      if (offOk(alt) && alt <= 0x200) { section1Off = alt; break; }
    }
  }
  if (!offOk(section1Off)) {
    for (const at of [0x4c, 0x5c, 0x50, 0x58]) {
      const alt = u32at(dv, ds + at);
      if (offOk(alt)) { section1Off = alt; break; }
    }
  }
  // +0x60 is often section-2's count sitting on a second bbox, NOT the submesh
  // stream length — prefer meshCount0 when +0x40 is empty.
  if (meshCount1 === 0 || meshCount1 > 256) meshCount1 = meshCount0;
  if (!offOk(section1Off)) return { meshName, prims: [] };

  const stride = vertexBlend ? 48 : 36;
  const prims = [];
  const sectionEnd = section.start + section.size;

  const parseOne = (pRef) => {
    let p = pRef.p;
    if (!looksLikeSubmesh(bytes, dv, p, sectionEnd, stride)) return false;
    const textureName = strAt(bytes, p, 0x10); p += 0x10;
    const numVerts = dv.getUint16(p, true);
    const flags = dv.getUint16(p + 2, true); p += 4;
    // Submesh render flags (xim ZoneMeshSection.parseMesh):
    //   0x8000 = blend (translucent submesh: water, soft terrain edges, overlays)
    //   0x2000 = DISABLE back-face culling (culling is on by default, not alpha-test)
    const blend = (flags & 0x8000) !== 0;
    const noCull = (flags & 0x2000) !== 0;

    const verts = new Array(numVerts);
    for (let v = 0; v < numVerts; v++) {
      const px = dv.getFloat32(p, true), py = dv.getFloat32(p + 4, true), pz = dv.getFloat32(p + 8, true);
      // Blend-position stream (wind sway target): the shader draws
      // p0 + windFactor * p1, so p1 is a per-vertex delta (xim XimShader vert).
      const bx = vertexBlend ? dv.getFloat32(p + 12, true) : 0;
      const by = vertexBlend ? dv.getFloat32(p + 16, true) : 0;
      const bz = vertexBlend ? dv.getFloat32(p + 20, true) : 0;
      const nOff = vertexBlend ? p + 24 : p + 12;
      const nx = dv.getFloat32(nOff, true), ny = dv.getFloat32(nOff + 4, true), nz = dv.getFloat32(nOff + 8, true);
      // per-vertex colour (baked lighting) sits right after the normal: BGRA bytes
      const cOff = vertexBlend ? p + 36 : p + 24;
      const cb = bytes[cOff], cg = bytes[cOff + 1], cr = bytes[cOff + 2], ca = bytes[cOff + 3];
      const u = dv.getFloat32(p + stride - 8, true), w = dv.getFloat32(p + stride - 4, true);
      verts[v] = [px, py, pz, nx, ny, nz, u, w, cr / 255, cg / 255, cb / 255, ca / 255, bx, by, bz];
      p += stride;
    }

    const numIndices = dv.getUint16(p, true); p += 4;
    if (p + numIndices * 2 > sectionEnd) return false;
    // Keep raw indices so degenerate detection matches Python (index equality,
    // not vertex-object identity — required for correct strip restarts).
    const indices = new Array(numIndices);
    for (let i = 0; i < numIndices; i++) {
      indices[i] = dv.getUint16(p, true);
      p += 2;
    }
    p = (p + 3) & ~3; // align0x04 after each mesh

    // Auto-detect strip when the flag is wrong but the index count can't be tris.
    const useStrip = isStrip || (numIndices > 3 && numIndices % 3 !== 0);

    const positions = [], normals = [], uvs = [], colors = [], blendOffsets = [];
    const pushIdx = (ii) => {
      const vt = verts[ii];
      if (!vt) return false;
      positions.push(vt[0], vt[1], vt[2]); normals.push(vt[3], vt[4], vt[5]);
      uvs.push(vt[6], vt[7]); colors.push(vt[8], vt[9], vt[10], vt[11]);
      if (vertexBlend) blendOffsets.push(vt[12], vt[13], vt[14]);
      return true;
    };
    if (useStrip) {
      // Degenerate tris (shared index) are strip restarts — reset parity so
      // winding stays consistent after the break (xi xi_export.py).
      let parity = 0;
      for (let t = 0; t < indices.length - 2; t++) {
        const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
        if (i0 === i1 || i1 === i2 || i0 === i2) { parity = 0; continue; }
        if (!verts[i0] || !verts[i1] || !verts[i2]) { parity = 0; continue; }
        if (parity % 2 === 0) { pushIdx(i0); pushIdx(i1); pushIdx(i2); }
        else { pushIdx(i1); pushIdx(i0); pushIdx(i2); }
        parity += 1;
      }
    } else {
      for (let t = 0; t < indices.length - 2; t += 3) {
        const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
        if (!verts[i0] || !verts[i1] || !verts[i2]) continue;
        pushIdx(i0); pushIdx(i1); pushIdx(i2);
      }
    }
    if (positions.length) {
      // Blank-name prototype meshes (no 0x20 textures in the DAT) often author
      // floor/ceiling winding that back-face culls under our Y flip — two-sided.
      const blankTex = !textureName || !textureName.trim();
      prims.push({
        textureName: textureName || null,
        blend,
        noCull: noCull || blankTex,
        hasBlendPos: vertexBlend,
        positions: new Float32Array(positions),
        blendOffsets: vertexBlend ? new Float32Array(blendOffsets) : null,
        normals: new Float32Array(normals),
        uvs: new Float32Array(uvs),
        colors: new Float32Array(colors),
      });
    }
    pRef.p = p;
    return true;
  };

  // Primary stream (defStart-relative offset, like xim).
  const pRef = { p: defStart + section1Off };
  // Only read while headers look like submeshes — a high meshCount0 often means
  // "N LOD/groups" with group headers between streams, not N back-to-back parts.
  for (let m = 0; m < 64; m++) {
    if (!parseOne(pRef)) break;
  }
  let highWater = pRef.p;

  // Further groups: count(u32) + bbox(6×f32) + pad(u32) = 0x20, then submeshes.
  // Large floor/wall meshes chain several of these (mc0=3 → up to 3 groups).
  // Also reachable via pointers at +0x4C / +0x5C. highWater avoids double-adds.
  const tryGroupAt = (at) => {
    if (at + 0x30 > sectionEnd) return false;
    // Already consumed this region via the cursor chain.
    if (at + 0x20 < highWater) return false;
    const c2 = u32at(dv, at);
    if (c2 < 1 || c2 > 64) return false;
    const nameAt = at + 0x20;
    if (!looksLikeSubmesh(bytes, dv, nameAt, sectionEnd, stride)) return false;
    const p2 = { p: nameAt };
    let n = 0;
    for (let m = 0; m < c2; m++) {
      if (!parseOne(p2)) break;
      n++;
    }
    if (n > 0) {
      pRef.p = p2.p;
      highWater = Math.max(highWater, p2.p);
    }
    return n > 0;
  };

  // Keep consuming group headers from the current cursor.
  for (let g = 0; g < 8; g++) {
    if (!tryGroupAt(pRef.p)) break;
  }
  // Pointer fallbacks for groups the cursor didn't reach.
  for (const at of [0x4c, 0x5c]) {
    const off = u32at(dv, ds + at);
    if (!offOk(off) || off <= section1Off) continue;
    if (!tryGroupAt(ds + off)) tryGroupAt(defStart + off);
    for (let g = 0; g < 8; g++) {
      if (!tryGroupAt(pRef.p)) break;
    }
  }

  return { meshName, prims };
}

// ── 0x1C placement parse ────────────────────────────────────────────────────
// Modern retail objects are 0x64 bytes. Pre-production MZB zones pack the same
// name/pos/rot/scale fields into 0x54. Using the wrong stride misaligns every
// entry after the first.
//
// IMPORTANT: `xi zone` convert_zonedef_to_retail_stride widens records to 0x64
// but KEAPS the pre-production mode byte. Trusting mode alone then reads a
// converted DAT (e.g. ROM10/1/4 after patch) as 0x54 and shreds placements.
// Match xi-tools zonedef_record_size: score printable mesh ids first; mode is
// only a tie-break. See docs/zone/prototype-zones.md in xi-tools.
const OBJ_STRIDE_MODERN = 0x64;
const OBJ_STRIDE_PROTO = 0x54;

function zoneDefObjectStride(bytes, dv, ds, nodeCount) {
  const mode = (u32at(dv, ds) >>> 24) & 0xFF;
  if (nodeCount < 2) {
    return (mode > 0 && mode <= 5) ? OBJ_STRIDE_PROTO : OBJ_STRIDE_MODERN;
  }
  const score = (stride) => {
    let n = 0;
    const limit = Math.min(nodeCount, 32);
    for (let i = 0; i < limit; i++) {
      const id = strAt(bytes, ds + 0x20 + i * stride, 0x10);
      if (id.length >= 2 && /^[\x20-\x7e]+$/.test(id)) n++;
    }
    return n;
  };
  const s54 = score(OBJ_STRIDE_PROTO);
  const s64 = score(OBJ_STRIDE_MODERN);
  // Clear winner wins — same ±2 margin as xi-tools.
  if (s64 > s54 + 2) return OBJ_STRIDE_MODERN;
  if (s54 > s64 + 2) return OBJ_STRIDE_PROTO;
  // Tie: mode ≤ 5 hints proto; otherwise retail.
  return (mode > 0 && mode <= 5) ? OBJ_STRIDE_PROTO : OBJ_STRIDE_MODERN;
}

function parseZoneDef(bytes, dv, section, table1) {
  const nodeCount = decryptZoneObjects(bytes, dv, section, table1);
  const ds = section.dataStart;
  const stride = zoneDefObjectStride(bytes, dv, ds, nodeCount);
  const placements = [];
  const sectionEnd = section.start + section.size;
  for (let i = 0; i < nodeCount; i++) {
    const b = ds + 0x20 + i * stride;
    if (b + 0x34 > sectionEnd) break;
    const meshId = strAt(bytes, b, 0x10);
    placements.push({
      meshId,
      index: i,   // stable DAT object index — lets edits target the EXACT instance of a shared mesh name
      // fileIdLink sits at +0x50 in the modern 0x64 record; absent on 0x54 proto.
      fileIdLink: stride >= OBJ_STRIDE_MODERN ? (dv.getUint32(b + 0x50, true) || null) : null,
      pos: [dv.getFloat32(b + 0x10, true), dv.getFloat32(b + 0x14, true), dv.getFloat32(b + 0x18, true)],
      rot: [dv.getFloat32(b + 0x1C, true), dv.getFloat32(b + 0x20, true), dv.getFloat32(b + 0x24, true)],
      scale: [dv.getFloat32(b + 0x28, true), dv.getFloat32(b + 0x2C, true), dv.getFloat32(b + 0x30, true)],
    });
  }
  return placements;
}

/**
 * Data Struct: parse the 0x1C ZoneDef placement table at `sectionStart`.
 * Copies the buffer so decryption does not mutate the inspect cache.
 * Returns { placements, nodeCount, stride } or null.
 */
export function parseZoneDefAt(buffer, sectionStart, keyTables) {
  if (!keyTables?.table1 || sectionStart == null) return null;
  const src = buffer instanceof Uint8Array
    ? buffer
    : new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  const bytes = src.slice();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sections = parseSections(dv);
  const section = sections.find((s) => s.start === sectionStart && s.typeCode === 0x1C)
    ?? sections.find((s) => s.typeCode === 0x1C);
  if (!section) return null;
  try {
    const placements = parseZoneDef(bytes, dv, section, keyTables.table1);
    const ds = section.dataStart;
    const nodeCount = u32at(dv, ds + 4) & 0x00FFFFFF;
    const stride = zoneDefObjectStride(bytes, dv, ds, nodeCount);
    return { placements, nodeCount: placements.length, stride };
  } catch {
    return null;
  }
}

// ── 0x36 ZoneInteraction parse ("RID", trigger volumes) ─────────────────────
// Plaintext (unlike 0x2E/0x1C). Mirrors xim ZoneInteractionSection. Each 0x40-byte
// entry is an OBB trigger; its sourceId's FIRST CHAR classifies it:
//   'm' = sub-area (building interior, param = sub-area id)   'z' = zone line/entrance
//   '_' = door                                                'f' = fishing area
// Sub-areas are how shops/buildings link to a zone: the interior lives in a
// SEPARATE "sub" DAT resolved by file-table index (subAreaId + 0x64), swapped in
// when the player enters this volume. See docs/ue5/zones.md §5.
function parseZoneInteractions(bytes, dv, section) {
  const ds = section.dataStart;
  if (strAt(bytes, ds, 4).slice(0, 3) !== 'RID') return [];   // magic guard (treat as hostile input)
  const dataOffset = u32at(dv, ds + 0x10);                    // [0:4]magic [4:8]unk [8:16]skip [16:20]dataOffset
  let p = ds + dataOffset;
  const numEntries = u32at(dv, p); p += 0x10;                 // numEntries + three zero u32
  const sectionEnd = section.start + section.size;
  const out = [];
  for (let i = 0; i < numEntries; i++) {
    const b = p + i * 0x40;
    if (b + 0x40 > sectionEnd) break;
    const kindByte = bytes[b + 0x24];                         // first char of the 4-byte sourceId
    out.push({
      kind: kindByte ? String.fromCharCode(kindByte) : '',
      sourceId: strAt(bytes, b + 0x24, 4),
      destId: strAt(bytes, b + 0x28, 4) || null,
      param: u32at(dv, b + 0x2C),                             // sub-area id (for 'm'); dest zone (for 'z')
      pos:  [dv.getFloat32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true)],
      size: [dv.getFloat32(b + 24, true), dv.getFloat32(b + 28, true), dv.getFloat32(b + 32, true)],
    });
  }
  return out;
}

// ── 0x1C collision triangle soup ("MZB", the player-collision mesh) ──────────
// Decodes the collision geometry embedded in the (already-decrypted) 0x1C
// section: walk the mesh/transform pair-groups -> world-space triangles. Mirrors
// src/xi/zone/xi_collision.py decode_collision. Returns flat, non-indexed
// world-space positions in RAW FFXI coords (the display root negates Y) plus a
// per-vertex colour (wall = red; floor coloured by terrain), ready to drop into a
// BufferGeometry. Collision is invisible in-game; this is a debug overlay.
const COLL_TERRAIN_RGB = [
  [0.30, 0.30, 0.30], [0.25, 0.50, 0.25], [0.10, 0.55, 0.10], [0.65, 0.62, 0.20],
  [0.85, 0.85, 0.88], [0.45, 0.45, 0.45], [0.55, 0.35, 0.30], [0.55, 0.40, 0.22],
  [0.25, 0.55, 0.80], [0.10, 0.20, 0.70], [0.55, 0.10, 0.55],
];
const COLL_WALL_RGB = [0.85, 0.12, 0.12];

function decodeCollision(bytes, dv, section) {
  const ds = section.dataStart;
  const collRel = u32at(dv, ds + 0x08);
  if (!collRel) return null;                       // ship-interior zones: no collision
  const cb = ds + collRel;
  const pairCount = u32at(dv, cb + 0x08);
  const pairsOff = u32at(dv, cb + 0x0C);
  const sectionEnd = section.start + section.size;

  const positions = [];
  const colors = [];
  const seen = new Set();                           // dedup (transform,mesh) instances
  let p = ds + pairsOff;
  for (let g = 0; g < pairCount; g++) {
    if (p + 4 > sectionEnd) break;
    const countFlags = u32at(dv, p); p += 4;
    const groupSize = countFlags & 0x7FF;
    for (let j = 0; j < groupSize; j++) {
      const matRel = u32at(dv, p); const meshRel = u32at(dv, p + 4); p += 8;
      const key = matRel + ':' + meshRel;
      if (seen.has(key)) continue;
      seen.add(key);

      // transform: column-major toWorld matrix (16 f32) at matRel
      const m = new Array(16);
      for (let k = 0; k < 16; k++) m[k] = dv.getFloat32(ds + matRel + k * 4, true);

      // mesh header: posOff, nrmOff, idxOff, triCount(u16)
      const mp = ds + meshRel;
      const posOff = ds + u32at(dv, mp + 0x00);
      const idxOff = ds + u32at(dv, mp + 0x08);
      const triCount = dv.getUint16(mp + 0x0C, true);

      for (let t = 0; t < triCount; t++) {
        const rec = idxOff + t * 8;
        const r0 = dv.getUint16(rec, true), r1 = dv.getUint16(rec + 2, true);
        const r2 = dv.getUint16(rec + 4, true), rd = dv.getUint16(rec + 6, true);
        const idx = [r0 & 0x7FFF, r1 & 0x3FFF, r2 & 0x3FFF];
        // material/terrain from the high nibble of each index word
        const f0 = r0 >>> 12, f1 = r1 >>> 12, f2 = r2 >>> 12, f3 = rd >>> 12;
        const hitWall = (((f2 << 4) & 0x40)) !== 0; // material bit 0x40 = f2 & 0x4
        const terrain = ((f0 & 8) >>> 3) + ((f1 & 8) >>> 2) + ((f2 & 8) >>> 1) + (f3 & 8);
        const col = hitWall ? COLL_WALL_RGB : (COLL_TERRAIN_RGB[terrain] || [0.6, 0.6, 0.6]);
        for (const vi of idx) {
          const vp = posOff + vi * 12;
          const x = dv.getFloat32(vp, true), y = dv.getFloat32(vp + 4, true), z = dv.getFloat32(vp + 8, true);
          positions.push(m[0] * x + m[4] * y + m[8] * z + m[12],
                         m[1] * x + m[5] * y + m[9] * z + m[13],
                         m[2] * x + m[6] * y + m[10] * z + m[14]);
          colors.push(col[0], col[1], col[2]);
        }
      }
    }
    p += 4; // group terminator (zero)
  }
  if (!positions.length) return null;
  return { positions: new Float32Array(positions), colors: new Float32Array(colors), triCount: positions.length / 9 };
}

// ── texture decode (0x20) ───────────────────────────────────────────────────
function dxt565(value) {
  return [((value >> 11) & 0x1F) * 255 / 31 | 0, ((value >> 5) & 0x3F) * 255 / 63 | 0, (value & 0x1F) * 255 / 31 | 0];
}

function decodeDxt1(r, width, height) {
  const out = new Uint8Array(width * height * 4);
  for (let y1 = 0; y1 < height; y1 += 4) for (let x1 = 0; x1 < width; x1 += 4) {
    const c0 = r.u16(), c1 = r.u16();
    const R = [0, 0, 0, 0], G = [0, 0, 0, 0], B = [0, 0, 0, 0], A = [255, 255, 255, 255];
    [R[0], G[0], B[0]] = dxt565(c0); [R[1], G[1], B[1]] = dxt565(c1);
    if (c0 > c1) for (const ch of [R, G, B]) { ch[2] = (2 * ch[0] + ch[1]) / 3 | 0; ch[3] = (ch[0] + 2 * ch[1]) / 3 | 0; }
    else { for (const ch of [R, G, B]) { ch[2] = (ch[0] + ch[1]) / 2 | 0; ch[3] = 0; } A[3] = 0; }
    const idxWord = r.dv.getUint32(r.pos, false); r.pos += 4; // big-endian
    let count = 15;
    for (let y = y1; y < y1 + 4; y++) for (let x = x1 + 3; x >= x1; x--) {
      const idx = (idxWord >>> (2 * count)) & 0x3; count--;
      const d = 4 * y * width + 4 * x;
      out[d] = R[idx]; out[d + 1] = G[idx]; out[d + 2] = B[idx]; out[d + 3] = A[idx];
    }
  }
  return out;
}

function decodeDxt3(r, width, height) {
  const out = new Uint8Array(width * height * 4);
  for (let y1 = 0; y1 < height; y1 += 4) for (let x1 = 0; x1 < width; x1 += 4) {
    const aHi = r.u32(), aLo = r.u32(); // alpha = (aHi<<32)|aLo; counts 0-7 in aLo, 8-15 in aHi
    const c0 = r.u16(), c1 = r.u16();
    const R = [0, 0, 0, 0], G = [0, 0, 0, 0], B = [0, 0, 0, 0];
    [R[0], G[0], B[0]] = dxt565(c0); [R[1], G[1], B[1]] = dxt565(c1);
    for (const ch of [R, G, B]) { ch[2] = (2 * ch[0] + ch[1]) / 3 | 0; ch[3] = (ch[0] + 2 * ch[1]) / 3 | 0; }
    const idxWord = r.dv.getUint32(r.pos, false); r.pos += 4;
    let count = 15;
    for (let y = y1; y < y1 + 4; y++) for (let x = x1 + 3; x >= x1; x--) {
      const idx = (idxWord >>> (2 * count)) & 0x3;
      const word = count < 8 ? aLo : aHi;
      const nib = (word >>> (4 * (count % 8))) & 0xF;
      count--;
      const d = 4 * y * width + 4 * x;
      out[d] = R[idx]; out[d + 1] = G[idx]; out[d + 2] = B[idx]; out[d + 3] = (nib * 255 / 15) | 0;
    }
  }
  return out;
}

function decodePalette(r, width, height, paletted, paletteBits = 32) {
  const colors = [];
  // Prototype zones may store the palette as 16-bit A1R5G5B5 (512 bytes) rather
  // than 32-bit BGRA (1024). Reading the narrow form as u32 scrambles the colours
  // and shifts every pixel by 512 bytes -- the bright-green speckle on rom/0/33's
  // gratest_sizenn / gratest_s00_jew. Retail is always 32-bit.
  if (paletted && paletteBits === 0x10) {
    for (let i = 0; i < 256; i++) {
      const v = r.u16();
      const a = (v >>> 15) & 1 ? 0xFF : 0x00;
      const cr = (((v >>> 10) & 0x1F) * 255 / 31) | 0;
      const cg = (((v >>> 5) & 0x1F) * 255 / 31) | 0;
      const cb = ((v & 0x1F) * 255 / 31) | 0;
      colors.push(((a << 24) | (cr << 16) | (cg << 8) | cb) >>> 0);
    }
  } else if (paletted) {
    for (let i = 0; i < 256; i++) colors.push(r.u32());
  }
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = paletted ? colors[r.u8()] : r.u32();
    const i = width * (height - (y + 1)) + x; // source rows are bottom-up
    out[i * 4] = (color >>> 16) & 0xFF; out[i * 4 + 1] = (color >>> 8) & 0xFF;
    out[i * 4 + 2] = color & 0xFF; out[i * 4 + 3] = (color >>> 24) & 0xFF;
  }
  return out;
}

function parseTexture(bytes, dv, section) {
  const r = new Reader(dv, section.dataStart);
  const texType = r.u8();
  // Paletted: 0x01 / 0x05 (common in field zones), 0x81 (proto/beta), 0x91, 0xB1.
  // DXT: 0xA1. 0x01/0x05/0x81 share the 0x91 header+payload layout.
  if (![0x01, 0x05, 0x81, 0x91, 0xA1, 0xB1].includes(texType)) return null;
  const name = r.str(0x10);
  r.u32();
  const width = r.u32(), height = r.u32();
  r.u16(); const bitCount = r.u16();
  for (let i = 0; i < 5; i++) r.u32();
  const paletteBits = r.u32();          // bits per palette entry: 0x10 / 0x20
  let rgba;
  if (texType === 0xA1) {
    const dxtType = r.str(0x4); r.u32(); r.u32();
    if (dxtType === '1TXD') rgba = decodeDxt1(r, width, height);
    else if (dxtType === '3TXD') rgba = decodeDxt3(r, width, height);
    else return null;
  } else if (texType === 0xB1) {
    r.u32(); rgba = decodePalette(r, width, height, bitCount !== 32, paletteBits);
  } else {
    rgba = decodePalette(r, width, height, bitCount !== 32, paletteBits);
  }
  return { name: name.trim(), width, height, rgba };
}

/**
 * Every 0x20 texture in a DAT, keyed by name, in the shape the renderer uploads
 * (matching zoneToModel's texture map). Used for the shared effects DAT
 * (ROM/0/0.DAT), whose textures back particle meshes that zones link to but
 * don't carry themselves.
 */
export function parseDatTextures(datBuffer) {
  const bytes = new Uint8Array(datBuffer instanceof ArrayBuffer ? datBuffer : datBuffer.buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map();
  for (const s of parseSections(dv)) {
    if (s.typeCode !== 0x20) continue;
    const img = parseTexture(bytes, dv, s);
    if (!img) continue;
    const entry = {
      name: img.name, width: img.width, height: img.height,
      format: 'rgba32', data: img.rgba,
    };
    // Key by embedded name and by section fourcc (structure tree shows the id).
    if (img.name && !out.has(img.name)) out.set(img.name, entry);
    if (s.id && !out.has(s.id)) out.set(s.id, entry);
    // Also the 8+8 category/name halves ("twr2bai tower_25" → "tower_25").
    const half = img.name.length > 8 ? img.name.slice(8).trim() : '';
    if (half && !out.has(half)) out.set(half, entry);
  }
  return out;
}

// ── name resolution helpers (LOD suffix + fuzzy texture match) ───────────────
const norm = (s) => s.replace(/ /g, '').replace(/_/g, '').toLowerCase();

export function resolveMeshName(meshId, meshes) {
  if (!meshId) return null;
  if (meshes.has(meshId)) return meshId;
  const base = ['_l', '_m', '_h'].includes(meshId.slice(-2)) ? meshId.slice(0, -2) : meshId;
  for (const suffix of ['_h', '_m', '_l']) if (meshes.has(base + suffix)) return base + suffix;
  // Prototype zones: mesh DAT name is often "category meshid" (e.g. "twr2bai
  // ue_wallh") while placements store just "ue_wallh".
  const want = norm(meshId);
  if (want.length >= 2) {
    for (const key of meshes.keys()) {
      const k = norm(key);
      if (k === want) return key;
      if (k.endsWith(want) || k.split(/\s+/).includes(want) || want.endsWith(k)) return key;
    }
  }
  return null;
}

export function resolveTexture(name, textures) {
  if (!name) return null;
  if (textures.has(name)) return name;            // exact
  const n = norm(name);
  for (const key of textures.keys()) if (norm(key) === n) return key;   // exact, normalized
  for (const key of textures.keys()) { const k = norm(key); if (n.includes(k) || k.includes(n)) return key; } // loose fallback
  return null;
}

// Match xi export + leveleditor (incl. fog/haze/mist celestial shells).
const SKY_PREFIXES = ['sun', 'moon', 'star', 'clod', 'cld', 'cloud', 'kamo', 'suny', 'sora', 'dust', 'fogd', 'fog', 'haze', 'mist'];
export const isSkyName = (name) => {
  const n = (name || '').toLowerCase();
  return SKY_PREFIXES.some((p) => n.startsWith(p));
};

// Weather directory ids under `weat/` (same set as environment.js). Cloud meshes
// are authored once per weather folder (often same mesh name, different texture).
const WEATHER_DIR_IDS = new Set([
  'fine', 'suny', 'clod', 'mist', 'dryw', 'heat', 'rain', 'squl',
  'dust', 'sand', 'wind', 'stom', 'snow', 'bliz', 'thdr', 'bolt',
  'aura', 'ligt', 'fogd', 'dark',
]);

// Sea / water surface shells (unplaced env meshes + 0x05 surface generators).
// Qufim uses umw*/uma*/umb* ocean planes; Ronfaure rivers are ka#/kb#/ksa*/kt* (kaw = river).
const WATER_EXACT = new Set(['lowsea', '2lowsea', 'lowcol', 'suimen', 'tamadai']);
export const isWaterName = (name) => {
  const n = (name || '').toLowerCase();
  if (WATER_EXACT.has(n)) return true;
  if (n.startsWith('sea') || n.startsWith('water') || n.startsWith('ocean')
    || n.includes('suimen') || n.endsWith('sea')) return true;
  if (n.startsWith('umw') || n.startsWith('uma') || n.startsWith('umb')
    || n.startsWith('umn') || n.startsWith('ucks')) return true;
  if (/^ka\d/.test(n) || /^kb\d/.test(n) || n.startsWith('ksa') || n.startsWith('kt0')) return true;
  return false;
};

/** Sky or water env mesh (shown with Toggle Skybox). */
export const isEnvName = (name) => isSkyName(name) || isWaterName(name);

// ── top-level: parse a zone DAT into {meshes, placements, textures} ──────────
export function parseZone(datBuffer, keyTables) {
  const bytes = new Uint8Array(datBuffer);
  const dv = new DataView(bytes.buffer);
  const sections = parseSections(dv);
  const { table1, table2 } = keyTables;

  const meshes = new Map();       // name -> [prim] (first wins; world + fallback)
  const meshIdToName = new Map();  // 0x2E section DatId -> mesh name (for effect-generator links)
  // Both maps above are lossy on purpose (placements only ever want one mesh per
  // name), but effect generators need the exact section their own directory
  // declares: Qufim carries three `clod` sections — weat/thdr, weat/clod and
  // weat/mist — sharing the mesh name `clod_a01` but with different textures.
  // Collapsing them makes every weather draw one zone's clouds, which is why
  // switching weather appeared to change nothing. Keep them all, with the
  // directory path, and let the particle system resolve by scope.
  const meshSections = [];        // { path, id, name, prims }
  // Per-weather sky shells under weat/<id>/ — same mesh name can appear in many
  // weather folders with different textures (clod_a01 × clod/mist/thdr/…).
  // First-wins on `meshes` would keep only one and hide clouds for other weathers.
  const weatherSky = []; // { name, weather, prims }
  const seenCelestial = new Set();
  const stack = [];
  for (const s of sections) {
    if (s.typeCode === 0x01) { stack.push(s.id); continue; }
    if (s.typeCode === 0x00) { stack.pop(); continue; }
    if (s.typeCode !== 0x2E) continue;
    decryptZoneMesh(bytes, dv, s.dataStart, table1, table2);
    const { meshName, prims } = parseZoneMeshSection(bytes, dv, s);
    if (meshName) meshIdToName.set(s.id, meshName);
    if (!prims.length || !meshName) continue;
    meshSections.push({ path: stack.join('/'), id: s.id, name: meshName, prims });

    const dirWeather = stack.includes('weat')
      ? [...stack].reverse().find((id) => WEATHER_DIR_IDS.has(id)) || null
      : null;

    if (dirWeather && isSkyName(meshName)) {
      const n = meshName.toLowerCase();
      // suny_* = sunshine clouds (not celestial). sun/sunsphere/moon/star = bodies.
      const celestial = !n.startsWith('suny')
        && (n.includes('sphere') || n.startsWith('sun') || n.startsWith('moon') || n.startsWith('star'));
      if (celestial) {
        // Star/moon/sun are duplicated under every weather folder — keep one.
        if (!seenCelestial.has(meshName)) {
          seenCelestial.add(meshName);
          weatherSky.push({ name: meshName, weather: null, prims });
        }
      } else {
        weatherSky.push({ name: meshName, weather: dirWeather, prims });
      }
    }

    if (!meshes.has(meshName)) meshes.set(meshName, prims);
    // Aliases for prototype placements that store a short id / section fourcc.
    if (s.id && !meshes.has(s.id)) meshes.set(s.id, prims);
    const parts = meshName.split(/\s+/).filter(Boolean);
    if (parts.length > 1) {
      const tail = parts[parts.length - 1];
      if (tail && !meshes.has(tail)) meshes.set(tail, prims);
    }
  }

  let placements = [];
  let collision = null;
  for (const s of sections) if (s.typeCode === 0x1C) {
    placements = parseZoneDef(bytes, dv, s, table1); // decrypts the 0x1C in place
    // Filter placements hidden by xi's delete mechanism (moved to y ≈ -100000).
    // Without this, hidden "deleted" duplicates load as real placements, occupy a
    // Three.js .NNN suffix, and confuse the adopt-or-reinstantiate logic on restore.
    placements = placements.filter(p => p.pos[1] > -90000);
    collision = decodeCollision(bytes, dv, s);        // then read the collision soup
    break;
  }

  const textures = new Map(); // name -> {width,height,rgba}
  for (const s of sections) {
    if (s.typeCode !== 0x20) continue;
    const img = parseTexture(bytes, dv, s);
    if (img && !textures.has(img.name)) textures.set(img.name, img);
  }

  // 0x05 effect generators are no longer flattened here — they're parsed into a
  // real directory tree and run by the particle system (ui/js/particle/), which
  // needs the full opcode chain rather than a static snapshot of one.

  // 0x36 trigger volumes → distinct sub-area links (shops/building interiors).
  const interactions = [];
  for (const s of sections) {
    if (s.typeCode !== 0x36) continue;
    try { for (const it of parseZoneInteractions(bytes, dv, s)) interactions.push(it); }
    catch (_e) { /* hostile input — skip this section */ }
  }
  const subAreas = [];
  const seenSub = new Set();
  for (const it of interactions) {
    if (it.kind === 'm' && it.param && !seenSub.has(it.param)) {
      seenSub.add(it.param);
      subAreas.push({ id: it.param, pos: it.pos, size: it.size });
    }
  }

  return {
    meshes, placements, textures, meshIdToName, meshSections,
    collision, interactions, subAreas, weatherSky,
  };
}
