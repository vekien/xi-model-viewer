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

// Same-dir: 76/30-108 or 1/76/30-108
// Cross-dir (ROM folders hold files 0–127): 76/124-77/74 or 86/107-87/57
const SAME_DIR_RE = /^(?:(\d+)\/)?(\d+)\/(\d+)(?:-(\d+))?$/;
const CROSS_DIR_RE = /^(?:(\d+)\/)?(\d+)\/(\d+)-(\d+)\/(\d+)$/;

const romPrefix = (rom) => (!rom || rom === '1' ? 'ROM' : `ROM${rom}`);

/** Walk DAT paths from dirA/fileA → dirB/fileB (inclusive), 128 files/dir. */
function expandDirWalk(rom, dirA, fileA, dirB, fileB, cap = 512) {
  const out = [];
  let d = dirA;
  let f = fileA;
  for (let n = 0; n < cap; n++) {
    out.push(`${romPrefix(rom)}\\${d}\\${f}.DAT`);
    if (d === dirB && f === fileB) break;
    f += 1;
    if (f > 127) { d += 1; f = 0; }
  }
  return out;
}

export function expandPathSpec(spec) {
  const out = [];
  for (const part of spec.split(';')) {
    const p = part.trim();
    if (!p) continue;
    const cross = p.match(CROSS_DIR_RE);
    if (cross) {
      const rom = cross[1] || '1';
      const dirA = parseInt(cross[2], 10);
      const fileA = parseInt(cross[3], 10);
      const dirB = parseInt(cross[4], 10);
      const fileB = parseInt(cross[5], 10);
      out.push(...expandDirWalk(rom, dirA, fileA, dirB, fileB));
      continue;
    }
    const same = p.match(SAME_DIR_RE);
    if (!same) continue;
    const rom = same[1] || '1';
    const dir = parseInt(same[2], 10);
    const from = parseInt(same[3], 10);
    const to = same[4] != null ? parseInt(same[4], 10) : from;
    if (to < from) continue;
    // Same-dir ranges can exceed 100 (WS motion blocks); cap still guards runaway.
    for (let f = from; f <= to && f - from < 512; f++) {
      out.push(`${romPrefix(rom)}\\${dir}\\${f}.DAT`);
    }
  }
  return out;
}

// `0/0` is AltanaViewer's "no DAT" sentinel.
export function expandSpec(spec) {
  return expandPathSpec(spec).filter((p) => p !== 'ROM\\0\\0.DAT');
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

// ---------------------------------------------------------------------------
// Battle waist / skirt packs — from FFXI model viewer CModel::LoadMotion
// (MOTION_BATTLE) and xim PcModel.getSkirtBattleAnimationResource().
//
// Main battle DAT holds btl0+btl1 only. Waist btl2 lives in a parallel pack:
//   main  = MotionBFileNo[race] + weaponIdx
//   skirt = MotionBFileNo[race] + motionBnum[race] + weaponIdx
// Special katana/hand packs use MotionB2* the same way.
// File numbers are folder*1000+file (GetMotionFileListItem encoding).
// ---------------------------------------------------------------------------

/** Race id → index in the old viewer / xim PC race tables. */
const PC_RACE_IDX = {
  HumeM: 0, HumeF: 1, ElvaanM: 2, ElvaanF: 3,
  Tarutaru: 4, TarutaruF: 5, TaruM: 4, TaruF: 5,
  Mithra: 6, Galka: 7,
};

// First battle-motion file number per race (HumeM…Galka).
const MOTION_B_BASE = [32013, 36117, 41084, 46057, 51019, 51019, 56014, 60112];
// How many main-hand battle packs before the skirt block starts.
const MOTION_B_NUM = [9, 8, 10, 6, 6, 6, 9, 8];
// Hand-to-hand / katana alternate block.
const MOTION_B2_BASE = [98055, 98086, 98117, 99020, 99055, 99055, 99086, 99117];
const MOTION_B2_NUM = [1, 1, 1, 2, 1, 1, 1, 2];

/** `ROM\32\14.DAT` → 32014 (viewer FileNumber). */
export function pathToMotFileNo(path) {
  const m = String(path || '').replace(/\//g, '\\').match(/\\(\d+)\\(\d+)\.DAT$/i);
  if (!m) return null;
  return (+m[1]) * 1000 + (+m[2]);
}

/** 32014 → `ROM\32\14.DAT` (mirrors GetMotionFileListItem). */
export function motFileNoToPath(fileNo) {
  if (fileNo == null || !Number.isFinite(fileNo)) return null;
  let folder = Math.floor(fileNo / 1000);
  let file = fileNo % 1000;
  if (file > 127) { folder += 1; file -= 128; }
  return `ROM\\${folder}\\${file}.DAT`;
}

/**
 * Battle-skirt (waist / btl2) companion for a main battle DAT.
 * Returns null when the path isn't in a known battle block for the race.
 */
export function battleSkirtPath(battlePath, raceId) {
  const idx = PC_RACE_IDX[raceId];
  if (idx == null) return null;
  const n = pathToMotFileNo(battlePath);
  if (n == null) return null;
  const b = MOTION_B_BASE[idx];
  const bn = MOTION_B_NUM[idx];
  if (n >= b && n < b + bn) return motFileNoToPath(n + bn);
  const b2 = MOTION_B2_BASE[idx];
  const b2n = MOTION_B2_NUM[idx];
  // Main hand-to-hand / single special file, or the +1 katana twin.
  if (n >= b2 && n < b2 + Math.max(b2n, 2)) return motFileNoToPath(n + b2n);
  return null;
}

/** skirtByType[i] companion for each battleByType[i] entry (nulls preserved). */
export function battleSkirtTable(battleByType, raceId) {
  return (battleByType ?? []).map((p) => (p ? battleSkirtPath(p, raceId) : null));
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
