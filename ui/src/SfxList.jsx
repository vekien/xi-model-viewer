import { useCallback, useEffect, useMemo, useState } from 'react';
import { backend } from '../js/backend.js';
import { gameCandidates, relFromAbs } from '../js/gamePath.js';
import { Tooltip } from './Tooltip.jsx';

// Sound effects live at <root>/win/se/seNNN/seNNNNNN.spw. The seNNN folder
// (id / 1000) is the natural category grouping.

const ROOTS = [
  { root: 'sound', label: 'Base Game' },
  { root: 'sound2', label: 'Rise of the Zilart' },
  { root: 'sound3', label: 'Chains of Promathia' },
  { root: 'sound4', label: 'Treasures of Aht Urhgan' },
  { root: 'sound5', label: 'Wings of the Goddess' },
  { root: 'sound6', label: 'Abyssea' },
  { root: 'sound9', label: 'Seekers / Rhapsodies' },
];

const natCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// Windower SFXInfo categories: per-folder labels ("Spell Sounds", "Weapon Skill
// Effects", …) + partial per-sound titles, from lists/sfx.json.
async function loadSfxMeta() {
  try {
    const res = await fetch('lists/sfx.json');
    if (res.ok) {
      const data = await res.json();
      return {
        folders: new Map(Object.entries(data.folders ?? {})),   // `<root>_seNNN` -> category label
        names: new Map(Object.entries(data.names ?? {})),       // 6-digit id -> title
      };
    }
  } catch { /* optional */ }
  return { folders: new Map(), names: new Map() };
}

function folderLabel(root, name, meta) {
  return meta.folders.get(`${root}_${name}`) ?? null;
}

function folderMatches(root, name, meta, q) {
  if (name.toLowerCase().includes(q)) return true;
  const cat = folderLabel(root, name, meta);
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

function fileMatches(f, meta, q) {
  const stem = f.replace(/\.spw$/i, '');
  const num = (f.match(/(\d+)/)?.[1] ?? '0');
  const id = num.padStart(6, '0');
  const title = meta.names.get(id) ?? null;
  if (stem.toLowerCase().includes(q)) return true;
  if (num.includes(q) || id.includes(q)) return true;
  if (title && title.toLowerCase().includes(q)) return true;
  return false;
}

export function SfxList({ gamePath, hdPath = '', hdEnabled = false, player, onError }) {
  const [roots, setRoots] = useState(null);
  const [meta, setMeta] = useState({ folders: new Map(), names: new Map() });
  const [query, setQuery] = useState('');
  /** root -> sorted seNNN folder names (lazy, filled on open / search). */
  const [folderMap, setFolderMap] = useState(() => new Map());
  const settings = { gamePath, hdPath, hdEnabled };

  useEffect(() => {
    if (!gamePath) return;
    let cancelled = false;
    (async () => {
      const loadedMeta = await loadSfxMeta();
      const found = [];
      for (const r of ROOTS) {
        const dir = `${gamePath}\\${r.root}\\win\\se`;
        const entries = await backend.listDir(dir).catch(() => []);
        const folders = entries.filter((e) => e.isDir && /^se\d+$/i.test(e.name));
        if (folders.length) found.push({ ...r, dir, count: folders.length });
      }
      if (!cancelled) { setMeta(loadedMeta); setRoots(found); setFolderMap(new Map()); }
    })();
    return () => { cancelled = true; };
  }, [gamePath]);

  const q = query.trim().toLowerCase();

  // While searching, preload every root's folder list so we can filter offline.
  useEffect(() => {
    if (!q || !roots?.length) return undefined;
    let cancelled = false;
    (async () => {
      const next = new Map(folderMap);
      let changed = false;
      await Promise.all(roots.map(async (r) => {
        if (next.has(r.root)) return;
        const entries = await backend.listDir(r.dir).catch(() => []);
        if (cancelled) return;
        next.set(
          r.root,
          entries.filter((e) => e.isDir && /^se\d+$/i.test(e.name)).map((e) => e.name).sort(natCompare),
        );
        changed = true;
      }));
      if (!cancelled && changed) setFolderMap(new Map(next));
    })();
    return () => { cancelled = true; };
    // folderMap intentionally omitted — only refill missing roots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, roots]);

  const ensureFolders = useCallback(async (group) => {
    if (folderMap.has(group.root)) return folderMap.get(group.root);
    const entries = await backend.listDir(group.dir).catch(() => []);
    const list = entries.filter((e) => e.isDir && /^se\d+$/i.test(e.name))
      .map((e) => e.name).sort(natCompare);
    setFolderMap((prev) => {
      if (prev.has(group.root)) return prev;
      const n = new Map(prev);
      n.set(group.root, list);
      return n;
    });
    return list;
  }, [folderMap]);

  const filteredRoots = useMemo(() => {
    if (!roots) return null;
    if (!q) return roots;
    const out = [];
    for (const r of roots) {
      const labelHit = (r.label || '').toLowerCase().includes(q)
        || (r.root || '').toLowerCase().includes(q);
      const folders = folderMap.get(r.root);
      if (labelHit) {
        out.push({ ...r, folders: folders ?? null, forceAll: true });
        continue;
      }
      if (!folders) {
        // Still loading folder names — keep root visible until we can filter.
        out.push({ ...r, folders: null, forceAll: false, pending: true });
        continue;
      }
      const matched = folders.filter((name) => folderMatches(r.root, name, meta, q));
      if (matched.length) out.push({ ...r, folders: matched, forceAll: false });
    }
    return out;
  }, [roots, q, folderMap, meta]);

  return (
    <div id="tree" className="panel list-panel">
      <div className="list-search-wrap">
        <input
          className="list-search"
          type="text"
          placeholder="Search sound effects…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        {query && (
          <Tooltip content="Clear">
            <button type="button" className="list-search-clear" onClick={() => setQuery('')}>
              <span className="icon">close</span>
            </button>
          </Tooltip>
        )}
      </div>
      <div className="list-scroll">
        {roots === null && <div className="side-note">Scanning sound effects…</div>}
        {roots?.length === 0 && <div className="side-note">No sound effects found.</div>}
        {filteredRoots && filteredRoots.length === 0 && (
          <div className="side-note">No sound effects match “{query.trim()}”.</div>
        )}
        {filteredRoots?.map((r) => (
          <SfxRoot
            key={r.root}
            group={r}
            folders={r.folders ?? folderMap.get(r.root) ?? null}
            searching={!!q}
            filterQ={q}
            meta={meta}
            player={player}
            onError={onError}
            settings={settings}
            ensureFolders={ensureFolders}
          />
        ))}
      </div>
    </div>
  );
}

function SfxRoot({
  group, folders, searching, filterQ, meta, player, onError, settings, ensureFolders,
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!searching || folders != null) return;
    ensureFolders?.(group);
  }, [searching, folders, group, ensureFolders]);

  const show = searching || open;
  const list = folders;

  const toggle = async () => {
    if (searching) return;
    const next = !open;
    setOpen(next);
    if (next) await ensureFolders?.(group);
  };

  return (
    <div className={`node${show ? ' open' : ''}`}>
      <div className="row" onClick={toggle}>
        <span className="caret icon">chevron_right</span>
        <span className="kind icon">graphic_eq</span>
        <span>{group.label}</span>
        <span className="badge">{list ? list.length : group.count}</span>
      </div>
      {show && list && (
        <div className="children">
          {list.map((name) => (
            <SfxFolder
              key={name}
              dir={`${group.dir}\\${name}`}
              name={name}
              root={group.root}
              searching={searching}
              filterQ={filterQ}
              meta={meta}
              player={player}
              onError={onError}
              settings={settings}
            />
          ))}
        </div>
      )}
      {show && list === null && (
        <div className="children">
          <div className="side-note">Loading…</div>
        </div>
      )}
    </div>
  );
}

