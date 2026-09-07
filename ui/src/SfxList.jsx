import { useCallback, useEffect, useMemo, useState } from 'react';
import { backend } from '../js/backend.js';
import { gameCandidates, relFromAbs } from '../js/gamePath.js';
import {
  SOUND_ROOTS, listSfxFiles, listSfxFolders, loadSfxMeta, rootMatches,
  sfxFileMatches, sfxFileStem, sfxFileTitle, sfxFolderLabel, sfxFolderMatches,
} from '../js/soundLists.js';
import { Tooltip } from './Tooltip.jsx';

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
      for (const r of SOUND_ROOTS) {
        const dir = `${gamePath}\\${r.root}\\win\\se`;
        // eslint-disable-next-line no-await-in-loop
        const folders = await listSfxFolders(dir);
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
        const folders = await listSfxFolders(r.dir);
        if (cancelled) return;
        next.set(r.root, folders);
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
    const list = await listSfxFolders(group.dir);
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
      const folders = folderMap.get(r.root);
      if (rootMatches(r, q)) {
        out.push({ ...r, folders: folders ?? null, forceAll: true });
        continue;
      }
      if (!folders) {
        // Still loading folder names — keep root visible until we can filter.
        out.push({ ...r, folders: null, forceAll: false, pending: true });
        continue;
      }
      const matched = folders.filter((name) => sfxFolderMatches(r.root, name, meta, q));
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

  const category = sfxFolderLabel(root, name, meta);

  useEffect(() => {
    if (!searching) return undefined;
    let cancelled = false;
    (async () => {
      if (files != null) return;
      const list = await listSfxFiles(dir);
      if (cancelled) return;
      setFiles(list);
    })();
    return () => { cancelled = true; };
  }, [searching, dir, files]);

  const toggle = async () => {
    if (searching) return;
    const next = !open;
    setOpen(next);
    if (next && files === null) setFiles(await listSfxFiles(dir));
  };

  const show = searching || open;
  const visibleFiles = useMemo(() => {
    if (!files) return null;
    if (!filterQ) return files;
    // Folder-level hit (label / seNNN): show all files. File-level hit: filter.
    const folderHit = name.toLowerCase().includes(filterQ)
      || (category && category.toLowerCase().includes(filterQ));
    if (folderHit) return files;
    return files.filter((f) => sfxFileMatches(f, meta, filterQ));
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
            const stem = sfxFileStem(f);
            const title = sfxFileTitle(f, meta);
            const num = (f.match(/(\d+)/)?.[1] ?? '0');
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
