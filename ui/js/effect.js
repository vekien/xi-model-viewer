// Standalone effect (spell / ability / status) playback support.
//
// A spell-effect DAT (e.g. ROM/11/31.DAT "Aero V") is a directory of 0x05
// particle generators plus one 0x07 routine (usually `main`) that schedules
// them. The routine's command list is what AltanaViewer exposes as its
// "Schedule" dropdown; each 0x02 command spawns one generator at a start delay
// for an emit duration. Play the routine and the generators draw the effect.
//
// Each 0x05 generator carries attachType in attachFlags (low 4 bits): None,
// SourceActor, TargetActor, joints, etc. Spell gens are almost always
// TargetActor (actor root / feet); authored basePosition and GroundProjection
// (0x42) / decal place the visual on the ground or body. With no actor they
// emit at the world origin for their scheduled window and then drain.

import { parseSections } from './zone.js';
import { VIS_OPS, readVisCommand } from './weaponVis.js';

const EFFECT_ROUTINE = 0x07;
const CMD_SPAWN_GENERATOR = 0x02;   // ref is a generator DatId
/**
 * Ops that run another 0x07 routine (xi-docs fx/effect_system.md §3):
 * 0x03 on the source actor, 0x09 on the target, 0x3B/0x3C as a blocking child.
 * Each plays that routine too, from this command's time; a blocking one also
 * holds the rest of its own routine until that routine ends (BLOCKING_OPS).
 */
const CALL_OPS = new Set([0x03, 0x09, 0x3b, 0x3c, 0x57]);
/**
 * Links that hold their routine: 0x3B (this DAT, then the shared one) and 0x3C
 * (the caster's own files) run the routine they name and suspend the one they
 * are in until it ends — YmParentTask::Suspend in the PS2 client's tag handler,
 * resumed from the child's destructor (ymschdecript.cpp, ymsch.cpp). Everything
 * after the link runs that much later: every retail spell opens with `3C sh··`,
 * which waits out `wash`'s 60 ticks, so the rest of its `main` lands about 61
 * ticks after the frame the DAT gives it.
 */
export const BLOCKING_OPS = new Set([0x3b, 0x3c]);
/** Links that look on the caster's own files (0x57 after them, the shared DAT). */
export const CASTER_OPS = new Set([0x3c, 0x57]);
/**
 * SoundEffect ops (effect_system.md §3: positioned / player-only / nearest /
 * global variants). A ref that doesn't resolve to a 0x3D pointer is skipped.
 */
const SOUND_OPS = new Set([0x0a, 0x0b, 0x4a, 0x53, 0x60]);
/**
 * SkeletonAnimation on the CASTER — the same op dat.js parseRoutine reads for
 * entity schedules. The ref is a clip tag, often wildcarded (`ma2?`), and
 * resolves against whatever animations the loaded character has: a Ninjutsu DAT
 * names its own motion and a nuke names its own, so nothing is mapped by hand.
 *
 * (0x09 is the target-side counterpart, but its refs — `chit`, `lhit`, `stnd` —
 * are 0x07 SCHEDULE ids on the target's own DAT, not clips, so it stays a call
 * op above rather than being read here.)
 */
const ANIM_OP = 0x05;
const DAMPEN_OP = 0x1e;   // DampenGenerator: end a generator (and its audio) now

/**
 * Control flow. sec2 is a PROGRAM, not a list: 0x69/0x6A bracket a block,
 * 0x64/0x67 are if/else over operands 0x6B pushes, and 0x3D/0x3E bracket a set
 * of siblings the engine picks exactly ONE of at random (effect_system.md §3).
 *
 * Walking it flat ran every branch at once. A dual-wield swing reaches the
 * shared damage dispatcher (`atl0` → `dada`), whose `atpr` tests the weapon
 * type against 0…23 in an if/else chain and whose `crtl` picks one of two
 * criticals — so all of them fired together: 149 generators on one hit, on top
 * of `vatk` playing all seven attack grunts simultaneously.
 *
 * The brackets are trustworthy: across the 103,351 retail 0x07 routines in the
 * effect DATs and every race's motion packs, 0x69/0x6A and 0x3D/0x3E balance in
 * every single one, and none overruns the 256-entry guard.
 */
