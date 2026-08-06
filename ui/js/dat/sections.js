// Section parsers for the resource types the particle system needs and the
// zone loader never read: 0x19 keyframe curves, 0x1F particle meshes, 0x21
// sprite sheets, 0x3D sound pointers, 0x4A paths.
//
// Ports of xim ParticleKeyFrameValueSection, ParticleMeshSection,
// SpriteSheetSection, SoundEffectPointerSection and PathSection.

import { ByteReader } from './reader.js';
import { SEC } from './tree.js';
import { Vec3 } from '../particle/math.js';

// ── 0x19 ParticleKeyFrameData ──────────────────────────────────────────────

/**
 * A keyframe curve: (time, value) pairs over normalised progress 0..1, read
 * until the terminating time == 1.0 entry.
 *
 * These drive nearly every animated property in a zone effect — alpha, colour,
 * scale, UV translation, emission frequency. 97 of them in Qufim alone; without
 * them a water surface has a constant colour and no wave motion.
 */
export class KeyFrameData {
  constructor(entries) { this.entries = entries; }

  /**
   * xim ParticleKeyFrameData.getCurrentValue — piecewise-linear lookup.
   * `initialValueOverride` replaces the first entry's value so a curve can start
   * from whatever the particle already had (xim uses it for the ProgressValue
   * updaters that read an initial value off the particle).
   */
  getCurrentValue(lifeProgress, initialValueOverride = null) {
    const d = this.entries;
    if (lifeProgress >= 1) return d[d.length - 1].value;

    const nextIndex = d.findIndex((e) => e.time > lifeProgress);
    if (nextIndex <= 0) return d[0].value;
    const prevIndex = nextIndex - 1;

    const next = d[nextIndex];
    const prev = d[prevIndex];
    const prevValue = (prevIndex === 0 && initialValueOverride != null)
      ? initialValueOverride : prev.value;

    const span = next.time - prev.time;
    const t = span === 0 ? 0 : (lifeProgress - prev.time) / span;
    return (1 - t) * prevValue + t * next.value;
  }
}

export function parseKeyFrame(bytes, dv, section) {
  const r = new ByteReader(bytes, dv);
  r.offsetFrom(section, 0x10);

  const end = section.start + section.size;
  const entries = [];
  while (r.position + 8 <= end) {
    const time = r.nextFloat();
    const value = r.nextFloat();
    entries.push({ time, value });
    if (time === 1) break;
  }
  if (!entries.length) throw new Error('empty keyframe curve');
  return new KeyFrameData(entries);
}

// ── 0x1F ParticleMesh ──────────────────────────────────────────────────────

/**
 * Particle geometry: a handful of small tri-meshes, each with its own texture.
 * `zoneResource` doubles the vertex colours (xim ParserContext colour scaling).
 */
export function parseParticleMesh(bytes, dv, section, entry, zoneResource = true) {
  const r = new ByteReader(bytes, dv);
  r.offsetFrom(section, 0x10);

  const version = r.next32();
  if (version !== 0x3 && version !== 0x5 && version !== 0x6) {
    throw new Error(`unknown ParticleDef version ${version}`);
  }

  const numWithTex = r.next8();
  const numWithoutTex = r.next8();
  const total = numWithTex + numWithoutTex;
  r.next16(); // total triangles (unused; per-mesh counts follow)

  // The triangle-count array is padded to one of a fixed set of lengths.
  const triArraySize = total <= 3 ? 3 : total <= 4 ? 4 : total <= 7 ? 7 : total <= 8 ? 8
    : total <= 11 ? 11 : total <= 12 ? 12 : total <= 15 ? 15 : -1;
  if (triArraySize < 0) throw new Error(`too many particle meshes: ${total}`);

  const triCounts = [];
  for (let i = 0; i < triArraySize; i++) triCounts.push(r.next16());
  if (version === 0x03) r.next16();

  const textureNames = [];
  const iterations = version === 0x03 ? 4 : numWithTex;
  for (let i = 0; i < iterations; i++) textureNames.push(r.nextString(0x10).replace(/\0/g, '').trim());

  const colorScale = zoneResource ? 2 : 1;
  const meshes = [];

  for (let k = 0; k < total; k++) {
    const numVerts = 3 * triCounts[k];
    const positions = new Float32Array(numVerts * 3);
    const normals = new Float32Array(numVerts * 3);
    const colors = new Uint8Array(numVerts * 4);
    const uvs = new Float32Array(numVerts * 2);

    for (let i = 0; i < numVerts; i++) {
      positions[i * 3] = r.nextFloat();
      positions[i * 3 + 1] = r.nextFloat();
      positions[i * 3 + 2] = r.nextFloat();
      normals[i * 3] = r.nextFloat();
      normals[i * 3 + 1] = r.nextFloat();
      normals[i * 3 + 2] = r.nextFloat();
      const c = r.nextBGRA();
      for (let j = 0; j < 4; j++) colors[i * 4 + j] = Math.min(0xff, c[j] * colorScale);
      uvs[i * 2] = r.nextFloat();
      uvs[i * 2 + 1] = r.nextFloat();
    }

    meshes.push({
      count: numVerts,
      positions,
      normals,
      colors,
      uvs,
      textureName: k < numWithTex ? textureNames[k] : null,
      localDir: entry?.dir ?? null,
    });
  }

  return { kind: 'particleMesh', id: entry?.id, meshes };
}

