// Viewport picking for zone Objects.
// 1) Ray vs placement AABBs (display space) to get candidates
// 2) Ray vs mesh triangles (transformed) so bottles on a table beat the table

function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Column-major TRS = T · Rz·Ry·Rx · S (same as zoneModel). */
function trsMatrix(pos, rot, scale) {
  const [px, py, pz] = pos;
  const [rx, ry, rz] = rot || [0, 0, 0];
  const [sx, sy, sz] = scale || [1, 1, 1];
  const sinx = Math.sin(rx), siny = Math.sin(ry), sinz = Math.sin(rz);
  const cosx = Math.cos(rx), cosy = Math.cos(ry), cosz = Math.cos(rz);
  const c0 = [cosy * cosz, cosy * sinz, -siny];
  const c1 = [sinx * siny * cosz - cosx * sinz, sinx * siny * sinz + cosx * cosz, sinx * cosy];
  const c2 = [cosx * siny * cosz + sinx * sinz, cosx * siny * sinz - sinx * cosz, cosx * cosy];
  return [
    c0[0] * sx, c0[1] * sx, c0[2] * sx, 0,
    c1[0] * sy, c1[1] * sy, c1[2] * sy, 0,
    c2[0] * sz, c2[1] * sz, c2[2] * sz, 0,
    px, py, pz, 1,
  ];
}

function mulPointDisplay(m, x, y, z) {
  const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
  return [-wx, -wy, wz];
}

/**
 * Client pixel → NDC matching the renderer's projection (incl. Explorer offset).
 */
export function clientToNdc(renderer, clientX, clientY) {
  const canvas = renderer?.canvas;
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const dx = renderer.screenOffsetX ? (2 * renderer.screenOffsetX) / rect.width : 0;
  const ndcX = (((clientX - rect.left) / rect.width) * 2 - 1) - dx;
  const ndcY = -((((clientY - rect.top) / rect.height) * 2) - 1);
  return { ndcX, ndcY, aspect: rect.width / rect.height };
}

export function cameraScreenRay(camera, ndcX, ndcY, aspect) {
  if (!camera) return null;
  const m = camera.viewMatrix();
  const right = [m[0], m[4], m[8]];
  const upv = [m[1], m[5], m[9]];
  const fwd = [-m[2], -m[6], -m[10]];
  const th = Math.tan(((camera.fovDegrees ?? 45) * Math.PI) / 360);
  const dir = norm([
    fwd[0] + right[0] * ndcX * th * aspect + upv[0] * ndcY * th,
    fwd[1] + right[1] * ndcX * th * aspect + upv[1] * ndcY * th,
    fwd[2] + right[2] * ndcX * th * aspect + upv[2] * ndcY * th,
  ]);
  const e = camera.eye;
  return { origin: [e[0], e[1], e[2]], dir };
}

export function rayAabb(origin, dir, min, max) {
  let tmin = -Infinity;
  let tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    const o = origin[i];
    const d = dir[i];
    const lo = min[i];
    const hi = max[i];
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  return tmin >= 0 ? tmin : 0;
}

function pointInAabb(p, min, max, eps = 1e-3) {
  return p[0] >= min[0] - eps && p[0] <= max[0] + eps
    && p[1] >= min[1] - eps && p[1] <= max[1] + eps
    && p[2] >= min[2] - eps && p[2] <= max[2] + eps;
}

function boundsMetrics(min, max) {
  const sx = max[0] - min[0];
  const sy = max[1] - min[1];
  const sz = max[2] - min[2];
  if (![sx, sy, sz].every((s) => Number.isFinite(s) && s >= 0)) {
    return { vol: Infinity, maxExtent: Infinity };
  }
  return {
    maxExtent: Math.max(sx, sy, sz),
    vol: Math.max(sx, 1e-4) * Math.max(sy, 1e-4) * Math.max(sz, 1e-4),
  };
}

