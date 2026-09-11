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

const EFFECT_ROUTINE = 0x07;
const CMD_SPAWN_GENERATOR = 0x02;   // ref is a generator DatId
/**
 * Ops that run another 0x07 routine (xi-docs fx/effect_system.md §3):
 * 0x03 on the source actor, 0x09 on the target, 0x3B/0x3C as a blocking child.
 * The blocking behaviour isn't modelled — for a standalone preview all of them
 * amount to "play that routine too, starting at this command's time".
 */
const CALL_OPS = new Set([0x03, 0x09, 0x3b, 0x3c, 0x57]);
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
  const empty = { commands: [], calls: [], sounds: [], anims: [] };
  if (section.size < 0x30) return empty;

  const sec2 = dv.getInt32(base + 0x14, true);   // command-list pointer (body-relative)
  const u16 = (o) => bytes[o] | (bytes[o + 1] << 8);

  const commands = [];
  const calls = [];
  const sounds = [];
  const anims = [];
  const regs = new Map();                        // bound as conditions are decided
  let stack = [];                                // operands awaiting the next 0x64
  let clock = 0;                                 // Σ delays of the entries BEFORE this one

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
    clock += u16(p + 4);
    if (p + 16 > end) return;
    const ref = cleanId(String.fromCharCode(bytes[p + 8], bytes[p + 9], bytes[p + 10], bytes[p + 11]));
    if (!/^[\x20-\x7e]{1,4}$/.test(ref)) return;
    if (op === CMD_SPAWN_GENERATOR) commands.push({ genId: ref, delay: at, dur: u16(p + 6) });
    else if (CALL_OPS.has(op)) calls.push({ routineId: ref, delay: at });
    else if (SOUND_OPS.has(op)) sounds.push({ soundId: ref, delay: at });
    else if (op === ANIM_OP) anims.push({ ref, delay: at, dur: u16(p + 6) });
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
  return { commands, calls, sounds, anims };
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
    const { commands, calls, sounds, anims } = parseRoutineCommands(bytes, dv, s);
    routines.push({
      id: cleanId(s.id) || 'main', commands, calls, sounds, anims, length: routineLength(commands),
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
 * @param {Object} routine        the routine to expand
 * @param {Map<string,Object>} byId      routines in this DAT
 * @param {Map<string,Object>} [globalById] routines in the shared effects DAT
 */
export function flattenRoutine(routine, byId, globalById = null) {
  const commands = [];
  const sounds = [];
  const anims = [];
  const actorCalls = [];
  const seen = new Set();

  const walk = (r, offset, depth) => {
    if (!r || depth > 8 || seen.has(r)) return;   // cycle / runaway guard
    seen.add(r);
    for (const c of r.commands) commands.push({ ...c, delay: c.delay + offset });
    for (const s of r.sounds) sounds.push({ ...s, delay: s.delay + offset });
    for (const a of r.anims ?? []) anims.push({ ...a, delay: a.delay + offset });
    for (const call of r.calls) {
      const next = byId.get(call.routineId) ?? globalById?.get(call.routineId) ?? null;
      if (!next) {
        // Neither this DAT nor the shared one has it — it is a schedule on the
        // ACTOR's own DAT. That is where the cast motions live: Fire calls
        // `shbk`, a Ninjutsu spell calls `shnj`, a cure calls `shwh`. Handing
        // the id up lets the caller resolve it against the loaded character.
        actorCalls.push({ scheduleId: call.routineId, delay: offset + call.delay });
        continue;
      }
      walk(next, offset + call.delay, depth + 1);
    }
  };
  walk(routine, 0, 0);

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
  return { commands, sounds: deduped, anims, actorCalls, length: routineLength(commands) };
}