// ── 0x21 SpriteSheetMesh ───────────────────────────────────────────────────

export function parseSpriteSheet(bytes, dv, section, entry) {
  const r = new ByteReader(bytes, dv);
  r.offsetFrom(section, 0x10);

  const unkFlag = r.next16();
  const numMesh = r.next16();

  // Only lens-flare sheets carry a per-sprite distance along the screen vector.
  const lensFlareFlag = r.next8();
  const lensFlare = lensFlareFlag === 1;
  r.next8();
  r.next8();

  const normalizationFlag = r.next8();
  const texScale = (unkFlag === 1 && normalizationFlag === 0) ? 1 / 256 : 1;

  const textureName = r.nextString(0x10).replace(/\0/g, '').trim();

  const meshes = [];
  const offsets = [];

  for (let i = 0; i < numMesh; i++) {
    const unk1 = r.next16();
    if (unk1 !== 0x01) throw new Error(`sprite sheet unk1 was ${unk1.toString(16)}`);
    const numQuads = r.next8();
    r.next8();

    if (lensFlare) {
      offsets.push(r.nextFloat());
      r.nextFloat(); r.nextFloat(); r.nextFloat();
    }

    const numVerts = 6 * numQuads;
    const positions = new Float32Array(numVerts * 3);
    const normals = new Float32Array(numVerts * 3);   // sprites are unlit; keep zero
    const colors = new Uint8Array(numVerts * 4);
    const uvs = new Float32Array(numVerts * 2);

    for (let j = 0; j < numVerts; j++) {
      positions[j * 3] = r.nextFloat();
      positions[j * 3 + 1] = r.nextFloat();
      positions[j * 3 + 2] = r.nextFloat();
      const c = r.nextRGBA();
      for (let k = 0; k < 4; k++) colors[j * 4 + k] = c[k];
      uvs[j * 2] = r.nextFloat() * texScale;
      uvs[j * 2 + 1] = r.nextFloat() * texScale;
    }

    meshes.push({ count: numVerts, positions, normals, colors, uvs, textureName, localDir: entry?.dir ?? null });
  }

  return { kind: 'spriteSheet', id: entry?.id, meshes, offsets, lensFlare };
}

// ── 0x3D SoundEffectPointer ────────────────────────────────────────────────

/** `SeSep` header + a sound id that maps to sound/win/se/<folder>/<file>.spw. */
export function parseSoundPointer(bytes, dv, section, entry) {
  const r = new ByteReader(bytes, dv);
  r.offsetFromDataStart(section, 0);

  const type = r.nextString(0x8);
  if (!type.startsWith('SeSep')) throw new Error(`not a SeSep: ${JSON.stringify(type)}`);

  const soundId = r.next32();
  return {
    kind: 'soundPointer',
    id: entry?.id,
    soundId,
    folderId: String(Math.floor(soundId / 1000)).padStart(3, '0'),
    fileId: String(soundId).padStart(6, '0'),
  };
}

// ── 0x3E PointList ─────────────────────────────────────────────────────────

