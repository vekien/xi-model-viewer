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

// A recipe's lanes are tracks: the three kinds each start with one track named
// after the kind (motion, vfx, sound) and can grow more (motion2, motion3…). An
// event's `from` is its track; its `kind` is the lane kind it draws in.
export const kindOf = (track) => String(track ?? '').replace(/\d+$/, '');
export function trackLabel(track) {
  const kind = kindOf(track);
  const base = LANE_BY_ID.get(kind);
  const n = String(track ?? '').slice(kind.length);
  return base ? (n ? `${base.label} ${n}` : base.label) : String(track ?? '');
}
/** The recipe's tracks in lane order: the base track of each kind always, then the
 *  extra keys its sources or events name (or `extra` holds while still empty). */
export function recipeTracks(recipe, extra = []) {
  const keys = new Set([...Object.keys(recipe?.sources ?? {}), ...(recipe?.events ?? []).map((e) => e.from), ...extra]);
  const out = [];
  for (const l of LANES) {
    const more = [...keys].filter((k) => kindOf(k) === l.id && k !== l.id)
      .sort((a, b) => Number(a.slice(l.id.length)) - Number(b.slice(l.id.length)));
    out.push({ id: l.id, kind: l.id }, ...more.map((id) => ({ id, kind: l.id })));
  }
  return out;
}

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
/** Ops that start a generator of their own: what Preview can play alone. */
export const isGeneratorOp = (op) => op === 0x02 || op === 0x3f;

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
/**
 * A clip event's [blend in, blend out] in frames: its own `blend` when set, else
 * the source command's, which compose keeps (u16 at bytes 24 and 28 of `raw`,
 * where effect.js reads transIn / transOut).
 */
export function clipBlend(ev) {
  if (Array.isArray(ev?.blend) && ev.blend.length === 2) return ev.blend.map((v) => Math.max(0, Number(v) || 0));
  const hex = typeof ev?.raw === 'string' ? ev.raw : '';
  if (hex.length < 64) return [0, 0];
  const u16 = (o) => parseInt(hex.substr(o * 2, 2), 16) | (parseInt(hex.substr(o * 2 + 2, 2), 16) << 8);
  return [u16(24), u16(28)];
}

/** A frame count as the schema wants it: a whole, non-negative integer. */
const frames = (v) => Math.max(0, Math.round(Number(v) || 0));

export function serializeRecipe(recipe) {
  // The timeline is edited in pixels and typed frames, so a start or duration can
  // arrive fractional, negative or empty; the file carries whole frames only (a
  // fractional dur fails the schema before compose starts).
  const events = recipe.events
    .filter((e) => e.enabled !== false)
    .map(({ _id, enabled, label, kind, sound, ...rest }) => {
      const out = { ...rest, start: frames(rest.start) };
      const dur = Number.isFinite(Number(rest.dur)) && rest.dur != null && rest.dur !== '' ? frames(rest.dur) : 0;
      if (dur > 0) out.dur = dur; else delete out.dur;
      if (Array.isArray(rest.blend)) out.blend = rest.blend.map(frames);
      if (rest.loops != null) out.loops = frames(rest.loops);
      return out;
    });
  // `total` is the routine's end (the timeline's loop marker): whole frames,
  // and absent rather than null when it is left to compose. `category` is the
  // organiser's, kept in its own index beside the files (the schema has no room).
  const { total, category, ...rest } = recipe;
  const totalOut = Number.isFinite(Number(total)) && Number(total) > 0 ? { total: frames(total) } : {};
  return JSON.stringify({ schema: RECIPE_SCHEMA, ...rest, ...totalOut, events }, null, 2);
}

/**
 * Turn an `xi ability inspect --json` result into recipe events for one lane.
 * Only events that live in the root routine are taken (linked local routines are
 * carried whole by their link command, exactly as compose does).
 */
const LINK_OPS = new Set([0x03, 0x09, 0x3b, 0x3c, 0x57]);
export const isLinkOp = (op) => LINK_OPS.has(op);