const BLOCK_OPEN = 0x69;
const BLOCK_CLOSE = 0x6a;
const RANDOM_OPEN = 0x3d;    // exactly one entry between these two runs
const RANDOM_CLOSE = 0x3e;
const OP_IF = 0x64;
const OP_ELSE = 0x67;
const OP_PUSH = 0x6b;        // operand / operator for the next 0x64
const CMP_EQUAL = 0x0c;      // 46 of the 48 comparisons in ROM/0/0.DAT

/** Trim trailing NUL/space so a routine ref compares like a DatId key. */
const cleanId = (s) => s.replace(/\0+$/, '').trimEnd();

/**
 * The entry stream, flat: `+0 op, +1 u16 sizeWords (low 5 bits), +4 u16 delay,
 * +6 u16 duration, +8 ref (4 chars)`, advancing by max(1, sizeWords) * 4 until
 * op 0x00. The 256 guard is the same runaway stop the flat walk always had.
 */
function readEntries(bytes, start, end) {
  const entries = [];
  let p = start;
  for (let guard = 0; guard < 256 && p + 8 <= end; guard++) {
    const op = bytes[p];
    if (op === 0x00) break;
    const n = (bytes[p + 1] | (bytes[p + 2] << 8)) & 0x1f;
    entries.push({ op, p });
    p += Math.max(1, n) * 4;
  }
  return entries;
}

/**
 * Nest the flat entries on their bracket pairs. A close with nothing open is
 * dropped rather than unwinding past the top — no retail routine does it.
 */
function nestBlocks(entries) {
  const root = [];
  const stack = [root];
  for (const e of entries) {
    if (e.op === BLOCK_CLOSE || e.op === RANDOM_CLOSE) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    stack[stack.length - 1].push(e);
    if (e.op === BLOCK_OPEN || e.op === RANDOM_OPEN) {
      e.body = [];
      stack.push(e.body);
    }
  }
  return root;
}

/**
 * One 0x6B: a 16-byte entry is an operand (`u16 0x1C` type, `u16 kind`, `u16
 * value` — kind 3 reads scheduler register `value`, kind 1 is the literal); a
 * 12-byte one is the operator.
 */
function readOperand(p, u16) {
  return { kind: u16(p + 10), value: u16(p + 12), operator: u16(p + 8) };
}

/**
 * Decide one 0x64.
 *
 * The registers hold combat state the server sends — which weapon type landed,
 * how hard, whether it critted — and a viewer with no target has none of it. So
 * a condition that can't be settled takes the FIRST branch: showing an effect
 * beats showing nothing.
 *
 * `regs` is what makes that one branch rather than several. The chains are
 * switches (`atpr`: weapon type == 0, == 1, == 2, … == 23), so binding the
 * register to the literal of the case we take leaves every later case in the
 * chain honestly false, and one hit effect plays instead of all twenty-four.
 */
function decideCondition(stack, regs) {
  if (stack.length !== 3) return true;
  const [lhs, rhs, cmp] = stack;
  if (lhs.kind !== 3 || rhs.kind !== 1 || cmp.operator !== CMP_EQUAL) return true;
  const have = regs.get(lhs.value);
  if (have === undefined) { regs.set(lhs.value, rhs.value); return true; }
  return have === rhs.value;
}

