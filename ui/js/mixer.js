// Ability Mixer — recipe model, catalog, timeline math, and the xi-tools bridge.
//
// A recipe is what `xi ability compose` reads (xi-tools docs/ability/inspect.md):
//   { name, sources: { lane: { spec, routine } }, events: [{ from, op, ref, start, dur, ... }] }
// The mixer keeps the recipe as plain data and derives the timeline view from it,
// so Save writes exactly what Play composes.

import { backend } from './backend.js';
import { loadListOrNull } from './lists.js';

export const LANES = [
  { id: 'motion', label: 'Motion', color: '#3FBDBB', ops: new Set([0x05, 0x2c, 0x76, 0x77, 0x79, 0x8c, 0xa4, 0xa5]) },
  { id: 'vfx', label: 'Effects', color: '#D97BC4', ops: new Set([0x02, 0x3f, 0x1e, 0x2d]) },
  { id: 'sound', label: 'Sound', color: '#E0A83E', ops: new Set([0x0a, 0x0b, 0x4a, 0x53, 0x60, 0x8a, 0x8b]) },
];
export const LANE_BY_ID = new Map(LANES.map((l) => [l.id, l]));
export const KEEP_LANE = { id: 'keep', label: 'Locks · hits · links', color: '#8B949A' };

/** Viewer race id (characters.json) → xi race name (RACE_NAMES). Tarutaru is one skeleton. */
export const RACE_TO_XI = {
  HumeM: 'HumeMale', HumeF: 'HumeFemale', ElvaanM: 'ElvaanMale', ElvaanF: 'ElvaanFemale',
  Tarutaru: 'TaruMale', Mithra: 'Mithra', Galka: 'Galka',
};

const OP_NAMES = {
  0x02: 'Generator', 0x03: 'Link', 0x05: 'Clip', 0x09: 'Link (target)', 0x0a: 'Sound', 0x0b: 'Sound (target)',
  0x1e: 'Dampen', 0x20: 'Lock status', 0x21: 'Flinch', 0x23: 'Spawn doll', 0x25: 'Flinch', 0x2c: 'Weapon trace',
  0x2d: 'Stop gen', 0x2e: 'Lock control', 0x2f: 'Lock rotation', 0x3b: 'Link (blocking)', 0x3c: 'Link (blocking)',
  0x3f: 'Transition', 0x4a: 'Sound (player)', 0x53: 'Sound (target)', 0x56: 'Lock target', 0x57: 'Link',
  0x59: 'Lock magic', 0x5e: 'Knockback', 0x60: 'Sound', 0x2a: 'Actor fade', 0x29: 'Actor fade',
};
export const opName = (op) => OP_NAMES[op] ?? `op${op.toString(16).padStart(2, '0').toUpperCase()}`;

/** Which mixer lane an inspector event belongs to (by opcode); everything else is "keep". */
export function laneForOp(op) {
  for (const l of LANES) if (l.ops.has(op)) return l.id;
  return 'keep';
}

/** Lane for a flattened inspector event: an audio generator (a 0x02 whose generator
 *  names a sound pointer — how spells and job abilities play their sound) is sound. */
export function laneForEvent(e) {
  // An audio generator (0x02) and the DampenGenerator (0x1E) that ends it both
  // belong to the sound lane: retail sustains a charge-up sound with the
  // generator and cuts it with the dampen, so the pair must travel together.
  if ((e.op === 0x02 || e.op === 0x1e) && e.detail?.sound) return 'sound';
  return laneForOp(e.op);
}

// ── Recipe ──────────────────────────────────────────────────────────────────────

/** schema/ability_recipe.json in xi-tools — what compose, publish and dats prepare validate against. */
export const RECIPE_SCHEMA = 'xi.ability.v1';

export function emptyRecipe(name = 'new_ability') {
  return { name, sources: {}, events: [] };
}

let evSeq = 0;
/** Give every event a stable client-side id (not written to the recipe file). */
export function withIds(events) {
  return events.map((e) => (e._id ? e : { ...e, _id: `e${++evSeq}` }));
}

/** Strip client-only fields before writing the recipe file. */
export function serializeRecipe(recipe) {
  const events = recipe.events
    .filter((e) => e.enabled !== false)
    .map(({ _id, enabled, label, kind, sound, ...rest }) => rest);
  return JSON.stringify({ schema: RECIPE_SCHEMA, ...recipe, events }, null, 2);
}

/**
 * Turn an `xi ability inspect --json` result into recipe events for one lane.
 * Only events that live in the root routine are taken (linked local routines are
 * carried whole by their link command, exactly as compose does).
 */
const LINK_OPS = new Set([0x03, 0x09, 0x3b, 0x3c, 0x57]);

