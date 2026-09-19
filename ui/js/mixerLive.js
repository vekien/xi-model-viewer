// Ability Mixer — a recipe's generator and curve edits, and its texture replacements,
// on a DAT that is already loaded.
//
// `xi ability compose` bakes the edits into the DAT it writes. This puts the same
// bytes into the tree the stage is playing, so an edit shows without composing again:
// each edited section is rebuilt from the track's unedited source (composedSection,
// the bytes compose would write), laid over the loaded copy, and parsed afresh. The
// rebuild starts from the source every time, so taking an edit back restores it.
// A replaced texture goes straight into the stage's GL texture of its name instead
// (textureSwaps, and see Textures below).
//
// Only the tree handed in is written — never the shared ROM/0/0.DAT tree, whose
// definitions every effect of the session reads.

import { DatDir, SEC, datKey } from './dat/tree.js';
import { allFields, datIds, describeGenerator, walkSections } from './particle/fields.js';
import { composedRef, composedSection, generatorEdits, isLinkOp, isTextureName, pngBytes, pngProblem, recipeTextures, textureKey } from './mixer.js';

const LISTS = [['generators', 'edits', SEC.EFFECT], ['curves', 'keys', SEC.KEYFRAME]];
// What a generator may name by id and compose carries along (fields.js datIds).
const CARRIED = new Set([0x20, 0x21, 0x1f, 0x19, 0x2e, 0x3d]);
// compose's VFX_OPS (xi_compose.py): the commands that bring the generator they name.
const GEN_OPS = new Set([0x02, 0x3f, 0x1e, 0x2d]);

/** A track's source DAT as the sync reads it: its bytes, its sections, the ids a `datid` edit may name. */
export function sourceOf(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return { bytes, sections: walkSections(bytes), ids: datIds(bytes) };
}

function entriesOf(root) {
  const out = [];
  const walk = (dir) => { for (const c of dir.children) { if (c instanceof DatDir) walk(c); else out.push(c); } };
  walk(root);
  return out;
}

const sameBytes = (bytes, at, want) => {
  for (let i = 0; i < want.length; i++) if (bytes[at + i] !== want[i]) return false;
  return true;
};

const isLink = (v) => !!v && typeof v === 'object' && 'id' in v && '_value' in v;

/** Whether a track's events could bring a generator or curve at all, read before its
 *  source is: a link, or a generator command (naming `ref`, when that is a generator). */
const mayCarry = (recipe, lane, type, ref) => recipe.events.some((e) => e.from === lane && e.enabled !== false && e.ref
  && (isLinkOp(e.op) || (GEN_OPS.has(e.op) && (type !== SEC.EFFECT || e.ref === ref))));

/**
 * Whether compose gives track `lane` a copy of section `sec` of its source `src`, the
 * way compose decides it: a generator one of its events fires, or a curve one of
 * those generators names as the track edits it (compose's 4cc walk from 0x10, before
 * any rename). A link into a routine of the source may fire anything, so it counts.
 */
function carries(recipe, lane, sec, src) {
  const events = recipe.events.filter((e) => e.from === lane && e.enabled !== false && e.ref);
  if (events.some((e) => isLinkOp(e.op) && src.sections.some((s) => s.type === SEC.EFFECT_ROUTINE && s.id === e.ref))) return true;
  const fired = new Set(events.filter((e) => GEN_OPS.has(e.op)).map((e) => e.ref));
  if (sec.type === SEC.EFFECT) return fired.has(sec.id);
  const cc = src.bytes.subarray(sec.start, sec.start + 4);
  for (const id of fired) {
    // The first generator of a name is the one compose carries.
    const g = src.sections.find((s) => s.type === SEC.EFFECT && s.id === id);
    if (!g) continue;
    const body = composedSection(src.bytes, g, { recipe, lane, ids: src.ids });
    for (let i = 16; i + 4 <= body.length; i++) if (sameBytes(body, i, cc)) return true;
  }
  return false;
}

/** Other generators keep the definition a child-generator link resolved to; the ones
 *  parsed again are looked up again. */
