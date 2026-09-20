// Ability Mixer — recipe model, catalog, timeline math, and the xi-tools bridge.
//
// A recipe is what `xi ability compose` reads (xi-tools docs/ability/inspect.md):
//   { name, sources: { lane: { spec, routine } }, events: [{ from, op, ref, start, dur, ... }],
//     generators: [{ lane, ref, edits }], curves: [{ lane, ref, keys }],   (see Generator edits)
//     textures: [{ lane, ref, png }] }                                     (see Texture replacements)
// The mixer keeps the recipe as plain data and derives the timeline view from it,
// so Save writes exactly what Play composes — plus each pill's timeline `row`,
// which compose ignores (see Rows below).

import { backend } from './backend.js';
import { loadListOrNull } from './lists.js';
import { allFields, applyCurve, applyEdits, datIds, describeGenerator, editFor, hueRotate, opcodeOf } from './particle/fields.js';

export const LANES = [
  { id: 'motion', label: 'Motion', color: '#3FBDBB', ops: new Set([0x05, 0x2c, 0x76, 0x77, 0x79, 0x8c, 0xa4, 0xa5]) },
  { id: 'vfx', label: 'Effects', color: '#D97BC4', ops: new Set([0x02, 0x3f, 0x1e, 0x2d]) },
  { id: 'sound', label: 'Sound', color: '#E0A83E', ops: new Set([0x0a, 0x0b, 0x4a, 0x53, 0x60, 0x8a, 0x8b]) },
];
export const LANE_BY_ID = new Map(LANES.map((l) => [l.id, l]));
export const KEEP_LANE = { id: 'keep', label: 'Commands', color: '#8B949A' };

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

// Who each command acts on is the PS2 client's (ymschdecript.cpp ExecuteTag): 0x20
// holds the target's status, 0x56 every target's, 0x1F the caster's; 0x25 flinches the
// target and 0x21 the caster; 0x2B is the hit itself (the shared `mdam` is one 0x2B).
const OP_NAMES = {
  0x02: 'Generator', 0x03: 'Link', 0x05: 'Clip', 0x07: 'Hold caster', 0x08: 'Hold target', 0x09: 'Link (as target)',
  0x0a: 'Sound', 0x0b: 'Sound (target)', 0x15: 'Stand-in (caster)', 0x16: 'Stand-in (target)',
  0x17: 'Back to caster', 0x18: 'Back to target', 0x19: 'Spell animation', 0x1e: 'Dampen',
  0x1f: 'Lock caster status', 0x20: 'Lock target status', 0x21: 'Flinch (caster)', 0x22: 'Tracking stand-in (caster)',
  0x23: 'Tracking stand-in (target)', 0x24: 'Melee result', 0x25: 'Flinch (target)', 0x28: 'Return to idle',
  0x29: 'Fade caster colour', 0x2a: 'Fade target colour', 0x2b: 'Show result', 0x2c: 'Weapon trace', 0x2d: 'Stop gen',
  0x2e: 'Lock control', 0x2f: 'Lock rotation', 0x30: 'Link per target', 0x31: 'Each target', 0x32: 'Next target',
  0x3b: 'Link and wait', 0x3c: 'Link and wait (caster)', 0x3f: 'Transition', 0x4a: 'Sound (player)',
  0x53: 'Sound (target)', 0x56: 'Lock all targets\' status', 0x57: 'Link (caster)', 0x59: 'Lock magic',
  0x5a: 'Guard (caster)', 0x5b: 'Guard (target)', 0x5e: 'Knockback', 0x5f: 'Stop routine', 0x60: 'Sound',
  0x71: 'Secondary message', 0x73: 'Start loop', 0x75: 'Show/hide weapon', 0x80: 'Added effect', 0x85: 'Stop loop',
  0x88: 'Lock colour', 0x89: 'Constrain',
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
/** The recipe's two edit lists and the key each entry keeps its body under (see Generator edits). */
const EDIT_LISTS = [['generators', 'edits'], ['curves', 'keys']];

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

/**
 * The recipe as JSON text. `layout` also writes each event's timeline `row`: the
 * saved file carries it, what goes to compose and publish does not — xi ignores
 * the key, an xi-tools older than it rejects it, and a pill changing row is no
 * reason to compose again.
 */
export function serializeRecipe(recipe, { layout = false } = {}) {
  // The timeline is edited in pixels and typed frames, so a start or duration can
  // arrive fractional, negative or empty; the file carries whole frames only (a
  // fractional dur fails the schema before compose starts).
  const events = recipe.events
    // A muted event is left out, and so is a command with no track (Locks, hits and
    // links) without its bytes, or a link of no track that names no routine: compose
    // has nothing to write for it.
    .filter(isComposed)
    .map(({ _id, enabled, label, kind, sound, row, rowHint, ...rest }) => {
      const out = { ...rest, start: frames(rest.start) };
      const dur = Number.isFinite(Number(rest.dur)) && rest.dur != null && rest.dur !== '' ? frames(rest.dur) : 0;
      if (dur > 0) out.dur = dur; else delete out.dur;
      // Its bytes follow its fields: compose leaves +6 alone when `dur` is 0, and the
      // file should read the same whichever the reader looks at. Bytes that are no
      // command go as they are, for compose to refuse. A link with no ref of its own
      // keeps the name its bytes carry, as stored.
      if (!hasTrack(rest)) {
        delete out.from;
        const fields = keepFields(rest.raw);
        if (fields) out.raw = keepRaw(rest.op, { ...fields, dur, ...(isLinkOp(rest.op) ? { ref: rest.ref || undefined } : null) }) ?? rest.raw;
      }
      if (Array.isArray(rest.blend)) out.blend = rest.blend.map(frames);
      if (rest.loops != null) out.loops = frames(rest.loops);
      // A pill's row is layout, kept in the working copy so a drag holds; compose ignores it.
      if (layout && rowOfEvent({ row }) != null) out.row = row;
      return out;
    });
  // Everything else the recipe holds goes out as it came in and where it sat
  // (`description`, `dir`, `target`, `generators`, `curves`…), so opening a mix
  // and saving it loses nothing. `category` is the organiser's, kept in its own
  // index beside the files (the schema has no room); `schema` is stamped here.
  const { schema, category, ...rest } = recipe;
  const out = { schema: RECIPE_SCHEMA, ...rest, events };
  // `total` is the routine's end (the timeline's loop marker): whole frames,
  // and absent rather than null when it is left to compose.
  if (Number.isFinite(Number(rest.total)) && Number(rest.total) > 0) out.total = frames(rest.total);
  else delete out.total;
  // Generator and curve edits: xi refuses an entry with nothing in it and one for a
  // track the mix no longer has, and an empty list is no list.
  for (const [key, body] of EDIT_LISTS) {
    const list = (Array.isArray(rest[key]) ? rest[key] : [])
      .filter((g) => Array.isArray(g?.[body]) && g[body].length && recipe.sources?.[g.lane]);
    if (list.length) out[key] = list; else delete out[key];
  }
  // Texture replacements go as data: URIs only: xi resolves a path against the recipe
  // file's own folder, and compose and Play mix read a copy of it under _work, Check
  // and Publish one in the mix's publish folder — none of them beside a PNG.
  const textures = recipeTextures(recipe);
  if (textures.length) out.textures = textures; else delete out.textures;
  return JSON.stringify(out, null, 2);
}

// ── Import ──────────────────────────────────────────────────────────────────────

/** A mix name as the schema wants it (`^[A-Za-z0-9_-]+$`); empty when nothing usable is left. */
export const safeRecipeName = (name) => String(name ?? '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '');

// The keys xi-tools' validate_recipe takes (xi_compose.py, in step with
// schema/ability_recipe.json). One unknown key fails compose and publish, so an
// imported file is cut down to these; `schema` is serializeRecipe's to stamp.
const IMPORT_RECIPE_KEYS = ['name', 'description', 'dir', 'target', 'total', 'sources', 'events', 'generators', 'curves', 'textures'];
const IMPORT_TARGET_KEYS = ['kind', 'animation'];
const IMPORT_SOURCE_KEYS = ['spec', 'routine', 'name'];
const IMPORT_EVENT_KEYS = ['from', 'op', 'ref', 'start', 'dur', 'order', 'blend', 'loops', 'raw', 'routine', 'offset', 'name', 'row'];
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const pickKeys = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => keys.includes(k)));

/**
 * Read a mix from the text of a .json file someone handed over. Pure: nothing is
 * written, so a file that is refused changes nothing.
 *
 *   stem   the file's name without `.mix.json` / `.recipe.json` / `.json`, used when the recipe names itself badly
 *   taken  the mix names already saved; a clash gets `_2`, `_3`… and nothing is overwritten
 *          (compared without case, as the file system does)
 *
 * Returns `{ error }` — a phrase that follows the file's name — or
 * `{ name, text, kind, clash, droppedTextures }`: the name it lands under, the
 * recipe file to write, the `target.kind` it declares (ja | spell | ws, else
 * null), the taken name it had to step around (else null), and how many texture
 * replacements were left out (one that names a PNG file, whose PNG fails the check,
 * whose name is not 1-16 printable characters, or is not an entry at all).
 */
export function recipeFromImport(text, { stem = '', taken = [] } = {}) {
  let r;
  try { r = JSON.parse(text); } catch (e) { return { error: `is not valid JSON (${e?.message ?? e})` }; }
  if (!isPlainObject(r)) return { error: 'is not a mix: it holds no JSON object' };
  if (r.schema != null && r.schema !== RECIPE_SCHEMA) return { error: `is not a mix this version reads: schema ${JSON.stringify(r.schema)}, expected "${RECIPE_SCHEMA}"` };
  if (!isPlainObject(r.sources) || !Object.keys(r.sources).length) return { error: 'is not a mix: it has no sources' };
  if (!Array.isArray(r.events)) return { error: 'is not a mix: it has no events list' };

  const sources = {};
  for (const [lane, src] of Object.entries(r.sources)) {
    // The schema also takes a bare spec string; the mixer reads `.spec` everywhere.
    const s = typeof src === 'string' ? { spec: src } : src;
    // `sources[lane] = …` with this key sets the object's prototype and drops the source.
    if (lane === '__proto__') return { error: 'is not a mix: a source is named "__proto__"' };
    if (!isPlainObject(s) || typeof s.spec !== 'string' || !s.spec) return { error: `is not a mix: source "${lane}" names no spec` };
    // The timeline renders these as text; anything else takes the whole app down.
    if (s.name != null && typeof s.name !== 'string') return { error: `is not a mix: source "${lane}" has a name that is not text` };
    if (s.routine != null && typeof s.routine !== 'string') return { error: `is not a mix: source "${lane}" has a routine that is not text` };
    sources[lane] = pickKeys(s, IMPORT_SOURCE_KEYS);
  }
  const events = [];
  for (const [i, ev] of r.events.entries()) {
    if (!isPlainObject(ev)) return { error: `is not a mix: event ${i} is not an object` };
    if (ev.enabled === false) continue;   // muted in the file it came from; `enabled` is not a recipe key
    const out = pickKeys(ev, IMPORT_EVENT_KEYS);
    // An opcode may be written as hex text ("0x16", "16"); the timeline compares numbers.
    if (typeof out.op === 'string' && /^(0x)?[0-9a-f]{1,2}$/i.test(out.op)) out.op = parseInt(out.op, 16);
    // What the timeline reads while it draws (opName, the pill label) must be the type
    // the schema gives it: a render error there unmounts the app, and the mix stays saved.
    if (!Number.isInteger(out.op) || out.op < 0 || out.op > 255) return { error: `is not a mix: event ${i} has no opcode (op: 0-255 or hex text)` };
    if (out.from == null || out.from === '') {
      // A lock, hit or link added by hand: its own bytes, and a kind of command that
      // needs no track's DAT (a generator, sound, clip or trace does).
      delete out.from;
      if (laneForOp(out.op) !== 'keep') return { error: `is not a mix: event ${i} names no source (from), which a ${opName(out.op).toLowerCase()} needs` };
      const why = keepRawProblem(out.op, out.raw);
      if (why) return { error: `is not a mix: event ${i} names no source (from) and ${why}` };
    } else if (typeof out.from !== 'string') return { error: `is not a mix: event ${i} names no source (from)` };
    if (out.ref != null && (typeof out.ref !== 'string' || out.ref.length < 1 || out.ref.length > 4)) return { error: `is not a mix: event ${i} has a ref that is not a 1-4 character id` };
    events.push(keepEventFromBytes(out));
  }

  const lower = new Set([...taken].map((n) => String(n).toLowerCase()));
  const base = safeRecipeName(r.name) || safeRecipeName(stem) || 'imported';
  let name = base;
  for (let i = 2; lower.has(name.toLowerCase()); i++) name = `${base}_${i}`;

  const recipe = pickKeys({ ...r, name, sources, events }, IMPORT_RECIPE_KEYS);
  if ('target' in recipe) {
    if (isPlainObject(recipe.target)) recipe.target = pickKeys(recipe.target, IMPORT_TARGET_KEYS);
    else delete recipe.target;
  }
  // Generator and curve edits keep their shape or go; what an edit writes is xi's to check.
  for (const [key, body] of EDIT_LISTS) {
    if (!(key in recipe)) continue;
    recipe[key] = (Array.isArray(recipe[key]) ? recipe[key] : [])
      .filter((g) => isPlainObject(g) && typeof g.lane === 'string' && typeof g.ref === 'string' && Array.isArray(g[body]))
      .map((g) => pickKeys(g, ['lane', 'ref', body]));
  }
  // A texture replacement keeps its PNG only inside the file: one that names a PNG
  // beside it (xi-tools reads that form from the CLI) cannot come along with the text,
  // and one whose PNG or name xi-tools would refuse only stops Play mix and Publish.
  let droppedTextures = 0;
  if ('textures' in recipe) {
    const all = Array.isArray(recipe.textures) ? recipe.textures : [];
    const kept = all.filter((t) => isPlainObject(t) && typeof t.lane === 'string' && typeof t.ref === 'string' && typeof t.png === 'string' && !pngProblem(t.png)
      && (t.name == null || isTextureName(t.name)))
      .map((t) => pickKeys(t, t.name == null ? ['lane', 'ref', 'png'] : ['lane', 'ref', 'name', 'png']));
    droppedTextures = all.length - kept.length;
    recipe.textures = kept;
  }
  const kind = ['ja', 'spell', 'ws'].includes(recipe.target?.kind) ? recipe.target.kind : null;
  return { name, text: serializeRecipe(recipe, { layout: true }), kind, clash: name === base ? null : base, droppedTextures };
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
      // A row read from a DAT keeps its blend and loop count in `raw`. A cast stage
      // (stageTimeline) has no command to keep, so it names them.
      blend: e.blend,
      loops: e.loops,
      sound: e.detail?.sound?.sound_id,   // for the timeline's click-to-preview
      kind: laneOf,
      label: e.summary || e.name,
      name: e.name,
      enabled: true,
    });
  }
  return withIds(out);
}