export function eventsFromInspect(info, track, opts = {}) {
  const wantKeep = opts.keep !== false;
  const kind = opts.kind ?? kindOf(track);
  const refs = opts.refs ?? null;     // a Set: take the events naming these refs, whatever their kind
  // A source brings its own kind and nothing else: a motion track gets the
  // clips and traces, an effects track the generators, a sound track the
  // sounds. A weapon skill's own flashes and hit sparks therefore stay behind
  // on a motion pick; to have Apex Arrow's motion and its effects, put it on a
  // Motion track and on an Effects track.
  // A link out of the DAT (a shared ROM/0/0.DAT routine, or a schedule on the
  // actor) runs whole, so it goes on the lane of what it plays: opts.linkLane,
  // effect.js sharedLinkLane. Combo's eis1 burst is effects, a cast motion like
  // shbk is motion. A preview on a lane plays the same slice (laneSlice).
  // Without linkLane, links are "keep".
  const linkLane = opts.linkLane ?? null;
  const out = [];
  for (const e of info.timeline) {
    // The inspector already expands local sub-routines at absolute frames, so
    // their commands are taken individually and the link itself is dropped —
    // a link would carry the whole sub-routine, effects and all, into every
    // lane. Links the DAT cannot satisfy (mdam, proc, eis1…) stay: they are
    // the client's shared routines.
    if (LINK_OPS.has(e.op) && e.detail?.local) continue;
    const laneOf = linkLane && LINK_OPS.has(e.op) && e.ref && e.detail?.local === false ? linkLane(e.ref) : laneForEvent(e);
    if (refs ? !refs.has(e.ref) : (laneOf !== kind && !(wantKeep && laneOf === 'keep'))) continue;
    out.push({
      from: track,
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
  const motion = events.filter((e) => kindOf(e.from) === 'motion');
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

// ── Custom animation bands ──────────────────────────────────────────────────────
// A stock client reaches only a few free animation numbers per kind: weapon skill
// 264–271, job ability 339–499, spell 1012–1611. A client-side plugin (cexislots) patches
// the number → file-id arithmetic so numbers at or above a threshold resolve into a
// reserved region, and xi-tools allocates there once the stock numbers are used up
// (FX_*_BAND_*, xi_config.py). On unless switched off — the client is assumed to run the
// plugin — and the defaults are cexislots' own (cexidats src/cexislots/sites.h); they
// must match the plugin the client runs.
export const ANIM_BANDS_DEFAULT = Object.freeze({
  on: true,
  wsFirst: 272, wsSlots: 256, wsBase: 431344,
  jaFirst: 500, jaBase: 427248,
  spellFirst: 1612, spellBase: 423152,
});
const BAND_KEYS = ['wsFirst', 'wsSlots', 'wsBase', 'jaFirst', 'jaBase', 'spellFirst', 'spellBase'];
const ANIMATION_MAX = 4095;   // the action packet carries the animation number in 12 bits
/** What a stock client can load, per kind — the numbers Publish tries first. */
export const STOCK_ANIM_RANGE = Object.freeze({ ws: [264, 271], ja: [339, 499], spell: [1012, 1611] });

export const ANIM_BANDS_KEY = 'customAnimBands';   // localStorage

/** The settings' band block with every number whole and positive (a blank falls back to the default). */
export function normalizeAnimBands(raw) {
  const out = { ...ANIM_BANDS_DEFAULT, on: raw?.on !== false };
  for (const k of BAND_KEYS) {
    const v = Math.round(Number(raw?.[k]));
    if (Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

export function loadAnimBands() {
  try { return normalizeAnimBands(JSON.parse(localStorage.getItem(ANIM_BANDS_KEY) || 'null')); } catch { return { ...ANIM_BANDS_DEFAULT }; }
}

/**
 * FX_*_BAND_* for xi. All seven, always — zeros when the switch is off — so the viewer's
 * setting, not a line left in xi-tools' .env, decides whether Publish may hand out
 * numbers that only a patched client can load (a real env var wins over .env).
 */
export function animBandsEnv(bands) {
  const b = normalizeAnimBands(bands);
  const v = (n) => String(b.on ? n : 0);
  return {
    FX_WS_BAND_FIRST: v(b.wsFirst), FX_WS_BAND_SLOTS: v(b.wsSlots), FX_WS_BAND_BASE: v(b.wsBase),
    FX_JA_BAND_FIRST: v(b.jaFirst), FX_JA_BAND_BASE: v(b.jaBase),
    FX_SPELL_BAND_FIRST: v(b.spellFirst), FX_SPELL_BAND_BASE: v(b.spellBase),
  };
}

/** `[first, last]` of the plugin band for a kind, or null when the bands are off. */
export function animBandRange(kind, bands) {
  const b = normalizeAnimBands(bands);
  if (!b.on) return null;
  if (kind === 'ws') return [b.wsFirst, Math.min(ANIMATION_MAX, b.wsFirst + b.wsSlots - 1)];
  if (kind === 'ja') return [b.jaFirst, ANIMATION_MAX];
  if (kind === 'spell') return [b.spellFirst, ANIMATION_MAX];
  return null;
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
  const out = [];
  // The JSON is read off stdout alone: the Tauri stream tags stderr, whose
  // lines (a uv notice, a Python warning) can land in the middle of a
  // multi-line value and break the parse at "line 93 column 1".
  const code = await backend.xiRunStream(args, xiPath, env, (line, stream) => {
    lines.push(line);
    if (stream !== 'err') out.push(line);
    onLine?.(line);
  });
  const text = lines.join('\n');
  if (code && code !== 0) throw new Error(`xi ${args[0]} ${args[1] ?? ''} failed (${code}): ${text.slice(-400)}`);
  let value;
  try {
    value = firstJsonValue(out.join('\n'));
  } catch (e) {
    // A shell built before stderr had its own event still mixes the streams;
    // a line of prose in the middle of the value is what breaks the parse.
    // Pretty-printed JSON lines start with a quote, a bracket, a number or a
    // bare literal — keep those and try once more before giving up.
    const jsonish = out.filter((l) => /^\s*(["{}[\]]|-?\d|true|false|null)/.test(l));
    try {
      value = firstJsonValue(jsonish.join('\n'));
      console.warn(`[xi] ${args.join(' ')}: read its JSON after dropping ${out.length - jsonish.length} non-JSON line(s) from stdout`, out.filter((l) => !jsonish.includes(l)).slice(0, 5));
    } catch (e2) {
      console.warn(`[xi] ${args.join(' ')}: JSON unreadable`, e2, text.slice(0, 2000));
      throw new Error(`xi ${args.join(' ')}: could not read its JSON (${e?.message ?? e})`);
    }
  }
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

/**
 * The organiser's categories: `_categories.json` beside the recipes, mix name →
 * category. The recipe schema allows no extra fields, so a category never goes
 * into the recipe itself; a mix the index does not name is uncategorised.
 */
const CATEGORY_INDEX = '_categories.json';
const categoryIndexPath = (xiPath) => `${mixerDir(xiPath)}\\${CATEGORY_INDEX}`;

/** Mix name → category, for every mix the index names. */
export async function readCategories(xiPath) {
  try {
    const text = await backend.readTextFile(categoryIndexPath(xiPath));
    const map = text ? JSON.parse(text) : {};
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  } catch {
    return {};
  }
}

/**
 * Change the index through `edit(map)` and write it back, names A–Z. A blank
 * category drops the entry, so clearing the field files the mix as uncategorised.
 */
export async function updateCategories(xiPath, edit) {
  const map = { ...(await readCategories(xiPath)) };
  edit(map);
  const out = {};
  for (const name of Object.keys(map).sort()) {
    const cat = typeof map[name] === 'string' ? map[name].trim().replace(/\s+/g, ' ') : '';
    if (cat) out[name] = cat;
  }
  await backend.writeTextFile(categoryIndexPath(xiPath), JSON.stringify(out, null, 2));
  return out;
}

/**
 * Where compose and publish read the mix from: a scratch copy under `_work`,
 * not the mixer folder itself. The saved list is that folder's `*.recipe.json`
 * files, so writing the working copy beside them made every preview — a
 * Randomise, a pick — look saved. Save is the only thing that writes there.
 */
function workRecipePath(xiPath, name) {
  return `${mixerDir(xiPath)}\\_work\\${name}.recipe.json`;
}

export function composedDatName(recipe, xiRace) {
  const raceBound = Object.values(recipe.sources).some((s) => /^ws:\d+$/i.test(s.spec));
  return raceBound ? `${recipe.name}.${xiRace}.DAT` : `${recipe.name}.DAT`;
}

/** Write the recipe, compose it for one race, return the absolute DAT path to preview. */
export async function composeForPreview(recipe, xiRace, xiPath, env, onLine, kind = null) {
  const dir = mixerDir(xiPath);
  const recipePath = workRecipePath(xiPath, recipe.name);
  await backend.writeTextFile(recipePath, serializeRecipe(recipe));
  const outDir = `${dir}\\${recipe.name}`;
  const args = ['ability', 'compose', recipePath, '--out', outDir, '--json'];
  if (xiRace) args.push('--race', xiRace);
  // The publish kind: a job ability or spell bakes a race-bound motion from the
  // viewer's race into its single DAT, so the preview plays what would ship.
  if (kind && kind !== 'auto') args.push('--kind', kind);
  const report = await xiJson(args, xiPath, env, onLine);
  const row = Array.isArray(report) ? report[0] : report;
  return { recipePath, datPath: row.dat, report: row };
}

/**
 * Publish through `xi dats`: the recipe becomes an `ability` action in
 * projects/<name>.json (`dats prepare … --type ability --replace`, which keeps
 * a slot an earlier build took), then `dats build <name>` — with --dry-run for
 * the plan, without to write the DATs and register the file ids, and with
 * --pivot to build into the pivot folder (FFXI_PIVOT_DIR) instead of the game
 * folder. Same manifest the wizard and the CLI use, so the ability is rebuilt,
 * listed and undone with the rest of the project. `animationFrom` is where an
 * automatic number starts (the first free one at or above it).
 */
export async function publishRecipe(recipe, { dryRun, animation = null, animationFrom = null, kind = null, subdir = null, force = false, pivot = false }, xiPath, env, onLine) {
  const recipePath = workRecipePath(xiPath, recipe.name);
  await backend.writeTextFile(recipePath, serializeRecipe(recipe));
  const lines = [];
  const say = (line) => { lines.push(line); onLine?.(line); };
  const run = async (args) => {
    say(`$ xi ${args.join(' ')}`);
    const code = await backend.xiRunStream(args, xiPath, env, (line) => say(line));
    return !code;
  };
  const prep = ['dats', 'prepare', recipePath, '--project', recipe.name, '--type', 'ability', '--replace'];
  if (animation != null) prep.push('--animation', String(animation));
  else if (animationFrom != null) prep.push('--animation-from', String(animationFrom));   // where auto starts
  if (kind && kind !== 'auto') prep.push('--kind', kind);
  if (subdir != null) prep.push('--subdir', String(subdir));
  if (!(await run(prep))) return { ok: false, text: lines.join('\n') };
  const build = ['dats', 'build', recipe.name, '--only', `ability.${slug(recipe.name)}`];
  if (dryRun) build.push('--dry-run');
  if (force) build.push('--force');
  if (pivot) build.push('--pivot');
  const ok = await run(build);
  return { ok, text: lines.join('\n') };
}

/**
 * `xi ability slots --json`: every weapon-skill number Publish can hand out in the
 * game or pivot folder — 264–271, then the plugin band — and what holds each:
 * `{ stock, band, slots: [{ animation, bank, index, fileId?, plugin, free, races, dats, owner }] }`.
 */
export async function listWsSlots({ pivot = false } = {}, xiPath, env) {
  const args = ['ability', 'slots', '--json'];
  if (pivot) args.push('--pivot');
  return xiJson(args, xiPath, env);
}

/**
 * What a `dats build --dry-run` says it would place, from its text: the kind
 * and animation number it settled on, and one row per DAT — file id, race,
 * role (body / companion_a / companion_b for a weapon skill), the ROM10 path
 * it goes to, and what the file id points at today ("occupied by": a retail
 * placeholder for a free extended slot, or another skill's DAT).
 */
export function parsePublishPlan(text) {
  const out = { kind: null, animation: null, files: [], server: null, errors: [], warnings: [] };
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    let m = line.match(/\(ability\):\s+(ja|spell|ws) animation (\d+)/);
    if (m) { out.kind = m[1]; out.animation = Number(m[2]); continue; }
    // "(occupied by X)" is a real collision; "(retail placeholder X, free)" is
    // the dummy DAT a free slot's id points at — what makes the slot free.
    m = line.match(/file_id\s+(\d+)\s+(.+?)\s+->\s+(\S+)(?:\s+\((occupied by|retail placeholder)\s+(\S+?),?(?:\s+free)?\))?/);
    if (m) {
      const parts = m[2].trim().split(/\s+/);
      out.files.push({
        fileId: Number(m[1]),
        race: parts.length > 1 ? parts[0] : null,
        role: parts.length > 1 ? parts[1] : parts[0],
        target: m[3],
        occupiedBy: m[4] === 'occupied by' ? m[5] : null,
        placeholder: m[4] === 'retail placeholder' ? m[5] : null,
      });
      continue;
    }
    m = line.match(/^server:\s+(\S+)/);
    if (m) { out.server = m[1]; continue; }
    // A race built without part of its motion (no copy of an emote, no such clip).
    m = line.match(/^⚠\s+(.+)$/);
    if (m) { out.warnings.push(m[1]); continue; }
    if (/^Error:/i.test(line)) out.errors.push(line.replace(/^Error:\s*/i, ''));
  }
  return out;
}

/** xi_dats._slug: lowercase, runs of anything but a-z0-9 → `_`. */
const slug = (v) => String(v).replace(/\\/g, '/').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'action';
