// Music (.bgw) and sound-effect (.spw) catalogues.
//
// The Music panel, the Sound FX panel and File > Batch Export all walk the same
// seven sound roots and filter them by the same rules, so the roots table, the
// baked name lists under `ui/public/lists/`, and the search predicates live here
// rather than being spelled once per caller and drifting apart.

import { backend } from './backend.js';
import { loadList } from './lists.js';

/** FFXI ships audio across seven sound roots; each aligns with an expansion. */
export const SOUND_ROOTS = [
  { root: 'sound', label: 'Base Game' },
  { root: 'sound2', label: 'Rise of the Zilart' },
  { root: 'sound3', label: 'Chains of Promathia' },
  { root: 'sound4', label: 'Treasures of Aht Urhgan' },
  { root: 'sound5', label: 'Wings of the Goddess' },
  { root: 'sound6', label: 'Abyssea' },
  { root: 'sound9', label: 'Seekers / Rhapsodies' },
];

export const natCompare = (a, b) => String(a)
  .localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });

/** A root's label ("Abyssea") or its folder name ("sound6") matching the query. */
export function rootMatches(group, q) {
  return (group.label || '').toLowerCase().includes(q)
    || (group.root || '').toLowerCase().includes(q);
}

// --- Music ------------------------------------------------------------------

// music.json names are keyed by `<root>_<NNN>` (e.g. sound2_135) — filename
// numbers are NOT globally unique (music181 differs between sound2 and sound5)
// and don't always equal the header track id, so the key includes the root.
export async function loadMusicNames() {
  try {
    const data = await loadList('music.json');
    return new Map(Object.entries(data.names ?? {}));
  } catch { /* names are optional */ }
  return new Map();
}

export const musicTrackName = (t) => t?.name ?? `music${String(t?.num ?? '0').padStart(3, '0')}`;

export function musicMatches(t, q) {
  if ((t.name || '').toLowerCase().includes(q)) return true;
  if ((t.file || '').toLowerCase().includes(q)) return true;
  if ((t.num || '').includes(q)) return true;
  if (`music${(t.num || '').padStart(3, '0')}`.includes(q)) return true;
  return false;
}

/** `<root>/win/music/data` for every root that has one, tracks sorted by name. */
export async function scanMusicRoots(gamePath, names) {
  const found = [];
  for (const { root, label } of SOUND_ROOTS) {
    const dir = `${gamePath}\\${root}\\win\\music\\data`;
    // eslint-disable-next-line no-await-in-loop
    const files = await backend.listFiles(dir);
    const tracks = files
      .filter((f) => f.toLowerCase().endsWith('.bgw'))
      .map((f) => {
        const raw = f.match(/(\d+)/)?.[1] ?? '0';
        const num = String(parseInt(raw, 10));
        return {
          file: f,
          path: `${dir}\\${f}`,
          rel: `${root}\\win\\music\\data\\${f}`,
          root,
          num,
          name: names.get(`${root}_${raw.padStart(3, '0')}`) ?? null,
        };
      })
      // Alphabetical by display name (ignoring leading quotes/brackets);
      // unnamed tracks (music###) sort last.
      .sort((a, b) => {
        const key = (t) => (t.name ? t.name.replace(/^[^\p{L}\p{N}]+/u, '') : `￿${t.num.padStart(4, '0')}`);
        return key(a).localeCompare(key(b), undefined, { sensitivity: 'base', numeric: true });
      });
    if (tracks.length) found.push({ root, label, tracks });
  }
  return found;
}

// --- Sound effects ----------------------------------------------------------

// Sound effects live at <root>/win/se/seNNN/seNNNNNN.spw. The seNNN folder
// (id / 1000) is the natural category grouping.

// Windower SFXInfo categories: per-folder labels ("Spell Sounds", "Weapon Skill
// Effects", …) + partial per-sound titles, from lists/sfx.json.
export async function loadSfxMeta() {
  try {
    const data = await loadList('sfx.json');
    return {
      folders: new Map(Object.entries(data.folders ?? {})),   // `<root>_seNNN` -> category label
      names: new Map(Object.entries(data.names ?? {})),       // 6-digit id -> title
    };
  } catch { /* optional */ }
  return { folders: new Map(), names: new Map() };
}

export function sfxFolderLabel(root, name, meta) {
  return meta.folders.get(`${root}_${name}`) ?? null;
}

export function sfxFolderMatches(root, name, meta, q) {
  if (name.toLowerCase().includes(q)) return true;
  const cat = sfxFolderLabel(root, name, meta);
  if (cat && cat.toLowerCase().includes(q)) return true;
  const base = parseInt(name.replace(/\D/g, ''), 10);
  if (!Number.isFinite(base)) return false;
  const lo = base * 1000;
  const hi = lo + 1000;
  for (const [id, title] of meta.names) {
    const n = parseInt(id, 10);
    if (!Number.isFinite(n) || n < lo || n >= hi) continue;
    if (id.includes(q) || (title || '').toLowerCase().includes(q)) return true;
  }
  return false;
}

export const sfxFileStem = (f) => String(f).replace(/\.spw$/i, '');
export const sfxFileId = (f) => (String(f).match(/(\d+)/)?.[1] ?? '0').padStart(6, '0');
export const sfxFileTitle = (f, meta) => meta.names.get(sfxFileId(f)) ?? null;

export function sfxFileMatches(f, meta, q) {
  const stem = sfxFileStem(f);
  const num = (String(f).match(/(\d+)/)?.[1] ?? '0');
  const id = num.padStart(6, '0');
  const title = meta.names.get(id) ?? null;
  if (stem.toLowerCase().includes(q)) return true;
  if (num.includes(q) || id.includes(q)) return true;
  if (title && title.toLowerCase().includes(q)) return true;
  return false;
}

/** The `seNNN` folders directly under a root's `win/se`, naturally sorted. */
export async function listSfxFolders(dir) {
  const entries = await backend.listDir(dir).catch(() => []);
  return entries
    .filter((e) => e.isDir && /^se\d+$/i.test(e.name))
    .map((e) => e.name)
    .sort(natCompare);
}

/** The `.spw` files in one `seNNN` folder, naturally sorted. */
export async function listSfxFiles(dir) {
  const files = await backend.listFiles(dir);
  return files.filter((f) => f.toLowerCase().endsWith('.spw')).sort(natCompare);
}
