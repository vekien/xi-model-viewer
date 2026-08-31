// Detour NAVMESHSET (.nav) parser — port of xi zone xi_navmesh.navmesh_triangles.
// Returns walkable polygon triangles as flat Float32Array in FFXI world space.

import { backend } from './backend.js';

const NAVMESHSET_MAGIC = 0x4d534554; // 'MSET' as little-endian u32... actually on disk TESM
// File stores 'MSET' little-endian → bytes T E S M → magic read as u32 LE = 0x4D534554? 
// Python: b"TESM"  # 'MSET' little-endian on disk
// struct unpack <i of TESM bytes = 0x4D534554 if MSET... 
// b"TESM" = 0x54,0x45,0x53,0x4D → LE int = 0x4D534554 = 'MSET' yes

const DT_TILE_MAGIC = 0x444e4156; // check via bytes
// Python: b"VAND"  # 'DNAV' little-endian
// We'll compare bytes

const DT_HEADER_SIZE = 100;
const DT_POLY_SIZE = 32;
const DT_MAX_VERTS = 6;

/**
 * Server navmesh filenames are zone_settings.name with spaces → underscores
 * and apostrophes stripped (Lower_Jeuno.nav, AlTaieu.nav, Balgas_Dais.nav).
 */
export function navmeshFileName(zoneName) {
  return String(zoneName || '')
    .replace(/[''`´]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '') + '.nav';
}

/**
 * Parse a Detour NAVMESHSET ArrayBuffer → flat FFXI-world positions [x,y,z,…],
 * or null if invalid/empty.
 */
export function parseNavmeshTriangles(buffer) {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 40) return null;
  // magic 'MSET' stored LE as bytes T,E,S,M
  if (bytes[0] !== 0x54 || bytes[1] !== 0x45 || bytes[2] !== 0x53 || bytes[3] !== 0x4d) {
    return null;
  }

  const numTiles = dv.getInt32(8, true);
  let off = 40;
  const positions = [];

  for (let t = 0; t < numTiles; t++) {
    if (off + 8 > bytes.length) break;
    // tileRef u32, dataSize i32
    const dataSize = dv.getInt32(off + 4, true);
    off += 8;
    const ts = off;
    if (dataSize <= 0 || ts + dataSize > bytes.length) break;
    // DNAV magic
    if (bytes[ts] !== 0x56 || bytes[ts + 1] !== 0x41 || bytes[ts + 2] !== 0x4e || bytes[ts + 3] !== 0x44) {
      off += dataSize;
      continue;
    }

    const polyCount = dv.getInt32(ts + 24, true);
    const vertCount = dv.getInt32(ts + 28, true);
    const offMeshBase = dv.getInt32(ts + 56, true);

    const vertOff = ts + DT_HEADER_SIZE;
    const verts = new Array(vertCount);
    for (let i = 0; i < vertCount; i++) {
      const p = vertOff + i * 12;
      const dx = dv.getFloat32(p, true);
      const dy = dv.getFloat32(p + 4, true);
      const dz = dv.getFloat32(p + 8, true);
      // Detour (x,-y,-z) → FFXI world (x,y,z)
      verts[i] = [dx, -dy, -dz];
    }

    const polyOff = vertOff + vertCount * 12;
    const walkableN = offMeshBase > 0 ? Math.min(polyCount, offMeshBase) : polyCount;
    for (let pi = 0; pi < walkableN; pi++) {
      const p = polyOff + pi * DT_POLY_SIZE;
      const nv = bytes[p + 30];
      if (nv < 3) continue;
      const vi = new Array(DT_MAX_VERTS);
      for (let k = 0; k < DT_MAX_VERTS; k++) vi[k] = dv.getUint16(p + 4 + k * 2, true);
      // Fan-triangulate convex poly
      for (let i = 1; i < nv - 1; i++) {
        for (const k of [0, i, i + 1]) {
          const v = verts[vi[k]];
          if (!v) continue;
          positions.push(v[0], v[1], v[2]);
        }
      }
    }

    off += dataSize;
  }

  if (!positions.length) return null;
  return {
    positions: new Float32Array(positions),
    triCount: positions.length / 9,
  };
}

/** Display-space positions from a parsed world-space navmesh buffer. */
function toDisplay(parsed, file) {
  if (!parsed) return null;
  // Display space same as zones: (−x, −y, z)
  const src = parsed.positions;
  const positions = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    positions[i] = -src[i];
    positions[i + 1] = -src[i + 1];
    positions[i + 2] = src[i + 2];
  }
  return { positions, triCount: parsed.triCount, file };
}

/**
 * Load navmesh for a zone name.
 * Prefers Settings → Navmesh Folder (`folder`), then bundled `public/navmesh/`.
 * Returns { positions (display-space), triCount, file } or null.
 */
export async function loadZoneNavmesh(zoneName, opts = {}) {
  const file = navmeshFileName(zoneName);
  if (!file || file === '.nav') return null;

  const folder = String(opts.folder || '').trim().replace(/[\\/]+$/, '');
  if (folder) {
    try {
      const buf = await backend.readFile(`${folder}\\${file}`);
      const out = toDisplay(parseNavmeshTriangles(buf), file);
      if (out) return out;
    } catch { /* try bundled next */ }
  }

  try {
    const res = await fetch(`navmesh/${encodeURIComponent(file)}`);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return toDisplay(parseNavmeshTriangles(buf), file);
  } catch {
    return null;
  }
}

/** True if a .nav exists for this zone (folder first, then bundled). */
export async function navmeshAvailable(zoneName, opts = {}) {
  const file = navmeshFileName(zoneName);
  if (!file || file === '.nav') return false;

  const folder = String(opts.folder || '').trim().replace(/[\\/]+$/, '');
  if (folder) {
    try {
      if (await backend.fileExists(`${folder}\\${file}`)) return true;
    } catch { /* fall through */ }
  }

  try {
    const res = await fetch(`navmesh/${encodeURIComponent(file)}`, { method: 'HEAD' });
    if (res.ok) return true;
    const res2 = await fetch(`navmesh/${encodeURIComponent(file)}`);
    return res2.ok;
  } catch {
    return false;
  }
}
