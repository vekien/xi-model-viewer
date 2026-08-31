// Best-effort type labels for DAT Browser rows — "Zone", "Gear", "Effect", …
//
// Everything here is derived from data the app already has, so a row can be
// labelled without opening the file:
//   • the baked lists/*.json (zones, maps, effects, NPCs)
//   • the merged FTABLE id map (path → file_id) the browser loads anyway
//   • the static gear tables + zone-id math in js/dat/
//
// A miss is normal and returns null — an unlisted DAT stays unlabelled rather
// than guessing. Only classifyDat() (which reads the bytes) is authoritative;
// this is the cheap preview that costs no I/O per row.

import { ENTITY_MODEL_OFFSET, RACE_SKELETON_RELS, gearIndex } from './dat/modelids.js';
import { matchTablePath } from './dat/ftable.js';
import { zoneForFileId } from './dat/zonedat.js';

/**
 * Normalize any DAT reference — absolute, game-relative, `game/…`-prefixed,
 * either slash — to the FTABLE key form: `ROM3/5/7.DAT`, uppercase.
 * HD/PIVOT copies collapse onto the same key as the base-game file, so an
 * override row gets the same label as the file it replaces.
 */
export function datTypeKey(path) {
  const p = String(path || '').replace(/\//g, '\\');
  const m = p.match(/(?:^|\\)((?:rom\d*|sound\d*|maps)\\.+)$/i);
  return (m ? m[1] : p).replace(/\\/g, '/').toUpperCase();
}

/** Baked lists that name DATs outright. Order is priority — first hit wins. */
const LISTS = [
  {
    url: 'lists/zones.json',
    // → [{ label, path }]
    entries: (j) => (Array.isArray(j) ? j.map((z) => ({ label: 'Zone', path: z.path })) : []),
  },
  {
    url: 'lists/images.json',
    // Per-group labels: maps stay Map; UI/system/cutscene packs are not maps.
    entries: (j) => {
      if (!Array.isArray(j)) return [];
      const out = [];
      for (const g of j) {
        const label = imageGroupLabel(g.name || g.id || '');
        for (const e of g.entries ?? []) {
          if (e?.path) out.push({ label, path: e.path });
        }
      }
      return out;
    },
  },
  {
    url: 'lists/effects.json',
    entries: (j) => (j?.categories ?? []).flatMap((c) => (c.entries ?? []).map((e) => ({
      label: 'Effect', path: e.path,
    }))),
  },
  {
    url: 'lists/npcs.json',
    entries: (j) => (j?.categories ?? []).flatMap((c) => (c.entries ?? []).flatMap((e) => (
      [...(e.variants ?? []), e.base].filter(Boolean).map((path) => ({ label: 'NPC', path }))
    ))),
  },
];

/** Map baked image-group titles → DAT Browser badge. */
function imageGroupLabel(name) {
  const n = String(name || '').toLowerCase();
  if (/\bui\b|system image|menu|title|window|icon/.test(n)) return 'UI';
  if (/cutscene|cs image|event image/.test(n)) return 'Cutscene';
  if (/unsorted|misc image|miscellaneous image/.test(n)) return 'Image';
  if (/map/.test(n)) return 'Map';
  return 'Image';
}

let listIndexPromise = null;

/**
 * Fetch the baked lists once and fold them into one key → label map.
 * A list that fails to load is skipped; the rest still label their files.
 * @returns {Promise<Map<string, string>>}
 */
export function loadDatTypeLists() {
  if (listIndexPromise) return listIndexPromise;
  listIndexPromise = (async () => {
    const index = new Map();
    const loaded = await Promise.all(LISTS.map(async (l) => {
      try {
        const res = await fetch(l.url);
        if (!res.ok) return null;
        return l.entries(await res.json());
      } catch {
        return null;
      }
    }));
    // Reverse order so earlier (higher-priority) lists overwrite later ones.
    for (const entries of loaded.filter(Boolean).reverse()) {
      for (const { label, path } of entries) {
        const k = datTypeKey(path);
        if (k) index.set(k, label);
      }
    }
    for (const rel of Object.values(RACE_SKELETON_RELS)) index.set(datTypeKey(rel), 'Race');
    return index;
  })();
  return listIndexPromise;
}

/** Zone companion DATs, by the kind zoneForFileId() reports. */
const ZONE_SCRIPT_LABELS = { events: 'Events', dialog: 'Dialog', npclist: 'NPCs' };

/**
 * Build the per-row lookup. `byPath` is loadMergedTables()'s path → file_id map
 * (uppercase, forward slashes) — pass null to label from the lists alone.
 * @returns {(path: string) => string | null}
 */
export function makeDatTypeLookup(listIndex, byPath) {
  const gear = gearIndex();
  return function datTypeFor(path) {
    const key = datTypeKey(path);
    if (!key) return null;

    const listed = listIndex?.get(key);
    if (listed) return listed;

    // Before the extension rules — a USER save's .DAT/.TTL is not a table.
    if (key.includes('/USER/')) return 'Save';

    if (key.endsWith('.BGW')) return 'Music';
    if (key.endsWith('.SPW')) return 'SFX';
    if (key.endsWith('.PNG')) return 'Image';
    if (matchTablePath(key)) return 'Table';

    const fid = byPath?.get(key);
    if (fid == null) return null;
    if (gear.has(fid)) return 'Gear';
    const zone = zoneForFileId(fid);
    if (zone) return ZONE_SCRIPT_LABELS[zone.kind] ?? null;
    if (fid >= ENTITY_MODEL_OFFSET) return 'Model';
    return null;
  };
}
