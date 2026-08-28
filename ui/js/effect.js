// Standalone effect (spell / ability / status) playback support.
//
// A spell-effect DAT (e.g. ROM/11/31.DAT "Aero V") is a directory of 0x05
// particle generators plus one 0x07 routine (usually `main`) that schedules
// them. The routine's command list is what AltanaViewer exposes as its
// "Schedule" dropdown; each 0x02 command spawns one generator at a start delay
// for an emit duration. Play the routine and the generators draw the effect.
//
// Every generator in these DATs is authored to attach to the target actor
// (attachType = TargetActor) and is not auto-running, so with no actor present
// they emit at the world origin for their scheduled window and then drain — no
// skeleton or actor rig is needed to preview them.

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

/** Trim trailing NUL/space so a routine ref compares like a DatId key. */
const cleanId = (s) => s.replace(/\0+$/, '').trimEnd();

/**
 * One 0x07 routine's command list. Ports the sec2 walk in dat.js parseRoutine,
 * but keeps the ops the effect runtime needs rather than the 0x05
 * (skeleton-animation) commands the pose system reads.
 *
 * Layout per entry: +0 op, +1 u16 sizeWords (low 5 bits), +4 u16 delay,
 * +6 u16 duration, +8 ref (4 chars).
 *
 * TIMING — delays are RELATIVE, not absolute: the header's totalDelay (@+0x1C)
 * equals the SUM of all sec2 delays on 26,329 of 26,832 retail routines
 * (98.1%), and equals the max (absolute reading) on zero. Every entry's delay —
 * including ops we don't act on — advances the running clock, and each delay
 * TRAILS its op: a command fires at the sum of the PRIOR entries' delays (see
 * the clock note in the loop; XiClient CMoSchedulerTask::OnMove).
 */
function parseRoutineCommands(bytes, dv, section) {
  const base = section.start + 0x10;             // dataStart
  const end = section.start + section.size;
  const empty = { commands: [], calls: [], sounds: [] };
  if (section.size < 0x30) return empty;

  const sec2 = dv.getInt32(base + 0x14, true);   // command-list pointer (body-relative)
  const u16 = (o) => bytes[o] | (bytes[o + 1] << 8);

  const commands = [];
  const calls = [];
  const sounds = [];
  let p = base + (sec2 - 16);
  let clock = 0;                                 // Σ delays of the entries BEFORE this one
  for (let guard = 0; guard < 256 && p + 8 <= end; guard++) {
    const op = bytes[p];
    const n = (bytes[p + 1] | (bytes[p + 2] << 8)) & 0x1f;
    const entryLen = Math.max(1, n) * 4;
    if (op === 0x00) break;

    // A tag executes IMMEDIATELY and its delay is the wait AFTER it, before the
    // next tag — XiClient CMoSchedulerTask::OnMove pumps
    //   field_98 += tag.delay; ExecuteTag();   (research/XIClient …/CMoSchedulerTask.cpp:75)
    // and CYyScheduler::CalcTotalFrame measures each window from the sum of the
    // PRIOR delays. Attaching the delay before its own op instead played
    // Banishga V's impact sound 65 ticks (1.08s) late while the small generator
    // delays hid the same error visually.
    const at = clock;
    clock += u16(p + 4);

    if (p + 16 <= end) {
      const ref = cleanId(String.fromCharCode(bytes[p + 8], bytes[p + 9], bytes[p + 10], bytes[p + 11]));
      if (/^[\x20-\x7e]{1,4}$/.test(ref)) {
        if (op === CMD_SPAWN_GENERATOR) commands.push({ genId: ref, delay: at, dur: u16(p + 6) });
        else if (CALL_OPS.has(op)) calls.push({ routineId: ref, delay: at });
        else if (SOUND_OPS.has(op)) sounds.push({ soundId: ref, delay: at });
      }
    }
    p += entryLen;
  }
  return { commands, calls, sounds };
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
    const { commands, calls, sounds } = parseRoutineCommands(bytes, dv, s);
    routines.push({
      id: cleanId(s.id) || 'main', commands, calls, sounds, length: routineLength(commands),
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
  const seen = new Set();

  const walk = (r, offset, depth) => {
    if (!r || depth > 8 || seen.has(r)) return;   // cycle / runaway guard
    seen.add(r);
    for (const c of r.commands) commands.push({ ...c, delay: c.delay + offset });
    for (const s of r.sounds) sounds.push({ ...s, delay: s.delay + offset });
    for (const call of r.calls) {
      const next = byId.get(call.routineId) ?? globalById?.get(call.routineId) ?? null;
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
  return { commands, sounds: deduped, length: routineLength(commands) };
}
