// Convert a parseZone() result into the ordered draw list the WebGL zone
// renderer consumes. Zones use the level-editor display frame (−x, −y, z) with
// a Y-up camera.
//
// Faithful to xim's ZoneDrawer/GLDrawer: geometry is emitted in DAT order
// (objectDrawOrder → per-object submesh order), opaque and blend interleaved,
// with each submesh's own render state (blend / cull / z-bias / discard). Only
// ADJACENT draws sharing identical state+texture are merged, so batching never
// reorders anything — FFXI relies on the authored order for overlay layering.

import { resolveMeshName, resolveTexture, isSkyName, isWaterName, isEnvName } from './zone.js';

/** Column-major TRS = T · Rz·Ry·Rx · S (xim / xi rotateZYX). */
function trsMatrix(pos, rot, scale) {
  const [px, py, pz] = pos;
  const [rx, ry, rz] = rot;
  const [sx, sy, sz] = scale;
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

const IDENTITY = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

function mulPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

function mulDir(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z,
  ];
}

// Display space — same net transform as the level editor zoneRoot:
//   180° about X then scale(−1,1,−1) ⇒ (−x, −y, z). Y-up camera (see camera.js).
function toDisplay(x, y, z) {
  return [-x, -y, z];
}

const clamp255 = (v) => Math.max(0, Math.min(255, (v * 255 + 0.5) | 0));

/**
 * Alpha-discard threshold for a submesh (xim ZoneMeshSection:119). Keyed purely
 * on the MESH name: `_`-prefixed models (foliage, grates, overlay structs) are
 * alpha-tested at 0.375 against `4 * vertexAlpha * texAlpha`; everything else
 * uses 0 (no discard). Independent of the 0x8000 blend flag — a `_` mesh that is
 * also blend-enabled gets both.
 */
function discardThresholdFor(meshName) {
  return (meshName || '').startsWith('_') ? 0.375 : 0;
}

/** Determinant of a column-major TRS matrix's 3×3 part (mirrored when < 0). */
function det3(m) {
  return m[0] * (m[5] * m[10] - m[6] * m[9])
    - m[4] * (m[1] * m[10] - m[2] * m[9])
    + m[8] * (m[1] * m[6] - m[2] * m[5]);
}

// Hidden/deleted placements are shoved to y ≈ −100000 (xi). Some DATs also
// carry garbage coords on one axis (e.g. Z ≈ −1e7) that blow out camera fit.
const COORD_LIMIT = 50000;
function isSanePlacement(p) {
  if (p.pos[1] <= -90000) return false;
  for (let i = 0; i < 3; i++) {
    const v = p.pos[i];
    if (!Number.isFinite(v) || Math.abs(v) > COORD_LIMIT) return false;
  }
  return true;
}

