// AltanaViewer List/* CSV parsing shared by the NPC and Character (PC) views.
// Plain JS (no JSX) so the parsing pipeline is testable outside the browser.
//
// Path spec grammar: `;`-separated variants of `rom/dir/file` (2 parts = base
// ROM), where `file` may be a range `a-b`.
//
// PC lists (List/PC):
//   index.csv       : `folder,label,baseSpec` — playable bases; the base DAT
//                     carries the race skeleton every other DAT rigs onto
//   <Slot>.csv rows : `pathSpec,label`, with optional `@Group` section headers.
//                     Empty label => one entry per expanded DAT, named by path
//   Action.csv rows : same grammar; a row's DATs are animation *schedule* sets
//   Motion.csv rows : `schedSpec, clipSpec[, clipSpec…]` — whenever a schedule
//                     DAT from column 0 is loaded, the later columns hold the
//                     motion-clip DATs those schedules reference

const PATH_RE = /^\d+(\/\d+(-\d+)?){1,2}$/;

export function expandPathSpec(spec) {
  const out = [];
  for (const part of spec.split(';')) {
    const p = part.trim();
    if (!PATH_RE.test(p)) continue;
    const parts = p.split('/');
    const [rom, dir, fileSpec] = parts.length === 2 ? ['1', parts[0], parts[1]] : parts;
    const romDir = rom === '1' ? 'ROM' : `ROM${rom}`;
    const range = fileSpec.match(/^(\d+)-(\d+)$/);
    if (range) {
      const from = parseInt(range[1], 10);
      const to = parseInt(range[2], 10);
      for (let f = from; f <= to && f - from < 100; f++) out.push(`${romDir}\\${dir}\\${f}.DAT`);
    } else {
      out.push(`${romDir}\\${dir}\\${fileSpec}.DAT`);
    }
  }
  return out;
}

// The PC lists carry a few cross-directory ranges (`86/107-87/57`) this viewer
// can't expand — a range is only valid in the final path segment. `0/0` is
// AltanaViewer's "no DAT" sentinel.
export function expandSpec(spec) {
  const clean = spec
    .split(';')
    .filter((p) => {
      const segs = p.trim().split('/');
      return segs.length >= 2 && segs.slice(0, -1).every((s) => !s.includes('-'));
    })
    .join(';');
  return expandPathSpec(clean).filter((p) => p !== 'ROM\\0\\0.DAT');
}

/** `ROM4\7\126.DAT` -> `4/7/126` for entries the list leaves unnamed. */
export function specLabel(path) {
  return path.replace(/\.DAT$/i, '').replace(/^ROM(\d*)\\/, (_, n) => (n ? `${n}\\` : '')).replaceAll('\\', '/');
}

// A PC's body motion is split across body-region slots stored in separate,
// consecutively-numbered DATs after the race's base motion file: base(+0) drives
// the lower body, base+1 the upper body, base+3 the waist/skirt overlay. The base
// DAT on its own animates only the legs, so locomotion (wlk/idl/run) leaves the
// torso and waist frozen in bind pose. This mirrors CModel::LoadMotion's
// MOTION_NORMAL path, which loads BaseMotionFileNo + {0, 1, 3} for the default
// config (the +2/+4 files are the left-weapon / alternate-body variants this
// viewer doesn't model). Returns the upper + waist companion motion DATs to merge
// alongside the base; the loader skips any that don't exist in a given client.
export function baseMotionCompanions(basePath) {
  const bump = (n) => basePath.replace(/(\d+)(\.DAT)$/i, (_, f, ext) => `${parseInt(f, 10) + n}${ext}`);
  return [bump(1), bump(3)];
}

/** index.csv -> [{ id, label, base }] */
export function parseRaceIndex(text) {
  const races = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = line.trim().split(',');
    if (cells.length < 3) continue;
    const base = expandSpec(cells[cells.length - 1])[0];
    if (!base) continue;
    races.push({ id: cells[0].trim(), label: cells[1].trim() || cells[0].trim(), base });
  }
  return races;
}

/** Slot/Action CSV -> [{ id, label, group, paths }] */
export function parseSlotCsv(text) {
  const items = [];
  let group = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('@')) { group = line.slice(1).trim() || null; continue; }
    const comma = line.indexOf(',');
    const spec = (comma < 0 ? line : line.slice(0, comma)).trim();
    const label = comma < 0 ? '' : line.slice(comma + 1).trim();
    const paths = expandSpec(spec);
    if (label) {
      // Labeled row: one entry, all DATs load together (0 paths = the None sentinel).
      items.push({ id: `${items.length}:${spec}`, label, group, paths });
    } else {
      // No label in the source, so the DAT path stands in for a name. `auto`
      // marks these as the only rows a generated name may overwrite — curated
      // labels like "Melee Cyclas (MNK Relic)" must survive untouched.
      for (const p of paths) {
        items.push({ id: `${items.length}:${p}`, label: specLabel(p), group, paths: [p], auto: true });
      }
    }
  }
  return items;
}

export function parseMotionCsv(text) {
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const cols = raw.split(',').map((c) => expandSpec(c.trim())).filter((a) => a.length > 0);
    if (cols.length >= 2) rows.push(cols);
  }
  return rows;
}

/** Adds `motionPaths` to each action: clip DATs mapped from its schedule DATs. */
export function attachMotions(actions, motionRows) {
  for (const a of actions) {
    const scheduled = new Set(a.paths);
    const extra = new Set();
    for (const row of motionRows) {
      if (row[0].some((p) => scheduled.has(p))) {
        for (const col of row.slice(1)) for (const p of col) extra.add(p);
      }
    }
    a.motionPaths = [...extra];
  }
}