// ── Cast stages ─────────────────────────────────────────────────────────────────
// A base motion (abilities.json `base_motions`) is a run of clips the game plays one
// after the other — a chant, its release, the follow-through — listed as `stages` in
// play order, each with the window (`dur`, ticks), blend and loop count retail plays
// it with. A pick lays one clip pill per stage; the stage's label (Start, Middle,
// End…) rides in the event's `name`, which compose ignores.

/** The most cycles a looping stage is laid with. Retail chants loop for as long as the
 *  cast lasts (63 cycles for black magic), which is no length for a mix. */
export const STAGE_LOOPS_MAX = 3;

/** The loop count a stage is laid with: once, or for a looping stage its retail count
 *  up to STAGE_LOOPS_MAX. Never forever — with the next pill deleted the actor would
 *  not stop. */
export function stageLoops(stage) {
  const n = Math.round(Number(stage?.loops));
  if (n === 0) return STAGE_LOOPS_MAX;
  return n > 1 ? Math.min(n, STAGE_LOOPS_MAX) : 1;
}

/** A base motion's stages as inspector rows for eventsFromInspect: one clip each, in
 *  order, each starting where the one before it ends (its window × its cycles). */
export function stageTimeline(stages) {
  let at = 0;
  return (stages ?? []).filter((s) => s?.ref).map((s) => {
    const dur = frames(s.dur) || frames(s.frames) * 2;   // ticks; a clip frame is two
    const loops = stageLoops(s);
    const row = {
      op: 0x05, ref: s.ref, start: at, dur, loops, name: s.label || 'PlayClip',
      blend: Array.isArray(s.blend) && s.blend.length === 2 ? s.blend.map(frames) : [0, 0],
      summary: `${s.label ? `${s.label} · ` : ''}${s.frames ?? '?'} f${s.schedule ? ` · ${s.schedule}` : ''}`,
    };
    at += dur * loops;
    return row;
  });
}

/** The stage a clip pill stands for (Start, Middle, End…), else null: a staged pick
 *  keeps it in `name`, where a pick read from a DAT holds the command's name. */
export const stageOf = (ev) => (ev?.op === 0x05 && typeof ev.name === 'string' && ev.name && ev.name !== 'PlayClip' ? ev.name : null);

/**
 * Whether a stage is the chant a spell is cast with. The server picks that chant from the
 * spell's group (spell_list.group, one of eight) and the client plays it from the caster's
 * race files for the whole cast; the spell's DAT only runs at the finish. It is the stage
 * of a `ca··` routine, or of the `lc··` a song or geomancy chants with (both its Start and
 * its looping Middle). A list from before stages named their routine calls it Start.
 */
export const isChantStage = (stage) => (typeof stage?.schedule === 'string' && stage.schedule
  ? /^(ca|lc)[a-z0-9]{2}$/i.test(stage.schedule)
  : stage?.label === 'Start');

/**
 * The stages a pick of a base motion lays. On a spell the chant is the server's, not the
 * mix's, so its stages stay out and the rest — the release and the follow-through — start
 * at frame 0, when the cast finishes and the DAT runs; a Start there would chant a second
 * time and hold everything after it back. A job ability or weapon skill plays its whole
 * motion from its DAT, so it keeps every stage. A cast with nothing but chant keeps it all.
 */
export function pickStages(entry, kind = entry?.kind) {
  const stages = Array.isArray(entry?.stages) ? entry.stages : [];
  if (kind !== 'spell') return stages;
  const rest = stages.filter((s) => !isChantStage(s));
  return rest.length ? rest : stages;
}
/** The chant stages a spell pick leaves out (none on another kind). */
export const chantStages = (entry, kind = entry?.kind) => {
  const laid = new Set(pickStages(entry, kind));
  return (entry?.stages ?? []).filter((s) => !laid.has(s));
};
/**
 * Whether a clip pill stands for a cast's chant (isChantStage): its label ends on the
 * routine the stage came from (`Start · 14 f · cabk`, `Start · 30 f · ja:0 main`); a
 * pill whose label names none — a list from before stages named it, a mix opened from
 * its file — goes by Start.
 */
export function isChantPill(ev) {
  const stage = stageOf(ev);
  if (!stage) return false;
  const parts = String(ev.label ?? '').split('·').map((s) => s.trim());
  const routine = parts.length >= 3 ? parts[parts.length - 1].split(/\s+/).pop() : null;
  return routine ? isChantStage({ schedule: routine }) : stage === 'Start';
}

/** Every clip ref a base-motion row plays: its stages', and its first clip's (all a
 *  list from before the stages holds). */
export const baseMotionRefs = (b) => [...new Set([b?.clip?.ref, ...(b?.stages ?? []).map((s) => s?.ref)].filter(Boolean))];

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

/** Absolute end of the timeline (last start or start+dur). A clip that loops a set
 *  number of times runs that many windows; one that loops forever has no end to add. */
export function recipeLength(events) {
  let end = 0;
  for (const e of events) end = Math.max(end, e.start + (e.dur || 0) * (e.op === 0x05 && e.loops > 1 ? e.loops : 1));
  return end;
}

const earliest = (list) => list.reduce((a, b) => (a == null || b.start < a.start ? b : a), null);

/** The strike frame: the first hit/impact-ish event of the motion tracks or added by
 *  hand (a flinch or a weapon trace, else a hit), else the first generator, else 0.
 *  The mixer shows it as the snap target for the other lanes. A muted event is not
 *  in the mix, so it does not count. */
export function strikeFrame(events) {
  const on = events.filter((e) => e.enabled !== false);
  const own = on.filter((e) => kindOf(e.from) === 'motion' || !hasTrack(e));
  const hit = earliest(own.filter((e) => e.op === 0x25 || e.op === 0x21 || e.op === 0x2c)) ?? earliest(own.filter(isKeepHit));
  if (hit) return hit.start;
  const gen = earliest(on.filter((e) => e.op === 0x02));
  return gen ? gen.start : 0;
}

/** Shift every event of a lane by `delta` frames (clamped at 0). The keep lane is
 *  every lock, hit and link, whatever track (or none) it came from. */
export function shiftLane(events, lane, delta) {
  const moves = lane === 'keep' ? (e) => e.kind === 'keep' : (e) => e.from === lane;
  return events.map((e) => (moves(e) ? { ...e, start: Math.max(0, e.start + delta) } : e));
}

// ── Rows ────────────────────────────────────────────────────────────────────────
// A track's pills sit in rows, and a pill stays in its row: an event's `row` (a
// whole number, 0 = the track's first line) is scoped to its track (`from`). It is
// the timeline's layout and nothing else — Save writes it, compose never sees it.
// The keep lane (locks, hits, links) packs itself and carries no rows.

/** The last row a track can have: a file naming row 100000 must not make a lane that tall. */
export const MAX_ROW = 63;
/** An event's row when it holds a usable one, else null. */
export const rowOfEvent = (ev) => (Number.isInteger(ev?.row) && ev.row >= 0 && ev.row <= MAX_ROW ? ev.row : null);

/**
 * Where a pill's hold on its row ends. `shown` is the length it draws at (never
 * under the minimum pill width). A looping clip holds its repeats too, so nothing
 * is placed on top of them. They tile at its true `dur` (each play lasts exactly
 * that in game), so it holds the longer of the drawn pill and `dur × loops`, or the
 * rest of the row for 0 (forever).
 */
export function pillEnd(ev, shown) {
  const loops = ev.op === 0x05 && ev.dur > 0 ? (ev.loops ?? 1) : 1;
  if (loops === 0) return Infinity;
  return ev.start + (loops > 1 ? Math.max(shown, ev.dur * loops) : shown);
}

const spansCross = (a, b) => a[0] < b[1] && b[0] < a[1];

/**
 * The row each pill of one track draws in: `{ rowOf: Map(_id → row), count }`.
 * A pill that carries a `row` is fixed there, whatever it overlaps. The rest are
 * first-fitted in start order around the fixed ones — `rowHint` first (a copy
 * lands beside its original when there is room), else the first row it clears,
 * else a fresh row below. Pills marked `ghost` (what a shared routine adds, never
 * part of the recipe) go last, so they fit around the mix rather than shape it.
 * With no rows set at all this is plain first-fit stacking.
 */
export function assignRows(laneEvents, endOf) {
  const rows = [];   // per row, the [start, end) spans taken
  const rowOf = new Map();
  const span = (ev) => [ev.start, endOf(ev)];
  const clear = (r, s) => !(rows[r] ?? []).some((t) => spansCross(s, t));
  const put = (ev, r, s) => { (rows[r] ??= []).push(s); rowOf.set(ev._id, r); };
  const loose = [];
  for (const ev of laneEvents) {
    const r = ev.ghost ? null : rowOfEvent(ev);
    if (r == null) loose.push(ev); else put(ev, r, span(ev));
  }
  loose.sort((a, b) => (a.ghost ? 1 : 0) - (b.ghost ? 1 : 0) || a.start - b.start);
  for (const ev of loose) {
    const s = span(ev);
    const hint = rowOfEvent({ row: ev.rowHint });
    // Only a row the track already uses: a copy pasted into another mix would otherwise open empty rows above it.
    let r = hint != null && hint < rows.length && clear(hint, s) ? hint : 0;
    while (!clear(r, s)) r++;
    put(ev, r, s);
  }
  return { rowOf, count: Math.max(1, rows.length) };
}

/**
 * Pills let go after a drag. A dragged pill (`moved`, a Set of _ids) that lies
 * over another pill of its row goes down to the first row with room for it — a
 * fresh one below the last when none has. Only dragged pills change row; what was
 * already there stays put. Returns Map(_id → row) for the pills that have to move.
 */
export function settleRows(laneEvents, moved, endOf) {
  const own = laneEvents.filter((e) => !e.ghost);
  const { rowOf } = assignRows(own, endOf);
  const rows = [];
  const span = (ev) => [ev.start, endOf(ev)];
  const clear = (r, s) => !(rows[r] ?? []).some((t) => spansCross(s, t));
  for (const ev of own) if (!moved.has(ev._id)) (rows[rowOf.get(ev._id)] ??= []).push(span(ev));
  const out = new Map();
  const dropped = own.filter((e) => moved.has(e._id))
    .sort((a, b) => rowOf.get(a._id) - rowOf.get(b._id) || a.start - b.start);
  // The dragged pills with room where they landed stay first, so a group keeps as
  // much of its shape as it can; the ones in the way then look for a row.
  const blocked = dropped.filter((ev) => {
    const s = span(ev);
    const r = rowOf.get(ev._id);
    if (!clear(r, s)) return true;
    (rows[r] ??= []).push(s);
    return false;
  });
  for (const ev of blocked) {
    const s = span(ev);
    let r = rowOf.get(ev._id) + 1;
    while (!clear(r, s)) r++;
    (rows[r] ??= []).push(s);
    out.set(ev._id, r);
  }
  return out;
}

/**
 * Delete row `row` (1 or more; a track always has its first row) of a track: its
 * pills join the row above, and every row below moves up one. Nothing is removed.
 * Returns `events` itself when no pill sat at or below that row.
 */
export function deleteRow(events, track, row) {
  if (!Number.isInteger(row) || row < 1) return events;
  let touched = false;
  const out = events.map((e) => {
    const r = e.from === track && e.kind !== 'keep' ? rowOfEvent(e) : null;
    if (r == null || r < row) return e;
    touched = true;
    return { ...e, row: r - 1 };
  });
  return touched ? out : events;
}

// ── Locks, hits and links ───────────────────────────────────────────────────────
// The keep lane's commands. Every scheduler command is `+0 op, +1 u16 size in dwords
// (low 5 bits), +3 zero, +4 u16 delay (the wait after it), +6 u16 dur`; a link names
// its routine at +8, and +0xC stays zero — the client keeps the routine it found there
// and reads anything else as a pointer. What each does is the PS2 client's scheduler
// (ymschdecript.cpp ExecuteTag); the defaults are what retail DATs carry most.
//
// A command added here is an event with no `from` and its whole command in `raw`:
// compose writes it into the mix's routine as it stands, with the delay, `dur` and a
// link's `ref` stamped in, so it belongs to no track — clearing or picking a track
// again leaves it — and compose never renames it. A link into a track's own routine
// is the exception: it keeps that track as `from`, so compose carries the routine.

/** Whether an event names the track it came from. */
export const hasTrack = (ev) => typeof ev?.from === 'string' && ev.from !== '';
/**
 * Whether compose writes `ev` into the routine: it plays, and a command of no track has
 * its bytes and, when it is a link, names a routine (under no name the game finds
 * nothing, and xi refuses the bytes). serializeRecipe, holdPlan and Play mix's reading
 * of what compose wrote all count by this.
 */
export const isComposed = (ev) => ev?.enabled !== false
  && (hasTrack(ev) || (typeof ev?.raw === 'string' && (!isLinkOp(ev.op) || !!(ev.ref || rawLinkName(ev.raw)))));