/** Local AABB of a mesh's prims (raw FFXI space). */
function meshLocalBounds(prims) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const prim of prims) {
    const n = prim.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const x = prim.positions[i * 3], y = prim.positions[i * 3 + 1], z = prim.positions[i * 3 + 2];
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }
  }
  if (!isFinite(minX)) return null;
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** Transform local AABB corners → display-space AABB. */
function transformBoundsDisplay(local, matrix) {
  const [xmin, ymin, zmin] = local.min;
  const [xmax, ymax, zmax] = local.max;
  const corners = [
    [xmin, ymin, zmin], [xmax, ymin, zmin], [xmin, ymax, zmin], [xmax, ymax, zmin],
    [xmin, ymin, zmax], [xmax, ymin, zmax], [xmin, ymax, zmax], [xmax, ymax, zmax],
  ];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [x, y, z] of corners) {
    const [wx, wy, wz] = mulPoint(matrix, x, y, z);
    const [dx, dy, dz] = toDisplay(wx, wy, wz);
    if (dx < minX) minX = dx; if (dy < minY) minY = dy; if (dz < minZ) minZ = dz;
    if (dx > maxX) maxX = dx; if (dy > maxY) maxY = dy; if (dz > maxZ) maxZ = dz;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/**
 * @param {{ meshes: Map, meshNames?: Set<string>, placements: any[], textures: Map, collision?: any }} parsed
 * @param {string} sourceName
 * @param {{ includeSky?: boolean }} [opts]  includeSky kept for compat; sky/water
 *   always baked into a separate `env` layer and toggled in the renderer.
 */
export function zoneToModel(parsed, sourceName = '', opts = {}) {
  const { meshes, meshNames, placements, textures: texMap, collision: rawCollision } = parsed;

  // Precompute local bounds per mesh (for placement focus + zone camera fit).
  const localBounds = new Map();
  for (const [name, prims] of meshes) {
    const b = meshLocalBounds(prims);
    if (b) localBounds.set(name, b);
  }

  // Ordered draw list. One entry per (object, submesh) in DAT order; adjacent
  // entries with identical state+texture are appended into the previous entry so
  // the merge can never reorder a draw (xim relies on the authored order).
  const draws = [];
  let triCount = 0;

  const emitPrim = (meshName, prim, matrix, layer = 'world') => {
    const texKey = resolveTexture(prim.textureName, texMap) || prim.textureName || '';
    const discard = discardThresholdFor(meshName);
    const wind = !!prim.hasBlendPos;
    // Mirrored placements (negative-determinant TRS) flip triangle winding once
    // the transform is baked in; pre-swap so the renderer keeps one fixed
    // front-face convention (xim instead flips frontFace per draw).
    const mirrored = det3(matrix) < 0;
    const blend = prim.blend;

    const last = draws[draws.length - 1];
    let d = last;
    if (!d || d.layer !== layer || d.texKey !== texKey || d.blend !== blend
      || d.noCull !== prim.noCull || d.discard !== discard || d.wind !== wind) {
      d = {
        layer, texKey, blend, noCull: prim.noCull, discard, wind,
        positions: [], blendOffsets: [], normals: [], uvs: [], colors: [],
      };
      draws.push(d);
    }

    const n = prim.positions.length / 3;
    const order = mirrored ? [0, 2, 1] : [0, 1, 2];
    for (let t = 0; t + 2 < n; t += 3) {
      for (const k of order) {
        const i = t + k;
        const i3 = i * 3, i2 = i * 2, i4 = i * 4;
        const [wx, wy, wz] = mulPoint(matrix, prim.positions[i3], prim.positions[i3 + 1], prim.positions[i3 + 2]);
        const [nx, ny, nz] = mulDir(matrix, prim.normals[i3], prim.normals[i3 + 1], prim.normals[i3 + 2]);
        const [dx, dy, dz] = toDisplay(wx, wy, wz);
        const [dnx, dny, dnz] = toDisplay(nx, ny, nz);
        d.positions.push(dx, dy, dz);
        d.normals.push(dnx, dny, dnz);
        d.uvs.push(prim.uvs[i2], prim.uvs[i2 + 1]);
        d.colors.push(
          clamp255(prim.colors[i4]),
          clamp255(prim.colors[i4 + 1]),
          clamp255(prim.colors[i4 + 2]),
          clamp255(prim.colors[i4 + 3]),
        );
        if (wind) {
          // Wind delta is a direction: rotate/scale only, then flip like a normal.
          const [bx, by, bz] = mulDir(matrix, prim.blendOffsets[i3], prim.blendOffsets[i3 + 1], prim.blendOffsets[i3 + 2]);
          const [dbx, dby, dbz] = toDisplay(bx, by, bz);
          d.blendOffsets.push(dbx, dby, dbz);
        } else {
          d.blendOffsets.push(0, 0, 0);
        }
      }
      triCount += 1;
    }
  };

  const emitMesh = (meshName, matrix, layer = 'world') => {
    const prims = meshes.get(meshName);
    if (!prims) return;
    for (const prim of prims) emitPrim(meshName, prim, matrix, layer, null);
  };

  const envKindOf = (name) => {
    if (isWaterName(name)) return 'water';
    if (isSkyName(name)) return 'sky';
    return null;
  };

  // Placement list for the objects panel (display-space centers + bounds).
  const zonePlacements = [];
  const nameCounts = new Map();
  let skippedWild = 0;
  let skippedMissing = 0;
  const placedMeshes = new Set();

  let bminX = Infinity, bminY = Infinity, bminZ = Infinity;
  let bmaxX = -Infinity, bmaxY = -Infinity, bmaxZ = -Infinity;
  const expand = (bb) => {
    if (bb.min[0] < bminX) bminX = bb.min[0];
    if (bb.min[1] < bminY) bminY = bb.min[1];
    if (bb.min[2] < bminZ) bminZ = bb.min[2];
    if (bb.max[0] > bmaxX) bmaxX = bb.max[0];
    if (bb.max[1] > bmaxY) bmaxY = bb.max[1];
    if (bb.max[2] > bmaxZ) bmaxZ = bb.max[2];
  };

  const pushPlacement = (p, resolved, matrix, kind = null) => {
    const c = (nameCounts.get(p.meshId) || 0) + 1;
    nameCounts.set(p.meshId, c);
    const name = c === 1 ? p.meshId : `${p.meshId}.${String(c).padStart(3, '0')}`;
    const [dx, dy, dz] = toDisplay(p.pos[0], p.pos[1], p.pos[2]);
    const local = localBounds.get(resolved);
    const bounds = local ? transformBoundsDisplay(local, matrix) : {
      min: [dx - 1, dy - 1, dz - 1],
      max: [dx + 1, dy + 1, dz + 1],
    };
    if (!kind) expand(bounds); // camera fit from world geometry only
    zonePlacements.push({
      name,
      meshId: p.meshId,
      mesh: resolved,
      index: p.index ?? -1,
      instance: c,
      pos: [dx, dy, dz],
      rawPos: [p.pos[0], p.pos[1], p.pos[2]],
      rot: p.rot || [0, 0, 0],
      scale: p.scale || [1, 1, 1],
      bounds,
      kind, // null | 'sky' | 'water' | 'unplaced'
    });
  };

  // World geometry: 0x1C placements. Anything with a real placement is world
  // geometry and draws in world space, sky-ish name or not — `kind` only
  // classifies it for the objects panel.
  /** @type {{ meshId: string, resolved: string, pos: number[], rot: number[], scale: number[], matrix: Float32Array }[]} */
  const placedWorld = [];
  for (const p of placements) {
    if (!isSanePlacement(p)) { skippedWild++; continue; }
    const resolved = resolveMeshName(p.meshId, meshes, meshNames);
    if (!resolved) { skippedMissing++; continue; }
    placedMeshes.add(resolved);
    // Aliases (section id / short tail) count as placed too.
    placedMeshes.add(p.meshId);
    const kind = envKindOf(resolved);
    const matrix = trsMatrix(p.pos, p.rot, p.scale);
    emitMesh(resolved, matrix, 'world');
    pushPlacement(p, resolved, matrix, kind);
    if (!kind) {
      placedWorld.push({
        meshId: p.meshId, resolved,
        pos: p.pos, rot: p.rot || [0, 0, 0], scale: p.scale || [1, 1, 1],
        matrix,
      });
    }
  }

  // 0x05 effect geometry — water surfaces, spray, godrays, thunder — is no
  // longer baked here. Those generators are run live by the particle system
  // (ui/js/particle/), which evaluates their keyframe curves, UV scroll,
  // draw-distance fades and emission over time. Baking them meant guessing at
  // static values for animated properties, which is what all the removed
  // heuristics (alpha-0 skips, whiteTexMask, untextured-chroma guards) were
  // compensating for.

  // Sky shells (clouds, sun, moon, stars) are NOT baked here either. In xim the
  // only thing drawn as "sky" is the procedural gradient dome built from the
  // 0x2F skybox slices; every cloud layer and celestial body is a 0x05 generator
  // run by the particle system, which is what places them relative to the camera
  // and the sun/moon and animates their drift.
  //
  // Emitting them here as well drew each layer twice — once wrapped on the
  // camera and once parked at the world origin — which read as hard-edged quads
  // slicing through the clouds and a badly over-bright sun.
  //
  // They still appear in the objects panel so they stay inspectable.
  for (const entry of parsed.weatherSky ?? []) {
    if (placedMeshes.has(entry.name)) continue;
    const b = meshLocalBounds(entry.prims);
    if (b && !localBounds.has(entry.name)) localBounds.set(entry.name, b);
    const local = localBounds.get(entry.name);
    zonePlacements.push({
      name: entry.weather ? `${entry.name} (${entry.weather})` : entry.name,
      meshId: entry.name,
      mesh: entry.name,
      index: -1,
      instance: 1,
      pos: [0, 0, 0],
      rawPos: [0, 0, 0],
      rot: [0, 0, 0],
      scale: [1, 1, 1],
      bounds: local ? transformBoundsDisplay(local, IDENTITY) : { min: [-1, -1, -1], max: [1, 1, 1] },
      kind: 'sky',
    });
  }

  // Unplaced 0x2E meshes (no 0x1C record).
  // Companion attach is intentionally NARROW — a loose "stem startsWith" rule
  // was instancing every roof_* onto every roof placement and hanging loads.
  //
  // Windmill kit on w_mill:
  //   mill     = full wheel → companion + live Y-spin (mil* gens use the same
  //              mesh at OTHER world positions via the particle system)
  //   mil_pol  = axle, static
  //   mil_wing = HALF wheel only (local X ≤ 0) — never attach (looks broken)
  // fu_in is particle-only (mi* gens). mil_wing is a half-mesh leftover — hide.
  // Other orphans → layer 'unplaced'.
  const isParticleOnlyMesh = (name) => {
    const n = String(name || '').toLowerCase();
    return n === 'fu_in' || n === 'fu_i' || n === 'mil_wing';
  };
  const isMillCompanion = (placedName, unplacedName) => {
    const p = String(placedName || '').toLowerCase();
    const u = String(unplacedName || '').toLowerCase();
    if (p !== 'w_mill') return false;
    return u === 'mill' || u === 'mil_pol';
  };
  const isMillSpinner = (name) => String(name || '').toLowerCase() === 'mill';

  let unplacedCompanions = 0;
  let unplacedOrphans = 0;
  /** @type {{ meshName: string, prims: object[], pos: number[], rot: number[], scale: number[], spinY: number }[]} */
  const zoneSpinners = [];
  // meshes Map stores aliases (section id / name tail) → same prims array.
  const seenPrims = new Set();
  for (const meshName of meshes.keys()) {
    const prims = meshes.get(meshName);
    if (!prims?.length || seenPrims.has(prims)) continue;
    seenPrims.add(prims);
    if (placedMeshes.has(meshName)) continue;
    // If any alias of this prims set was placed, skip.
    let already = false;
    for (const [k, v] of meshes) {
      if (v === prims && placedMeshes.has(k)) { already = true; break; }
    }
    if (already) continue;
    if (envKindOf(meshName)) continue;
    if (meshName.length < 3) continue;
    // Particle system draws these (pos + rotation) — no static/unplaced copy.
    if (isParticleOnlyMesh(meshName)) continue;
    // mill is both particle-driven (mil1..6) and a w_mill companion spinner.
    // Skip origin orphan; companions handled below when hosts exist.
    if (isMillSpinner(meshName)) {
      const hosts = placedWorld.filter(
        (h) => isMillCompanion(h.resolved, meshName) || isMillCompanion(h.meshId, meshName),
      );
      if (hosts.length) {
        for (const h of hosts) {
          // ~0.01745 rad/frame @ 30fps — same as mil* RotationVelocitySetup.
          zoneSpinners.push({
            meshName,
            prims,
            pos: h.pos,
            rot: h.rot,
            scale: h.scale,
            spinY: 0.0174533 * 30,
          });
          pushPlacement(
            { meshId: meshName, index: -1, pos: h.pos, rot: h.rot, scale: h.scale },
            meshName,
            h.matrix,
            null,
          );
          unplacedCompanions++;
        }
        placedMeshes.add(meshName);
      }
      continue;
    }

    const hosts = placedWorld.filter(
      (h) => isMillCompanion(h.resolved, meshName) || isMillCompanion(h.meshId, meshName),
    );
    if (hosts.length) {
      for (const h of hosts) {
        emitMesh(meshName, h.matrix, 'world');
        pushPlacement(
          { meshId: meshName, index: -1, pos: h.pos, rot: h.rot, scale: h.scale },
          meshName,
          h.matrix,
          null,
        );
        unplacedCompanions++;
      }
      placedMeshes.add(meshName);
      continue;
    }

    // Orphan at origin — layer 'unplaced' so the renderer can toggle visibility
    // (off by default; avoids grey sky-shells through the zone).
    if (!localBounds.has(meshName)) {
      const b = meshLocalBounds(prims);
      if (b) localBounds.set(meshName, b);
    }
    emitMesh(meshName, IDENTITY, 'unplaced');
    pushPlacement(
      { meshId: meshName, index: -1, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] },
      meshName,
      IDENTITY,
      'unplaced',
    );
    unplacedOrphans++;
  }

  // Freeze the ordered draw list into GPU-ready typed arrays. zBias mirrors xim:
  // blend submeshes get ZBiasLevel.High (5) → polygonOffset(-5, 1) at draw time.
  const zoneDraws = [];
  let vertexCount = 0;
  for (const d of draws) {
    const n = d.positions.length / 3;
    if (n < 3) continue;
    vertexCount += n;
    zoneDraws.push({
      layer: d.layer,
      textureName: d.texKey || null,
      blend: d.blend,
      noCull: d.noCull,
      discard: d.discard,
      wind: d.wind,
      zBias: d.blend ? 5 : 0,
      count: n,
      positions: new Float32Array(d.positions),
      blendOffsets: new Float32Array(d.blendOffsets),
      normals: new Float32Array(d.normals),
      uvs: new Float32Array(d.uvs),
      colors: new Uint8Array(d.colors),
    });
  }

  const outTextures = new Map();
  for (const [name, img] of texMap) {
    outTextures.set(name, {
      name,
      width: img.width,
      height: img.height,
      format: 'rgba32',
      data: img.rgba,
    });
  }

  // Group mesh types for the objects panel.
  // World groups first (by count), then env (sky/water) alphabetically.
  const byMesh = new Map();
  for (const p of zonePlacements) {
    const key = `${p.kind || 'world'}\0${p.mesh}`;
    let g = byMesh.get(key);
    if (!g) {
      g = { mesh: p.mesh, meshId: p.meshId, kind: p.kind || null, instances: [] };
      byMesh.set(key, g);
    }
    g.instances.push(p);
  }
  const objectGroups = [...byMesh.values()]
    .map((g) => ({ ...g, count: g.instances.length }))
    .sort((a, b) => {
      const ae = a.kind ? 1 : 0, be = b.kind ? 1 : 0;
      if (ae !== be) return ae - be;
      if (!a.kind && !b.kind) return b.count - a.count || a.mesh.localeCompare(b.mesh);
      return a.mesh.localeCompare(b.mesh);
    });

  const zoneBounds = isFinite(bminX) ? {
    min: [bminX, bminY, bminZ],
    max: [bmaxX, bmaxY, bmaxZ],
    footY: bminY,
  } : null;

  // Collision overlay: convert raw FFXI world coords → display (−x,−y,z).
  let collision = null;
  if (rawCollision?.positions?.length) {
    const src = rawCollision.positions;
    const positions = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      const [dx, dy, dz] = toDisplay(src[i], src[i + 1], src[i + 2]);
      positions[i] = dx; positions[i + 1] = dy; positions[i + 2] = dz;
    }
    collision = {
      positions,
      colors: rawCollision.colors,
      triCount: rawCollision.triCount || (positions.length / 9),
    };
  }

  const model = {
    sourceName,
    kind: 'zone',
    skeleton: {
      joints: [{ parent: -1, rot: [0, 0, 0, 1], trans: [0, 0, 0] }],
      references: [],
    },
    // Zones bypass the entity mesh-group/skinning path entirely: the renderer
    // draws zoneDraws in order with per-draw GL state (xim GLDrawer.drawXim).
    meshGroups: [],
    zoneDraws,
    // Live-spin companions (mill on w_mill). Renderer re-bakes each frame.
    zoneSpinners,
    textures: outTextures,
    animations: [],
    schedules: [],
    info: null,
    zoneBounds,
    zonePlacements,
    objectGroups,
    // Local mesh prims for Live Selection triangle picks (name → prim[]).
    zoneMeshes: meshes,
    collision,
    zoneStats: {
      meshCount: meshes.size,
      placementCount: zonePlacements.filter((p) => !p.kind || p.kind === 'unplaced').length,
      unplacedCompanions,
      unplacedOrphans,
      envCount: zonePlacements.filter((p) => p.kind).length,
      placementTotal: placements.length,
      skippedWild,
      skippedMissing,
      triCount: triCount | 0,
      vertexCount,
      drawCount: zoneDraws.length,
      textureCount: outTextures.size,
      objectTypes: objectGroups.length,
      collTris: collision?.triCount ?? 0,
    },
  };
  model.isRenderable = zoneDraws.length > 0 || zoneSpinners.length > 0;
  return model;
}