function SfxFolder({ dir, name, root, searching, filterQ, meta, player, onError, settings }) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState(null);

  const category = folderLabel(root, name, meta);

  useEffect(() => {
    if (!searching) return undefined;
    let cancelled = false;
    (async () => {
      if (files != null) return;
      const list = await backend.listFiles(dir);
      if (cancelled) return;
      setFiles(list.filter((f) => f.toLowerCase().endsWith('.spw')).sort(natCompare));
    })();
    return () => { cancelled = true; };
  }, [searching, dir, files]);

  const toggle = async () => {
    if (searching) return;
    const next = !open;
    setOpen(next);
    if (next && files === null) {
      const list = await backend.listFiles(dir);
      setFiles(list.filter((f) => f.toLowerCase().endsWith('.spw')).sort(natCompare));
    }
  };

  const show = searching || open;
  const visibleFiles = useMemo(() => {
    if (!files) return null;
    if (!filterQ) return files;
    // Folder-level hit (label / seNNN): show all files. File-level hit: filter.
    const folderHit = name.toLowerCase().includes(filterQ)
      || (category && category.toLowerCase().includes(filterQ));
    if (folderHit) return files;
    return files.filter((f) => fileMatches(f, meta, filterQ));
  }, [files, filterQ, name, category, meta]);

  if (searching && visibleFiles && visibleFiles.length === 0) return null;

  return (
    <div className={`node${show ? ' open' : ''}`}>
      <div className="row" onClick={toggle}>
        <span className="caret icon">chevron_right</span>
        <span className="kind icon">{category ? 'category' : 'folder'}</span>
        <span>{category ?? name}</span>
        <span className="mono-small sfx-folder-id">{name}</span>
        {visibleFiles && <span className="badge">{visibleFiles.length}</span>}
      </div>
      {show && visibleFiles && (
        <div className="children">
          {visibleFiles.map((f) => {
            const stem = f.replace(/\.spw$/i, '');
            const num = (f.match(/(\d+)/)?.[1] ?? '0');
            const title = meta.names.get(num.padStart(6, '0')) ?? null;
            const track = { file: f, path: `${dir}\\${f}`, root, num, name: title ?? stem };
            const active = player.current?.file === track.file && player.current?.root === track.root;
            const play = async () => {
              const rel = relFromAbs(track.path, settings);
              const path = await backend.resolvePrefer(
                rel !== track.path ? gameCandidates(rel, settings) : [track.path],
              );
              await player.play({ ...track, path });
            };
            return (
              <div key={f} className={`node${active ? ' selected' : ''}`}>
                <div className="row" onClick={() => play().catch((e) => onError?.(String(e.message ?? e)))}>
                  <span className="caret">
                    {active && player.playing
                      ? <span className="eq"><i /><i /><i /><i /></span>
                      : <span className="icon" />}
                  </span>
                  <span className="kind icon">volume_up</span>
                  {title ? <span className="track-name">{title}</span>
                         : <span className="mono-small">{stem}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {show && visibleFiles === null && (
        <div className="children">
          <div className="side-note">Loading…</div>
        </div>
      )}
    </div>
  );
}