const FLINCH_FIELDS = [
  { key: 'weight', at: 0x08, type: 'f32' },
  { key: 'speed', at: 0x0c, type: 'f32' },
  { key: 'loops', at: 0x10, type: 'i32' },
  { key: 'blendIn', at: 0x14, type: 'f32' },
  { key: 'blendOut', at: 0x18, type: 'f32' },
  { key: 'direction', at: 0x1c, type: 'u32' },   // 0 by facing, 1 front, 2 back
];
const KNOCKBACK_FIELDS = [
  { key: 'mode', at: 0x08, type: 's16' },        // 0: the server's knockback
  { key: 'reverse', at: 0x0a, type: 's16' },     // 0 away from the caster, 1 the other way
  { key: 'distance', at: 0x0c, type: 'f32' },
];
const FADE_FIELDS = [{ key: 'rgba', at: 0x08, type: 'rgba' }];   // 0x80 each is neutral
const FIELD_BYTES = { f32: 4, i32: 4, u32: 4, s16: 2, rgba: 4 };

const LINK_LOOKS = {
  track: 'in this mix\'s DAT', shared: 'in ROM/0/0.DAT', actor: 'on the caster', target: 'on the target',
};
/**
 * The keep ops the mixer knows the bytes of. `size` in bytes; `xi` the name `xi ability
 * inspect` gives it; `short` its pill label (`timed`: with its span); `family` and
 * `variant` the ops one command can switch between; `looks` where a link's routine is
 * searched, in order; `does` what it does in game, in a line.
 */
const KEEP_OPS = {
  0x20: { size: 12, xi: 'LockActorStatus', short: 'Lock target', timed: true, family: 'lock', variant: 'the target',
    does: 'Holds the target\'s status: until it ends the target ignores the server\'s death, stance and gear changes, so it cannot fall or disengage before its number shows. Retail runs it from frame 0 to the hit.' },
  0x1f: { size: 12, xi: 'LockActorStatus', short: 'Lock caster', timed: true, family: 'lock', variant: 'the caster',
    does: 'Holds the caster\'s status: the server\'s death, stance and gear changes wait until it ends.' },
  0x56: { size: 12, xi: 'LockTargetStatus', short: 'Lock all', timed: true, family: 'lock', variant: 'every target',
    does: 'Holds the status of every target the action hit (the main target when it hit none): an area action\'s lock. Retail keeps it short and lets a target lock take over.' },
  0x2e: { size: 8, xi: 'LockCasterControl', short: 'Lock control', timed: true,
    does: 'The player cannot act until it ends; then the body goes back to idle. Retail ends it about at the hit.' },
  0x2f: { size: 8, xi: 'LockCasterRotation', short: 'Lock turning', timed: true,
    does: 'The caster cannot turn until it ends.' },
  0x59: { size: 8, xi: 'LockCasterMagic', short: 'Lock magic', timed: true,
    does: 'Locks the caster\'s magic and holds its status until it ends. Retail gives it the control lock\'s length.' },
  0x07: { size: 12, xi: 'BondActors', short: 'Hold caster', timed: true, does: 'Keeps the caster held until it ends (Raise II carries one).' },
  0x08: { size: 12, xi: 'BondActors', short: 'Hold target', timed: true, does: 'Keeps the target held until it ends (Tractor carries one).' },
  0x88: { size: 12, xi: 'LockColorDrive', short: 'Lock colour', timed: true, does: 'Stops other colour fades on the caster until it ends.' },
  0x25: { size: 36, xi: 'Flinch', short: 'Flinch · target', family: 'flinch', variant: 'the target', fields: FLINCH_FIELDS,
    does: 'The target plays its damage motion, as hard as the server says the hit was. Nothing plays when the server sends no hit strength (this server sends none for spells) or the target is dead. Its duration is not read.' },
  0x21: { size: 36, xi: 'Flinch', short: 'Flinch · caster', family: 'flinch', variant: 'the caster', fields: FLINCH_FIELDS,
    does: 'The caster plays its damage motion, as hard as the server says the hit was. Retail uses it only in routines that run on the target. Its duration is not read.' },
  0x5e: { size: 24, xi: 'Knockback', short: 'Knockback', fields: KNOCKBACK_FIELDS,
    does: 'The target slides back and plays its knock-back motion. Mode 0 follows the server, which sends none for most actions; any other mode knocks back by the distance here.' },
  0x2b: { size: 12, xi: 'StatusMessage', short: 'Hit · 2B',
    does: 'Shows the next result not shown yet: the damage or heal line and its number. The shared mdam is exactly this.' },
  0x71: { size: 12, xi: 'StatusMessageSP', short: 'Message', fields: [{ key: 'type', at: 0x08, type: 'u32' }],
    does: 'Prints the added-effect (type 1) or spikes and counter (type 2) message of the last result shown.' },
  0x28: { size: 12, short: 'Back to idle', fields: [{ key: 'blend', at: 0x08, type: 'f32' }],
    does: 'The caster blends back into its idle, walk or run over the blend ticks.' },
  0x29: { size: 16, xi: 'ActorFade', short: 'Fade caster', timed: true, fields: FADE_FIELDS,
    does: 'Fades the caster\'s colour to this one over its duration; 80 80 80 80 puts it back.' },
  0x2a: { size: 16, xi: 'ActorFade', short: 'Fade target', timed: true, fields: FADE_FIELDS,
    does: 'Fades the target\'s colour to this one over its duration; 80 80 80 80 puts it back.' },
  0x75: { size: 16, xi: 'ShowHideWeapon', short: 'Weapon', fields: [
    { key: 'hide', at: 0x08, type: 'u32' }, { key: 'slot', at: 0x0c, type: 's16' }, { key: 'engaged', at: 0x0e, type: 's16' }],
  does: 'Shows or hides a weapon (main, sub or ranged); with a duration it hides it that long and shows it again.' },
  0x03: { size: 16, xi: 'LinkRoutine(source)', family: 'link', variant: 'alongside (0x03)', looks: ['track', 'shared'],
    does: 'Runs the routine alongside this one, on the same caster, target and result.' },
  0x3b: { size: 16, xi: 'LinkRoutine(blocking)', family: 'link', variant: 'and wait for it (0x3B)', looks: ['track', 'shared'], blocking: true,
    does: 'Runs the routine and waits for it to end: this routine and its locks pause until then.' },
  0x09: { size: 16, xi: 'LinkRoutine(target)', family: 'link', variant: 'as the target (0x09)', looks: ['target', 'shared'],
    does: 'Runs the routine with caster and target swapped.' },
  0x57: { size: 16, xi: 'LinkRoutine', family: 'link', variant: 'the caster\'s own (0x57)', looks: ['actor', 'shared'],
    does: 'Runs a routine alongside this one, the caster\'s own (its race\'s files) before a shared one.' },
  0x3c: { size: 16, xi: 'LinkRoutine(blocking)', family: 'link', variant: 'the caster\'s own, and wait (0x3C)', looks: ['actor'], blocking: true,
    does: 'Runs one of the caster\'s own routines (its race\'s files) and waits for it: retail\'s cast release (sh··) is this. A name the race does not have is skipped.' },
};
const KEEP_FAMILIES = { lock: [0x20, 0x1f, 0x56], flinch: [0x25, 0x21], link: [0x03, 0x3b, 0x09, 0x57, 0x3c] };
/** What the family's variant combo calls the choice. */
export const KEEP_FAMILY_LABEL = { lock: 'holds', flinch: 'plays on', link: 'runs' };

/** The shared routines retail links, and what each is. */
const SHARED_NOTES = {
  mdam: 'the hit: shows the damage or heal line and its number now',
  proc: 'the added effect: plays the added-effect or skillchain animation when the result has one',
  eis1: 'the activation flash on the caster, with its sound',
  ei11: 'the activation flash on the caster',
  hwmg: 'puts the weapons away to cast (main and sub when engaged, and the ranged one)',
  hwso: 'brings the instrument out (ranged shown, main and sub put away when engaged)',
  stnm: 'stops the charge circle',
  wash: '60 ticks of magic, target and control locks, what a cast release waits on',
  waso: '60 ticks of magic, target and control locks, what a song\'s release waits on',
};
/** The shared routines retail links, most used first: the routine field lists them first. */
export const SHARED_ROUTINES = Object.keys(SHARED_NOTES);
/** What a shared routine retail links is, or null. */
export const sharedNote = (ref) => SHARED_NOTES[ref] ?? null;