export function parsePointList(bytes, dv, section, entry) {
  const r = new ByteReader(bytes, dv);
  r.offsetFrom(section, 0x10);
  const count = r.next32();
  const points = [];
  const end = section.start + section.size;
  for (let i = 0; i < count && r.position + 12 <= end; i++) points.push(r.nextVector3f());
  if (!points.length) throw new Error('empty point list');
  return { kind: 'pointList', id: entry?.id, points };
}

// ── 0x4A Path ──────────────────────────────────────────────────────────────

/**
 * A `RAB` polyline of thick (radius-bearing) vertices joined into segments.
 * Shoreline audio emitters reference one so the wave sound tracks the nearest
 * point on the coast instead of a single fixed emitter position.
 */
export function parsePath(bytes, dv, section, entry) {
  const r = new ByteReader(bytes, dv);
  r.offsetFromDataStart(section, 0);

  const magic = r.nextString(4);
  if (!magic.startsWith('RAB')) throw new Error(`not a RAB path: ${JSON.stringify(magic)}`);

  r.next32();          // unk0 (always 7?)
  r.next32();          // unk1
  r.next32();          // zero
  const verticesOffset = r.next32() + section.dataStart;
  const pairsOffset = r.next32() + section.dataStart;

  r.position = verticesOffset;
  const numVertices = r.next32();
  r.skip(12);          // three zero dwords

  const vertices = [];
  for (let i = 0; i < numVertices; i++) {
    const position = r.nextVector3f();
    const radius = r.nextFloat();
    r.skip(16);        // four unknown dwords, generally zero
    vertices.push({ position, radius });
  }

  r.position = pairsOffset;
  const numSegments = r.next32();
  r.skip(12);          // three zero dwords

  const segments = [];
  for (let i = 0; i < numSegments; i++) {
    const i0 = r.next32() & 0xffffff;
    const i1 = r.next32() & 0xffffff;
    if (i0 >= numVertices || i1 >= numVertices) throw new Error(`path segment index out of range: ${i0},${i1}`);
    segments.push([vertices[i0], vertices[i1]]);
  }

  // xim PathSegment.nearestPoint — closest point on a capsule, so anywhere
  // inside the path's radius reports distance 0 (full volume).
  const segmentNearest = ([start, end], point) => {
    const dir = end.position.sub(start.position).normalizeInPlace();
    const t = point.sub(start.position).dot(dir);
    const length = Vec3.distance(start.position, end.position);
    const partial = length === 0 ? 0 : t / length;

    let center, radius;
    if (partial <= 0) { center = start.position; radius = start.radius; }
    else if (partial >= 1) { center = end.position; radius = end.radius; }
    else {
      center = start.position.add(dir.scale(t));
      radius = start.radius + (end.radius - start.radius) * partial;
    }

    const distanceToCenter = Vec3.distance(center, point);
    if (distanceToCenter <= radius) return { point, distance: 0 };
    const toCenter = center.sub(point).normalizeInPlace();
    const distance = distanceToCenter - radius;
    return { point: point.add(toCenter.scale(distance)), distance };
  };

  return {
    kind: 'path',
    id: entry?.id,
    vertices,
    segments,
    nearestPoint(to) {
      let best = null;
      for (const s of segments) {
        const r0 = segmentNearest(s, to);
        if (!best || r0.distance < best.distance) best = r0;
      }
      return best;
    },
  };
}

/**
 * Parser table for buildDatTree. `extra` supplies the zone-specific parsers we
 * already have (zone meshes, textures, environments) so the tree exposes one
 * lookup for everything.
 */
/**
 * @param {Object}  extra        additional/overriding section parsers
 * @param {boolean} zoneResource true for a zone DAT, false for the shared
 *   effects DAT. xim loads ROM/0/0.DAT with `staticResource` (zoneResource
 *   false), and only zone resources get the x2 vertex-colour scale — passing
 *   true for both makes every shared effect twice as bright.
 */
export function makeParsers(extra = {}, zoneResource = true) {
  return {
    [SEC.KEYFRAME]: parseKeyFrame,
    [SEC.PARTICLE_MESH]: (b, d, s, e) => parseParticleMesh(b, d, s, e, zoneResource),
    [SEC.SPRITE_SHEET]: parseSpriteSheet,
    [SEC.SOUND_POINTER]: parseSoundPointer,
    [SEC.POINT_LIST]: parsePointList,
    [SEC.PATH]: parsePath,
    ...extra,
  };
}