function forgetGeneratorLinks(entries, names) {
  for (const entry of entries) {
    const def = entry.type === SEC.EFFECT ? entry._resource?.def : null;
    if (!def) continue;
    for (const ops of [def.generatorUpdaters, def.initializers, def.updaters, def.expirationHandlers]) {
      for (const op of ops ?? []) {
        for (const v of Object.values(op)) {
          if (isLink(v) && v._value?.kind === 'effect' && names.has(datKey(v.id))) v._value = undefined;
        }
      }
    }
  }
}

/**
 * Bring a loaded DAT in line with the recipe's edits.
 *
 *   tree     the stage's tree (buildDatTree); its bytes are written in place
 *   recipe   the mix
 *   sources  track → sourceOf(its source DAT), for every track that has edits and,
 *            for a composed mix, every track that may bring a copy (lanesThatCarry)
 *   renames  the compose report's, when the tree is the composed mix
 *   lane     set when the tree is one track's source DAT on its own (a generator
 *            preview): every section is shown as that track has it
 *   touched  a Set the caller keeps with the tree: the sections it holds edited,
 *            so an edit taken back is undone. For a composed mix it starts as the
 *            edits compose baked in (seedTouched).
 *
 * Nothing is written unless everything can be: `{ ok: false, why }` means the tree
 * cannot show this recipe and it has to be composed — an id re-pointed at a
 * resource the DAT does not carry, a copy two tracks share but no longer agree on,
 * an edit that does not fit. An edit on a section its track does not bring is left
 * out, as compose leaves it out. Otherwise `{ ok: true, gens, curves }`: the names
 * (as the tree has them) of what changed. A changed generator parses again on its
 * next lookup; a changed curve is live where it is.
 */