const hexOf = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
function bytesOf(hex) {
  if (typeof hex !== 'string' || !/^([0-9a-f]{2})+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
const u16 = (v) => Math.max(0, Math.min(0xffff, Math.round(Number(v) || 0)));

/** The ops the mixer knows the bytes of, with what they do: KEEP_OPS[op] or null. */
export const keepOp = (op) => KEEP_OPS[op] ?? null;

/**
 * A command's fields from its bytes (hex): `{ op, size, delay, dur, raw }`, a link's
 * `ref`, and the operands the catalogue gives a layout for (flinch, knockback, colour
 * fade, weapon, message, return to idle). Null when `raw` is not a command.
 */
export function keepFields(raw) {
  const b = bytesOf(raw);
  if (!b || b.length < 8) return null;
  const dv = new DataView(b.buffer);
  const op = b[0];
  const out = { op, size: Math.max(1, dv.getUint16(1, true) & 0x1f) * 4, delay: dv.getUint16(4, true), dur: dv.getUint16(6, true), raw: hexOf(b) };
  if (isLinkOp(op) && b.length >= 12) {
    out.ref = String.fromCharCode(...b.subarray(8, 12)).replace(/\0.*$/s, '').trimEnd();
  }
  for (const f of KEEP_OPS[op]?.fields ?? []) {
    if (f.at + FIELD_BYTES[f.type] > b.length) continue;
    if (f.type === 'f32') out[f.key] = dv.getFloat32(f.at, true);
    else if (f.type === 'i32') out[f.key] = dv.getInt32(f.at, true);
    else if (f.type === 'u32') out[f.key] = dv.getUint32(f.at, true);
    else if (f.type === 's16') out[f.key] = dv.getInt16(f.at, true);
    else if (f.type === 'rgba') out[f.key] = Array.from(b.subarray(f.at, f.at + 4));
  }
  return out;
}

/**
 * A command's bytes (hex) from its fields, as keepFields gives them: `raw` is the
 * command to start from (every byte the fields do not name is kept), else a zeroed
 * body of the op's size. The header is written as the client reads it: the op, the
 * size in dwords, `delay` and `dur` (when given); a link's `ref` at +8 with +0xC zero.
 * Null for an op the mixer does not know the size of, with no bytes to start from.
 */
export function keepRaw(op, fields = {}) {
  const spec = KEEP_OPS[op];
  const base = bytesOf(fields.raw);
  const size = spec?.size ?? (base && base.length % 4 === 0 ? base.length : 0);
  if (!size || size > 0x1f * 4) return null;
  const b = new Uint8Array(size);
  if (base) b.set(base.subarray(0, size));
  const dv = new DataView(b.buffer);
  b[0] = op;
  dv.setUint16(1, size / 4, true);
  b[3] = 0;
  if (fields.delay != null) dv.setUint16(4, u16(fields.delay), true);
  if (fields.dur != null) dv.setUint16(6, u16(fields.dur), true);
  if (isLinkOp(op) && size >= 16) {
    if (fields.ref != null) b.set(name4(String(fields.ref).slice(0, 4)), 8);
    dv.setUint32(12, 0, true);
  }
  for (const f of spec?.fields ?? []) {
    const v = fields[f.key];
    if (v == null || f.at + FIELD_BYTES[f.type] > size) continue;
    if (f.type === 'f32') dv.setFloat32(f.at, Number(v) || 0, true);
    else if (f.type === 'i32') dv.setInt32(f.at, Math.trunc(Number(v) || 0), true);
    else if (f.type === 'u32') dv.setUint32(f.at, Math.max(0, Math.trunc(Number(v) || 0)) >>> 0, true);
    else if (f.type === 's16') dv.setInt16(f.at, Math.max(-0x8000, Math.min(0x7fff, Math.trunc(Number(v) || 0))), true);
    else if (f.type === 'rgba' && Array.isArray(v)) v.slice(0, 4).forEach((c, i) => { b[f.at + i] = Math.max(0, Math.min(255, Math.round(Number(c) || 0))); });
  }
  return hexOf(b);
}

/** The routine a link's bytes name at +8, as stored (trailing spaces kept: the game
 *  compares all four bytes), when it is a name the schema takes; else null. */
function rawLinkName(raw) {
  const b = bytesOf(raw);
  if (!b || b.length < 12) return null;
  const name = String.fromCharCode(...b.subarray(8, 12)).replace(/\0+$/, '');
  return /^[ -~]{1,4}$/.test(name) && name.trim() ? name : null;
}

/**
 * A command of no track with the routine it names and its duration read from its bytes
 * where the event leaves them out: a file may carry them only in `raw`, and
 * serializeRecipe and patchKeepEvent write the event's own fields over the bytes.
 */
export function keepEventFromBytes(ev) {
  if (hasTrack(ev)) return ev;
  const b = bytesOf(ev?.raw);
  if (!b || b.length < 8) return ev;
  const out = { ...ev };
  if (out.ref == null && isLinkOp(ev.op)) {
    const name = rawLinkName(ev.raw);
    if (name) out.ref = name;
  }
  const dur = b[6] | (b[7] << 8);
  if (out.dur == null && dur > 0) out.dur = dur;
  return out;
}

/**
 * Why `raw` cannot be written for `op` as a command of its own, as a phrase that
 * follows "and" (null when it can): hex whole dwords, its size byte saying as much,
 * its first byte the op — the client walks a routine by those sizes, so one wrong
 * size runs every command after it together.
 */
export function keepRawProblem(op, raw) {
  const b = bytesOf(raw);
  if (!b) return 'carries no raw bytes (hex)';
  if (b.length < 8 || b.length % 4) return 'its raw bytes are not whole dwords';
  if (Math.max(1, b[1] & 0x1f) * 4 !== b.length) return 'its raw bytes say another size than they are';
  if (b[0] !== op) return `its raw bytes are op ${b[0].toString(16).padStart(2, '0')}, not ${op.toString(16).padStart(2, '0')}`;
  return null;
}

/** A hit: a link to the shared `mdam` (one 0x2B) or a 0x2B of its own. */
const isKeepHit = (e) => (isLinkOp(e?.op) && e.ref === 'mdam') || e?.op === 0x2b;
/** The mix's hits that play, earliest first. */
export const keepHits = (events) => (events ?? []).filter((e) => e.enabled !== false && isKeepHit(e)).sort((a, b) => a.start - b.start);

/** The ops one command can switch between, `[{ id: op, label }]`, or null. */
export function keepVariants(op) {
  const fam = KEEP_OPS[op]?.family;
  return fam ? KEEP_FAMILIES[fam].map((o) => ({ id: o, label: KEEP_OPS[o].variant })) : null;
}
export const keepFamily = (op) => KEEP_OPS[op]?.family ?? null;

/** A keep pill's label: what it is, and for a timed lock its span ("Lock target 0-80"). */
export function keepLabel(ev) {
  const { op, ref } = ev;
  if (isLinkOp(op)) {
    if (ref === 'mdam') return 'Hit · mdam';
    if (ref === 'proc') return 'Added effect';
    if (op === 0x3c && /^sh/.test(ref ?? '')) return `Release · ${ref}`;
    const verb = op === 0x3b || op === 0x3c ? 'Link+wait' : op === 0x09 ? 'Link (target)' : 'Link';
    return `${verb} ${ref || '?'}`;
  }
  const spec = KEEP_OPS[op];
  if (!spec?.short) return ref ? `${opName(op)} ${ref}` : opName(op);
  const dur = Number(ev.dur) || 0;
  return spec.timed && dur > 0 ? `${spec.short} ${ev.start}-${ev.start + dur}` : spec.short;
}

/** What a keep command does in game, in a line or two: its op's, and for a link what the routine it names is. */
export function keepDoes(ev) {
  const spec = KEEP_OPS[ev?.op];
  let text = spec?.does ?? `${opName(ev?.op ?? 0)}: the mixer has no notes on this command; it goes in as its bytes.`;
  if (isLinkOp(ev?.op) && ev.ref) {
    const note = SHARED_NOTES[ev.ref] ?? (/^sh/.test(ev.ref) ? 'the cast release: it stops the casting circle, plays the release burst and motion, then waits out 60 ticks of locks' : null);
    if (note) text += ` ${ev.ref} is ${note}.`;
  }
  return text;
}

/**
 * Where the game finds the routine a link names, for its op. 0x03 and 0x3B look in the
 * mix's own DAT (a track's routine that compose carries) and then ROM/0/0.DAT, never on
 * the actor; 0x09 on the target and then ROM/0/0; 0x57 on the caster and then ROM/0/0;
 * 0x3C only on the caster (retail's `sh··` cast releases).
 *
 *   targets  { shared: Set | null, actor: Set | null, tracks: Map(track → Set | null) }:
 *            the shared routines, the stage actor's, each track's source's (null: not read)
 *   from     the event's track: only its own source's routines travel with it
 *
 * `{ where: 'track' | 'shared' | 'actor' | 'self' | 'nowhere' | 'unknown' | 'none', track, also }` —
 * `unknown` when a place it looks has not been read, `none` for no ref, `self` for the
 * mix's own main, and for `nowhere` the place (`also`, with `track`) that has it where
 * this op does not look.
 */
export function resolveKeepRef(op, ref, targets = null, from = null) {
  if (!ref) return { where: 'none' };
  const t = targets ?? {};
  // Only the event's own track's routines travel with it; one whose source is not read yet is not known.
  const own = hasTrack({ from }) ? (t.tracks?.get(from) ?? null) : undefined;
  const has = {
    track: own === undefined ? false : (own == null ? null : own.has(ref)),
    shared: t.shared ? t.shared.has(ref) : null,
    actor: t.actor ? t.actor.has(ref) : null,
    target: null,   // the target's own files: no target here
  };
  const looks = KEEP_OPS[op]?.looks ?? ['track', 'shared'];
  // Compose writes the mix as `main`, and 0x03 / 0x3B look in its DAT first: a link of
  // that name (not a track's own routine of it) runs the mix again from inside itself.
  if (ref === 'main' && looks.includes('track') && !has.track) return { where: 'self' };
  for (const place of looks) if (has[place]) return { where: place, track: place === 'track' ? from : null };
  if (looks.some((place) => has[place] == null)) return { where: 'unknown' };
  const other = [...(t.tracks ?? [])].find(([, set]) => set?.has(ref))?.[0] ?? null;
  const also = has.actor ? 'actor' : has.shared ? 'shared' : other ? 'track' : null;
  return { where: 'nowhere', also, track: also === 'track' ? other : null };
}
/** Where an op looks for its routine, in words ("on the caster or in ROM/0/0.DAT"). */
export const keepLooks = (op) => (KEEP_OPS[op]?.looks ?? ['track', 'shared']).map((p) => LINK_LOOKS[p]).join(' or ');

/**
 * The track a link belongs to: the one whose source has the routine it names, when its
 * op looks in the mix's own DAT (0x03, 0x3B) — compose then carries that routine with
 * the track's renames — else none. The event's own track first; a shared routine of
 * the name keeps it trackless. A track whose source is not read keeps what it holds.
 */
function linkHome(op, ref, targets = null, from = null) {
  if (!ref || !(op === 0x03 || op === 0x3b)) return null;
  const tracks = targets?.tracks ?? new Map();
  if (hasTrack({ from })) {
    const own = tracks.get(from);
    if (own == null || own.has(ref)) return from;
  }
  if (targets?.shared?.has(ref)) return null;
  return [...tracks].find(([, set]) => set?.has(ref))?.[0] ?? null;
}

/**
 * `ev` with `patch` applied and its bytes in step: `op` (a variant of its family),
 * `dur`, a link's `ref` and the operands in `patch.fields` go into `raw`, from the
 * bytes it has. A link's `from` follows its routine (linkHome). `start` and `enabled`
 * are the event's alone: compose stamps the delay.
 */
export function patchKeepEvent(ev, patch, targets = null) {
  const { fields = null, ...plain } = patch;
  const next = { ...ev, ...plain };
  if ('ref' in plain && !plain.ref) delete next.ref;
  if ('dur' in plain && !(Number(plain.dur) > 0)) delete next.dur;
  const bytes = fields || 'op' in plain || 'dur' in plain || 'ref' in plain;
  if (bytes && (ev.raw || KEEP_OPS[next.op])) {
    const raw = keepRaw(next.op, {
      ...(keepFields(ev.raw) ?? {}), ...(fields ?? {}), dur: frames(next.dur),
      ...(isLinkOp(next.op) ? { ref: next.ref ?? '' } : null),
    });
    if (raw) next.raw = raw;
    if ('op' in plain && KEEP_OPS[next.op]?.xi) next.name = KEEP_OPS[next.op].xi;
  }
  if (isLinkOp(next.op) && ('ref' in plain || 'op' in plain)) {
    const home = linkHome(next.op, next.ref, targets, ev.from);
    if (home) next.from = home; else delete next.from;
  }
  return next;
}

/** A keep event, added by hand: no track, its bytes built from its fields. */
function keepEvent(op, { ref = null, start = 0, dur = 0, fields = {} } = {}) {
  const spec = KEEP_OPS[op];
  const name = typeof ref === 'string' && ref ? ref.slice(0, 4) : null;
  const d = frames(dur);
  return {
    op, ...(name ? { ref: name } : null), start: frames(start), ...(d > 0 ? { dur: d } : null),
    raw: keepRaw(op, { ...fields, delay: 0, dur: d, ...(isLinkOp(op) ? { ref: name ?? '' } : null) }),
    ...(spec?.xi ? { name: spec.xi } : null),
    kind: 'keep', enabled: true,
  };
}

// Retail's most common bodies: a full-weight flinch played once by facing (blend in 2,
// out 10), and Tail Slap's knockback, which follows the server.
const FLINCH_BODY = { weight: 1, speed: 1, loops: 1, blendIn: 2, blendOut: 10, direction: 0 };
const KNOCKBACK_BODY = { raw: '5e0600000000000000000000000040410000003e00000000' };
const HOLD = 90;   // retail's commonest lock length

/**
 * What the keep lane's + adds, grouped for Combo `groupByType`. A preset is one
 * command (`op`, `ref`, `dur`, `body`), or a set (`set(at, ctx)` → rows) laid where
 * retail lays them. `ctx` (makeKeepEvents) says where the mix's hit is.
 */
export const KEEP_PRESETS = [
  { id: 'lock-target', group: 'Locks', label: 'Target status', op: 0x20, dur: HOLD, toHit: true },
  { id: 'lock-all', group: 'Locks', label: 'Every target\'s status (area)', op: 0x56, dur: 60 },
  { id: 'lock-caster', group: 'Locks', label: 'Caster status', op: 0x1f, dur: HOLD },
  { id: 'lock-control', group: 'Locks', label: 'Control', op: 0x2e, dur: HOLD },
  { id: 'lock-magic', group: 'Locks', label: 'Magic', op: 0x59, dur: HOLD },
  { id: 'lock-rotation', group: 'Locks', label: 'Turning', op: 0x2f, dur: HOLD },
  { id: 'hit', group: 'Hits', label: 'Hit · mdam (the damage number)', op: 0x03, ref: 'mdam' },
  { id: 'proc', group: 'Hits', label: 'Added effect · proc', op: 0x03, ref: 'proc' },
  { id: 'flinch-target', group: 'Hits', label: 'Flinch · target', op: 0x25, body: FLINCH_BODY },
  { id: 'flinch-caster', group: 'Hits', label: 'Flinch · caster', op: 0x21, body: FLINCH_BODY },
  { id: 'knockback', group: 'Hits', label: 'Knockback', op: 0x5e, body: KNOCKBACK_BODY },
  { id: 'link-eis1', group: 'Links', label: 'eis1 · activation flash and sound', op: 0x03, ref: 'eis1' },
  { id: 'link-ei11', group: 'Links', label: 'ei11 · activation flash', op: 0x03, ref: 'ei11' },
  { id: 'link-hwmg', group: 'Links', label: 'hwmg · weapons away', op: 0x03, ref: 'hwmg' },
  { id: 'link-hwso', group: 'Links', label: 'hwso · instrument out', op: 0x03, ref: 'hwso' },
  { id: 'link-stnm', group: 'Links', label: 'stnm · stop the charge circle', op: 0x03, ref: 'stnm' },
  { id: 'link-release', group: 'Links', label: 'Cast release · sh·· (waits)', op: 0x3c, school: true },
  { id: 'link-custom', group: 'Links', label: 'Another routine…', op: 0x03 },
  {
    id: 'retail-ws', group: 'Retail set', label: 'Weapon skill or ability: locks, hit, added effect',
    // Fast Blade's: the target held from 0 to the hit, magic and control held about as
    // long (90 at least), the hit, and the added effect 20 ticks after it.
    set: (at, ctx) => {
      const hit = ctx.hit ?? ctx.strike ?? 60;
      const hold = Math.max(HOLD, hit);
      return [
        { op: 0x20, start: 0, dur: Math.max(1, hit) },
        { op: 0x59, start: 0, dur: hold },
        { op: 0x2e, start: 0, dur: hold },
        { op: 0x03, ref: 'mdam', start: hit },
        { op: 0x03, ref: 'proc', start: hit + 20 },
      ];
    },
  },
  {
    id: 'retail-spell', group: 'Retail set', label: 'Spell: cast release, target lock, hit',
    // Every retail spell opens on `3C sh<school>` at 0 (its release waits out `wash`'s 60
    // ticks, so the rest plays about a second later in game) and shows its hit late in
    // the routine (0.85 of it); most hold the target until then.
    set: (at, ctx) => {
      const hit = ctx.hit ?? (ctx.end > 0 ? Math.max(1, Math.round(ctx.end * 0.85)) : 60);
      return [
        { op: 0x3c, ref: ctx.school ?? null, start: 0 },
        { op: 0x20, start: 0, dur: hit },
        { op: 0x03, ref: 'mdam', start: hit },
      ];
    },
  },
];
const PRESET_BY_ID = new Map(KEEP_PRESETS.map((p) => [p.id, p]));
/** The retail set for a mix Type. */
export const retailKeepSet = (kind) => (kind === 'spell' ? 'retail-spell' : 'retail-ws');

/** Whether the mix already has what a set's row adds (a set fills in, never doubles up). */
function hasKeepRow(events, row) {
  const on = (events ?? []).filter((e) => e.enabled !== false);
  if (row.op === 0x03 && row.ref === 'mdam') return on.some(isKeepHit);
  if (row.op === 0x3c) return on.some((e) => e.op === 0x3c && /^sh/.test(e.ref ?? ''));
  return on.some((e) => e.op === row.op && (row.ref == null || e.ref === row.ref));
}

/**
 * The events a preset adds at frame `start`, trackless and with their bytes, fresh ids.
 *
 *   ctx.hit     the mix's first hit (a target lock reaches it), else null
 *   ctx.strike  where a hit goes when the mix has none (a set's)
 *   ctx.end     the mix's length (a spell's hit goes near its end)
 *   ctx.school  the cast release the mix's motion calls for (`shbk`…), else null
 *   ctx.events  the mix's events: a set adds only what they do not have
 */
export function makeKeepEvents(presetId, start = 0, ctx = {}) {
  const p = PRESET_BY_ID.get(presetId);
  if (!p) return [];
  const at = frames(start);
  let rows;
  if (p.set) rows = p.set(at, ctx).filter((row) => !hasKeepRow(ctx.events, row));
  else {
    const dur = p.toHit && ctx.hit != null && ctx.hit > at ? ctx.hit - at : (p.dur ?? 0);
    rows = [{ op: p.op, ref: p.school ? ctx.school ?? null : p.ref ?? null, start: at, dur, fields: p.body }];
  }
  return withIds(rows.map((row) => keepEvent(row.op, row)));
}

/** The cast release (`sh··`) the mix's own motion calls for: its casting clips name the
 *  school (black magic plays mb0? mb1? mb2?, …), else null. */
const CLIP_SCHOOL = { mb: 'shbk', mw: 'shwh', ma: 'shbl', mn: 'shnj', ms: 'shsm', mi: 'shit', sf: 'shso', sh: 'shso', sk: 'shso', gc: 'shge' };
export function keepSchool(events) {
  for (const e of events ?? []) {
    if (e.enabled === false || e.op !== 0x05 || kindOf(e.from) !== 'motion' || !/^[a-z]{2}\d/.test(e.ref ?? '')) continue;
    const school = CLIP_SCHOOL[e.ref.slice(0, 2)];
    if (school) return school;
  }
  return null;
}
/** The cast release (`sh··`) of a base motion's stages: its chant routine names it
 *  (`cabk` → `shbk`, `casm` → `shsm`), else its clips' school (a song's `sf` → `shso`).
 *  Null for a motion that is no cast. */
export function castRelease(stages) {
  for (const s of stages ?? []) {
    const m = /^ca([a-z0-9]{2})$/i.exec(s?.schedule ?? '');
    if (m) return `sh${m[1].toLowerCase()}`;
  }
  for (const s of stages ?? []) {
    const school = CLIP_SCHOOL[String(s?.ref ?? '').slice(0, 2)];
    if (school) return school;
  }
  return null;
}

/** The ops "Copy locks & hits" takes from a source: its locks and holds, flinches,
 *  knockbacks, hits and messages. Its links come when they are the keep lane's. */
const COPY_OPS = new Set([0x1f, 0x20, 0x56, 0x2e, 0x2f, 0x59, 0x07, 0x08, 0x88, 0x21, 0x25, 0x5e, 0x2b, 0x71]);
/**
 * A source's locks, hits and keep-lane links (eventsFromInspect with `keep`) as
 * commands of the mix's own: trackless, each with the bytes it had, fresh ids. What
 * `events` already has at the same frame (same op and ref) is left out.
 */
export function keepCopies(inspected, events = []) {
  const have = new Set((events ?? []).map((e) => `${e.op}|${e.ref ?? ''}|${e.start}`));
  return withIds((inspected ?? [])
    .filter((e) => e.kind === 'keep' && typeof e.raw === 'string' && (COPY_OPS.has(e.op) || isLinkOp(e.op))
      && !have.has(`${e.op}|${e.ref ?? ''}|${e.start}`))
    .map(({ _id, from, routine, offset, row, rowHint, sound, ...rest }) => ({ ...rest, kind: 'keep', enabled: true })));
}

/**
 * How far a track's events sit from its source's own frames: the frame its pick was
 * dropped on plus any lane drags, which live only in the events' starts. Each event is
 * matched to its inspector row (routine, offset, op; a sub-routine linked twice to the
 * nearer run) and the shift most of them share wins. 0 when none match.
 */
export function trackShift(events, track, timeline) {
  const at = new Map();
  for (const t of timeline ?? []) {
    if (t.routine == null || t.offset == null) continue;   // a cast stage: no command to match
    const k = `${t.routine}|${t.offset}|${t.op}`;
    if (!at.has(k)) at.set(k, []);
    at.get(k).push(t.start);
  }
  const votes = new Map();
  for (const e of events ?? []) {
    if (e.from !== track) continue;
    const starts = at.get(`${e.routine}|${e.offset}|${e.op}`);
    if (!starts) continue;
    const near = starts.reduce((a, b) => (Math.abs(e.start - b) < Math.abs(e.start - a) ? b : a));
    votes.set(e.start - near, (votes.get(e.start - near) ?? 0) + 1);
  }
  let best = 0; let n = 0;
  for (const [d, c] of votes) if (c > n || (c === n && d < best)) { best = d; n = c; }
  return best;
}

const LONG_HOLD = 600;   // a blocking link waiting this long (10 s) holds the player too
// How far retail itself goes: its target locks end up to 7 ticks before the hit (most
// on it or a tick before), and a flinch lands up to 4 after it (Leaden Salute).
const LOCK_SLACK = 10;
const FLINCH_SLACK = 5;
/**
 * What is off about the mix's locks, hits and links, as `[{ text, ids, noHit? }]`
 * (`ids` the events it is about). Nothing for an empty mix.
 *
 *   targets  as resolveKeepRef takes them, plus how long a routine runs (linkHold):
 *            `sharedTicks(ref)`, `actorTicks(ref)`, `trackTicks(track, ref)`
 */
export function keepWarnings(events, { targets = null } = {}) {
  const on = (events ?? []).filter((e) => e.enabled !== false);
  if (!on.length) return [];
  const out = [];
  const say = (text, evs = [], extra = null) => out.push({ text, ids: evs.map((e) => e._id).filter(Boolean), ...extra });
  const hits = keepHits(on);
  const hit = hits[0] ?? null;
  if (!hit) {
    say('No hit: the damage number shows only when the routine ends, when the game flushes what it has not shown.', [], { noHit: true });
  } else {
    const latest = (list, at = (e) => e.start) => list.reduce((a, b) => (a == null || at(b) > at(a) ? b : a), null);
    const flinch = latest(on.filter((e) => e.op === 0x25 || e.op === 0x21));
    const swing = latest(on.filter((e) => e.op === 0x2c));
    if (flinch && flinch.start > hit.start + FLINCH_SLACK) {
      say(`The hit at f${hit.start} comes before the last flinch (f${flinch.start}): the number shows before the blow lands.`, [hit, flinch]);
    } else if (swing && swing.start > hit.start) {
      say(`The hit at f${hit.start} comes before the last swing (the weapon trace at f${swing.start}): the number shows before contact.`, [hit, swing]);
    }
    // The target lock that holds longest: retail ends it on the hit or a tick before, and
    // a second one often takes over from a first that ends early (Shield Bash).
    const lock = latest(on.filter((e) => e.op === 0x20), (e) => e.start + (Number(e.dur) || 0));
    const lockEnd = lock ? lock.start + (Number(lock.dur) || 0) : 0;
    if (lock && lockEnd < hit.start - LOCK_SLACK) {
      say(`The target lock ends at f${lockEnd}, before the hit at f${hit.start}: the target can fall or disengage before its number shows.`, [lock, hit]);
    }
    // One result per target: an area action (every target locked, or a loop over them) has more.
    const area = on.some((e) => e.op === 0x56 || e.op === 0x30 || e.op === 0x31 || e.op === 0x32);
    if (hits.length > 1 && !area) say(`${hits.length} hits on a single-target action: its number shows at the first (f${hit.start}); the others show nothing.`, hits);
  }
  for (const link of on.filter((e) => isLinkOp(e.op))) {
    const blocking = !!KEEP_OPS[link.op]?.blocking;
    const res = resolveKeepRef(link.op, link.ref, targets, link.from);
    const what = `${blocking ? 'The waiting link' : 'The link'}${link.ref ? ` to ${link.ref}` : ''} at f${link.start}`;
    if (res.where === 'self') say(`${what} runs this mix's own main: the game finds it in this DAT, so main starts itself again on every pass and never ends${blocking ? ', with its locks and the player held' : ''}. Link another routine.`, [link]);
    else if (res.where === 'none') say(`${what} names no routine: it is left out of the mix until it names one.`, [link]);
    else if (res.where === 'nowhere') {
      const hint = res.also === 'actor' ? ' It is one of the caster\'s own routines: run it "the caster\'s own, and wait (0x3C)".'
        : res.also === 'shared' ? ' It is a shared routine: run it "alongside (0x03)".'
          : res.also === 'track' ? ` It is a routine of ${trackLabel(res.track)}'s source: name it again in the block's routine field to link it from there.` : '';
      say(`${what} is not found ${keepLooks(link.op)}: the game ${blocking ? 'logs an error and goes on' : 'skips it'}.${hint}`, [link]);
    } else if (blocking) {
      const ticks = linkHold(link, targets) ?? 0;
      if (ticks >= LONG_HOLD) say(`${what} waits for a routine that runs ${ticks} ticks (${Math.round(ticks / 60)} s): this routine and its locks hold that long, and the player with them.`, [link]);
    }
  }
  // A cast release is one routine or the other: the link plays its own release clips
  // on the caster, so clips of the same cast's release beside it play it a second time.
  for (const link of on.filter((e) => e.op === 0x3c && /^sh/.test(e.ref ?? ''))) {
    const pills = on.filter((e) => e.op === 0x05 && stageOf(e) && !isChantPill(e) && CLIP_SCHOOL[String(e.ref ?? '').slice(0, 2)] === link.ref);
    if (!pills.length) continue;
    const names = [...new Set(pills.map((e) => stageOf(e)))].join(' and ');
    say(`The release plays twice: the link to ${link.ref} at f${link.start} plays it on the caster, and so ${pills.length === 1 ? 'does the' : 'do the'} ${names} ${pills.length === 1 ? 'pill' : 'pills'}. Keep one: mute the link, or the pills.`, [link, ...pills]);
  }
  return out;
}

// ── Holds ───────────────────────────────────────────────────────────────────────
// A blocking link (0x3B, 0x3C) runs its routine and suspends the one it is in until that
// routine ends (ymschdecript.cpp, YmParentTask::Suspend; the child's destructor resumes it),
// so everything after it in the mix plays that many ticks behind its frame: a spell's
// `3C sh··` holds the rest of its DAT about 61 ticks — the release's tick, then `wash`'s 60.
// The timeline keeps the frames compose writes and shades each hold; the stage plays them
// held (App.jsx); holdClock turns one clock into the other.

/** Whether a link holds its routine until the one it runs has ended (0x3B, 0x3C). */
export const isBlockingOp = (op) => !!KEEP_OPS[op]?.blocking;

/**
 * How many ticks a blocking link holds the mix for: the run of the routine it names, found
 * where the game looks for its op (resolveKeepRef) — `targets.actorTicks(ref)` on the
 * caster, `sharedTicks(ref)` in ROM/0/0.DAT, `trackTicks(track, ref)` in a track's source.
 * 0 when it holds nothing (no blocking link, no routine, or one the game does not find: it
 * logs the name and goes on), null while that is not known.
 */
export function linkHold(ev, targets = null) {
  if (!isBlockingOp(ev?.op) || !ev.ref) return 0;
  const res = resolveKeepRef(ev.op, ev.ref, targets, ev.from);
  const n = res.where === 'actor' ? targets?.actorTicks?.(ev.ref)
    : res.where === 'shared' ? targets?.sharedTicks?.(ev.ref)
      : res.where === 'track' ? targets?.trackTicks?.(res.track, ev.ref)
        : res.where === 'unknown' ? null : 0;
  return n == null ? null : Math.max(0, Math.round(Number(n) || 0));
}

/**
 * Where the mix's blocking links hold it, and how far behind its frame each event plays.
 * Compose writes the routine in start order, a tie in the recipe's own order (`order`
 * first), so a link holds what comes after it there: every later frame, and an event on
 * its frame listed after it. Only what compose writes counts (isComposed): a muted event, a
 * command of no track without bytes, or a link of no track that names nothing is not in
 * the routine.
 *
 *   holdOf(ev)  the ticks a blocking link holds (linkHold); 0 or null holds nothing
 *
 * `{ holds: [{ id, at, ticks, ref, op }], offsets: Map(_id → ticks) }`, holds in the order
 * they hold.
 */
export function holdPlan(events, holdOf) {
  const written = (events ?? []).filter(isComposed);
  const order = written.map((e, i) => ({ e, i }))
    .sort((a, b) => frames(a.e.start) - frames(b.e.start) || (Number(a.e.order) || 0) - (Number(b.e.order) || 0) || a.i - b.i);
  const holds = [];
  const offsets = new Map();
  let late = 0;
  for (const { e } of order) {
    offsets.set(e._id, late);
    if (!isBlockingOp(e.op)) continue;
    const ticks = Math.max(0, Math.round(Number(holdOf(e)) || 0));
    if (!ticks) continue;
    holds.push({ id: e._id, at: frames(e.start), ticks, ref: e.ref ?? null, op: e.op });
    late += ticks;
  }
  return { holds, offsets };
}

/**
 * The holds the timeline shades, one per blocking link that compose writes: holdPlan's
 * with `late`, how far everything after it plays behind its frame (its own hold and the
 * ones before it), plus each link whose hold is not known yet (`ticks` and `late` null:
 * its routine is on the caster with no character on the stage, or in a DAT not read).
 * A link that holds nothing (its routine ends at once, or the game does not find it) has
 * none. In frame order.
 *
 *   targets  as linkHold takes them
 */
export function holdMarks(events, targets = null) {
  const unknown = [];
  const { holds } = holdPlan(events, (e) => {
    const n = linkHold(e, targets);
    if (n == null) unknown.push(e);
    return n;
  });
  let late = 0;
  const marks = holds.map((h) => ({ ...h, late: (late += h.ticks) }));
  for (const e of unknown) marks.push({ id: e._id, at: frames(e.start), ticks: null, late: null, ref: e.ref ?? null, op: e.op });
  return marks.sort((a, b) => a.at - b.at);
}

/**
 * The stage's clock against the timeline's frames, for holdPlan's holds. `toStage(frame)`
 * is the tick an event on that frame plays on, past every hold before it (`inclusive`
 * counts one on that very frame too: a routine that ends there waits it out first);
 * `toFrame(tick)` is the frame the routine is on at that tick of the stage — a hold keeps
 * it on its link's frame until the routine it waits for ends.
 */
export function holdClock(holds) {
  const hs = [...(holds ?? [])].filter((h) => h.ticks > 0).sort((a, b) => a.at - b.at);
  return {
    toStage: (frame, inclusive = false) => hs.reduce((t, h) => (h.at < frame || (inclusive && h.at === frame) ? t + h.ticks : t), frame),
    toFrame: (tick) => {
      let shift = 0;
      for (const h of hs) {
        const from = h.at + shift;
        if (tick < from) break;
        if (tick < from + h.ticks) return h.at;
        shift += h.ticks;
      }
      return tick - shift;
    },
  };
}

// ── Generator edits ─────────────────────────────────────────────────────────────
// What the generator editor changes rides on the recipe: `generators` holds in-place
// edits to a track's particle generators, `curves` replaces the keys of a track's
// keyframe curves. Both name their section as the track's SOURCE DAT does, so a name
// compose changes on a collision does not disturb them, and compose bakes them into
// every DAT it writes. An EDIT names bytes, not a field — { sec, op, nth, at, type,
// value, mask } (particle/fields.js) — so the helpers here work in FIELDs of the
// source generator (describeGenerator / allFields on the unedited bytes, whose
// `value` is what no edit leaves): one whole-field EDIT per edited field. An entry
// with nothing left in it goes, and so does an emptied list. Each returns the recipe
// it was given when nothing changes.

const EDIT_BYTES = { u8: 1, u16: 2, u32: 4, i16: 2, i32: 4, f32: 4, datid: 4 };
const editSpan = (e) => [e.at, e.at + (EDIT_BYTES[e.type] ?? 4) * (Array.isArray(e.value) ? e.value.length : 1)];
/** The bits of its integer a field owns; null when it owns all of them. */
const fieldBits = (field) => (field.type === 'flags' ? field.editMask : field.mask) ?? null;
const sameOp = (e, field) => e.sec === field.sec
  && (field.sec === 0 || (opcodeOf(e.op) === field.op && (e.nth ?? 0) === field.nth));
/** An EDIT that writes nothing outside the field. */
function editWithin(e, field) {
  if (!sameOp(e, field)) return false;
  const [from, to] = editSpan(e);
  if (from < field.at || to > field.at + field.size) return false;
  const bits = fieldBits(field);
  return bits == null || (e.mask != null && (e.mask & ~bits) === 0);
}
/** An EDIT that writes some of the field's bits. */
function editTouches(e, field) {
  if (!sameOp(e, field)) return false;
  const [from, to] = editSpan(e);
  return from < field.at + field.size && to > field.at && ((e.mask ?? -1) & (fieldBits(field) ?? -1)) !== 0;
}
const sameStored = (field, a, b) => {
  const eq = (x, y) => (field.type === 'f32' ? Math.fround(x) === Math.fround(y) : x === y);
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => eq(v, b[i]));
  return eq(a, b);
};

const entryOf = (recipe, key, lane, ref) => (recipe?.[key] ?? []).find((g) => g.lane === lane && g.ref === ref) ?? null;
/** The recipe with one entry's body list replaced; an empty list drops the entry, an emptied list of entries its key. */
function withEntry(recipe, key, body, lane, ref, value) {
  const had = entryOf(recipe, key, lane, ref);
  if (JSON.stringify(had?.[body] ?? []) === JSON.stringify(value)) return recipe;
  const others = (recipe[key] ?? []).filter((g) => g !== had);
  const list = value.length ? [...others, { lane, ref, [body]: value }] : others;
  const { [key]: _, ...rest } = recipe;
  return list.length ? { ...rest, [key]: list } : rest;
}

const NO_EDITS = Object.freeze([]);   // one array, so "no edits" compares equal from one render to the next
/** The EDITs a recipe holds for one generator of a track. */
export const generatorEdits = (recipe, lane, ref) => entryOf(recipe, 'generators', lane, ref)?.edits ?? NO_EDITS;
/** The keys a recipe gives one curve of a track, else null. */
export const curveKeys = (recipe, lane, ref) => entryOf(recipe, 'curves', lane, ref)?.keys ?? null;

/**
 * Set a field to `value` — the stored value, as editFor takes it. The field's own
 * EDITs are replaced by one; setting it back to the source's value leaves none. An
 * EDIT that also writes beyond the field (written by hand) stays, and the new one
 * lands after it.
 */
export function setFieldEdit(recipe, lane, ref, field, value) {
  const rest = generatorEdits(recipe, lane, ref).filter((e) => !editWithin(e, field));
  if (!sameStored(field, value, field.value) || rest.some((e) => editTouches(e, field))) rest.push(editFor(field, value));
  return withEntry(recipe, 'generators', 'edits', lane, ref, rest);
}
/** A field back to what the source DAT holds. */
export const clearFieldEdit = (recipe, lane, ref, field) => setFieldEdit(recipe, lane, ref, field, field.value);
/** Every edit of one generator gone. */
export const clearGeneratorEdits = (recipe, lane, ref) => withEntry(recipe, 'generators', 'edits', lane, ref, []);

/**
 * Replace a curve's keys ([[time, value], …], as many as the source curve has).
 * `sourceKeys` are the source DAT's: keys equal to them leave no entry.
 */
export function setCurveKeys(recipe, lane, ref, keys, sourceKeys = null) {
  const same = sourceKeys && keys.length === sourceKeys.length
    && keys.every(([t, v], k) => Math.fround(t) === Math.fround(sourceKeys[k][0]) && Math.fround(v) === Math.fround(sourceKeys[k][1]));
  return withEntry(recipe, 'curves', 'keys', lane, ref, same ? [] : keys.map(([t, v]) => [t, v]));
}
export const clearCurveKeys = (recipe, lane, ref) => withEntry(recipe, 'curves', 'keys', lane, ref, []);

/** A track's edits and texture replacements gone with it: they name sections of the source it held. */
export function dropLaneEdits(recipe, lane) {
  let out = recipe;
  for (const key of [...EDIT_LISTS.map(([k]) => k), 'textures']) {
    if (!(out[key] ?? []).some((g) => g.lane === lane)) continue;
    const list = out[key].filter((g) => g.lane !== lane);
    const { [key]: _, ...rest } = out;
    out = list.length ? { ...rest, [key]: list } : rest;
  }
  return out;
}

/**
 * One generator's colours turned `degrees` round the colour wheel, as recipe edits
 * (fields.js hueRotate): its colour operands, and its red / green / blue curves
 * where their keys line up. The turn starts from the edit lists in `from`
 * ({ generators, curves }, the recipe's own when omitted) rather than from what an
 * earlier turn left, so a slider can sweep without the rounding piling up and 0°
 * is `from` again.
 *
 *   source, section   the track's source DAT and the generator's section in it
 *   curves            curvesOf(source)
 */
export function turnGeneratorHue(recipe, { lane, ref, source, section, curves, ids = null, degrees, from = recipe }) {
  const { generators: _g, curves: _c, ...rest } = recipe;
  const begin = { ...rest, ...(from.generators ? { generators: from.generators } : null), ...(from.curves ? { curves: from.curves } : null) };
  const fields = allFields(describeGenerator(source, section.start, section.size));
  const start = describeGenerator(composedSection(source, section, { recipe: begin, lane, ids }), 0, section.size);
  const curveAt = (id) => {
    const c = curves.get(id);
    const keys = c && curveKeys(begin, lane, id);
    return keys && keys.length === c.keys.length ? { ...c, keys } : c ?? null;
  };
  const turned = hueRotate(start, degrees, curveAt);
  let next = begin;
  for (const e of turned.edits) {
    const field = fields.find((f) => f.type === 'rgba' && f.at === e.at && sameOp(e, f));
    if (field) next = setFieldEdit(next, lane, ref, field, e.value);
  }
  for (const c of turned.curves) next = setCurveKeys(next, lane, c.ref, c.keys, curves.get(c.ref)?.keys ?? null);
  return next;
}

/** "track:ref" of every generator the recipe edits — the pills the timeline marks. */
export function editedGenerators(recipe) {
  return new Set((recipe?.generators ?? []).filter((g) => g.edits?.length).map((g) => `${g.lane}:${g.ref}`));
}

/** The name a track's section goes by in a composed DAT: compose renames one that
 *  collides with another track's and reports it as `renames` ("track:old" → new). */
export const composedRef = (renames, lane, ref) => renames?.[`${lane}:${ref}`] ?? ref;

const name4 = (s, pad = 0) => Uint8Array.from({ length: 4 }, (_, i) => (i < s.length ? s.charCodeAt(i) & 0xff : pad));

/**
 * One section of a track's source DAT as compose writes that track's copy of it
 * (xi-tools xi_compose.py): the recipe's edits on it, its new name when compose
 * renamed it, and — in a generator — every id the track had renamed patched to its
 * new name. With no renames it is the section as the edited source holds it.
 *
 *   source   the track's source DAT, unedited
 *   section  { id, type, start, size } of it (fields.js walkSections): a 0x05 or a 0x19
 *   ids      datIds(source), when the caller already has it
 *
 * Throws what applyEdits / applyCurve throw for an edit that does not fit.
 */
export function composedSection(source, section, { recipe, lane, renames = null, ids = null }) {
  const out = source.slice(section.start, section.start + section.size);
  const isGen = section.type === 0x05;
  if (isGen) {
    const edits = generatorEdits(recipe, lane, section.id);
    if (edits.length) applyEdits(out, 0, edits, { ids: ids ?? datIds(source), inPlace: true, sectionSize: section.size, where: `${lane} ${section.id}` });
  } else {
    const keys = curveKeys(recipe, lane, section.id);
    if (keys) applyCurve(out, 0, keys, { inPlace: true, sectionSize: section.size, where: `${lane} curve ${section.id}` });
  }
  const own = Object.entries(renames ?? {}).filter(([k]) => k.startsWith(`${lane}:`)).map(([k, to]) => [k.slice(lane.length + 1), to]);
  const renamed = own.find(([from]) => from === section.id);
  if (renamed) out.set(name4(renamed[1]), 0);
  if (!isGen) return out;
  for (const [from, to] of own) {
    const b = name4(to);
    // A body names an id the way its DAT spells it, and a DAT pads a short one with NULs
    // or spaces (Cure III's `srn␣`): both spellings, NULs first, as compose's
    // _apply_renames looks for them, each written as the new section header has it.
    for (const a of from.length < 4 ? [name4(from), name4(from, 0x20)] : [name4(from)]) {
      for (let i = 16; i + 4 <= out.length;) {
        if (out[i] === a[0] && out[i + 1] === a[1] && out[i + 2] === a[2] && out[i + 3] === a[3]) { out.set(b, i); i += 4; } else i++;
      }
    }
  }
  return out;
}

// ── Texture replacements ────────────────────────────────────────────────────────
// `textures` swaps a texture of a track's source DAT for a PNG: { lane, ref, name, png },
// `ref` the 0x20 section's id and `name` its 16-character name as the SOURCE DAT has
// them, `png` the picked file's bytes as they came (never re-encoded) in a data: URI,
// alpha at full scale (255 opaque) as the viewer shows textures. Several textures of one
// DAT may share an id (ROM/11/21's five `faid`), never a name, so the name picks the
// section; an entry without one (older recipes) replaces the first section of its id.
// Compose encodes it as DXT3, each side a power of two up to 256, alpha halved, keeping
// the section's 16-character name, so every mesh and sprite sheet of that track that
// names the texture draws the PNG. One entry per texture, not per generator: every
// generator drawing it changes with it.

const PNG_URI = 'data:image/png;base64,';
/** The largest PNG a replacement may be (xi-tools refuses more). */
export const PNG_MAX_BYTES = 2 * 1024 * 1024;
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_MAX_SIDE = 4096;
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

/** A texture's 16-character name as an entry and a mesh compare it (xi-tools texture_key):
 *  trailing spaces and NULs dropped. */
export const textureKey = (raw) => String(raw ?? '').replace(/[\0 ]+$/, '');
/** Whether `name` may go in an entry's `name`: 1 to 16 printable ASCII characters, not only
 *  spaces, as xi-tools checks it. */
export const isTextureName = (name) => typeof name === 'string' && /^(?=[\x20-\x7e]*[\x21-\x7e])[\x20-\x7e]{1,16}$/.test(name);

/** The replacements a recipe holds that compose can take: a data: URI PNG on a track the mix
 *  still has, with a name xi-tools takes or none, one per texture entry (the first of each
 *  track + id + name). Each as compose reads it: { lane, ref, name?, png }. */
export function recipeTextures(recipe) {
  const seen = new Set();
  const out = [];
  for (const t of Array.isArray(recipe?.textures) ? recipe.textures : []) {
    if (typeof t?.ref !== 'string' || typeof t.png !== 'string' || !t.png.startsWith(PNG_URI) || !recipe.sources?.[t.lane]) continue;
    if (t.name != null && !isTextureName(t.name)) continue;
    const key = JSON.stringify([t.lane, t.ref, t.name == null ? null : textureKey(t.name)]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ lane: t.lane, ref: t.ref, ...(t.name != null ? { name: t.name } : null), png: t.png });
  }
  return out;
}
/**
 * Texture entries that name a PNG beside the recipe (xi-tools' CLI form) read into data:
 * URIs, as xi's load_recipe does, so compose, Publish and Save carry them. `readBytes`
 * reads a path relative to the recipe's folder. `missing`: the paths that are not a PNG
 * inside that folder; their entries are left out.
 */