/**
 * Bake one spinner instance at angleY (radians, FFXI local Y) into zoneDraws-
 * shaped entries. Vane cards are two-sided (noCull forced).
 */
export function bakeSpinnerDraws(spinner, angleY = 0) {
  const prims = spinner?.prims;
  if (!prims?.length) return [];
  const [px, py, pz] = spinner.pos || [0, 0, 0];
  const [rx, ry0, rz] = spinner.rot || [0, 0, 0];
  const sc = spinner.scale || [1, 1, 1];
  const matrix = trsMatrix([px, py, pz], [rx, ry0 + angleY, rz], sc);
  const mirrored = det3(matrix) < 0;
  const order = mirrored ? [0, 2, 1] : [0, 1, 2];
  const out = [];
  for (const prim of prims) {
    const texName = prim.textureName || null;
    const positions = [];
    const normals = [];
    const uvs = [];
    const colors = [];
    const blendOffsets = [];
    const n = prim.positions.length / 3;
    for (let t = 0; t + 2 < n; t += 3) {
      for (const k of order) {
        const i = t + k;
        const i3 = i * 3, i2 = i * 2, i4 = i * 4;
        const [wx, wy, wz] = mulPoint(matrix, prim.positions[i3], prim.positions[i3 + 1], prim.positions[i3 + 2]);
        const [nx, ny, nz] = mulDir(matrix, prim.normals[i3], prim.normals[i3 + 1], prim.normals[i3 + 2]);
        const [dx, dy, dz] = toDisplay(wx, wy, wz);
        const [dnx, dny, dnz] = toDisplay(nx, ny, nz);
        positions.push(dx, dy, dz);
        normals.push(dnx, dny, dnz);
        uvs.push(prim.uvs[i2], prim.uvs[i2 + 1]);
        colors.push(
          clamp255(prim.colors[i4]),
          clamp255(prim.colors[i4 + 1]),
          clamp255(prim.colors[i4 + 2]),
          clamp255(prim.colors[i4 + 3]),
        );
        blendOffsets.push(0, 0, 0);
      }
    }
    if (positions.length < 9) continue;
    out.push({
      layer: 'world',
      textureName: texName,
      blend: !!prim.blend,
      noCull: true,
      discard: discardThresholdFor(spinner.meshName),
      wind: false,
      zBias: prim.blend ? 5 : 0,
      count: positions.length / 3,
      positions: new Float32Array(positions),
      blendOffsets: new Float32Array(blendOffsets),
      normals: new Float32Array(normals),
      uvs: new Float32Array(uvs),
      colors: new Uint8Array(colors),
    });
  }
  return out;
}