/**
 * One 0x07 routine's command list. Ports the sec2 walk in dat.js parseRoutine,
 * but keeps the ops the effect runtime needs rather than the 0x05
 * (skeleton-animation) commands the pose system reads.
 *
 * TIMING — delays are RELATIVE, not absolute: the header's totalDelay (@+0x1C)
 * equals the SUM of all sec2 delays on 26,329 of 26,832 retail routines
 * (98.1%), and equals the max (absolute reading) on zero. Every entry's delay —
 * including ops we don't act on — advances the running clock, and each delay
 * TRAILS its op: a command fires at the sum of the PRIOR entries' delays (see
 * the clock note on `emit`; XiClient CMoSchedulerTask::OnMove). Only entries
 * that actually RUN advance it, so taking case 1 of a 24-case chain no longer
 * inherits the other 23 cases' waits.
 */
function parseRoutineCommands(bytes, dv, section) {
  const base = section.start + 0x10;             // dataStart
  const end = section.start + section.size;
  const empty = { commands: [], calls: [], sounds: [], anims: [], stops: [], vis: [], total: 0 };
  if (section.size < 0x30) return empty;

  const sec2 = dv.getInt32(base + 0x14, true);   // command-list pointer (body-relative)
  const u16 = (o) => bytes[o] | (bytes[o + 1] << 8);

  const commands = [];
  const calls = [];
  const sounds = [];
  const anims = [];
  const stops = [];
  const vis = [];                                // weapon show/hide tags (weaponVis.js)
  const regs = new Map();                        // bound as conditions are decided
  let stack = [];                                // operands awaiting the next 0x64
  let clock = 0;                                 // Σ delays of the entries BEFORE this one
  // The order entries run in. Two on one tick run in list order, which is what
  // decides whether a blocking link holds the other (flattenRoutine).
  let seq = 0;

  // A tag executes IMMEDIATELY and its delay is the wait AFTER it, before the
  // next tag — XiClient CMoSchedulerTask::OnMove pumps
  //   field_98 += tag.delay; ExecuteTag();   (research/XIClient …/CMoSchedulerTask.cpp:75)
  // and CYyScheduler::CalcTotalFrame measures each window from the sum of the
  // PRIOR delays. Attaching the delay before its own op instead played
  // Banishga V's impact sound 65 ticks (1.08s) late while the small generator
  // delays hid the same error visually.
  const emit = (node) => {
    const { op, p } = node;
    const at = clock;
    const s = seq++;
    clock += u16(p + 4);
    // Before the ref check: these tags carry numbers where the others carry an id.
    if (VIS_OPS.has(op)) {
      const v = readVisCommand(bytes, p, op, at, end);
      if (v) vis.push({ ...v, seq: s });
      return;
    }
    if (p + 16 > end) return;
    const ref = cleanId(String.fromCharCode(bytes[p + 8], bytes[p + 9], bytes[p + 10], bytes[p + 11]));
    if (!/^[\x20-\x7e]{1,4}$/.test(ref)) return;
    if (op === CMD_SPAWN_GENERATOR) commands.push({ genId: ref, delay: at, dur: u16(p + 6), seq: s });
    else if (CALL_OPS.has(op)) calls.push({ routineId: ref, delay: at, op, seq: s });
    else if (SOUND_OPS.has(op)) sounds.push({ soundId: ref, delay: at, seq: s });
    else if (op === ANIM_OP) {
      // transIn/transOut are the scheduler's blend windows in ticks (u16 @+24 /
      // @+28), maxLoops @+30 (0 = loop forever).
      const long = p + 32 <= end;
      anims.push({
        ref, delay: at, dur: u16(p + 6),
        transIn: long ? u16(p + 24) : 0, transOut: long ? u16(p + 28) : 0, loops: long ? u16(p + 30) : 1, seq: s,
      });
    } else if (op === DAMPEN_OP) stops.push({ genId: ref, delay: at, seq: s });
  };

  const run = (nodes) => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const { op, p } = node;

      if (op === OP_PUSH) { clock += u16(p + 4); stack.push(readOperand(p, u16)); continue; }

      if (op === BLOCK_OPEN) { clock += u16(p + 4); run(node.body); continue; }

      if (op === RANDOM_OPEN) {
        // The engine rolls each time it runs the routine; we parse once, so the
        // roll happens here and holds until the next load. Always taking the
        // first would make `vatk` silent forever — three of its seven options
        // are the no-op that leaves a swing quiet.
        clock += u16(p + 4);
        if (node.body.length) run([node.body[Math.floor(Math.random() * node.body.length)]]);
        continue;
      }

      if (op === OP_IF) {
        clock += u16(p + 4);
        const taken = decideCondition(stack, regs);
        stack = [];
        let j = i + 1;
        const thenBlock = nodes[j]?.op === BLOCK_OPEN ? nodes[j++] : null;
        let elseBlock = null;
        if (nodes[j]?.op === OP_ELSE) {
          clock += u16(nodes[j].p + 4);
          j += 1;
          if (nodes[j]?.op === BLOCK_OPEN) elseBlock = nodes[j++];
        }
        const branch = taken ? thenBlock : elseBlock;
        if (branch) { clock += u16(branch.p + 4); run(branch.body); }
        i = j - 1;
        continue;
      }

      emit(node);
    }
  };

  run(nestBlocks(readEntries(bytes, base + (sec2 - 16), end)));
  // `total`: where the routine's own clock ends, the tick it ends on when nothing
  // holds it (the header's totalDelay on 98% of retail routines).
  return { commands, calls, sounds, anims, stops, vis, total: clock };
}