export async function inlineRecipeTextures(recipe, readBytes) {
  const list = Array.isArray(recipe?.textures) ? recipe.textures : [];
  if (!list.some((t) => typeof t?.png === 'string' && !t.png.startsWith(PNG_URI))) return { recipe, missing: [] };
  const textures = [];
  const missing = [];
  for (const t of list) {
    if (typeof t?.png !== 'string' || t.png.startsWith(PNG_URI)) { textures.push(t); continue; }
    const rel = t.png.replace(/\\/g, '/');
    let bytes = null;
    // xi refuses a path that leaves the recipe's folder.
    if (/\.png$/i.test(rel) && !/^([A-Za-z]:|\/)/.test(rel) && !rel.split('/').includes('..')) {
      try { bytes = new Uint8Array(await readBytes(rel)); } catch { /* not there */ }
    }
    if (!bytes || pngInfo(bytes).error) { missing.push(t.png); continue; }
    textures.push({ ...t, png: pngDataUri(bytes) });
  }
  return { recipe: { ...recipe, textures }, missing };
}

// A texture of a track's source DAT as the functions below take it: `{ ref, name, first }`,
// its 0x20 id, its textureKey name, and whether it is the first section of that id — the
// one an entry without a name replaces (mixerLive.js generatorTextures gives all three).
// `{ ref }` alone is the first section of that id, whatever its name.
const firstOf = (tex) => tex.first ?? tex.name == null;
/** Whether a `textures` entry replaces `tex` of track `lane`. */
const replaces = (t, lane, tex) => t?.lane === lane && t.ref === tex.ref
  && (t.name == null ? firstOf(tex) : tex.name != null && textureKey(t.name) === textureKey(tex.name));

