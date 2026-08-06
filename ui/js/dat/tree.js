// DAT directory tree — the equivalent of xim's DirectoryResource.
//
// A DAT is a flat run of 16-byte-headed sections where 0x01 pushes a directory
// and 0x00 pops it. Everything else is a resource that belongs to the directory
// it was declared in. Effects reference each other by DatId (the 4 bytes at the
// head of a section), and xim resolves those links relative to the *declaring*
// directory: local children first, then parent directories, then the whole tree.
//
// Our previous zone loader flattened this into a single `id -> mesh name` map,
// which silently loses every link whose id is reused in more than one directory
// and every link that points at a resource type we hadn't parsed. Rebuilding the
// real tree is what lets ParticleGenerator resolve its linkedDataId and its
// keyframe curves the same way the game does.
//
// Resources parse lazily: a zone has ~1700 sections but a given run only touches
// the handful an active generator actually references.

/** Section type codes (xim SectionType). */
export const SEC = {
  END: 0x00,
  DIR: 0x01,
  TABLE: 0x04,
  EFFECT: 0x05,          // ParticleGenerator
  ROUTE: 0x06,
  EFFECT_ROUTINE: 0x07,
  KEYFRAME: 0x19,        // ParticleKeyFrameData
  ZONE_DEF: 0x1c,
  PARTICLE_MESH: 0x1f,
  TEXTURE: 0x20,
  SPRITE_SHEET: 0x21,
  WEIGHTED_MESH: 0x25,
  ZONE_MESH: 0x2e,
  ENVIRONMENT: 0x2f,
  INTERACTION: 0x36,
  SOUND_POINTER: 0x3d,
  POINT_LIST: 0x3e,
  PATH: 0x4a,
};

/** Normalise a DatId to a comparable key (ids are 4 raw bytes, NUL/space padded). */
export const datKey = (id) => String(id ?? '').replace(/\0+$/, '').trim();

/**
 * One resource in the tree. `get()` parses on first use via the registered
 * parser for its section type; a parser that throws is remembered as null so a
 * malformed section can't cost anything on retry.
 */
class DatEntry {
  constructor(id, type, section, dir, ctx) {
    this.id = datKey(id);
    this.type = type;
    this.section = section;
    this.dir = dir;
    this._ctx = ctx;
    this._resource = undefined;
  }

  get() {
    if (this._resource !== undefined) return this._resource;
    const parser = this._ctx.parsers[this.type];
    if (!parser) { this._resource = null; return null; }
    try {
      this._resource = parser(this._ctx.bytes, this._ctx.dv, this.section, this) ?? null;
    } catch (e) {
      this._ctx.warn(`[${this.id}] failed to parse section 0x${this.type.toString(16)}: ${e.message}`);
      this._resource = null;
    }
    return this._resource;
  }
}

export class DatDir {
  constructor(id, parent, ctx) {
    this.id = datKey(id);
    this.parent = parent || null;
    this.ctx = ctx;
    this.children = [];              // DatEntry | DatDir, in DAT order
    this._byId = new Map();          // id -> (DatEntry | DatDir)[]
  }

  addChild(child) {
    this.children.push(child);
    const list = this._byId.get(child.id);
    if (list) list.push(child); else this._byId.set(child.id, [child]);
  }

  root() {
    let d = this;
    while (d.parent) d = d.parent;
    return d;
  }

  /** Sub-directories declared directly under this one. */
  getSubDirectories() {
    return this.children.filter((c) => c instanceof DatDir);
  }

  getNullableSubDirectory(id) {
    const list = this._byId.get(datKey(id));
    return list?.find((c) => c instanceof DatDir) ?? null;
  }

  hasSubDirectory(id) { return !!this.getNullableSubDirectory(id); }

  /** Direct child of `type` with this id — xim getNullableChildAs. */
  getChild(id, type) {
    const list = this._byId.get(datKey(id));
    if (!list) return null;
    for (const c of list) {
      if (c instanceof DatDir) continue;
      if (type !== undefined && c.type !== type) continue;
      const r = c.get();
      if (r) return r;
    }
    return null;
  }

  /** This directory and everything beneath it — xim getNullableChildRecursivelyAs. */
  getChildRecursive(id, type) {
    const local = this.getChild(id, type);
    if (local) return local;
    for (const c of this.children) {
      if (!(c instanceof DatDir)) continue;
      const found = c.getChildRecursive(id, type);
      if (found) return found;
    }
    return null;
  }

  /** Local children, then walk up the parents — xim searchLocalAndParentsById. */
  searchLocalAndParents(id, type) {
    for (let d = this; d; d = d.parent) {
      const found = d.getChild(id, type);
      if (found) return found;
    }
    return null;
  }

  /** Last resort: anywhere in the DAT — xim findFirstInEntireTreeById. */
  findFirstInEntireTree(id, type) {
    return this.root().getChildRecursive(id, type);
  }

  /** Direct children of a type (parsed) — xim collectByType. */
  collectByType(type) {
    const out = [];
    for (const c of this.children) {
      if (c instanceof DatDir || c.type !== type) continue;
      const r = c.get();
      if (r) out.push(r);
    }
    return out;
  }

  /** This directory and all descendants — xim collectByTypeRecursive. */
  collectByTypeRecursive(type) {
    const out = [];
    const walk = (dir) => {
      for (const c of dir.children) {
        if (c instanceof DatDir) { walk(c); continue; }
        if (c.type !== type) continue;
        const r = c.get();
        if (r) out.push(r);
      }
    };
    walk(this);
    return out;
  }

  /** Directory path from the root, for diagnostics. */
  path() {
    const parts = [];
    for (let d = this; d; d = d.parent) if (d.id) parts.unshift(d.id);
    return parts.join('/');
  }
}

/**
 * Build the directory tree over an already-split section list.
 *
 * @param {Uint8Array} bytes
 * @param {DataView} dv
 * @param {{id:string,typeCode:number,start:number,size:number,dataStart:number}[]} sections
 * @param {Object<number, Function>} parsers  section type -> (bytes, dv, section, entry) => resource
 * @param {(msg:string)=>void} [warn]
 */
export function buildDatTree(bytes, dv, sections, parsers, warn = () => {}) {
  const ctx = { bytes, dv, parsers, warn };
  const root = new DatDir('', null, ctx);
  let current = root;

  for (const s of sections) {
    if (s.typeCode === SEC.DIR) {
      const dir = new DatDir(s.id, current, ctx);
      current.addChild(dir);
      current = dir;
      continue;
    }
    if (s.typeCode === SEC.END) {
      // Never pop above the root — xim guards this for the one DAT that over-pops.
      if (current.parent) current = current.parent;
      continue;
    }
    current.addChild(new DatEntry(s.id, s.typeCode, s, current, ctx));
  }

  return root;
}

/**
 * Every directory in the tree, depth-first, paired with the weather id it sits
 * under (the `weat/<id>/…` folder) — the gate xim applies via WeatherAssociation.
 */
export function walkDirs(root, visit) {
  const rec = (dir, weather) => {
    for (const c of dir.getSubDirectories()) {
      // `weat` holds one sub-directory per weather type; below that the id sticks.
      const w = dir.id === 'weat' ? c.id : weather;
      visit(c, w);
      rec(c, w);
    }
  };
  visit(root, null);
  rec(root, null);
}