export function syncEdits(tree, { recipe, sources, renames = null, lane: solo = null, touched }) {
  const bytes = tree.ctx.bytes;
  const entries = entriesOf(tree);
  const keyOf = (type, lane, ref) => `${type}|${solo ? '' : lane}|${ref}`;
  const targets = new Map();   // key → { type, lane, ref, edited }
  for (const key of touched) {
    const [type, lane, ref] = key.split('|');
    targets.set(key, { type: Number(type), lane: solo ?? lane, ref, edited: false });
  }
  for (const [list, body, type] of LISTS) {
    for (const g of recipe[list] ?? []) {
      if (!g[body]?.length || (solo && g.lane !== solo)) continue;
      targets.set(keyOf(type, g.lane, g.ref), { type, lane: g.lane, ref: g.ref, edited: true });
    }
  }

  const writes = [];
  for (const [key, t] of targets) {
    const src = sources.get(t.lane);
    if (!src) {
      if (t.edited) return { ok: false, why: `the source of track ${t.lane} is not read` };
      continue;
    }
    const sec = src.sections.find((s) => s.type === t.type && s.id === t.ref);
    if (!sec) continue;   // not a section of this source: compose says so on Play
    const name = composedRef(renames, t.lane, t.ref);
    const entry = entries.find((e) => e.type === t.type && e.id === name);
    let mine;
    try {
      mine = !!solo || carries(recipe, t.lane, sec, src);
    } catch (e) {
      return { ok: false, why: String(e?.message ?? e) };
    }
    // A section this track does not bring (its pill deleted or muted, a curve none of
    // its generators names): compose leaves it out and ignores its edits, and a copy of
    // that name on the stage is another track's. A section the mix newly needs comes
    // with an event change, which marks the mix stale.
    if (!entry || !mine) continue;
    if (entry.section.size !== sec.size) return { ok: false, why: `${name} is not the size of its source` };
    let out;
    try {
      out = composedSection(src.bytes, sec, { recipe, lane: t.lane, renames, ids: src.ids });
      // Tracks share a copy for as long as their bytes agree. Compose shares identical
      // bytes whatever the source (xi_compose.py Bag.add), so every track counts that
      // brings a section of this name and type.
      for (const other of Object.keys(solo ? {} : recipe.sources ?? {})) {
        if (other === t.lane || composedRef(renames, other, t.ref) !== name) continue;
        if (!mayCarry(recipe, other, t.type, t.ref)) continue;
        const theirSrc = sources.get(other);
        if (!theirSrc) return { ok: false, why: `the source of track ${other} is not read` };
        const theirSec = theirSrc.sections.find((s) => s.type === t.type && s.id === t.ref);
        if (!theirSec || !carries(recipe, other, theirSec, theirSrc)) continue;   // that track brings no copy of it
        const theirs = composedSection(theirSrc.bytes, theirSec, { recipe, lane: other, renames, ids: theirSrc.ids });
        if (theirs.length !== out.length || !sameBytes(theirs, 0, out)) return { ok: false, why: `tracks ${t.lane} and ${other} share ${name} and no longer agree on it` };
      }
    } catch (e) {
      return { ok: false, why: String(e?.message ?? e) };
    }
    if (t.type === SEC.EFFECT) {
      for (const e of generatorEdits(recipe, t.lane, t.ref)) {
        if (e.type !== 'datid') continue;
        for (const v of Array.isArray(e.value) ? e.value : [e.value]) {
          const id = composedRef(renames, t.lane, String(v).replace(/[\0 ]+$/, ''));
          if (!entries.some((x) => x.id === id && CARRIED.has(x.type))) return { ok: false, why: `${id} is not in the DAT on the stage` };
        }
      }
    }
    writes.push({ key, entry, out });
  }

  const gens = [];
  const curves = [];
  for (const { key, entry, out } of writes) {
    if (sameBytes(bytes, entry.section.start, out)) continue;
    bytes.set(out, entry.section.start);
    touched.add(key);
    if (entry.type === SEC.EFFECT) {
      entry._resource = undefined;
      gens.push(entry.id);
    } else {
      // Links hold the parsed curve itself, so its keys change where they are.
      const ctx = entry._ctx;
      const fresh = entry._resource?.entries ? ctx.parsers[entry.type]?.(ctx.bytes, ctx.dv, entry.section, entry) : null;
      if (fresh?.entries) entry._resource.entries.splice(0, entry._resource.entries.length, ...fresh.entries);
      else entry._resource = undefined;
      curves.push(entry.id);
    }
  }
  if (gens.length) forgetGeneratorLinks(entries, new Set(gens));
  return { ok: true, gens, curves };
}

/** The sections a composed DAT already holds edited: what the recipe it was composed from edits. */
export function seedTouched(recipe) {
  const out = new Set();
  for (const [list, body, type] of LISTS) {
    for (const g of recipe?.[list] ?? []) if (g[body]?.length) out.add(`${type}|${g.lane}|${g.ref}`);
  }
  return out;
}

/** The tracks whose events can bring a generator or curve (a generator command or a link):
 *  a composed mix's sync reads their sources too, to check a copy they share still agrees.
 *  A link added on the keep lane with no track brings nothing of a source. */
export function lanesThatCarry(recipe) {
  return [...new Set((recipe?.events ?? [])
    .filter((e) => e.enabled !== false && e.ref && e.from && (isLinkOp(e.op) || GEN_OPS.has(e.op))).map((e) => e.from))];
}

/** The tracks whose sources a sync needs: the ones the recipe edits, and the ones `touched` names. */
export function lanesToSync(recipe, touched) {
  const out = new Set();
  for (const [list, body] of LISTS) for (const g of recipe?.[list] ?? []) if (g[body]?.length) out.add(g.lane);
  for (const key of touched ?? []) { const lane = key.split('|')[1]; if (lane) out.add(lane); }
  return [...out];
}