/** The PNG (a data: URI) a recipe puts in place of one texture of a track, else null —
 *  only one compose receives (recipeTextures), and one that names the texture before
 *  one that goes by its id alone. */
export function textureOf(recipe, lane, tex) {
  const mine = recipeTextures(recipe).filter((t) => replaces(t, lane, tex));
  return (mine.find((t) => t.name != null) ?? mine[0])?.png ?? null;
}
/**
 * Replace a texture of a track with a PNG (`pngDataUri` of the picked bytes); an empty
 * `png` takes the replacement back. The entry names the texture by id and name, and
 * takes the place of every entry that replaced it before, one without a name included.
 * A texture that shares its id with a section before it and has no name an entry can
 * hold cannot be named: the recipe comes back as it was.
 */
export function setTexture(recipe, lane, tex, png) {
  const name = tex.name != null && isTextureName(textureKey(tex.name)) ? textureKey(tex.name) : null;
  const list = Array.isArray(recipe.textures) ? recipe.textures : [];
  const had = list.filter((t) => replaces(t, lane, tex));
  if (png && name == null && !firstOf(tex)) return recipe;
  if (png ? had.length === 1 && had[0].png === png && (had[0].name ?? null) === name : !had.length) return recipe;
  const next = list.filter((t) => !had.includes(t));
  if (png) next.push({ lane, ref: tex.ref, ...(name != null ? { name } : null), png });
  const { textures: _, ...rest } = recipe;
  return next.length ? { ...rest, textures: next } : rest;
}
/** A texture back to what the source DAT holds. */
export const clearTexture = (recipe, lane, tex) => setTexture(recipe, lane, tex, '');