export function eventsFromInspect(info, lane, opts = {}) {
  const wantKeep = opts.keep !== false;
  const out = [];
  for (const e of info.timeline) {
    // The inspector already expands local sub-routines at absolute frames, so
    // their commands are taken individually and the link itself is dropped —
    // a link would carry the whole sub-routine, effects and all, into every
    // lane. Links the DAT cannot satisfy (mdam, proc, eis1…) stay: they are
    // the client's shared routines.
    if (LINK_OPS.has(e.op) && e.detail?.local) continue;
    const laneOf = laneForEvent(e);
    if (laneOf !== lane && !(wantKeep && laneOf === 'keep')) continue;
    out.push({
      from: lane,
      op: e.op,
      ref: e.ref,
      start: e.start,
      dur: e.dur || undefined,
      routine: e.routine,
      offset: e.offset,
      raw: e.raw,
      sound: e.detail?.sound?.sound_id,   // for the timeline's click-to-preview
      kind: laneOf,
      label: e.summary || e.name,
      name: e.name,
      enabled: true,
    });
  }
  return withIds(out);
}

/**
 * ref → sound id for everything in an inspect result that plays a sound: the
 * sound commands (their ref is the pointer section, whose name is not always
 * the id — Raging Rush's `8049` plays se018049) and the audio generators.
 * Used to backfill `sound` on events of recipes saved without it.
 */
export function soundIdsFromInfo(info) {
  const out = new Map();
  for (const e of info?.timeline ?? []) {
    const id = e.detail?.sound?.sound_id;
    if (id != null && e.ref) out.set(e.ref, id);
  }
  return out;
}

/** Absolute end of the timeline (last start or start+dur). */
export function recipeLength(events) {
  let end = 0;
  for (const e of events) end = Math.max(end, e.start + (e.dur || 0));
  return end;
}

/** The strike frame: the first hit/impact-ish event in the motion lane, else the first
 *  generator, else 0. The mixer shows it as the snap target for the other lanes. */
export function strikeFrame(events) {
  const motion = events.filter((e) => e.from === 'motion');
  const hit = motion.find((e) => e.op === 0x25 || e.op === 0x21 || e.op === 0x2c)
    ?? motion.find((e) => e.op === 0x03 && e.ref === 'mdam');
  if (hit) return hit.start;
  const gen = events.find((e) => e.op === 0x02);
  return gen ? gen.start : 0;
}

/** Shift every event of a lane by `delta` frames (clamped at 0). */
export function shiftLane(events, lane, delta) {
  return events.map((e) => (e.from === lane ? { ...e, start: Math.max(0, e.start + delta) } : e));
}

// ── Catalog ─────────────────────────────────────────────────────────────────────

/** The list file `xi mv update --only abilities` bakes (`{ races, entries }`). */
export const CATALOG_LIST = 'abilities.json';

/**
 * The pick list, through the same door as every other list: the copy
 * downloaded into the viewer's lists folder, else the one baked into the build.
 * Null when neither exists (an install older than the list, and no build yet).
 * `fresh` reads the downloaded copy directly, for right after Build catalog
 * wrote it — the lists door caches its directory listing per session.
 */
export async function loadCatalog({ fresh = false } = {}) {
  if (fresh) {
    try {
      const dir = await backend.listsDir();
      const text = dir ? await backend.readTextFile(joinPath(dir, CATALOG_LIST)) : '';
      if (text) return JSON.parse(text);
    } catch { /* fall through to the lists door */ }
  }
  const cat = await loadListOrNull(CATALOG_LIST);
  return cat && Array.isArray(cat.entries) ? cat : null;
}

/** `xi mv update --only abilities --lists <viewer lists folder>` — the bake, written
 *  where the viewer reads downloaded lists from (falls back to xi-tools' mv/lists). */
export async function buildCatalogArgs() {
  const args = ['mv', 'update', '--only', 'abilities'];
  let dir = null;
  try { dir = await backend.listsDir(); } catch { dir = null; }
  if (dir) args.push('--lists', dir);
  return args;
}

const joinPath = (dir, name) => `${dir}${dir.includes('\\') ? '\\' : '/'}${name}`;

