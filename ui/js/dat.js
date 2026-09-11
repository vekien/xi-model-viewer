// FFXI entity DAT parsing — port of XiViewer.Data (C#), itself ported from
// xim's Kotlin parsers (the authoritative reference that renders retail DATs).
// Sections: skeleton 0x29, skinned mesh 0x2A, texture 0x20, animation 0x2B.

export const SectionType = {
  End: 0x00,
  Directory: 0x01,
  ParticleGenerator: 0x05,
  EffectRoutine: 0x07,
  ParticleMesh: 0x1f,
  Texture: 0x20,
  SpriteSheetMesh: 0x21,
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
    particleMeshes: new Map(),  // fourcc -> 0x1F/0x21 geometry an effect draws
    effectLayers: [],           // the subset built into renderable meshGroups
  };

  const r = new DatReader(buffer);
  const sections = walkSections(buffer);

  // Particle geometry first: a generator names its mesh by FourCC, so the set of
  // 0x1F/0x21 ids has to exist before the 0x05 pass can spot a reference.
  for (const sec of sections) {
    if (sec.typeCode !== SectionType.ParticleMesh && sec.typeCode !== SectionType.SpriteSheetMesh) continue;
    try {
      const mesh = sec.typeCode === SectionType.ParticleMesh
        ? parseParticleMesh(r, sec)
        : parseSpriteMesh(r, sec);
      // Keyed by FourCC and first-wins, matching the client's local-then-parent
      // DatId lookup (ROM/0/0 reuses 14 of its 61 mesh names across scopes).
      if (mesh && !model.particleMeshes.has(mesh.sectionId)) model.particleMeshes.set(mesh.sectionId, mesh);
    } catch (e) {
      console.warn(`[${sec.id}] particle mesh 0x${sec.typeCode.toString(16)} parse failed:`, e);
    }
  }

  const generators = [];
  if (model.particleMeshes.size) {
    for (const sec of sections) {
      if (sec.typeCode !== SectionType.ParticleGenerator) continue;
      try {
        const gen = parseGenerator(r, sec, model.particleMeshes);
        if (gen) generators.push(gen);
      } catch (e) {
        console.warn(`[${sec.id}] generator parse failed:`, e);
      }
    }
  }

  for (const sec of sections) {
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

  // Effect-only entities (Home Points, and every other thing whose 0x2A geometry
  // is just a transparent click proxy): the visible object is its effect layers.
  // Append them so the normal skinned draw path picks them up — they bind to
  // joint 0, which every skeleton has.
  if (generators.length) {
    model.effectLayers = buildEffectLayers(model.particleMeshes, generators);
    model.meshGroups.push(...model.effectLayers);
  }

  // Tag meshes with the DAT they came from so the PC isolator can hide/show
  // per equipment slot after merge.
  const src = String(sourceName || '').replace(/\//g, '\\').toLowerCase();
  if (src) {
    for (const g of model.meshGroups) g.sourcePath = g.sourcePath || src;
  }
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
  // Routine calls (0x03 and kin). A routine's motion often lives one hop away:
  // Tachi: Shoha's `main` plays no 0x05 itself and calls `cas0`, which does;
  // every race's `sh*` cast routine calls its `ss*` twin the same way. The
  // callee's commands are inlined by inlineRoutineCalls once the whole DAT is
  // parsed, so `main` lists (and plays) what it actually runs.
  const calls = [];
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
    if (ROUTINE_CALL_OPS.has(op) && p + 12 <= end) {
      const ref = String.fromCharCode(r.bytes[p + 8], r.bytes[p + 9], r.bytes[p + 10], r.bytes[p + 11]).replace(/\0+$/, '');
      if (/^[\x20-\x7e]{1,4}$/.test(ref)) calls.push({ routineId: ref.trimEnd(), delay: at });
    }
    if (op === 0x00) break;
    p += entryLen;
  }

  // Keep routines even with no clip refs (SFX/VFX-only) so the schedule list
  // matches the full 0x07 set AltanaViewer shows.
  return { id: sec.id, refs, commands, calls, dur, maxLoops, transIn, transOut };
}