/**
 * A picked file checked as a replacement, the way xi-tools checks it: `{ width,
 * height }` from its header, or `{ error }`, a phrase that follows the file's name.
 */
export function pngInfo(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length > PNG_MAX_BYTES) return { error: `is ${(b.length / 1048576).toFixed(1)} MB: a texture PNG may be 2 MB at most` };
  if (b.length < 33 || PNG_SIG.some((v, i) => b[i] !== v)) return { error: 'is not a PNG' };
  // IHDR is always the first chunk: width and height at 16 and 20, big-endian.
  if (String.fromCharCode(...b.subarray(12, 16)) !== 'IHDR') return { error: 'is not a PNG: it has no IHDR header' };
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  if (width < 1 || height < 1 || width > PNG_MAX_SIDE || height > PNG_MAX_SIDE) return { error: `is ${width}×${height}: each side may be 1 to ${PNG_MAX_SIDE} pixels` };
  return { width, height };
}

/** PNG bytes as the recipe carries them. */
export function pngDataUri(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return PNG_URI + btoa(bin);
}
/** The PNG bytes of a recipe's data: URI; null for anything else. */
export function pngBytes(uri) {
  if (typeof uri !== 'string' || !uri.startsWith(PNG_URI)) return null;
  const b64 = uri.slice(PNG_URI.length);
  // xi-tools decodes strictly (standard alphabet, padded); atob alone takes more.
  if (b64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
// Answers by data: URI, a few at a time: the panel and the timeline ask on every edit.
const problemCache = new Map();
/** Why a recipe's `png` cannot replace a texture (a phrase, as pngInfo gives it), else null. */
export function pngProblem(uri) {
  if (problemCache.has(uri)) return problemCache.get(uri);
  const bytes = pngBytes(uri);
  const why = bytes ? pngInfo(bytes).error ?? null : 'is not a PNG data: URI';
  if (problemCache.size >= 16) problemCache.delete(problemCache.keys().next().value);
  problemCache.set(uri, why);
  return why;
}

/** A side as compose publishes it: the nearer power of two from 4 (one DXT block) to 256, the smaller on a tie (xi-tools xi_compose.texture_size). */
export function publishedSide(n) {
  let lo = 4;
  while (lo * 2 <= n && lo * 2 <= 256) lo *= 2;
  const hi = lo * 2 <= 256 ? lo * 2 : lo;
  return Math.abs(hi - n) < Math.abs(n - lo) ? hi : lo;
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** zlib data: deflated where the runtime has CompressionStream, else stored blocks. */
async function zlib(raw) {
  if (typeof CompressionStream === 'function') {
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const blocks = Math.max(1, Math.ceil(raw.length / 0xffff));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  out.set([0x78, 0x01]);
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const part = raw.subarray(i * 0xffff, (i + 1) * 0xffff);
    out[o] = i === blocks - 1 ? 1 : 0;
    out[o + 1] = part.length & 0xff; out[o + 2] = part.length >> 8;
    out[o + 3] = ~part.length & 0xff; out[o + 4] = (~part.length >> 8) & 0xff;
    out.set(part, o + 5);
    o += 5 + part.length;
  }
  let a = 1; let b = 0;
  for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; }
  const adler = ((b << 16) | a) >>> 0;
  out.set([adler >>> 24, (adler >>> 16) & 0xff, (adler >>> 8) & 0xff, adler & 0xff], o);
  return out;
}

/**
 * RGBA pixels (top-down, straight alpha) as a PNG file, byte for byte: a canvas
 * would premultiply them and lose the colour under low alpha, which a texture
 * handed back as a replacement keeps.
 */
export async function encodePng(width, height, rgba) {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);   // filter 0 per row
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);   // 8-bit RGBA, deflate, adaptive filtering, no interlace
  const parts = [Uint8Array.from(PNG_SIG), chunk('IHDR', ihdr), chunk('IDAT', await zlib(raw)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
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
      if (text) return await fillStages(JSON.parse(text));
    } catch { /* fall through to the lists door */ }
  }
  const cat = await loadListOrNull(CATALOG_LIST);
  return cat && Array.isArray(cat.entries) ? fillStages(cat) : null;
}

const hasStages = (b) => Array.isArray(b?.stages) && b.stages.length > 0;

/**
 * A downloaded list wins over the baked one (lists.js), and one from an xi-tools
 * older than the cast stages holds each base motion's first clip alone. Its rows
 * take their stages from the baked list's row for the same motion — same name, same
 * first clip — and keep everything else. Returns `cat` itself when there is nothing
 * to take.
 */
export function withBakedStages(cat, baked) {
  const rows = cat?.base_motions;
  if (!Array.isArray(rows) || rows.every(hasStages)) return cat;
  const key = (b) => `${b?.name}#${b?.clip?.ref}`;
  const staged = new Map((baked?.base_motions ?? []).filter(hasStages).map((b) => [key(b), b.stages]));
  if (!rows.some((b) => !hasStages(b) && staged.has(key(b)))) return cat;
  return { ...cat, base_motions: rows.map((b) => (!hasStages(b) && staged.has(key(b)) ? { ...b, stages: staged.get(key(b)) } : b)) };
}

/** The catalog with its base motions' stages filled in from the baked list when its
 *  own rows have none; the baked file is only read then. */