/** Möller–Trumbore. Returns t or null. */
function rayTriangle(orig, dir, v0, v1, v2) {
  const eps = 1e-7;
  const e1x = v1[0] - v0[0], e1y = v1[1] - v0[1], e1z = v1[2] - v0[2];
  const e2x = v2[0] - v0[0], e2y = v2[1] - v0[1], e2z = v2[2] - v0[2];
  const px = dir[1] * e2z - dir[2] * e2y;
  const py = dir[2] * e2x - dir[0] * e2z;
  const pz = dir[0] * e2y - dir[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -eps && det < eps) return null;
  const inv = 1 / det;
  const tx = orig[0] - v0[0], ty = orig[1] - v0[1], tz = orig[2] - v0[2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return null;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t >= eps ? t : null;
}

/**
 * Closest triangle hit for a placement in display space.
 * prims.positions are de-indexed triangle lists in local FFXI space.
 */
function rayPlacementMesh(origin, dir, placement, meshes) {
  const meshName = placement.mesh || placement.meshId;
  const prims = meshes?.get?.(meshName);
  if (!prims?.length) return null;
  const matrix = trsMatrix(
    placement.rawPos || placement.pos || [0, 0, 0],
    placement.rot,
    placement.scale,
  );
  let bestT = Infinity;
  let triCount = 0;
  const TRI_CAP = 8000; // safety for huge props
  for (const prim of prims) {
    const pos = prim.positions;
    if (!pos?.length) continue;
    const n = (pos.length / 9) | 0;
    for (let t = 0; t < n; t++) {
      if (++triCount > TRI_CAP) return bestT < Infinity ? bestT : null;
      const o = t * 9;
      const v0 = mulPointDisplay(matrix, pos[o], pos[o + 1], pos[o + 2]);
      const v1 = mulPointDisplay(matrix, pos[o + 3], pos[o + 4], pos[o + 5]);
      const v2 = mulPointDisplay(matrix, pos[o + 6], pos[o + 7], pos[o + 8]);
      const hit = rayTriangle(origin, dir, v0, v1, v2);
      if (hit != null && hit < bestT) bestT = hit;
    }
  }
  return bestT < Infinity ? bestT : null;
}

/**
 * Pick the placement under the cursor.
 * AABB shortlist → triangle refine so table-top props beat the table hull.
 */
export function pickZonePlacement(placements, origin, dir, meshes = null) {
  if (!placements?.length || !origin || !dir) return null;
  const hits = [];

  for (const p of placements) {
    // Pick whatever is actually on screen. Sub-area sets draw like world
    // geometry (Ru'Aun's islands are mostly sub-area), unplaced and collision
    // rows draw once their Objects-list eye is on, and all three were
    // unselectable while this skipped every kind. Sky and water stay out: the
    // sky rows are particle-system geometry with no zone batch at all, and the
    // ocean shells are zone-wide planes that would swallow every click.
    if (p.kind === 'sky' || p.kind === 'water') continue;
    if (p.userHidden || p.dragHidden || p.pvsHidden) continue;
    const b = p.bounds;
    if (!b?.min || !b?.max) continue;
    const m = boundsMetrics(b.min, b.max);
    if (!(m.maxExtent < 5e4)) continue;

    const pad = Math.min(0.35, Math.max(0.08, m.maxExtent * 0.03));
    const min = [b.min[0] - pad, b.min[1] - pad, b.min[2] - pad];
    const max = [b.max[0] + pad, b.max[1] + pad, b.max[2] + pad];
    const tAabb = rayAabb(origin, dir, min, max);
    if (tAabb == null || tAabb < 0) continue;

    hits.push({
      p,
      tAabb,
      vol: m.vol,
      maxExtent: m.maxExtent,
      containing: pointInAabb(origin, b.min, b.max),
    });
  }
  if (!hits.length) return null;

  // Ignore giant hulls that wrap the camera when anything else is hit.
  const outer = hits.filter((h) => !h.containing);
  let pool = outer.length ? outer : hits;

  // Prefer prop-scale AABBs when present.
  const minVol = Math.min(...pool.map((h) => h.vol));
  const focused = pool.filter((h) => h.vol <= Math.max(minVol * 20, minVol + 1));
  if (focused.length) pool = focused;

  // Triangle-test the smallest candidates first (bottles before tables before rooms).
  pool.sort((a, b) => (a.vol - b.vol) || (a.tAabb - b.tAabb));
  const MESH_CANDIDATES = 48;
  let bestMesh = null;
  let bestMeshT = Infinity;
  if (meshes) {
    const n = Math.min(pool.length, MESH_CANDIDATES);
    for (let i = 0; i < n; i++) {
      const h = pool[i];
      // Skip enormous shells for mesh walk — AABB fallback covers terrain.
      if (h.maxExtent > 120) continue;
      const t = rayPlacementMesh(origin, dir, h.p, meshes);
      if (t != null && t < bestMeshT) {
        bestMeshT = t;
        bestMesh = h.p;
      }
    }
  }
  if (bestMesh) return bestMesh;

  // No mesh hit (missing prims / too heavy): smallest AABB that isn't a wrap hull.
  pool.sort((a, b) => (a.vol - b.vol) || (a.tAabb - b.tAabb));
  return pool[0].p;
}

export function pickZoneAt(renderer, model, clientX, clientY) {
  if (!renderer || model?.kind !== 'zone') return null;
  const list = model.zonePlacements;
  if (!list?.length) return null;
  const ndc = clientToNdc(renderer, clientX, clientY);
  if (!ndc) return null;
  const ray = cameraScreenRay(renderer.camera, ndc.ndcX, ndc.ndcY, ndc.aspect);
  if (!ray) return null;
  return pickZonePlacement(list, ray.origin, ray.dir, model.zoneMeshes ?? null);
}
