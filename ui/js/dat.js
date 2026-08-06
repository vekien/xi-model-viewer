// FFXI entity DAT parsing — port of XiViewer.Data (C#), itself ported from
// xim's Kotlin parsers (the authoritative reference that renders retail DATs).
// Sections: skeleton 0x29, skinned mesh 0x2A, texture 0x20, animation 0x2B.

export const SectionType = {
  End: 0x00,
  Directory: 0x01,
  EffectRoutine: 0x07,
  Texture: 0x20,
  Skeleton: 0x29,
  SkeletonMesh: 0x2a,
  SkeletonAnimation: 0x2b,
  Info: 0x45,
};

class DatReader {
  constructor(buffer) {
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.pos = 0;
  }
  get length() { return this.bytes.length; }
  u8() { return this.bytes[this.pos++]; }
  u16() { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i32() { const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  u32() { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  f32() { const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
  vec3() { return [this.f32(), this.f32(), this.f32()]; }
  skip(n) { this.pos += n; }
  str(len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      const b = this.bytes[this.pos + i];
      if (b === 0) break;
      s += String.fromCharCode(b);
    }
    this.pos += len;
    return s.replace(/ +$/, '');
  }
  bytesAt(count) {
    const out = this.bytes.slice(this.pos, this.pos + count);
    this.pos += count;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Section walker: 16-byte headers — 4-char id, u32 meta (bits 0-6 type,
// bits 7-26 size in 16-byte units, includes header). Data at start+0x10.
// ---------------------------------------------------------------------------

export function walkSections(buffer) {
  const r = new DatReader(buffer);
  const sections = [];

  while (r.pos + 16 <= r.length) {
    const start = r.pos;

    let plausible = true;
    for (let i = 0; i < 4; i++) {
      const b = r.bytes[start + i];
      if (b !== 0 && (b < 0x20 || b > 0x7e)) { plausible = false; break; }
    }
    if (!plausible) break;

    const id = r.str(4);
    const meta = r.u32();
    const typeCode = meta & 0x7f;
    let size = ((meta >>> 7) & 0xfffff) * 0x10;
    if (size < 0x10) size = 0x10;
    if (start + size > r.length) break;

    sections.push({ id, typeCode, start, size, dataStart: start + 0x10, end: start + size });
    r.pos = start + size;
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Entity parsing
// ---------------------------------------------------------------------------

export function parseEntity(buffer, sourceName = '') {
  const model = {
    sourceName,
    skeleton: null,
    meshGroups: [],
    textures: new Map(),      // name -> texture
    animations: [],
    schedules: [],            // 0x07 EffectRoutine entries (raw refs, resolved below)
    info: null,               // 0x45 movement/weapon metadata
  };

  const r = new DatReader(buffer);

  for (const sec of walkSections(buffer)) {
    try {
      switch (sec.typeCode) {
        case SectionType.EffectRoutine: {
          const sched = parseRoutine(r, sec);
          if (sched) model.schedules.push(sched);
          break;
        }
        case SectionType.Skeleton:
          if (!model.skeleton) model.skeleton = parseSkeleton(r, sec);
          break;
        case SectionType.SkeletonMesh:
          model.meshGroups.push(parseSkeletonMesh(r, sec));
          break;
        case SectionType.Texture: {
          const tex = parseTexture(r, sec);
          if (tex) model.textures.set(tex.name, tex);
          break;
        }
        case SectionType.SkeletonAnimation:
          model.animations.push(parseAnimation(r, sec));
          break;
        case SectionType.Info:
          if (sec.id === 'info' && !model.info) model.info = parseInfo(r, sec);
          break;
      }
    } catch (e) {
      console.warn(`[${sec.id}] section 0x${sec.typeCode.toString(16)} parse failed:`, e);
    }
  }

  resolveSchedules(model);
  model.isRenderable = model.meshGroups.length > 0 && model.skeleton !== null;
  return model;
}

// ---------------------------------------------------------------------------
// Schedules (0x07 EffectRoutine)
// ---------------------------------------------------------------------------
//
// A routine is what a cutscene/NPC actually triggers (never a raw 0x2B clip).
// Its sec2 command list holds 0x05 SkeletonAnimation commands that reference a
// clip by a wildcard tag (`at0?`); the client resolves `?` to the concrete slot.
// Ported from xi-tools _routine_sec2_commands / _clip_ref.

function parseRoutine(r, sec) {
  const base = sec.dataStart;
  const size = sec.size;
  if (size < 0x30) return null;

  // Body offset 0x10 holds four u32s (s1, sec2, s3, tot); sec2 (the command-list
  // pointer) is the second, at body 0x14.
  r.pos = base + 0x14;
  const sec2 = r.i32();
  const refs = [];
  // Every 0x05 command is one animation on the routine's timeline, each with its
  // own start delay — a routine plays several clips (body-region layers and/or
  // sequenced phases), not just its first (xim SkeletonAnimationRoutine).
  //   +0 op, +1 u16 sizeWords, +3 unk, +4 u16 delay, +6 u16 duration,
  //   +8 clip ref (4 chars), +24 transIn, +28 transOut, +30 maxLoops
  //
  // Delays are RELATIVE, not absolute (header totalDelay == Σ delays on 98.1%
  // of retail routines, == max on none), and each delay TRAILS its own op —
  // see the clock note below. Chained clips (ssit: sit-down then sitting
  // idle) depend on this.
  const commands = [];
  let dur = 0;
  let maxLoops = 0;
  let transIn = 0;
  let transOut = 0;
  let gotFields = false;

  let p = base + (sec2 - 16);      // body-relative sec2 start, mapped to absolute
  const end = sec.end;
  const u16 = (o) => r.bytes[o] | (r.bytes[o + 1] << 8);
  // A tag executes immediately; its delay is the wait AFTER it before the next
  // tag (XiClient CMoSchedulerTask::OnMove: `field_98 += tag.delay; ExecuteTag()`),
  // so a command starts at the sum of the PRIOR entries' delays only.
  let clock = 0;
  for (let guard = 0; guard < 128 && p + 8 <= end; guard++) {
    const op = r.bytes[p];
    const n = (r.bytes[p + 1] | (r.bytes[p + 2] << 8)) & 0x1f;
    const entryLen = Math.max(1, n) * 4;
    const at = clock;
    if (op !== 0x00) clock += u16(p + 4);
    if (op === 0x05 && p + 32 <= end) {
      const ref = String.fromCharCode(r.bytes[p + 8], r.bytes[p + 9], r.bytes[p + 10], r.bytes[p + 11]);
      if (/^[\x20-\x7e]{4}$/.test(ref)) {
        const id = ref.trimEnd();
        refs.push(id);
        commands.push({
          ref: id,
          delay: at,
          duration: u16(p + 6),
          transIn: u16(p + 24),
          transOut: u16(p + 28),
          maxLoops: u16(p + 30),
        });
      }
      if (!gotFields) {
        gotFields = true;
        dur = u16(p + 6);        // playback window
        transIn = u16(p + 24);   // blend-in frames
        transOut = u16(p + 28);  // blend-out frames
        maxLoops = u16(p + 30);  // 0 = loop forever, N = play N then hold
      }
    }
    if (op === 0x00) break;
    p += entryLen;
  }

  // Keep routines even with no clip refs (SFX/VFX-only) so the schedule list
  // matches the full 0x07 set AltanaViewer shows.
  return { id: sec.id, refs, commands, dur, maxLoops, transIn, transOut };
}

/**
 * Resolves each schedule's wildcard clip refs to concrete animation ids from
 * `animations`. Raw `refs` are kept on the result so a merged model (schedule
 * DATs + separate motion DATs) can re-resolve against the combined clip set.
 */
export function resolveScheduleRefs(schedules, animations) {
  const ids = animations.map((a) => a.id);

  /** Concrete clip ids a single command ref resolves to. */
  const matchRef = (ref) => {
    const q = ref.indexOf('?');
    if (q >= 0) {
      const prefix = ref.slice(0, q);
      return ids.filter((id) => id.startsWith(prefix));
    }
    if (ids.includes(ref)) return [ref];
    // Ref may already be a display base (at0) while tracks are slotted (at00).
    return ids.filter((id) => animDisplayName(id) === ref || id.startsWith(ref));
  };

  const out = [];
  for (const sched of schedules) {
    const clipIds = new Set();
    for (const ref of sched.refs ?? []) for (const id of matchRef(ref)) clipIds.add(id);
    // Per-command resolution keeps each animation's own start delay.
    const commands = (sched.commands ?? []).map((c) => ({ ...c, clipIds: matchRef(c.ref) }));
    out.push({ ...sched, clipIds: [...clipIds], commands });
  }
  // De-dupe by id, keep first occurrence; sort for a scannable list.
  const seen = new Set();
  return out
    .filter((s) => (seen.has(s.id) ? false : seen.add(s.id)))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' }));
}

function resolveSchedules(model) {
  model.schedules = resolveScheduleRefs(model.schedules, model.animations);
}

/**
 * Builds one playable clip for a schedule. A routine's 0x05 commands each start
 * at their own delay, so the result is a *sequence*: body-region parts of one
 * command merge into a layer (groupAnimations), and layers are placed on a
 * shared timeline. `segments` is what SkeletonPose.evaluate consumes; a single
 * layer at delay 0 collapses back to a plain clip.
 */
export function resolveScheduleClip(model, schedule) {
  const byId = new Map(model.animations.map((a) => [a.id, a]));
  const segments = [];

  for (const cmd of schedule.commands ?? []) {
    const clips = (cmd.clipIds ?? []).map((id) => byId.get(id)).filter(Boolean);
    if (clips.length === 0) continue;
    // Scheduler delays are 1/60s ticks; segment starts are 30fps clip frames.
    // Retail writes a chained clip's delay as the previous clip's window
    // (2 × its frame count), so ÷2 makes chains seamless (see effect.js).
    for (const g of groupAnimations(clips)) segments.push({ clip: g.clip, delay: (cmd.delay ?? 0) / 2, transOut: cmd.transOut ?? 0 });
  }

  // Fallback for routines whose commands didn't resolve (older/odd layouts).
  if (segments.length === 0) {
    const clips = schedule.clipIds.map((id) => byId.get(id)).filter(Boolean);
    if (clips.length === 0) return null;
    for (const g of groupAnimations(clips)) segments.push({ clip: g.clip, delay: 0 });
  }

  if (segments.length === 1 && segments[0].delay === 0) return segments[0].clip;

  const lengthInFrames = Math.max(...segments.map((s) => s.delay + s.clip.lengthInFrames));
  // Union of tracked joints: lets callers test what the schedule drives (e.g.
  // the weapon hand-attach override) without knowing about segments.
  const jointTracks = new Map();
  for (const s of segments) for (const [j, t] of s.clip.jointTracks) jointTracks.set(j, t);

  return {
    id: schedule.id,
    segments,
    jointTracks,
    lengthInFrames,
    numFrames: Math.max(...segments.map((s) => s.clip.numFrames)),
    keyFrameDuration: 1,
    parts: segments.map((s) => s.clip.id),
  };
}

/**
 * Merges multiple parsed models into one renderable (e.g. Automaton frame DAT
 * providing the skeleton + animations, head DAT providing extra meshes that
 * rig onto the same skeleton). Earlier models take precedence for skeleton;
 * later textures override same-named earlier ones.
 */
export function mergeModels(models, sourceName = '') {
  const out = {
    sourceName,
    skeleton: null,
    meshGroups: [],
    textures: new Map(),
    animations: [],
    schedules: [],
  };
  const seenAnims = new Set();
  const seenSched = new Set();

  for (const m of models) {
    if (!m) continue;
    if (!out.skeleton && m.skeleton) out.skeleton = m.skeleton;
    out.meshGroups.push(...m.meshGroups);
    for (const [name, tex] of m.textures) out.textures.set(name, tex);
    for (const anim of m.animations) {
      if (seenAnims.has(anim.id)) continue;
      seenAnims.add(anim.id);
      out.animations.push(anim);
    }
    for (const s of m.schedules ?? []) {
      if (seenSched.has(s.id)) continue;
      seenSched.add(s.id);
      out.schedules.push(s);
    }
  }

  // Schedule DATs and their motion-clip DATs are separate files — re-resolve
  // clip refs against the combined animation set.
  out.schedules = resolveScheduleRefs(out.schedules, out.animations);

  out.isRenderable = out.meshGroups.length > 0 && out.skeleton !== null;
  return out;
}

// ---------------------------------------------------------------------------
// Body-region animation grouping
// ---------------------------------------------------------------------------
//
// FFXI animation names are 4 chars. A trailing digit 0/1/2 is the *body-region
// slot* (lower / upper / waist), not a separate clip — those parts play together
// and overlay into one pose (docs/anim/emotes.md).
//
// Examples:
//   idl0 + idl1 + idl2  →  one list entry "idl"  (merged)
//   at00 / at10 / at20  →  "at0" / "at1" / "at2" (middle digit = attack variant;
//                          each is already a full-body track, only the slot digit
//                          is stripped for the display name)
//   mou4 / atm5         →  unchanged (trailing digit is not a body slot)
//
// Only merge when 2+ slots actually exist for the same base. Solo tracks still
// use the stripped base as their list id so AltanaViewer-style names match
// (at00 shows as at0, not at00).

/** Body-region slot digit (0/1/2), or -1 if the name isn't a slotted part. */
function bodySlot(id) {
  if (!id || id.length < 2) return -1;
  const d = id[id.length - 1];
  return d >= '0' && d <= '2' ? +d : -1;
}

/** List/display name: strip trailing body-region slot (at00 → at0, idl0 → idl). */
export function animDisplayName(id) {
  return bodySlot(id) >= 0 ? id.slice(0, -1) : id;
}

export function groupAnimations(animations) {
  const groups = [];
  const byBase = new Map();

  for (const a of animations) {
    const base = animDisplayName(a.id);
    let g = byBase.get(base);
    if (!g) { g = { base, parts: [] }; byBase.set(base, g); groups.push(g); }
    g.parts.push(a);
  }

  const out = [];
  for (const { base, parts } of groups) {
    if (parts.length >= 2) {
      out.push({ id: base, clip: mergeAnimationParts(base, parts) });
    } else {
      // Keep stripped base as the id even for a lone part (at00 → at0).
      const clip = parts[0];
      out.push({
        id: base,
        clip: base === clip.id ? clip : { ...clip, id: base, parts: [clip.id] },
      });
    }
  }
  // Stable, readable order (at0/at1/at2 together — DAT order buries at0 after at1/at2).
  out.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' }));
  return out;
}

// Trailing part-digit (0/1/2); lower = primary body-region part.
function partDigit(id) {
  const s = bodySlot(id);
  return s >= 0 ? s : 0;
}

function mergeAnimationParts(base, parts) {
  // Overlay every part into one clip. idl0 is the primary/base layer (drives most of
  // the body); higher-digit parts (idl1…) layer on top and override any joints they
  // share with a lower part — mirroring the engine picking the higher slot per joint
  // (xim SkeletonAnimator). Applied low→high so the higher part wins the overlap.
  const ordered = [...parts].sort((a, b) => partDigit(a.id) - partDigit(b.id));
  const jointTracks = new Map();
  let lengthInFrames = 0;
  for (const part of ordered) {
    for (const [j, track] of part.jointTracks) jointTracks.set(j, track);   // higher part overrides
    lengthInFrames = Math.max(lengthInFrames, part.lengthInFrames);
  }
  return {
    id: base,
    numFrames: Math.max(...parts.map((p) => p.numFrames)),
    keyFrameDuration: 1,
    jointTracks,
    lengthInFrames,
    parts: ordered.map((p) => p.id),
  };
}

// --- Skeleton (0x29) -------------------------------------------------------

function parseSkeleton(r, sec) {
  r.pos = sec.dataStart + 0x02;
  const numJoints = r.u8();

  r.pos = sec.dataStart + 0x04;
  const joints = [];
  for (let i = 0; i < numJoints; i++) {
    const maybeParent = r.u8();
    const parent = maybeParent === i ? -1 : maybeParent;
    r.skip(1);
    const rot = [r.f32(), r.f32(), r.f32(), r.f32()];   // x,y,z,w
    const trans = r.vec3();
    joints.push({ parent, rot, trans });
  }

  // Joint-reference table (xim JointReference): named attach points into the
  // skeleton — 126 = left hand, 127 = right hand, weapon grips via the weapon
  // DAT's `info` standardJointIndex. { u16 jointIndex, vec3 unk, vec3 offset }.
  const references = [];
  const numRefs = r.u16();
  r.u16();                                  // usually -1
  for (let i = 0; i < numRefs && r.pos + 26 <= sec.end; i++) {
    const index = r.u16();
    r.skip(12);                             // unk vec3
    const offset = r.vec3();
    references.push({ index, offset });
  }

  return { joints, references };
}

// --- Info (0x45, id 'info') ------------------------------------------------
//
// Movement/weapon metadata (xim InfoSection). For weapons, standardJointIndex
// names the joint-reference of the grip joint that re-parents onto the hand
// when the weapon is drawn.

function parseInfo(r, sec) {
  r.pos = sec.dataStart;
  const b = [];
  for (let i = 0; i < 16; i++) b.push(r.u8());
  return {
    weaponAnimationType: b[3],
    weaponAnimationSubType: b[4],
    standardJointIndex: b[6] === 0xff ? null : b[6],
  };
}

// --- Skinned mesh (0x2A) ---------------------------------------------------

function unpackJointRef(data) {
  return { index: data & 0x7f, flippedIndex: (data >>> 7) & 0x7f, flipAxis: (data >>> 14) & 0x3 };
}

function flipVec(v, axis) {
  const out = [v[0], v[1], v[2]];
  if (axis >= 1 && axis <= 3) out[axis - 1] = -out[axis - 1];
  return out;
}

function parseSkeletonMesh(r, sec) {
  r.pos = sec.dataStart;

  r.u8();                                 // flags1
  r.u8();                                 // flags2
  const flags3 = r.u8();
  const clothEffect = (flags3 & 0x01) !== 0;
  const useJointArray = (flags3 & 0x80) !== 0;
  const hasNormals = !clothEffect;
  // flags4: what this mesh occludes on OTHER pieces. A helmet (0x04) hides hair,
  // a sleeve (0x12) hides the wrist, etc. — see occludesDisplayType (renderer).
  const occludeType = r.u8();
  const symmetric = r.u8() === 0x01;
  r.u8();                                 // flags6

  const instructionOffset = 2 * r.i32();
  r.u8(); r.u8();                         // maybeMeshCount / maybeInstructionCount

  const jointArrayOffset = 2 * r.i32();
  const numJoints = r.u16();

  const vertexCountsOffset = 2 * r.i32();
  const numVertexCounts = r.u16();

  const vertexJointMappingOffset = 2 * r.i32();
  r.u16();                                // vertexJointMappingCount

  const vertexDataOffset = 2 * r.i32();
  r.u16();                                // vertexDataSize / 2
  r.i32();                                // endOffset / 2
  r.u16();                                // endOffsetDataSize

  // Joint array (u16 entries): local joint-ref index -> skeleton joint index
  const jointArray = new Array(numJoints);
  r.pos = sec.dataStart + jointArrayOffset;
  for (let i = 0; i < numJoints; i++) jointArray[i] = r.u16();
  const mapJoint = (i) => (useJointArray ? (i < jointArray.length ? jointArray[i] : 0) : i);

  // Vertex counts
  r.pos = sec.dataStart + vertexCountsOffset;
  if (numVertexCounts !== 2) throw new Error(`expected 2 vertex counts, got ${numVertexCounts}`);
  const singleCount = r.u16();
  const doubleCount = r.u16();
  const total = singleCount + doubleCount;

  const vertices = new Array(total);
  for (let i = 0; i < total; i++) {
    vertices[i] = {
      p0: [0, 0, 0], p1: [0, 0, 0], n0: [0, 0, 0], n1: [0, 0, 0],
      w0: 1, w1: 0, joint0: 0, joint1: -1,
    };
  }

  // Joint refs: 2 x u16 per vertex (both kinds)
  const refs0 = new Array(total), refs1 = new Array(total);
  r.pos = sec.dataStart + vertexJointMappingOffset;
  for (let i = 0; i < singleCount; i++) {
    refs0[i] = unpackJointRef(r.u16());
    refs1[i] = unpackJointRef(r.u16());
    vertices[i].joint0 = mapJoint(refs0[i].index);
  }
  for (let i = singleCount; i < total; i++) {
    refs0[i] = unpackJointRef(r.u16());
    refs1[i] = unpackJointRef(r.u16());
    vertices[i].joint0 = mapJoint(refs0[i].index);
    vertices[i].joint1 = mapJoint(refs1[i].index);
  }

  // Vertex data. Double-jointed positions are PRE-WEIGHTED (p_i = w_i * local).
  r.pos = sec.dataStart + vertexDataOffset;
  for (let i = 0; i < singleCount; i++) {
    const v = vertices[i];
    v.p0 = r.vec3();
    if (hasNormals) v.n0 = r.vec3();
  }
  for (let i = singleCount; i < total; i++) {
    const v = vertices[i];
    v.p0[0] = r.f32(); v.p1[0] = r.f32();
    v.p0[1] = r.f32(); v.p1[1] = r.f32();
    v.p0[2] = r.f32(); v.p1[2] = r.f32();
    v.w0 = r.f32(); v.w1 = r.f32();
    if (hasNormals) {
      v.n0[0] = r.f32(); v.n1[0] = r.f32();
      v.n0[1] = r.f32(); v.n1[1] = r.f32();
      v.n0[2] = r.f32(); v.n1[2] = r.f32();
    }
  }

  // Flipped pool for symmetric meshes
  let flippedVertices = null;
  if (symmetric) {
    flippedVertices = vertices.map((src, i) => ({
      p0: flipVec(src.p0, refs0[i].flipAxis),
      p1: flipVec(src.p1, refs1[i].flipAxis),
      n0: flipVec(src.n0, refs0[i].flipAxis),
      n1: flipVec(src.n1, refs1[i].flipAxis),
      w0: src.w0, w1: src.w1,
      joint0: mapJoint(refs0[i].flippedIndex),
      joint1: src.joint1 === -1 ? -1 : mapJoint(refs1[i].flippedIndex),
    }));
  }

  // Instruction stream
  const pieces = [];
  const addPiece = (topology, corners, textureName, props) => {
    pieces.push({ topology, corners, textureName, props, mirrored: false });
    if (symmetric) pieces.push({ topology, corners, textureName, props, mirrored: true });
  };

  r.pos = sec.dataStart + instructionOffset;
  let currentTexture = '';
  let currentProps = defaultProps();

  loop: while (true) {
    const op = r.u16();
    switch (op) {
      case 0xffff:
        break loop;

      case 0x8000:
        currentTexture = r.str(0x10);
        break;

      case 0x8010:
        currentProps = readRenderProps(r);
        break;

      case 0x5453: { // textured tri strip
        const numTriangles = r.u16();
        const corners = new Array(numTriangles + 2);
        const i0 = r.u16(), i1 = r.u16(), i2 = r.u16();
        const u0 = r.f32(), v0 = r.f32(), u1 = r.f32(), v1 = r.f32(), u2 = r.f32(), v2 = r.f32();
        corners[0] = { vi: i0, u: u0, v: v0, color: 0x80808080 };
        corners[1] = { vi: i1, u: u1, v: v1, color: 0x80808080 };
        corners[2] = { vi: i2, u: u2, v: v2, color: 0x80808080 };
        for (let i = 1; i < numTriangles; i++) {
          const vi = r.u16();
          corners[i + 2] = { vi, u: r.f32(), v: r.f32(), color: 0x80808080 };
        }
        addPiece('strip', corners, currentTexture, currentProps);
        break;
      }

      case 0x0054: { // textured tri mesh
        const numTriangles = r.u16();
        const corners = new Array(numTriangles * 3);
        for (let i = 0; i < numTriangles; i++) {
          const i0 = r.u16(), i1 = r.u16(), i2 = r.u16();
          const u0 = r.f32(), v0 = r.f32(), u1 = r.f32(), v1 = r.f32(), u2 = r.f32(), v2 = r.f32();
          corners[i * 3 + 0] = { vi: i0, u: u0, v: v0, color: 0x80808080 };
          corners[i * 3 + 1] = { vi: i1, u: u1, v: v1, color: 0x80808080 };
          corners[i * 3 + 2] = { vi: i2, u: u2, v: v2, color: 0x80808080 };
        }
        addPiece('list', corners, currentTexture, currentProps);
        break;
      }

      case 0x0043: { // untextured tri mesh (per-triangle BGRA)
        const numTriangles = r.u16();
        const corners = new Array(numTriangles * 3);
        for (let i = 0; i < numTriangles; i++) {
          const i0 = r.u16(), i1 = r.u16(), i2 = r.u16();
          const color = r.u32();
          corners[i * 3 + 0] = { vi: i0, u: 0, v: 0, color };
          corners[i * 3 + 1] = { vi: i1, u: 0, v: 0, color };
          corners[i * 3 + 2] = { vi: i2, u: 0, v: 0, color };
        }
        addPiece('list', corners, '', currentProps);
        break;
      }

      case 0x4353: { // untextured tri strip (single BGRA)
        const numTriangles = r.u16();
        const corners = new Array(numTriangles + 2);
        const i0 = r.u16(), i1 = r.u16(), i2 = r.u16();
        const color = r.u32();
        corners[0] = { vi: i0, u: 0, v: 0, color };
        corners[1] = { vi: i1, u: 0, v: 0, color };
        corners[2] = { vi: i2, u: 0, v: 0, color };
        for (let i = 1; i < numTriangles; i++)
          corners[i + 2] = { vi: r.u16(), u: 0, v: 0, color };
        addPiece('strip', corners, '', currentProps);
        break;
      }

      default:
        throw new Error(`unknown mesh opcode 0x${op.toString(16)} @ 0x${(r.pos - 2).toString(16)}`);
    }
  }

  return { sectionId: sec.id, vertices, flippedVertices, pieces, hasNormals, occludeType };
}

function defaultProps() {
  return { specularEnabled: false, specularPower: 0, displayType: 0, ambientMultiplier: 1 };
}

function readRenderProps(r) {
  r.u32();                                // tFactor BGRA
  r.f32(); r.f32();                       // f0, f1
  r.u8();                                 // flag0
  const displayType = r.u8();
  r.u8(); r.u8();                         // flag2, flag3
  const ambientMultiplier = r.f32();
  r.u32(); r.u32();                       // unk0, unk1
  r.u16();                                // unk2
  r.f32();                                // f4
  r.u16();                                // unk3
  const specularPower = r.f32();
  const specularEnabled = r.f32() === 1.0;
  return { specularEnabled, specularPower, displayType, ambientMultiplier };
}

/**
 * Extracts a single floor/zone texture by its 4-char section id (the fourcc in
 * AltanaViewer's Floor.csv), for use as a tiled ground plane.
 */
export function parseFloorTexture(buffer, fourcc) {
  const r = new DatReader(buffer);
  for (const sec of walkSections(buffer)) {
    if (sec.typeCode === SectionType.Texture && sec.id === fourcc) {
      try {
        const tex = parseTexture(r, sec);
        if (tex) return tex;
      } catch { /* try next match */ }
    }
  }
  return null;
}

// --- Texture (0x20) --------------------------------------------------------

function parseTexture(r, sec) {
  r.pos = sec.dataStart;

  const type = r.u8();
  if (type !== 0x91 && type !== 0xa1 && type !== 0xb1) return null;

  const name = r.str(0x10);
  r.u32();                                // 0x28
  const width = r.i32();
  const height = r.i32();
  r.u16();                                // 0x01
  const bitCount = r.u16();
  r.skip(5 * 4);                          // zeros
  r.u32();                                // 0x10 / 0x20

  if (width <= 0 || height <= 0 || width > 8192 || height > 8192) return null;

  if (type === 0xa1) {
    const dxtType = r.str(4);
    r.u32(); r.u32();
    if (dxtType === '1TXD')
      return { name, width, height, format: 'dxt1', data: r.bytesAt(width * height / 2) };
    if (dxtType === '3TXD')
      return { name, width, height, format: 'dxt3', data: r.bytesAt(width * height) };
    throw new Error(`unsupported DXT type ${dxtType}`);
  }

  if (type === 0xb1) r.u32();             // extra field vs 0x91

  // Palettized / raw 32-bit, stored bottom-up; decode to top-down RGBA.
  const pixels = new Uint8Array(width * height * 4);
  if (bitCount === 32) {
    for (let y = 0; y < height; y++) {
      const destRow = height - 1 - y;
      for (let x = 0; x < width; x++) {
        const c = r.u32();                // BGRA packed
        const o = (destRow * width + x) * 4;
        pixels[o + 0] = (c >>> 16) & 0xff;   // R
        pixels[o + 1] = (c >>> 8) & 0xff;    // G
        pixels[o + 2] = c & 0xff;            // B
        pixels[o + 3] = (c >>> 24) & 0xff;   // A
      }
    }
  } else {
    const palette = new Uint32Array(256);
    for (let i = 0; i < 256; i++) palette[i] = r.u32();
    for (let y = 0; y < height; y++) {
      const destRow = height - 1 - y;
      for (let x = 0; x < width; x++) {
        const c = palette[r.u8()];
        const o = (destRow * width + x) * 4;
        pixels[o + 0] = (c >>> 16) & 0xff;
        pixels[o + 1] = (c >>> 8) & 0xff;
        pixels[o + 2] = c & 0xff;
        pixels[o + 3] = (c >>> 24) & 0xff;
      }
    }
  }
  return { name, width, height, format: 'rgba32', data: pixels };
}

// --- Animation (0x2B) ------------------------------------------------------

function parseAnimation(r, sec) {
  r.pos = sec.dataStart;

  r.u16();                                // unk0
  const numJoints = r.u16();
  const numFrames = r.u16();
  const keyFrameDuration = r.f32();
  const keyFrameDataOffset = r.pos;

  const jointTracks = new Map();

  for (let j = 0; j < numJoints; j++) {
    const jointIndex = r.i32();
    const rot = readChannelGroup(r, 4, numFrames, keyFrameDataOffset);
    const trans = readChannelGroup(r, 3, numFrames, keyFrameDataOffset);
    const scale = readChannelGroup(r, 3, numFrames, keyFrameDataOffset);
    if (!rot || !trans || !scale) continue;   // negative offset => joint not animated

    const rotations = new Float32Array(numFrames * 4);
    const translations = new Float32Array(numFrames * 3);
    const scales = new Float32Array(numFrames * 3);
    for (let f = 0; f < numFrames; f++) {
      rotations[f * 4] = rot[0][f]; rotations[f * 4 + 1] = rot[1][f];
      rotations[f * 4 + 2] = rot[2][f]; rotations[f * 4 + 3] = rot[3][f];
      translations[f * 3] = trans[0][f]; translations[f * 3 + 1] = trans[1][f]; translations[f * 3 + 2] = trans[2][f];
      scales[f * 3] = scale[0][f]; scales[f * 3 + 1] = scale[1][f]; scales[f * 3 + 2] = scale[2][f];
    }
    // `frames` lets one merged clip mix parts of different lengths (each sampled by phase).
    jointTracks.set(jointIndex, { rotations, translations, scales, frames: numFrames });
  }

  return {
    id: sec.id,
    numFrames,
    keyFrameDuration,
    jointTracks,
    lengthInFrames: Math.max(numFrames - 1, 1) / keyFrameDuration,
  };
}

// Offset semantics: 0 = constant, >0 = per-frame floats at base + offset*4, <0 = absent.
function readChannelGroup(r, count, numFrames, base) {
  const offsets = [];
  for (let i = 0; i < count; i++) offsets.push(r.i32());
  const constValues = [];
  for (let i = 0; i < count; i++) constValues.push(r.f32() % 10000);

  if (offsets.some((o) => o < 0)) return null;

  const result = [];
  for (let i = 0; i < count; i++) {
    const values = new Float32Array(numFrames);
    if (offsets[i] === 0) {
      values.fill(constValues[i]);
    } else {
      const saved = r.pos;
      r.pos = base + offsets[i] * 4;
      for (let f = 0; f < numFrames; f++) values[f] = r.f32();
      r.pos = saved;
    }
    result.push(values);
  }
  return result;
}