// Ops that invoke another routine by id (same set as effect.js CALL_OPS).
const ROUTINE_CALL_OPS = new Set([0x03, 0x09, 0x3b, 0x3c, 0x57]);

/**
 * Folds each routine's same-DAT calls into its own command list, offset by the
 * call's delay (nested delays add, as in effect.js flattenRoutine). Calls that
 * leave the DAT — `mdam`, `proc`, `eis1` in the shared effects file, or a
 * schedule on the actor — are left to the effect scheduler.
 *
 * Without this, ROM/268/76 (Tachi: Shoha) lists only `cas0`: its `main` is a
 * wrapper — VFX ops plus `0x03 cas0` — while the older ROM/101/76 (Tachi:
 * Enpi) puts the 0x05 commands straight in `main`. The picker then had no
 * `main` to lead with, and the base race's `sh*` cast routines (which only
 * call `ss*`) stayed empty.
 */
function inlineRoutineCalls(schedules) {
  const byId = new Map();
  for (const s of schedules) if (!byId.has(s.id)) byId.set(s.id, s);
  return schedules.map((s) => {
    if (!s.calls?.length) return s;
    const commands = [...s.commands];
    const seen = new Set([s]);
    const walk = (r, offset, depth) => {
      if (depth > 8) return;
      for (const call of r.calls ?? []) {
        const next = byId.get(call.routineId);
        if (!next || seen.has(next)) continue;
        seen.add(next);
        const at = offset + call.delay;
        for (const c of next.commands) commands.push({ ...c, delay: c.delay + at });
        walk(next, at, depth + 1);
      }
    };
    walk(s, 0, 0);
    if (commands.length === s.commands.length) return s;
    commands.sort((a, b) => a.delay - b.delay);
    const refs = [...new Set(commands.map((c) => c.ref))];
    // Header-style fields come from the first command when the routine had none.
    const first = s.commands.length ? s : commands[0];
    return {
      ...s, refs, commands,
      dur: first.dur ?? first.duration, maxLoops: first.maxLoops, transIn: first.transIn, transOut: first.transOut,
    };
  });
}

/**
 * Resolves each schedule's wildcard clip refs to concrete animation ids from
 * `animations`. Raw `refs` are kept on the result so a merged model (schedule
 * DATs + separate motion DATs) can re-resolve against the combined clip set.
 */
/**
 * Concrete clip ids a single routine ref resolves to. `?` is the client's
 * wildcard for the body-slot digit (`at0?`), so it matches by prefix.
 *
 * Shared with the effect scheduler: a spell DAT's 0x05 commands name clips the
 * same way, which is what lets a Ninjutsu effect find the character's ninjutsu
 * motion without anything being mapped by hand.
 */
export function matchAnimRef(ref, ids) {
  const q = ref.indexOf('?');
  if (q >= 0) {
    const prefix = ref.slice(0, q);
    return ids.filter((id) => id.startsWith(prefix));
  }
  if (ids.includes(ref)) return [ref];
  // Ref may already be a display base (at0) while tracks are slotted (at00).
  return ids.filter((id) => animDisplayName(id) === ref || id.startsWith(ref));
}