async function fillStages(cat) {
  if (!Array.isArray(cat?.base_motions) || cat.base_motions.every(hasStages)) return cat;
  try {
    const res = await fetch(`lists/${CATALOG_LIST}`);
    return res.ok ? withBakedStages(cat, await res.json()) : cat;
  } catch {
    return cat;
  }
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

// ── Mix files ───────────────────────────────────────────────────────────────────
//
// A saved mix is `<Name>.mix.json` in the mixer folder. Before that it was
// `<Name>.recipe.json`, and those are still listed, opened, renamed, duplicated,
// exported and deleted; Save writes the `.mix.json` and only then removes the old
// file of that mix. Where both exist for one name the `.mix.json` is the mix.

/** A saved mix's file suffix. */
export const MIX_SUFFIX = '.mix.json';
/** What a saved mix was called before (still read everywhere a mix is read). */
export const LEGACY_MIX_SUFFIX = '.recipe.json';

/** `LOVE.mix.json` → { name: 'LOVE', legacy: false }; `LOVE.recipe.json` → legacy; anything else null. */
export function mixFileName(file) {
  const m = /^(.+?)(\.mix\.json|\.recipe\.json)$/i.exec(String(file ?? ''));
  if (!m || !m[1]) return null;
  return { name: m[1], legacy: m[2].toLowerCase() === LEGACY_MIX_SUFFIX };
}

/**
 * The saved mixes in a folder listing (file names), A–Z: one entry per mix name,
 * compared without case as the disk does. `file` is the one to read — the
 * `.mix.json` when both exist — and `legacyFile` the `.recipe.json` it shadows (null
 * when there is none), which Save, rename and delete clear away with it.
 */
export function mixFilesIn(files) {
  const byKey = new Map();
  for (const file of files ?? []) {
    const f = mixFileName(file);
    if (!f) continue;
    const key = f.name.toLowerCase();
    const cur = byKey.get(key) ?? { name: f.name, file: null, legacyFile: null };
    if (f.legacy) cur.legacyFile = file;
    else { cur.file = file; cur.name = f.name; }
    byKey.set(key, cur);
  }
  return [...byKey.values()]
    .map((m) => (m.file ? m : { name: m.name, file: m.legacyFile, legacyFile: null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Where compose and Play mix read the mix from: a scratch copy under `_work`,
 * not the mixer folder itself. The saved list is that folder's `*.mix.json`
 * files, so writing the working copy beside them made every preview — a
 * Randomise, a pick — look saved. Save is the only thing that writes there.
 */
function workRecipePath(xiPath, name) {
  return `${mixerDir(xiPath)}\\_work\\${name}${MIX_SUFFIX}`;
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
 * The mix a real Publish hands `dats prepare`:
 * <xi-tools>\projects\abilities\<slug>\<Name>.mix.json, in the folder that publish fills,
 * so the folder always holds the mix its DATs were built from.
 */
export function publishRecipePath(xiPath, name) {
  return `${publishFolder(xiPath, name)}\\${name}${MIX_SUFFIX}`;
}

/**
 * The mix a Check (a dry run) hands `dats prepare`: check.<Name>.mix.json beside the
 * published one, which a Check never touches. The first Check makes the folder.
 */
export function checkRecipePath(xiPath, name) {
  return `${publishFolder(xiPath, name)}\\check.${name}${MIX_SUFFIX}`;
}

/**
 * The build options for Manage's three server switches, in the order xi-tools
 * documents them (xi dats build --help). Only a switch that is on sends its
 * fields: Clone from feeds all three, Server id the row and its menu record,
 * Menu name the menu record, and the one-off confirmation (--db-row) only
 * Database Update. Credentials never go on the command line: xi reads them
 * from its own .env (Settings › Local Server).
 */
export function serverBuildArgs({ db = false, menu = false, lua = false, cloneFrom = null, menuName = null, serverId = null, dbRow = null } = {}) {
  const args = [];
  if (db) args.push('--apply-db');
  if (db && dbRow != null) args.push('--db-row', String(dbRow));
  if ((db || menu || lua) && cloneFrom) args.push('--clone-from', String(cloneFrom));
  if ((db || menu) && serverId != null) args.push('--server-id', String(serverId));
  if (menu) args.push('--menu-record');
  if (menu && menuName) args.push('--menu-name', String(menuName));
  if (lua) args.push('--lua-stub');
  return args;
}

/**
 * Publish through `xi dats`: the recipe becomes an `ability` action in
 * projects/<name>.json (`dats prepare … --type ability --replace`, which keeps
 * a slot an earlier build took), then `dats build <name>` — with --dry-run for
 * the plan, without to write the DATs and register the file ids, and with
 * --pivot to build into the pivot folder (FFXI_PIVOT_DIR) instead of the game
 * folder. Same manifest the wizard and the CLI use, so the ability is rebuilt,
 * listed and undone with the rest of the project. `animationFrom` is where an
 * automatic number starts (the first free one at or above it). `db`, `menu` and
 * `lua` are Manage's server switches (serverBuildArgs), on Check and Publish alike.
 * The mix handed to prepare is written into the mix's publish folder: <Name>.mix.json
 * on a Publish, check.<Name>.mix.json on a Check.
 */
export async function publishRecipe(recipe, { dryRun, animation = null, animationFrom = null, kind = null, subdir = null, force = false, pivot = false,
  db = false, menu = false, lua = false, cloneFrom = null, menuName = null, serverId = null, dbRow = null }, xiPath, env, onLine) {
  const recipePath = dryRun ? checkRecipePath(xiPath, recipe.name) : publishRecipePath(xiPath, recipe.name);
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
  build.push(...serverBuildArgs({ db, menu, lua, cloneFrom, menuName, serverId, dbRow }));
  const ok = await run(build);
  return { ok, text: lines.join('\n') };
}

/** Where `xi dats build` leaves each ability's publish folder, under the xi-tools folder
 *  (xi runs there, and the build writes it relative to where it runs). */
const ABILITIES_REL = 'projects\\abilities';
/** Where xi-tools 1.9 and earlier left an ability's server SQL, flat (no publish folders). */
const LEGACY_SQL_REL = 'projects\\server\\abilities';

/** <xi-tools>\projects\abilities. */
export function abilitiesDir(xiPath) {
  return `${String(xiPath).replace(/[\\/]+$/, '')}\\${ABILITIES_REL}`;
}

/** <xi-tools>\projects\server\abilities: the old home of the flat SQL. */
const legacySqlDir = (xiPath) => `${String(xiPath).replace(/[\\/]+$/, '')}\\${LEGACY_SQL_REL}`;

/**
 * A mix's publish folder relative to xi-tools: projects\abilities\<slug>. A real
 * build leaves there what packaging needs — the server SQL, a copy of every DAT it
 * placed at that DAT's ROM path, and placements.json — beside the mix it was built
 * from (<Name>.mix.json), the one a Check last ran (check.<Name>.mix.json) and, when
 * Database Update ran, what it ran (<slug>_<n>.applied.sql). `<slug>` is the action's
 * own (`ability.<slug>`, the one publishRecipe builds), so it follows xi_dats._slug.
 */
export function publishFolderRel(name) {
  return `${ABILITIES_REL}\\${slug(name)}`;
}

/** A mix's publish folder: <xi-tools>\projects\abilities\<slug>. */
export function publishFolder(xiPath, name) {
  return `${String(xiPath).replace(/[\\/]+$/, '')}\\${publishFolderRel(name)}`;
}

/** A folder's entries, or null when it is not there. */
async function entriesOrNull(dir) {
  try {
    return await backend.listDir(dir);
  } catch {
    return null;
  }
}

/**
 * What a publish folder's files say about the mix, and the one to select: placements.json
 * (published), else the server SQL <slug>_<n>.sql, else <Name>.mix.json (a Publish that
 * stopped before it placed anything), else check.<Name>.mix.json (checked, never
 * published), else nothing. Names compare without case, as the disk does.
 * Returns `{ pick, state }`, state being published | unfinished | checked | empty.
 */
export function publishFolderPick(files, name) {
  const names = [...(files ?? [])].sort();
  const lc = (n) => String(n).toLowerCase();
  const sql = new RegExp(`^${slug(name)}_\\d+\\.sql$`, 'i');
  const record = names.find((n) => lc(n) === 'placements.json');
  if (record) return { pick: record, state: 'published' };
  const mix = names.find((n) => lc(n) === lc(`${name}${MIX_SUFFIX}`));
  const own = names.find((n) => sql.test(n)) ?? mix;
  if (own) return { pick: own, state: 'unfinished' };
  const check = names.find((n) => lc(n) === lc(`check.${name}${MIX_SUFFIX}`));
  if (check) return { pick: check, state: 'checked' };
  return { pick: null, state: 'empty' };
}

/**
 * Manage › Folder: a mix's publish folder in the file manager. The shell's one
 * primitive shows a path selected in its parent, so this selects a file inside the
 * folder (publishFolderPick) and the window opens on the folder itself. "Published"
 * means placements.json is there: a Check makes the folder too (its
 * check.<Name>.mix.json), and a Publish that stopped leaves just its mix.
 * A mix with no folder yet opens its flat SQL in projects\server\abilities when
 * xi-tools 1.9 or earlier left one there, else projects\abilities.
 * Returns `{ published, state, dir, pick, flatSql }` — `state` as publishFolderPick,
 * or `none` without a folder; `dir` is the folder that opened, null when not even
 * the abilities folder exists yet.
 */
export async function revealPublishFolder(xiPath, name) {
  const own = publishFolder(xiPath, name);
  const ownEntries = await entriesOrNull(own);
  if (ownEntries) {
    const { pick, state } = publishFolderPick(ownEntries.filter((e) => !e.isDir).map((e) => e.name), name);
    // An empty folder has nothing to select: selecting the folder opens its parent on it.
    await backend.revealPath(pick ? `${own}\\${pick}` : own);
    return { published: state === 'published', state, dir: pick ? own : abilitiesDir(xiPath), pick, flatSql: null };
  }
  const legacy = legacySqlDir(xiPath);
  const flat = new RegExp(`^${slug(name)}_\\d+\\.sql$`, 'i');
  const flatSql = (await entriesOrNull(legacy))?.filter((e) => !e.isDir).map((e) => e.name).sort().find((n) => flat.test(n)) ?? null;
  if (flatSql) {
    await backend.revealPath(`${legacy}\\${flatSql}`);
    return { published: false, state: 'none', dir: legacy, pick: flatSql, flatSql };
  }
  const dir = abilitiesDir(xiPath);
  const entries = await entriesOrNull(dir);
  if (!entries) return { published: false, state: 'none', dir: null, pick: null, flatSql: null };
  const first = entries.map((e) => e.name).sort()[0];
  await backend.revealPath(first ? `${dir}\\${first}` : dir);
  // An empty abilities folder has nothing to select: selecting the folder opens its parent on it.
  return { published: false, state: 'none', dir: first ? dir : dir.replace(/\\[^\\]+$/, ''), pick: null, flatSql: null };
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
 * placeholder for a free extended slot, or another skill's DAT). `db`, `menu` and
 * `lua` are the server steps' lines (parseStepLine), null when that step did not run.
 */
export function parsePublishPlan(text) {
  const out = { kind: null, animation: null, files: [], server: null, errors: [], warnings: [], db: null, menu: null, lua: null };
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    // The server steps (Manage's three switches): `db: …`, `menu: …`, `lua: …`.
    const step = parseStepLine(line);
    if (step) { out[step.step] = step.value; continue; }
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

// ── Server step lines (dats build --apply-db / --menu-record / --lua-stub) ───────
//
// Each ability block of a build ends with one line per step that ran, indented
// like its `server:` line:
//   db: [would ]update spell_list #144 'fire' animation 144 -> 1100 (xidb@127.0.0.1:3306)
//   db: needs-confirm spell_list #144 'fire' animation 144 -> 1100 — this mix did not create…
//   menu: place job ability 511 'Tiger\'s Fury' at command 1023 like job ability 35 …
//   lua: write scripts/actions/spells/black/love.lua (calls black/fire #144 at run time)
//   db: skip|refused|error — <reason, all the rest>
// A name inside '…' has `\` and `'` escaped; the reason separator is " — " (U+2014).

const STEP_RX = /^(db|menu|lua):\s+(?:(would)\s+)?(update|insert|unchanged|needs-confirm|place|write|rewrite|kept|skip|refused|error)\b\s*(.*)$/;
/** A quoted name on a step line; `\'` and `\\` are its escapes. */
export const QNAME = String.raw`'((?:[^'\\]|\\.)*)'`;
/** A quoted name's text as it reads. */
export const unquote = (s) => (s == null ? null : s.replace(/\\(.)/g, '$1'));
const DB_ROW_RX = new RegExp(String.raw`^(\w+) #(\d+) ` + QNAME);   // table, id, name
const DB_FROMTO_RX = /animation (\d+) -> (\d+)/;
const DB_TO_RX = /animation (\d+)/;
const DB_LIKE_RX = new RegExp(String.raw`like #(\d+) ` + QNAME);
const DB_SERVER_RX = /\(([^()\s]+@[^()\s]+)\)\s*$/;
const MENU_RX = new RegExp(String.raw`(spell|job ability|weapon skill) (\d+) ` + QNAME);
const LUA_PATH_RX = /(scripts\/actions\/\S+\.lua)/;
const WHOLE_REASON = new Set(['skip', 'refused', 'error']);
const num = (v) => (v == null ? null : Number(v));

/** The reason on a step line: all the rest for skip / refused / error, else what follows the first " — ". */
function stepReason(op, rest) {
  if (WHOLE_REASON.has(op)) return rest.replace(/^—\s*/, '') || null;
  const i = rest.indexOf(' — ');
  return i >= 0 ? rest.slice(i + 3) : null;
}

/** One trimmed build line → `{ step: 'db'|'menu'|'lua', value }`, or null when it is no step line. */
export function parseStepLine(line) {
  const m = STEP_RX.exec(String(line ?? '').trim());
  if (!m) return null;
  const [, step, would, op, rest] = m;
  const reason = stepReason(op, rest);
  const base = { op, would: !!would, text: rest, reason };
  // A skip / refused / error line is its reason: a name quoted in it is never the row.
  const whole = WHOLE_REASON.has(op);
  if (step === 'db') {
    const row = whole ? null : DB_ROW_RX.exec(rest);
    const ft = whole ? null : DB_FROMTO_RX.exec(rest);
    const to = whole || ft ? null : DB_TO_RX.exec(rest);
    const like = whole ? null : DB_LIKE_RX.exec(rest);
    const server = whole ? null : DB_SERVER_RX.exec(rest);
    return { step, value: {
      ...base,
      table: row?.[1] ?? null, id: num(row?.[2]), name: unquote(row?.[3] ?? null),
      from: num(ft?.[1]), to: num(ft?.[2] ?? to?.[1]),
      like: num(like?.[1]), likeName: unquote(like?.[2] ?? null),
      server: server?.[1] ?? null,
    } };
  }
  if (step === 'menu') {
    const mm = whole ? null : MENU_RX.exec(rest);
    return { step, value: {
      ...base,
      kind: mm?.[1] ?? null, id: num(mm?.[2]), name: unquote(mm?.[3] ?? null),
      provisional: !whole && / · provisional\b/.test(rest),
    } };
  }
  const p = whole ? null : LUA_PATH_RX.exec(rest);
  return { step, value: { ...base, path: p?.[1] ?? null } };
}

/** A step's text as it reads: each quoted name unescaped, anything else (a Windows path in a reason) as it is. */
export function showStepText(text) {
  return String(text ?? '').replace(new RegExp(QNAME, 'g'), (_, n) => `'${unquote(n)}'`);
}

/** A step op's colour: ok | warn | err. */
export function stepTone(op) {
  if (op === 'refused' || op === 'error') return 'err';
  if (op === 'needs-confirm' || op === 'skip' || op === 'kept') return 'warn';
  return 'ok';
}

/**
 * The row Manage's Confirm is for, from a plan's steps: `{ id, name, unchanged }`, or null.
 * - `db: needs-confirm`: a row this mix didn't make would change (`unchanged: false`).
 * - `db: unchanged` on such a row while the menu step skipped with `row #<id> was not made by
 *   this mix`: the row already has the animation, so nothing on the server changes, but its
 *   menu record only goes at its id once the row is this mix's (`unchanged: true`).
 */
export function dbConfirmOf(plan) {
  const db = plan?.db;
  if (!db || !Number.isInteger(db.id)) return null;
  if (db.op === 'needs-confirm') return { id: db.id, name: db.name ?? null, unchanged: false };
  const menu = plan.menu;
  if (db.op === 'unchanged' && menu?.op === 'skip') {
    const m = /^row #(\d+) was not made by this mix$/.exec(String(menu.reason ?? '').trim());
    if (m && Number(m[1]) === db.id) return { id: db.id, name: db.name ?? null, unchanged: true };
  }
  return null;
}

/**
 * The status-bar words for a plan's server steps, one part each (joined with ' · '
 * after the base text). A Check's plan says `would`; a Publish's what it did.
 */
export function publishStatusParts(plan) {
  const parts = [];
  const db = plan?.db;
  if (db) {
    const row = `${db.table ?? '?'} #${db.id ?? '?'}`;
    if (db.op === 'update' || db.op === 'insert') {
      parts.push(db.would ? `database: would ${db.op} ${row}` : `database: ${{ update: 'updated', insert: 'inserted' }[db.op]} ${row} — restart the map server`);
    } else if (db.op === 'unchanged') {
      parts.push(`database: unchanged ${row}`);
    } else if (db.op === 'needs-confirm') {
      parts.push(`database not updated — #${db.id ?? '?'} '${db.name ?? '?'}' wasn't made by this mix: Manage › Confirm`);
    } else {
      parts.push(`database not updated: ${showStepText(db.reason ?? db.op)}`);
    }
  }
  const menu = plan?.menu;
  if (menu) {
    if (menu.op === 'place') parts.push(`menu: ${menu.would ? 'would place ' : ''}${menu.kind ?? '?'} ${menu.id ?? '?'}${menu.provisional ? ' (provisional)' : ''}`);
    else if (menu.op === 'unchanged') parts.push(`menu: unchanged ${menu.kind ?? '?'} ${menu.id ?? '?'}`);
    else if (dbConfirmOf(plan)?.unchanged) parts.push(`menu not placed — #${db.id} '${db.name ?? '?'}' wasn't made by this mix: Manage › Confirm`);
    else parts.push(`menu not placed: ${showStepText(menu.reason ?? menu.op)}`);
  }
  const lua = plan?.lua;
  if (lua) {
    if (lua.op === 'write' || lua.op === 'rewrite') parts.push(`lua: ${lua.would ? `would ${lua.op} ` : ''}${lua.path ?? '?'}`);
    else if (lua.op === 'unchanged') parts.push(`lua: unchanged ${lua.path ?? ''}`.trimEnd());
    // kept: the stub is there, edited by hand, and was left as it is.
    else if (lua.op === 'kept') parts.push(`lua: kept ${lua.path ?? '?'}${lua.reason ? ` — ${showStepText(lua.reason)}` : ''}`);
    else parts.push(`no Lua stub: ${showStepText(lua.reason ?? lua.op)}`);
  }
  return parts;
}

/** The build refused a server option this xi-tools does not have yet. */
export const OLD_XI_SERVER_OPTION_RX = /No such option:?\s+['"]?--(apply-db|db-row|clone-from|menu-record|menu-name|lua-stub|server-id)\b/;
export const OLD_XI_SERVER_TEXT = 'This xi-tools is too old for Database Update / Client Menu Record / Lua Stub — update it in Settings › XI Tools.';

/** xi_dats._slug: lowercase, runs of anything but a-z0-9 → `_`. */
const slug = (v) => String(v).replace(/\\/g, '/').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'action';