/** Strip leveleditor `game/` prefix → path relative to the install root. */
export function zoneDatRelPath(zonePath) {
  return String(zonePath || '')
    .replace(/^game[\\/]/i, '')
    .replace(/\//g, '\\');
}

/**
 * Re-bake zoneDraws from current zonePlacements + zoneMeshes.
 * Skips placements with `dragHidden` (move-proxy) or `userHidden` (Objects list eye).
 * Sky panel-only rows are not geometry (particle system). Unplaced re-emits as layer 'unplaced'.
 * Updates model.zoneDraws in place; caller must push batches to the renderer.
 */
export function rebuildZoneDraws(model) {
  if (!model?.zoneMeshes || !model.zonePlacements) return null;
  const meshes = model.zoneMeshes;
  // Reuse emit path via a minimal re-run of world placement loop.
  const draws = [];
  let triCount = 0;

  const emitPrim = (meshName, prim, matrix, layer = 'world') => {
    // Texture key is the DAT name string; GPU map is already populated from setModel.
    const texName = prim.textureName || '';
    const discard = discardThresholdFor(meshName);
    const wind = !!prim.hasBlendPos;
    const mirrored = det3(matrix) < 0;
    const blend = prim.blend;
    const last = draws[draws.length - 1];
    let d = last;
    if (!d || d.layer !== layer || d.texKey !== texName || d.blend !== blend
      || d.noCull !== prim.noCull || d.discard !== discard || d.wind !== wind) {
      d = {
        layer, texKey: texName, blend, noCull: prim.noCull, discard, wind,
        positions: [], blendOffsets: [], normals: [], uvs: [], colors: [],
      };
      draws.push(d);
    }
    const n = prim.positions.length / 3;
    const order = mirrored ? [0, 2, 1] : [0, 1, 2];
    for (let t = 0; t + 2 < n; t += 3) {
      for (const k of order) {
        const i = t + k;
        const i3 = i * 3, i2 = i * 2, i4 = i * 4;
        const [wx, wy, wz] = mulPoint(matrix, prim.positions[i3], prim.positions[i3 + 1], prim.positions[i3 + 2]);
        const [nx, ny, nz] = mulDir(matrix, prim.normals[i3], prim.normals[i3 + 1], prim.normals[i3 + 2]);
        const [dx, dy, dz] = toDisplay(wx, wy, wz);
        const [dnx, dny, dnz] = toDisplay(nx, ny, nz);
        d.positions.push(dx, dy, dz);
        d.normals.push(dnx, dny, dnz);
        d.uvs.push(prim.uvs[i2], prim.uvs[i2 + 1]);
        d.colors.push(
          clamp255(prim.colors[i4]),
          clamp255(prim.colors[i4 + 1]),
          clamp255(prim.colors[i4 + 2]),
          clamp255(prim.colors[i4 + 3]),
        );
        if (wind) {
          const [bx, by, bz] = mulDir(matrix, prim.blendOffsets[i3], prim.blendOffsets[i3 + 1], prim.blendOffsets[i3 + 2]);
          const [dbx, dby, dbz] = toDisplay(bx, by, bz);
          d.blendOffsets.push(dbx, dby, dbz);
        } else {
          d.blendOffsets.push(0, 0, 0);
        }
      }
      triCount += 1;
    }
  };

  for (const p of model.zonePlacements) {
    // Panel-only sky rows — particle system draws those, not zone batches.
    if (p.kind === 'sky') continue;
    if (p.dragHidden || p.userHidden) continue;
    if (!p.mesh) continue;
    const prims = meshes.get(p.mesh);
    if (!prims?.length) continue;
    const matrix = trsMatrix(p.rawPos || p.pos, p.rot, p.scale);
    const layer = p.kind === 'unplaced' ? 'unplaced' : 'world';
    for (const prim of prims) emitPrim(p.mesh, prim, matrix, layer);
  }

  const zoneDraws = [];
  let vertexCount = 0;
  for (const d of draws) {
    const n = d.positions.length / 3;
    if (n < 3) continue;
    vertexCount += n;
    zoneDraws.push({
      layer: d.layer,
      textureName: d.texKey || null,
      blend: d.blend,
      noCull: d.noCull,
      discard: d.discard,
      wind: d.wind,
      zBias: d.blend ? 5 : 0,
      count: n,
      positions: new Float32Array(d.positions),
      blendOffsets: new Float32Array(d.blendOffsets),
      normals: new Float32Array(d.normals),
      uvs: new Float32Array(d.uvs),
      colors: new Uint8Array(d.colors),
    });
  }
  model.zoneDraws = zoneDraws;
  if (model.zoneStats) {
    model.zoneStats.triCount = triCount;
    model.zoneStats.vertexCount = vertexCount;
    model.zoneStats.drawCount = zoneDraws.length;
  }
  return zoneDraws;
}

/** GPU-ready draws for a single placement (move-proxy while dragging). */
export function buildPlacementDraws(model, placement) {
  if (!model?.zoneMeshes || !placement?.mesh) return [];
  const prims = model.zoneMeshes.get(placement.mesh);
  if (!prims?.length) return [];
  const matrix = trsMatrix(placement.rawPos || placement.pos, placement.rot, placement.scale);
  // Temporary mini-model path via rebuild helper with one placement.
  const tmp = {
    zoneMeshes: model.zoneMeshes,
    zonePlacements: [{ ...placement, kind: null, dragHidden: false }],
    textures: model.textures,
    zoneStats: {},
  };
  rebuildZoneDraws(tmp);
  return tmp.zoneDraws ?? [];
}

/** Display pos (−x,−y,z) ↔ raw FFXI pos. */
export function displayToRaw(dx, dy, dz) {
  return [-dx, -dy, dz];
}

/** Move a placement in display space; updates pos, rawPos, and bounds. */
export function translatePlacementDisplay(placement, ddx, ddy, ddz) {
  if (!placement) return;
  const pos = placement.pos || [0, 0, 0];
  placement.pos = [pos[0] + ddx, pos[1] + ddy, pos[2] + ddz];
  placement.rawPos = displayToRaw(placement.pos[0], placement.pos[1], placement.pos[2]);
  if (placement.bounds?.min && placement.bounds?.max) {
    placement.bounds = {
      min: [
        placement.bounds.min[0] + ddx,
        placement.bounds.min[1] + ddy,
        placement.bounds.min[2] + ddz,
      ],
      max: [
        placement.bounds.max[0] + ddx,
        placement.bounds.max[1] + ddy,
        placement.bounds.max[2] + ddz,
      ],
    };
  }
}

/** Snapshot pose for undo / reset. */
export function clonePlacementPose(placement) {
  if (!placement) return null;
  return {
    name: placement.name,
    pos: placement.pos ? placement.pos.slice() : [0, 0, 0],
    rawPos: placement.rawPos ? placement.rawPos.slice() : [0, 0, 0],
    rot: placement.rot ? placement.rot.slice() : [0, 0, 0],
    scale: placement.scale ? placement.scale.slice() : [1, 1, 1],
    bounds: placement.bounds?.min && placement.bounds?.max
      ? {
        min: placement.bounds.min.slice(),
        max: placement.bounds.max.slice(),
      }
      : null,
  };
}

/** Restore a pose snapshot onto a live placement object. */
export function applyPlacementPose(placement, snap) {
  if (!placement || !snap) return;
  placement.pos = snap.pos.slice();
  placement.rawPos = snap.rawPos.slice();
  if (snap.rot) placement.rot = snap.rot.slice();
  if (snap.scale) placement.scale = snap.scale.slice();
  if (snap.bounds) {
    placement.bounds = {
      min: snap.bounds.min.slice(),
      max: snap.bounds.max.slice(),
    };
  }
}

export function posesEqual(a, b) {
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (Math.abs((a.pos?.[i] ?? 0) - (b.pos?.[i] ?? 0)) > 1e-5) return false;
  }
  return true;
}