export function resolveScheduleRefs(schedules, animations) {
  const ids = animations.map((a) => a.id);
  const matchRef = (ref) => matchAnimRef(ref, ids);

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
  model.schedules = resolveScheduleRefs(inlineRoutineCalls(model.schedules), model.animations);
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
    const src = String(m.sourceName || '').replace(/\//g, '\\').toLowerCase();
    for (const g of m.meshGroups) {
      out.meshGroups.push(g.sourcePath ? g : { ...g, sourcePath: src });
    }
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

/**
 * Hangs a rigged prop off one joint of an actor: the fishing rod.
 *
 * A rod is not a weapon mesh. It is an entity of its own — a 9-joint skeleton
 * so the tip can bend, one mesh, and a full set of fishing clips (fh00…fhd0)
 * plus the same fsh0…fsh9 schedules the character plays — that the client
 * spawns as a second actor at the character's position and rotation while
 * fishing (FFXiMain keeps a per-race base file id; the rod's item model id
 * indexes it). Its clips move it from that origin into the grip. Rather than
 * run a second actor, the rig is grafted onto the character: its joints are
 * appended with the root parented onto `hostJoint` (−1 = the actor origin,
 * which is where the client puts it), its mesh re-indexed onto them, and each
 * clip's tracks merged into the character's clip of the same id — so when
 * fsh1 plays the rod bends on the very same timeline, and the pose/skinning
 * path needs no new concept. Clips only the rig has are added as-is.
 */
export function graftRig(model, rig, hostJoint, sourcePath = null) {
  const skel = model.skeleton;
  if (!skel || !rig?.skeleton || !rig.meshGroups?.length) return false;
  const N = skel.joints.length;
  for (const j of rig.skeleton.joints) {
    skel.joints.push({
      parent: j.parent < 0 ? hostJoint : j.parent + N,
      rot: j.rot,
      trans: j.trans,
    });
  }
  const remap = (v) => ({
    ...v,
    joint0: v.joint0 >= 0 ? v.joint0 + N : v.joint0,
    joint1: v.joint1 >= 0 ? v.joint1 + N : v.joint1,
  });
  const src = String(sourcePath ?? rig.sourceName ?? '').replace(/\//g, '\\').toLowerCase();
  for (const g of rig.meshGroups) {
    model.meshGroups.push({
      ...g,
      vertices: g.vertices.map(remap),
      flippedVertices: g.flippedVertices ? g.flippedVertices.map(remap) : g.flippedVertices,
      sourcePath: src || g.sourcePath || null,
      // Framing and the orbit pivot ignore it like a weapon — it is long.
      isWeapon: true,
      rig: true,
    });
  }
  for (const [name, tex] of rig.textures ?? []) {
    if (!model.textures.has(name)) model.textures.set(name, tex);
  }
  const byId = new Map(model.animations.map((a) => [a.id, a]));
  for (const a of rig.animations ?? []) {
    const tracks = new Map([...a.jointTracks].map(([j, t]) => [j + N, t]));
    const host = byId.get(a.id);
    if (host) {
      for (const [j, t] of tracks) host.jointTracks.set(j, t);
    } else {
      const copy = { ...a, jointTracks: tracks };
      model.animations.push(copy);
      byId.set(a.id, copy);
    }
  }
  return true;
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
    // Body armour: which waist (body-slot 2) pack block the client pairs with
    // it — AltanaView's BODYinfo, byte 0x19 of the section. 2 selects the
    // second block of every waist pack family (race +4 not +3, battle skirt
    // +2·n not +n, weapon-skill companion B not A): those clips drive all ten
    // waist joints (4, 5, 18–25), where the first block keys six and pins
    // 5 / 21 / 23 / 25 to bind. Long-skirted bodies (Seer's Tunic, robes) are
    // skinned to exactly those pinned joints, so the first block leaves part
    // of the skirt frozen while the rest animates — the classic clip-through.
    waistVariant: b[9] === 0xff ? 0 : b[9],
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

// ---------------------------------------------------------------------------
// Particle geometry (0x1F ParticleMesh, 0x21 SpriteSheetMesh)
// ---------------------------------------------------------------------------
//
// Some entities have no body at all. A Home Point's 0x2A mesh is a single 3 mm
// triangle painted with a 2x1 black texture, on a skeleton named `toum`
// (toumei, "transparent") — an invisible proxy that exists so the client's actor
// system has something to place, click and pose. Everything you actually see is
// drawn by its 0x05 generators out of 0x1F meshes, which nothing here parsed, so
// the viewer rendered an empty stage.
//
// Layout is the client's own loader (CMoD3m::Open / GetAnotherShortPointer /
// GetFloatPointer), cross-checked against retail bytes. Ported from xi-tools
// src/xi/fx/xi_particle_mesh.py — see xi-tools docs/fx/particle_mesh.md.
//
//   +0x00 u16 flags        marker = flags & 0xF (5/6 = vertex-array layout)
//   +0x04 u8  matCount     +0x05 u8 extraCount
//   +0x06 u16 triCount
//   +0x08 u16[matCount+extraCount] per-entry triangle counts
//         materials at 8 + 2*align(matCount+extraCount), 16 bytes each
//         vertices  at materials + 16*matCount, 36 bytes each
//
// A vertex is D3DFVF_XYZ|NORMAL|DIFFUSE|TEX1: pos, normal, BGRA, uv.

const PARTICLE_VERTEX_STRIDE = 36;
const SPRITE_VERTEX_STRIDE = 24;
const SPRITE_CARD_VERTS = 6;
const SPRITE_CARD_STRIDE = 4 + SPRITE_CARD_VERTS * SPRITE_VERTEX_STRIDE;   // 148
const SPRITE_DATA_START = 0x18;

// The material table is aligned by rounding the ENTRY COUNT down to a multiple
// of 4 and adding 3 — not by rounding the byte offset up to 16. They agree for
// 1-3 entries (offset 14) and diverge after; a generic 16-byte alignment reads
// two bytes into every vertex and yields garbage positions.
function materialTableOffset(matCount, extraCount) {
  const n = matCount + extraCount;
  const rem = n & 3;
  return 8 + 2 * (rem === 0 ? n : n - rem + 3);
}

function particleVertex(p0, n0) {
  return { p0, p1: [0, 0, 0], n0, n1: [0, 0, 0], w0: 1, w1: 0, joint0: 0, joint1: -1 };
}

function parseParticleMesh(r, sec) {
  const base = sec.dataStart;
  const avail = sec.end - base;
  if (avail < 14) return null;

  r.pos = base;
  const marker = r.u16() & 0xf;
  // 7 is what the client REWRITES the marker to when its own validation fails.
  if (marker !== 5 && marker !== 6) return null;
  r.u16();                                  // runtime "opened" flags, 0 on disk
  const matCount = r.u8();
  const extraCount = r.u8();
  const triCount = r.u16();
  if (!triCount) return null;

  const matOffset = materialTableOffset(matCount, extraCount);
  const vertOffset = matOffset + 16 * matCount;
  const corners = triCount * 3;
  if (vertOffset + corners * PARTICLE_VERTEX_STRIDE > avail) return null;

  const materials = [];
  for (let i = 0; i < matCount; i++) {
    r.pos = base + matOffset + 16 * i;
    materials.push(r.str(0x10));            // the 0x20 texture's own 16-char name
  }

  const vertices = new Array(corners);
  const cornerList = new Array(corners);
  for (let i = 0; i < corners; i++) {
    r.pos = base + vertOffset + i * PARTICLE_VERTEX_STRIDE;
    const p0 = r.vec3();
    const n0 = r.vec3();
    const color = r.u32();
    const u = r.f32(), v = r.f32();
    vertices[i] = particleVertex(p0, n0);
    cornerList[i] = { vi: i, u, v, color };
  }

  const piece = {
    topology: 'list',
    corners: cornerList,
    textureName: materials[0] ?? '',
    props: defaultProps(),
    mirrored: false,
  };
  return {
    sectionId: sec.id, sectionType: SectionType.ParticleMesh, materials,
    triangles: triCount, vertices, flippedVertices: null, pieces: [piece],
    hasNormals: true, occludeType: 0,
  };
}

// A 0x21 is N flat cards sharing one texture — the quad a sprite-sheet particle
// billboards. Header, then per card a 4-byte tag and six 24-byte vertices
// (pos, BGRA, uv; no normal — the generator orients the card at runtime).
function parseSpriteMesh(r, sec) {
  const base = sec.dataStart;
  const avail = sec.end - base;
  if (avail < SPRITE_DATA_START + SPRITE_CARD_STRIDE) return null;

  r.pos = base + 2;
  const cardCount = r.u16();
  if (!cardCount) return null;
  if (SPRITE_DATA_START + cardCount * SPRITE_CARD_STRIDE > avail) return null;

  r.pos = base + 8;
  const tag = r.str(0x10);

  const total = cardCount * SPRITE_CARD_VERTS;
  const vertices = new Array(total);
  const cornerList = new Array(total);
  for (let c = 0; c < cardCount; c++) {
    for (let i = 0; i < SPRITE_CARD_VERTS; i++) {
      const idx = c * SPRITE_CARD_VERTS + i;
      r.pos = base + SPRITE_DATA_START + c * SPRITE_CARD_STRIDE + 4 + i * SPRITE_VERTEX_STRIDE;
      const p0 = r.vec3();
      const color = r.u32();
      const u = r.f32(), v = r.f32();
      vertices[idx] = particleVertex(p0, [0, 0, -1]);
      cornerList[idx] = { vi: idx, u, v, color };
    }
  }

  const piece = {
    topology: 'list', corners: cornerList, textureName: tag,
    props: defaultProps(), mirrored: false,
  };
  return {
    sectionId: sec.id, sectionType: SectionType.SpriteSheetMesh, materials: [tag],
    triangles: cardCount * 2, vertices, flippedVertices: null, pieces: [piece],
    hasNormals: false, occludeType: 0,
  };
}

// --- 0x05 generators: the transform and the motion --------------------------
//
// A generator names its mesh by FourCC and carries both the transform it draws
// at and what moves it. The body is four opcode streams whose offsets sit at
// section+0x80; an entry is a u32 config (`op = cfg & 0xFF`, `size = (cfg >> 8)
// & 0x1F` in 4-byte words, including the config) followed by its payload, and
// op 0 ends the stream. The ops that matter here:
//
//   sec2 0x01 StandardSetup      the mesh FourCC, then +8 -> 3x f32 position
//   sec2 0x09 Rotation           3x f32 radians — STATIC placement rotation
//   sec2 0x0B RotationVelocity   3x f32 radians per 60 Hz frame
//   sec2 0x0F Scale              3x f32
//   sec2 0x1E BlendFunc          u8
//   sec3 0x05 Rotation           the updater that integrates 0x0B each frame
//   sec3 0x27/0x28 TexCoordU/V   f32 UV scroll per 60 Hz frame
//
// The velocity and the updater are separate: sec2 carries the rate, sec3 applies
// it. A Home Point's crystal and its two ground rings have both; the aura shells
// and cross planes have neither and only scroll their UVs.
//
// autoRun (genFlags bit 0x10) is what separates an ambient entity's idle layers
// from its triggered ones: every generator in a Home Point's `aper` idle routine
// sets it, and every generator in its `bind` activation routine does not.
const GENERATOR_AUTORUN_BIT = 0x10;
const GENERATOR_FLAGS_OFFSET = 0x79;     // section-start relative
const GENERATOR_STREAM_TABLE = 0x80;     // section-start relative: 4x u32 offsets
const GENERATOR_OP_CAP = 256;

/** The four opcode streams of a 0x05, as `[, sec1, sec2, sec3, sec4]`. */
function generatorStreams(r, sec) {
  if (sec.start + GENERATOR_STREAM_TABLE + 16 > sec.end) return null;
  const view = r.view;
  const out = [null, [], [], [], []];
  for (let i = 0; i < 4; i++) {
    const off = view.getUint32(sec.start + GENERATOR_STREAM_TABLE + i * 4, true);
    if (!off) continue;
    const ops = out[i + 1];
    let p = sec.start + off;
    while (p + 4 <= sec.end && ops.length < GENERATOR_OP_CAP) {
      const cfg = view.getUint32(p, true);
      const op = cfg & 0xff;
      const words = (cfg >>> 8) & 0x1f;
      if (op === 0 || words === 0) break;
      ops.push({ op, at: p + 4, floats: words - 1 });
      p += words * 4;
    }
  }
  return out;
}

function streamFloats(view, streams, section, opcode, count) {
  for (const e of streams?.[section] || []) {
    if (e.op !== opcode) continue;
    if (e.floats < count) return null;
    const out = [];
    for (let i = 0; i < count; i++) out.push(view.getFloat32(e.at + i * 4, true));
    return out.every(Number.isFinite) ? out : null;
  }
  return null;
}

function streamByte(view, streams, section, opcode) {
  for (const e of streams?.[section] || []) {
    if (e.op === opcode && e.floats >= 1) return view.getUint8(e.at);
  }
  return null;
}

function streamHas(streams, section, opcode) {
  return (streams?.[section] || []).some((e) => e.op === opcode);
}

/** Rotate by ZYX Euler radians — the order xi-tools' trs_matrix uses. */
function eulerRotate(v, rot) {
  const [rx, ry, rz] = rot;
  const sx = Math.sin(rx), cx = Math.cos(rx);
  const sy = Math.sin(ry), cy = Math.cos(ry);
  const sz = Math.sin(rz), cz = Math.cos(rz);
  const c0 = [cy * cz, cy * sz, -sy];
  const c1 = [sx * sy * cz - cx * sz, sx * sy * sz + cx * cz, sx * cy];
  const c2 = [cx * sy * cz + sx * sz, cx * sy * sz - sx * cz, cx * cy];
  return [
    c0[0] * v[0] + c1[0] * v[1] + c2[0] * v[2],
    c0[1] * v[0] + c1[1] * v[1] + c2[1] * v[2],
    c0[2] * v[0] + c1[2] * v[1] + c2[2] * v[2],
  ];
}

// `0x1E` BlendFunc, same nibble decode as particle/ops/initializers.js. A
// generator that declares NO BlendFunc falls through to Src_One_Add — which is
// why the Home Point's aura, ground rings and cross planes are authored with a
// black-to-white vertex ramp: under additive, black is transparent.
function blendModeFrom(value) {
  if (value === null) return 'additive';
  if (((value >> 4) & 0x01) !== 0) return 'opaque';         // One_Zero
  switch (value & 0x0f) {
    case 0x4: return 'blend';                               // Src_InvSrc_Add
    case 0x6: return 'blend';                               // Zero_InvSrc_Add
    default: return 'additive';                             // Src_One_Add / RevSub
  }
}

function parseGenerator(r, sec, meshIds) {
  const bytes = r.bytes;
  const view = r.view;
  const body = sec.start;
  const autoRun = body + GENERATOR_FLAGS_OFFSET < sec.end
    ? (bytes[body + GENERATOR_FLAGS_OFFSET] & GENERATOR_AUTORUN_BIT) !== 0
    : false;

  let meshRef = null;
  let position = [0, 0, 0];
  for (let p = sec.dataStart; p + 20 <= sec.end; p++) {
    // Section ids come off walkSections through r.str(4), which strips trailing
    // spaces — so a reference to `"wa  "` has to be trimmed the same way or it
    // never matches the mesh it names.
    const id = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3])
      .replace(/ +$/, '');
    if (!id || !meshIds.has(id)) continue;
    if (meshRef === null) meshRef = id;
    const xyz = [view.getFloat32(p + 8, true), view.getFloat32(p + 12, true),
                 view.getFloat32(p + 16, true)];
    // A generator authored at its mesh's own origin writes (0,0,0) here and
    // still names the mesh — keep the reference, keep scanning for a position.
    if (xyz.every((v) => Number.isFinite(v) && Math.abs(v) < 1e5)
        && xyz.some((v) => Math.abs(v) > 0.01)) {
      position = xyz;
      meshRef = id;
      break;
    }
  }
  if (meshRef === null) return null;

  const streams = generatorStreams(r, sec);
  const sane = (v, lo, hi) => v.every((x) => Number.isFinite(x) && x >= lo && x <= hi);

  let scale = streamFloats(view, streams, 2, 0x0f, 3) ?? [1, 1, 1];
  if (!scale.every((v) => Number.isFinite(v) && v > 0 && v <= 100)) scale = [1, 1, 1];

  let rotation = streamFloats(view, streams, 2, 0x09, 3) ?? [0, 0, 0];
  if (!sane(rotation, -100, 100)) rotation = [0, 0, 0];

  // The rate alone turns nothing — sec3's 0x05 Rotation updater is what
  // integrates it each frame. Treat a rate with no updater as no spin.
  let spin = 0;
  if (streamHas(streams, 3, 0x05)) {
    const vel = streamFloats(view, streams, 2, 0x0b, 3);
    if (vel && sane(vel, -1, 1)) spin = vel[1];      // Y is the only axis retail uses
  }

  const uvScroll = [
    streamFloats(view, streams, 3, 0x27, 1)?.[0] ?? 0,
    streamFloats(view, streams, 3, 0x28, 1)?.[0] ?? 0,
  ].map((v) => (Number.isFinite(v) && Math.abs(v) < 1 ? v : 0));

  const blend = blendModeFrom(streamByte(view, streams, 2, 0x1e));
  return { name: sec.id, meshRef, position, scale, rotation, spin, uvScroll, autoRun, blend };
}

/**
 * Build renderable mesh groups for an entity whose geometry lives in its
 * effects. Each autorun generator contributes one group: its 0x1F mesh with the
 * generator's scale, static rotation and position baked into the vertices (the
 * renderer skins straight from `vertices`, there is no per-group transform).
 *
 * What is NOT baked is the motion. `spin` (radians per 60 Hz frame about Y) and
 * `uvScroll` ride along on the group for the renderer to apply per frame — see
 * `uEffectSpin` / `uUvOffset` in renderer.js. `pivot` is the point the spin
 * turns about: the generator's own position, not the model origin, so a layer
 * placed off-centre rotates rather than orbits.
 *
 * 0x21 sprite cards are left out — they are the billboard for ONE emitted
 * particle, so a static copy at the origin is a flat square through the middle
 * of the model rather than a layer of it. `particleMeshes` still carries them.
 */
function buildEffectLayers(particleMeshes, generators) {
  const groups = [];
  // ONLY autorun. A generator without the flag is fired by a routine, and a DAT
  // where none of them autorun (`ROM/3/27`, 29 generators over three routines)
  // has nothing to show at rest — the engine draws none of it until something
  // triggers it. Flattening them all into one static pile stacks every phase of
  // every routine on top of each other, which reads as one big lit quad, not as
  // the effect. Those play through the particle system instead; see the Effect
  // routine picker in AnimationPanel.
  const chosen = generators.filter((g) => g.autoRun);
  const seen = new Set();

  for (const gen of chosen) {
    const mesh = particleMeshes.get(gen.meshRef);
    if (!mesh || mesh.sectionType !== SectionType.ParticleMesh) continue;
    // Rotation belongs in the key: a Home Point's nak0/nak1 are ONE mesh at
    // 30 deg and 150 deg — the crossed planes inside the crystal — and differ
    // in nothing else, so keying on mesh+position+scale alone drops one of them.
    const key = [gen.meshRef, gen.position, gen.rotation, gen.scale].join('|');
    if (seen.has(key)) continue;
    seen.add(key);

    const [sx, sy, sz] = gen.scale;
    const [px, py, pz] = gen.position;
    const rot = gen.rotation || [0, 0, 0];
    const turned = !!(rot[0] || rot[1] || rot[2]);
    const place = (v) => {
      const s = [v[0] * sx, v[1] * sy, v[2] * sz];
      const q = turned ? eulerRotate(s, rot) : s;
      return [q[0] + px, q[1] + py, q[2] + pz];
    };

    groups.push({
      sectionId: mesh.sectionId,
      generator: gen.name,
      isEffectLayer: true,
      spin: gen.spin || 0,
      uvScroll: gen.uvScroll || [0, 0],
      pivot: gen.position,
      vertices: mesh.vertices.map((v) => particleVertex(
        place(v.p0),
        turned ? eulerRotate(v.n0, rot) : v.n0,     // scale is not applied to normals
      )),
      flippedVertices: null,
      pieces: mesh.pieces.map((p) => ({ ...p, alphaMode: gen.blend })),
      hasNormals: mesh.hasNormals,
      occludeType: 0,
    });
  }
  return groups;
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
  // 0x01/0x05/0x81 = paletted (same layout as 0x91); 0xa1 = DXT; 0xb1 = paletted+extra.
  if (type !== 0x01 && type !== 0x05 && type !== 0x81 && type !== 0x91 && type !== 0xa1 && type !== 0xb1) return null;

  const name = r.str(0x10);
  r.u32();                                // 0x28
  const width = r.i32();
  const height = r.i32();
  r.u16();                                // 0x01
  const bitCount = r.u16();
  r.skip(5 * 4);                          // zeros
  const paletteBits = r.u32();            // bits per palette entry: 0x10 / 0x20

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
    // Prototype zones may store the palette as 16-bit A1R5G5B5 (512 bytes)
    // instead of 32-bit BGRA (1024). Reading the narrow form as u32 scrambles
    // the colours and shifts the pixels by 512 bytes -- the bright-green
    // speckle on rom/0/33's gratest_sizenn / gratest_s00_jew.
    const palette = new Uint32Array(256);
    if (paletteBits === 0x10) {
      for (let i = 0; i < 256; i++) {
        const v = r.u16();
        const a = (v >>> 15) & 1 ? 0xff : 0x00;
        const cr = (((v >>> 10) & 0x1f) * 255 / 31) | 0;
        const cg = (((v >>> 5) & 0x1f) * 255 / 31) | 0;
        const cb = ((v & 0x1f) * 255 / 31) | 0;
        palette[i] = ((a << 24) | (cr << 16) | (cg << 8) | cb) >>> 0;
      }
    } else {
      for (let i = 0; i < 256; i++) palette[i] = r.u32();
    }
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
    if (!rot || !trans || !scale) {
      // A negative offset is not "joint not animated" — it is a RESET. The
      // client (XiClient MotionResource::ApplyBaseAnimation) sees the sign bit
      // on a non-base layer and writes identity rotation / zero translation /
      // unit scale to the bone, i.e. pins it to the bind pose. Clips lean on
      // this: Tachi: Shoha keys the hip offset on joint 2 and flags joint 1,
      // where Tachi: Enpi keys joint 1 and flags joint 2. Skipping the joint
      // instead let the battle-stance underlay drive joint 1 as well, and the
      // two offsets stacked — the body sank and the feet went through the
      // floor. Across 1,536 PC motion DATs the masked index is always 0 and no
      // sibling body-region part ever keys a joint another part flags.
      jointTracks.set(jointIndex, resetTrack());
      continue;
    }

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

/** One-frame identity track: the joint holds its bind pose for the clip. */
function resetTrack() {
  return {
    rotations: new Float32Array([0, 0, 0, 1]),
    translations: new Float32Array(3),
    scales: new Float32Array([1, 1, 1]),
    frames: 1,
    reset: true,
  };
}

// Offset semantics: 0 = constant, >0 = per-frame floats at base + offset*4,
// <0 = reset to bind (see parseAnimation).
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