/** Frames the routine spans, from its last generator's start + emit window. */
function routineLength(commands) {
  let len = 1;
  for (const c of commands) len = Math.max(len, c.delay + Math.max(c.dur, 1));
  return len;
}

/**
 * Every 0x07 routine in an effect DAT, in DAT order. The first is normally
 * `main`; a few effects carry alternates (`mai0`, `tgt0`, …).
 */
export function parseEffectRoutines(buf) {
  const bytes = new Uint8Array(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const routines = [];
  for (const s of parseSections(dv)) {
    if (s.typeCode !== EFFECT_ROUTINE) continue;
    const { commands, calls, sounds, anims, stops, vis, total } = parseRoutineCommands(bytes, dv, s);
    routines.push({
      id: cleanId(s.id) || 'main', commands, calls, sounds, anims, stops, vis, total, length: routineLength(commands),
    });
  }
  return routines;
}

/**
 * Resolve a routine into everything it actually plays, following its 0x03 calls.
 *
 * A `main` routine very often spawns nothing itself and just invokes another
 * routine — Cure's `main` is only a sound plus `0x03 tgt0`, and `tgt0` holds all
 * seven generators. (That indirection is what AltanaViewer surfaces as "play
 * target's schedules".) Across every effect DAT, 1482 first-routines have no
 * 0x02 of their own; following 0x03 recovers 740 of them locally, and more via
 * the shared ROM/0/0.DAT routines (`mdam`, `stnm`, `dada`, …).
 *
 * Nested delays add up, so a call at delay 3 shifts everything it plays by 3.
 *
 * A blocking link (BLOCKING_OPS) holds the rest of the routine it is in until the
 * routine it runs has ended (routineTicks), so what comes after it in that routine
 * — and everything that plays — runs that many ticks later: the delays here are
 * when things play, not the frames the DAT writes. `holds` lists the top routine's
 * own, `{ at, ticks, ref, op }` with `at` its frame in the DAT. A `3C sh··` runs on
 * the caster, so only `actorTicks(scheduleId)` knows how long it holds (the stage
 * character's routine; nothing is held without one).
 *
 * @param {Object} routine        the routine to expand
 * @param {Map<string,Object>} byId      routines in this DAT
 * @param {Map<string,Object>} [globalById] routines in the shared effects DAT
 * @param {{ actorTicks?: (id: string) => number|null }} [opts]
 */
export function flattenRoutine(routine, byId, globalById = null, { actorTicks = null } = {}) {
  const commands = [];
  const sounds = [];
  const anims = [];
  const stops = [];
  const vis = [];
  const actorCalls = [];
  const holds = [];
  const seen = new Set();

  // Where a blocking link finds its routine, as the client looks: 0x3B in this
  // DAT then the shared one, 0x3C on the caster alone. One it cannot find is
  // logged and skipped, and holds nothing.
  const find = (id, op) => (op === 0x3c ? (actorTicks?.(id) ?? null) : (byId.get(id) ?? globalById?.get(id) ?? null));
  const ticksOf = new Map();
  const holdOf = (call) => {
    if (!BLOCKING_OPS.has(call.op)) return 0;
    const key = `${call.op}:${call.routineId}`;
    if (!ticksOf.has(key)) {
      const r = find(call.routineId, call.op);
      ticksOf.set(key, typeof r === 'number' ? Math.max(0, r) : routineTicks(r, find));
    }
    return ticksOf.get(key);
  };

  // `via`: on everything a link out of this DAT plays (into the shared DAT, or
  // a schedule on the actor), the id that link named, the outermost one. The
  // Ability Mixer keeps a link whole on one lane (sharedLinkLane, laneSlice).
  const walk = (r, offset, depth, via) => {
    if (!r || depth > 8 || seen.has(r)) return;   // cycle / runaway guard
    seen.add(r);
    const tag = via ? { via } : null;
    // This routine's own holds: each delays what runs after it here, in list
    // order (a routine that parses without it falls back to its tick).
    const own = (r.calls ?? []).filter((c) => BLOCKING_OPS.has(c.op)).map((c) => ({ c, ticks: holdOf(c) })).filter((h) => h.ticks > 0);
    const after = (h, x) => (x.seq != null && h.c.seq != null ? x.seq > h.c.seq : x.delay > h.c.delay);
    const at = (x) => own.reduce((n, h) => (after(h, x) ? n + h.ticks : n), x.delay + offset);
    if (depth === 0) for (const h of own) holds.push({ at: h.c.delay, ticks: h.ticks, ref: h.c.routineId, op: h.c.op });
    for (const c of r.commands) commands.push({ ...c, delay: at(c), ...tag });
    for (const s of r.sounds) sounds.push({ ...s, delay: at(s), ...tag });
    for (const a of r.anims ?? []) anims.push({ ...a, delay: at(a), ...tag });
    for (const st of r.stops ?? []) stops.push({ ...st, delay: at(st), ...tag });
    for (const v of r.vis ?? []) vis.push({ ...v, delay: at(v), ...tag });
    for (const call of r.calls) {
      const local = byId.has(call.routineId);
      const next = call.op === 0x3c ? null : (byId.get(call.routineId) ?? globalById?.get(call.routineId) ?? null);
      if (!next) {
        // Neither this DAT nor the shared one has it — it is a schedule on the
        // ACTOR's own DAT. That is where the cast motions live: Fire calls
        // `shbk`, a Ninjutsu spell calls `shnj`, a cure calls `shwh`. Handing
        // the id up lets the caller resolve it against the loaded character;
        // `op` says whether the game would look there at all (CASTER_OPS).
        actorCalls.push({ scheduleId: call.routineId, delay: at(call), via: via ?? call.routineId, op: call.op });
        continue;
      }
      walk(next, at(call), depth + 1, via ?? (local ? null : call.routineId));
    }
  };
  walk(routine, 0, 0, null);

  // Several ops can name the same sound a frame or two apart (Cure's `main`
  // carries 0303 on both 0x53 and 0x0b), which would fire the one-shot twice and
  // flam. Keep the earliest of each cluster.
  sounds.sort((a, b) => a.delay - b.delay);
  const deduped = [];
  for (const s of sounds) {
    const clash = deduped.some((d) => d.soundId === s.soundId && s.delay - d.delay <= 4);
    if (!clash) deduped.push(s);
  }

  // Delays/durations stay in raw scheduler ticks: the whole effect engine —
  // routines, generators, particles — runs on one 60 ticks/second clock
  // (particle/math.js FPS), so no unit conversion happens here. The only 2:1
  // seam in the system is model animation clips (30fps), handled where
  // schedules meet clips in dat.js resolveScheduleClip.
  anims.sort((a, b) => a.delay - b.delay);
  actorCalls.sort((a, b) => a.delay - b.delay);
  vis.sort((a, b) => a.delay - b.delay);
  return { commands, sounds: deduped, anims, stops, vis, actorCalls, holds, length: routineLength(commands) };
}

/**
 * How long a routine runs before it ends, in ticks: its own clock (`total`, the
 * sum of its delays — a routine ends when its list runs out) plus the hold of every
 * blocking link in it. `find(id, op)` gives what a blocking link reaches: a routine
 * (anything with `total` and `calls`: parseEffectRoutines', or a character's
 * schedule from dat.js), its ticks when they are known another way, or null when it
 * reaches nothing (the game logs the name and goes on without waiting). `wash` is
 * 60; a race's `shbk` is 61 — one tick, then it waits for `wash`.
 */
export function routineTicks(routine, find, seen = new Set()) {
  if (!routine || typeof routine !== 'object' || seen.has(routine) || seen.size > 8) return 0;
  const inner = new Set(seen).add(routine);
  let ticks = Math.max(0, Number(routine.total) || 0);
  for (const c of routine.calls ?? []) {
    if (!BLOCKING_OPS.has(c.op)) continue;
    const t = find(c.routineId, c.op);
    ticks += typeof t === 'number' ? Math.max(0, t) : routineTicks(t, find, inner);
  }
  return ticks;
}

/**
 * The Ability Mixer lane a link out of a DAT goes on. A link runs its routine
 * whole, so it takes one lane, by what that routine plays: any visual generator
 * is `vfx` (eis1, the weapon-skill burst, even with its impact sound in it);
 * else a sound or an audio generator is `sound`; else a clip or a call into the
 * actor's schedules is `motion`. A routine the shared DAT does not have is one
 * of those actor schedules (a cast motion: shbk, shnj), so `motion`. Nothing the
 * stage plays (mdam, proc) is `keep`.
 *
 * @param {string} routineId
 * @param {Map<string,Object>|null} globalById  the shared DAT's routines
 * @param {(genId: string) => boolean} isAudioGen  a generator that emits sound, not particles
 */
export function sharedLinkLane(routineId, globalById, isAudioGen) {
  if (!globalById?.size) return 'keep';
  const r = globalById.get(routineId);
  if (!r) return 'motion';
  const flat = flattenRoutine(r, globalById, globalById);
  if (flat.commands.some((c) => !isAudioGen(c.genId))) return 'vfx';
  if (flat.commands.length || flat.sounds.length) return 'sound';
  if (flat.anims.length || flat.actorCalls.length) return 'motion';
  return 'keep';
}

/**
 * The part of a flattened routine that one Ability Mixer lane takes: exactly
 * what a pick onto that lane brings (mixer.js eventsFromInspect), so a preview
 * on the lane plays the same thing. The DAT's own commands go by kind: `motion`
 * its clips and actor calls, `vfx` its visual generators, `sound` its sounds and
 * audio generators. Everything a link plays goes with the link, on the lane
 * `linkLane(via)` gives it.
 */
export function laneSlice(flat, lane, { isAudioGen, linkLane }) {
  const takes = (x, own) => (x.via ? linkLane(x.via) === lane : own);
  const commands = flat.commands.filter((c) => takes(c, lane !== 'motion' && isAudioGen(c.genId) === (lane === 'sound')));
  const ownGens = new Set(commands.filter((c) => !c.via).map((c) => c.genId));
  return {
    ...flat,
    commands,
    sounds: flat.sounds.filter((s) => takes(s, lane === 'sound')),
    stops: (flat.stops ?? []).filter((st) => takes(st, ownGens.has(st.genId))),
    anims: (flat.anims ?? []).filter((a) => takes(a, lane === 'motion')),
    actorCalls: (flat.actorCalls ?? []).filter((a) => takes(a, lane === 'motion')),
  };
}