// ── Textures ────────────────────────────────────────────────────────────────────
// A generator draws a texture through what it links: a particle mesh (0x1F) binds up
// to four, a sprite sheet (0x21) one, by the 16-character name inside the 0x20 section
// — never by the texture's own id (Fire's sheet fai0 draws section fai2), and the first
// section of a name wins. A ring (0x24) and the specular op (0x55) name the 0x20 by id,
// the first section of it. Several textures of a DAT may share an id (ROM/11/21's five
// `faid`), never a name (textureKey), so a recipe `textures` entry names the section by
// its id and name in the track's source DAT (mixer.js), and everything here goes by the
// section. The stage keys an effect texture by its name (zone.js parseDatTextures), so
// a swap on the stage goes by name, and only ever into a texture the stage DAT itself holds.

const T_TEXTURE = 0x20;
const T_MESH = 0x1f;
const T_SHEET = 0x21;
const T_WEIGHTED = 0x25;
/** The name the stage keys a texture by: zone.js parseTexture reads up to the first NUL and trims. */
export const stageTextureName = (raw) => String(raw ?? '').split('\0')[0].trim();
const text16 = (bytes, at) => String.fromCharCode(...bytes.subarray(at, at + 16));
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// The triangle-count array of a particle mesh is padded to one of these lengths (dat/sections.js).
const triSlots = (n) => (n <= 3 ? 3 : n <= 4 ? 4 : n <= 7 ? 7 : n <= 8 ? 8 : n <= 11 ? 11 : n <= 12 ? 12 : n <= 15 ? 15 : -1);

/** The texture names a particle mesh or sprite sheet draws with, as stored (the bytes
 *  dat/sections.js reads): a mesh's textured submeshes in order, a sheet's one name. */
function boundNames(bytes, sec) {
  const d = sec.start + 0x10;
  if (sec.type === T_SHEET) return [text16(bytes, d + 8)];
  if (sec.type === T_WEIGHTED) return [text16(bytes, d + 0x10)];
  const version = u32le(bytes, d);
  if (version !== 3 && version !== 5 && version !== 6) return [];
  const withTex = bytes[d + 4];
  const slots = triSlots(withTex + bytes[d + 5]);
  if (slots < 0) return [];
  // Version 3 stores four names whatever the count; submesh k draws name k.
  const at = d + 8 + slots * 2 + (version === 3 ? 2 : 0);
  return Array.from({ length: version === 3 ? Math.min(withTex, 4) : withTex }, (_, i) => text16(bytes, at + i * 16));
}

// A DAT's 0x20 sections by name, by id (first of each wins) and by id and name, kept per source object.
const texIndexes = new WeakMap();
const idName = (id, name) => JSON.stringify([id, textureKey(name)]);
function texIndex(src) {
  let idx = texIndexes.get(src);
  if (!idx) {
    idx = { byName: new Map(), byId: new Map(), byIdName: new Map() };
    for (const s of src.sections) {
      if (s.type !== T_TEXTURE) continue;
      const name = textureKey(text16(src.bytes, s.start + 0x11));
      if (name && !idx.byName.has(name)) idx.byName.set(name, s);
      if (!idx.byId.has(s.id)) idx.byId.set(s.id, s);
      const key = idName(s.id, name);
      if (!idx.byIdName.has(key)) idx.byIdName.set(key, s);
    }
    texIndexes.set(src, idx);
  }
  return idx;
}
const sectionOf = (src, type, id) => src?.sections.find((s) => s.type === type && s.id === id) ?? null;

/** The 0x20 section of a track's source (sourceOf) a `textures` entry replaces: the one of
 *  id `ref` and name `name` (compared as textureKey), or with no name the first of that
 *  id; null when there is none. */
export function textureSection(src, ref, name = null) {
  const idx = texIndex(src);
  return (name == null ? idx.byId.get(ref) : idx.byIdName.get(idName(ref, name))) ?? null;
}