/** Filter catalog entries by kind chips and a text query; ranked by name match. */
export function filterCatalog(entries, { query = '', kinds = null, lane = null, limit = 400 } = {}) {
  const q = query.trim().toLowerCase();
  const out = [];
  for (const e of entries) {
    if (kinds && kinds.size && !kinds.has(e.kind)) continue;
    if (lane === 'sound' && !(e.sounds?.length || e.audio_gens?.length)) continue;
    if (lane === 'vfx' && !(e.gens?.length)) continue;
    if (q) {
      const hay = `${e.name} ${(e.names || []).join(' ')} ${e.spec} ${e.path}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

/** The DAT to preview for an entry on the given viewer race. */
export function entryPathForRace(entry, viewerRace) {
  if (entry.paths) {
    const xi = RACE_TO_XI[viewerRace] ?? 'HumeMale';
    return entry.paths[xi] ?? entry.path;
  }
  return entry.path;
}

// ── xi bridge ───────────────────────────────────────────────────────────────────

/** Run `xi <args>` and parse its stdout as JSON (streaming so it can be cancelled). */
export async function xiJson(args, xiPath, env, onLine) {
  const lines = [];
  const code = await backend.xiRunStream(args, xiPath, env, (line) => {
    lines.push(line);
    onLine?.(line);
  });
  const text = lines.join('\n');
  if (code && code !== 0) throw new Error(`xi ${args[0]} ${args[1] ?? ''} failed (${code}): ${text.slice(-400)}`);
  const value = firstJsonValue(text);
  if (value === undefined) throw new Error(`xi ${args.join(' ')} printed no JSON`);
  return value;
}

/**
 * The first complete JSON value in `text`, or undefined when there is none.
 *
 * The runner hands back stdout and stderr together — the Tauri stream emits
 * both as `xi-log` lines, the dev server concatenates them — so a uv warning or
 * a Python notice can land before, between or after the JSON. Parsing the whole
 * text fails with "non-whitespace character after JSON"; walking to the value's
 * own closing bracket (string-aware, so a `}` inside a name does not end it)
 * and parsing only that slice does not.
 */
export function firstJsonValue(text) {
  const s = String(text ?? '');
  const a = s.indexOf('{');
  const b = s.indexOf('[');
  const start = a < 0 ? b : (b < 0 ? a : Math.min(a, b));
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return JSON.parse(s.slice(start, i + 1));
    }
  }
  // Unbalanced: let JSON.parse produce its own message for the tail.
  return JSON.parse(s.slice(start));
}

export async function inspectSpec(spec, xiPath, env, routine = 'main') {
  const args = ['ability', 'inspect', spec, '--json'];
  if (routine && routine !== 'main') args.push('--routine', routine);
  const info = await xiJson(args, xiPath, env);
  return Array.isArray(info) ? info[0] : info;
}

/** Where the mixer keeps recipes and compose output: <xi-tools>/exports/ability/mixer/. */
export function mixerDir(xiPath) {
  return `${String(xiPath).replace(/[\\/]+$/, '')}\\exports\\ability\\mixer`;
}

export function composedDatName(recipe, xiRace) {
  const raceBound = Object.values(recipe.sources).some((s) => /^ws:\d+$/i.test(s.spec));
  return raceBound ? `${recipe.name}.${xiRace}.DAT` : `${recipe.name}.DAT`;
}

/** Write the recipe, compose it for one race, return the absolute DAT path to preview. */
export async function composeForPreview(recipe, xiRace, xiPath, env, onLine) {
  const dir = mixerDir(xiPath);
  const recipePath = `${dir}\\${recipe.name}.recipe.json`;
  await backend.writeTextFile(recipePath, serializeRecipe(recipe));
  const outDir = `${dir}\\${recipe.name}`;
  const args = ['ability', 'compose', recipePath, '--out', outDir, '--json'];
  if (xiRace) args.push('--race', xiRace);
  const report = await xiJson(args, xiPath, env, onLine);
  const row = Array.isArray(report) ? report[0] : report;
  return { recipePath, datPath: row.dat, report: row };
}

/**
 * Publish through `xi dats`: the recipe becomes an `ability` action in
 * projects/<name>.json (`dats prepare … --type ability --replace`, which keeps
 * a slot an earlier build took), then `dats build <name>` — with --dry-run for
 * the plan, without to write the DATs and register the file ids. Same manifest
 * the wizard and the CLI use, so the ability is rebuilt, listed and undone with
 * the rest of the project.
 */
export async function publishRecipe(recipe, { dryRun, animation = null, kind = null }, xiPath, env, onLine) {
  const dir = mixerDir(xiPath);
  const recipePath = `${dir}\\${recipe.name}.recipe.json`;
  await backend.writeTextFile(recipePath, serializeRecipe(recipe));
  const lines = [];
  const run = async (args) => {
    lines.push(`$ xi ${args.join(' ')}`);
    const code = await backend.xiRunStream(args, xiPath, env, (line) => { lines.push(line); onLine?.(line); });
    return !code;
  };
  const prep = ['dats', 'prepare', recipePath, '--project', recipe.name, '--type', 'ability', '--replace'];
  if (animation != null) prep.push('--animation', String(animation));
  if (kind && kind !== 'auto') prep.push('--kind', kind);
  if (!(await run(prep))) return { ok: false, text: lines.join('\n') };
  const build = ['dats', 'build', recipe.name, '--only', `ability.${slug(recipe.name)}`];
  if (dryRun) build.push('--dry-run');
  const ok = await run(build);
  return { ok, text: lines.join('\n') };
}

/** xi_dats._slug: lowercase, runs of anything but a-z0-9 → `_`. */
const slug = (v) => String(v).replace(/\\/g, '/').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'action';