/**
 * The textures one generator draws: `desc` is describeGenerator of it as the mix has
 * it (edits on, so a re-pointed "Draws" follows), `data` its track's source DAT
 * (sourceOf), `shared` sourceOf(ROM/0/0.DAT) when it has been read. One entry each:
 *
 *   ref     the 0x20 section's id in `data`; null when the texture is not in it
 *   name    its 16-character name as textureKey has it: with `ref`, what a recipe
 *           `textures` entry names the section by (mixer.js setTexture)
 *   first   whether it is the first section of its id in `data`, the one an entry
 *           without a name replaces
 *   name16  its 16-character name as stored
 *   bytes, start   where its section is (`data`, or `shared`), for showing it; null when nowhere
 *   via     mesh | sprites | ring | specular | weighted, and `from` the id the generator names
 *   note    why a mix cannot replace it (null when it can)
 *   stage   a note when the stage does not draw it (a ring or specular texture)
 *
 * A texture drawn twice (two submeshes, or a mesh and a specular op) is listed once.
 */
export function generatorTextures(desc, data, shared = null) {
  const out = [];
  if (!desc) return out;
  const fields = allFields(desc);
  const header = (name) => fields.find((f) => f.key === `s2.0x01.0.${name}`)?.value;
  const type = header('linkedType');
  const id = header('linkedId') || null;
  const seen = new Set();
  const push = (entry) => {
    // One per section of this DAT: textures that share an id are different textures.
    const key = entry.ref ? `@${entry.start}` : `${entry.bytes ? 'shared' : 'none'}|${entry.name}|${entry.from}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ first: false, stage: null, ...entry });
  };
  // A 0x20 section of this DAT, which a mix can replace unless no entry can name it: one
  // after the first of its id goes by its name, and not every name is text a recipe holds.
  const ownTexture = (s, via, from, stage = null) => {
    const name16 = text16(data.bytes, s.start + 0x11);
    const name = textureKey(name16);
    const first = texIndex(data).byId.get(s.id) === s;
    push({ ref: s.id, name, first, name16, bytes: data.bytes, start: s.start, via, from, stage,
      note: first || isTextureName(name) ? null : `It shares the id ${s.id} with a texture before it, and its name is not text a mix can name it by, so it cannot be replaced.` });
  };
  // What a mix cannot reach: ROM/0/0.DAT, the shared DAT every effect falls back on.
  const SHARED = 'the shared ROM/0/0.DAT, which a mix does not carry';
  // A texture a mesh or sheet binds by name, looked up the way the stage does: this DAT, then the shared one.
  const byName = (name16, via, from, meshShared) => {
    const name = textureKey(name16);
    if (!name) return;
    const own = meshShared ? null : texIndex(data).byName.get(name);
    if (own) {
      ownTexture(own, via, from);
      return;
    }
    const theirs = shared ? texIndex(shared).byName.get(name) : null;
    const base = { ref: null, name16, name, via, from };
    if (theirs) {
      push({ ...base, bytes: shared.bytes, start: theirs.start,
        note: meshShared ? `${from} is in ${SHARED}, so its texture cannot be replaced.` : `This texture is only in ${SHARED}, so it cannot be replaced.` });
    } else {
      push({ ...base, bytes: null, start: null,
        note: shared ? `${stageTextureName(name16)} is not in this DAT or the shared ROM/0/0.DAT, so there is nothing to replace.`
          : `${stageTextureName(name16)} is not in this DAT: the game looks in ${SHARED}, so it cannot be replaced.` });
    }
  };
  const byId = (texId, via, stage) => {
    const own = texIndex(data).byId.get(texId);
    if (own) {
      ownTexture(own, via, texId, stage);
      return;
    }
    const theirs = shared ? texIndex(shared).byId.get(texId) : null;
    const name16 = theirs ? text16(shared.bytes, theirs.start + 0x11) : '';
    push({ ref: null, name16, name: textureKey(name16), bytes: theirs ? shared.bytes : null, start: theirs?.start ?? null, via, from: texId, stage,
      note: theirs ? `This texture is only in ${SHARED}, so it cannot be replaced.` : `${texId} is not in this DAT, so there is nothing to replace.` });
  };

  if (id && (type === 0x0b || type === 0x0e || type === 0x39)) {
    const kind = type === 0x0b ? T_MESH : T_SHEET;
    const via = type === 0x0b ? 'mesh' : 'sprites';
    const own = sectionOf(data, kind, id);
    const theirs = own ? null : sectionOf(shared, kind, id);
    if (own) for (const n of boundNames(data.bytes, own)) byName(n, via, id, false);
    else if (theirs) for (const n of boundNames(shared.bytes, theirs)) byName(n, via, id, true);
    else {
      push({ ref: null, name16: '', name: '', bytes: null, start: null, via, from: id,
        note: shared ? `${id} is not in this DAT or the shared ROM/0/0.DAT, so there is no texture to show.`
          : `${id} is not in this DAT: the game looks in ${SHARED}, so its texture cannot be replaced.` });
    }
  } else if (id && type === 0x24) {
    byId(id, 'ring', 'The stage draws rings without their texture, so a replacement shows in game only.');
  } else if (id && type === 0x1d) {
    // Compose carries no weighted mesh (0x25), so whatever it draws stays as the game has it.
    const mesh = sectionOf(data, T_WEIGHTED, id);
    const name16 = mesh ? boundNames(data.bytes, mesh)[0] : '';
    const tex = name16 ? texIndex(data).byName.get(textureKey(name16)) : null;
    push({ ref: null, name16, name: textureKey(name16), bytes: tex ? data.bytes : null, start: tex?.start ?? null, via: 'weighted', from: id,
      note: `${id} is a weighted mesh, which compose does not carry, so its texture cannot be replaced.` });
  }
  for (const f of fields) {
    if (f.op === 0x55 && f.name === 'texture' && f.value) byId(f.value, 'specular', 'The stage does not draw specular textures, so a replacement shows in game only.');
  }
  return out;
}

/**
 * Who draws each texture of a track's source DAT: its 0x20 section's start → the ids of
 * the generators that draw it, every generator of the DAT as the track has it (its edits
 * on, so one re-pointed at another mesh counts where it points now). By section, not by
 * id: textures that share an id are drawn by different generators.
 */
export function textureUsers(data, { recipe, lane }) {
  const out = new Map();
  for (const s of data.sections) {
    if (s.type !== SEC.EFFECT) continue;
    let desc;
    try { desc = describeGenerator(composedSection(data.bytes, s, { recipe: { generators: recipe?.generators }, lane, ids: data.ids }), 0, s.size); }
    catch { desc = describeGenerator(data.bytes, s.start, s.size); }
    for (const t of generatorTextures(desc, data)) {
      if (!t.ref || t.note) continue;
      const list = out.get(t.start) ?? [];
      if (!list.includes(s.id)) list.push(s.id);
      out.set(t.start, list);
    }
  }
  return out;
}

/** "track:generator" of every generator that draws a texture the recipe replaces — pills
 *  the timeline marks. `sources`: track → sourceOf, for the tracks with replacements.
 *  Only a replacement compose takes counts: a data: URI of a PNG that passes the check. */
export function texturedGenerators(recipe, sources) {
  const out = new Set();
  const users = new Map();
  for (const t of recipeTextures(recipe)) {
    const src = sources.get(t.lane);
    const sec = src && !pngProblem(t.png) ? textureSection(src, t.ref, t.name) : null;
    if (!sec) continue;
    if (!users.has(t.lane)) users.set(t.lane, textureUsers(src, { recipe, lane: t.lane }));
    for (const g of users.get(t.lane).get(sec.start) ?? []) out.add(`${t.lane}:${g}`);
  }
  return out;
}

/** The 0x20 sections (their starts) the generators a track fires draw; null when a link could fire any of them. */
function laneDraws(recipe, lane, src) {
  const events = recipe.events.filter((e) => e.from === lane && e.enabled !== false && e.ref);
  if (events.some((e) => isLinkOp(e.op) && src.sections.some((s) => s.type === SEC.EFFECT_ROUTINE && s.id === e.ref))) return null;
  const out = new Set();
  for (const ref of new Set(events.filter((e) => GEN_OPS.has(e.op)).map((e) => e.ref))) {
    const g = sectionOf(src, SEC.EFFECT, ref);
    if (!g) continue;
    let desc;
    try { desc = describeGenerator(composedSection(src.bytes, g, { recipe, lane, ids: src.ids }), 0, g.size); }
    catch { desc = describeGenerator(src.bytes, g.start, g.size); }
    for (const t of generatorTextures(desc, src)) if (t.ref) out.add(t.start);
  }
  return out;
}

/** The texture each replacement of track `lane` lands on, as textureOf picks one (an entry
 *  that names the texture before one that goes by its id alone): 0x20 section start →
 *  { sec, entry }. Entries whose texture the source lacks land nowhere. */
function replacementsOf(entries, lane, src) {
  const out = new Map();
  for (const t of entries) {
    if (t.lane !== lane) continue;
    const sec = textureSection(src, t.ref, t.name);
    if (sec && (t.name != null || !out.has(sec.start))) out.set(sec.start, { sec, entry: t });
  }
  return out;
}

/**
 * Which effect textures on the stage to fill again so they show the recipe's texture
 * replacements, without composing:
 *
 *   stage    the bytes of the DAT on the stage (tree.ctx.bytes)
 *   recipe   the mix
 *   sources  track → sourceOf(its source DAT): every track with a replacement, and for a
 *            composed mix every track that may draw a texture of the same name
 *   lane     set when the stage is that track's source DAT on its own (a generator preview)
 *   names    the compose report's `textures`: the name each texture it replaced or renamed
 *            goes by in the composed DAT, per source id and source name (`renamed_from`,
 *            else `name`)
 *   baked    the replacements the composed DAT was built with (recipeTextures of that recipe)
 *   shown    what the stage's textures show besides their own pixels: name → png | 'source'
 *
 * Returns `{ ok: true, swaps }`, each swap `{ name, show, png | bytes + start }`: `show`
 * is the PNG (a data: URI) to upload, 'source' for the track's source texture (a
 * replacement compose baked in and the mix has since taken back), or null for the
 * stage DAT's own pixels. `{ ok: false, why }` when the stage cannot show the recipe:
 * two tracks draw one texture of the stage and no longer agree on it (compose names
 * them apart), a source is not read, or a source lacks a texture compose baked in. A
 * replacement lands on the 0x20 section its entry names (textureSection); one naming a
 * texture its source lacks shows nothing, and compose says so on Play. A texture the
 * stage DAT does not hold is left alone — nothing draws it there, and one of the shared
 * ROM/0/0.DAT is never touched.
 */
export function textureSwaps(stage, { recipe, sources, lane: solo = null, names = null, baked = null, shown }) {
  const onStage = new Map();   // stage name → the stage DAT's first 0x20 section of it
  for (const s of walkSections(stage)) {
    if (s.type !== T_TEXTURE) continue;
    const name = stageTextureName(text16(stage, s.start + 0x11));
    if (name && !onStage.has(name)) onStage.set(name, s);
  }
  // The name a texture of a track's source goes by on the stage: its own, unless compose
  // renamed it. A report row names the texture by its source id and source name
  // (`renamed_from` when compose renamed it, else `name`), as textures may share an id;
  // a row without a name is the first section of its id.
  const nameOf = (lane, sec, src) => {
    const own = text16(src.bytes, sec.start + 0x11);
    const r = solo ? null : (names ?? []).find((t) => t?.lane === lane && textureKey(t.ref) === sec.id
      && (typeof t.name === 'string' ? textureKey(t.renamed_from ?? t.name) === textureKey(own) : texIndex(src).byId.get(sec.id) === sec));
    return stageTextureName(r?.name || own) || null;
  };
  const current = recipeTextures(recipe).filter((t) => !solo || t.lane === solo);
  for (const t of current) if (!sources.get(t.lane)) return { ok: false, why: `the source of track ${t.lane} is not read` };
  // Per track, the texture each replacement lands on (replacementsOf): now, and when composed.
  const cache = new Map();
  const landed = (entries, lane) => {
    const key = `${entries === current ? 'now' : 'baked'}|${lane}`;
    if (!cache.has(key)) cache.set(key, replacementsOf(entries ?? [], lane, sources.get(lane)));
    return cache.get(key);
  };
  const want = new Map();   // stage name → { show, lane, start }
  const put = (name, v) => {
    const had = want.get(name);
    if (had && had.show !== v.show) return `tracks ${had.lane} and ${v.lane} both draw ${name} and no longer agree on it`;
    want.set(name, v);
    return null;
  };
  for (const lane of new Set(current.map((t) => t.lane))) {
    const src = sources.get(lane);
    for (const { sec, entry } of landed(current, lane).values()) {
      const name = nameOf(lane, sec, src);
      if (!name || !onStage.has(name)) continue;
      const bakedPng = solo ? null : landed(baked, lane).get(sec.start)?.entry.png ?? null;
      const why = put(name, { show: solo || bakedPng !== entry.png ? entry.png : null, lane, start: sec.start });
      if (why) return { ok: false, why };
    }
  }
  if (!solo) {
    // Baked in and since taken back: the track's source texture, which the composed DAT no longer holds.
    for (const b of baked ?? []) {
      const src = sources.get(b.lane);
      if (!src) continue;   // the track is gone, and what it fired with it
      const sec = textureSection(src, b.ref, b.name);
      if (!sec) return { ok: false, why: `the source of track ${b.lane} has no texture ${b.ref}${b.name != null ? ` named ${b.name}` : ''}` };
      if (landed(current, b.lane).has(sec.start)) continue;
      const name = nameOf(b.lane, sec, src);
      if (!name || !onStage.has(name)) continue;
      const why = put(name, { show: 'source', lane: b.lane, start: sec.start });
      if (why) return { ok: false, why };
    }
    // One texture of the stage that another track draws as well, with other pixels:
    // compose gives the two their own names, the stage cannot.
    const drawsOf = new Map();
    for (const [name, v] of want) {
      if (v.show === null || v.show === 'source') continue;
      for (const [other, src] of sources) {
        if (other === v.lane) continue;
        for (const s of src.sections) {
          if (s.type !== T_TEXTURE || nameOf(other, s, src) !== name) continue;
          if (!drawsOf.has(other)) drawsOf.set(other, laneDraws(recipe, other, src));
          const draws = drawsOf.get(other);
          if (draws && !draws.has(s.start)) continue;
          if (landed(current, other).get(s.start)?.entry.png === v.show) continue;
          return { ok: false, why: `tracks ${v.lane} and ${other} both draw ${name} and no longer agree on it` };
        }
      }
    }
  }
  const swaps = [];
  for (const name of new Set([...want.keys(), ...shown.keys()])) {
    const v = want.get(name) ?? { show: null };
    if (v.show === (shown.get(name) ?? null)) continue;
    if (v.show === null) {
      const s = onStage.get(name);
      if (s) swaps.push({ name, show: null, bytes: stage, start: s.start });
    } else if (v.show === 'source') {
      swaps.push({ name, show: 'source', bytes: sources.get(v.lane).bytes, start: v.start });
    } else {
      swaps.push({ name, show: v.show, png: v.show });
    }
  }
  return { ok: true, swaps };
}

// Decoded replacements by data: URI, a few at a time: a sync runs on every edit.
const pngCache = new Map();
/**
 * A replacement PNG as the stage uploads it (browser only): `{ width, height, rgba }`,
 * top-down, alpha halved to FFXI's scale as compose stores it. A 2D canvas keeps its
 * pixels premultiplied, so colour under very low alpha comes back rounded: the stage
 * is a preview, and what publishes is xi-tools' own decode of the file.
 */
export async function pngPixels(uri) {
  if (pngCache.has(uri)) return pngCache.get(uri);
  const bytes = pngBytes(uri);
  if (!bytes) throw new Error('not a PNG data: URI');
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const { width, height } = bitmap;
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = Math.round(rgba[i] / 2);
  const out = { width, height, rgba };
  if (pngCache.size >= 8) pngCache.delete(pngCache.keys().next().value);
  pngCache.set(uri, out);
  return out;
}
