import { useCallback, useEffect, useState } from 'react';
import { backend } from '../js/backend.js';
import { gameCandidates, relFromAbs } from '../js/gamePath.js';

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

export function SfxList({ gamePath, hdPath = '', hdEnabled = false, player, onError }) {
  const [roots, setRoots] = useState(null);
  const [meta, setMeta] = useState({ folders: new Map(), names: new Map() });
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
      if (!cancelled) { setMeta(loadedMeta); setRoots(found); }
    })();
    return () => { cancelled = true; };
  }, [gamePath]);

  return (
    <div id="tree" className="panel list-panel">
      <div className="list-scroll">
        {roots === null && <div className="side-note">Scanning sound effects…</div>}
        {roots?.length === 0 && <div className="side-note">No sound effects found.</div>}
        {roots?.map((r) => (
          <SfxRoot key={r.root} group={r} meta={meta} player={player} onError={onError} settings={settings} />
        ))}
      </div>
    </div>
  );
}

function SfxRoot({ group, meta, player, onError, settings }) {
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && folders === null) {
      const entries = await backend.listDir(group.dir).catch(() => []);
      setFolders(entries.filter((e) => e.isDir && /^se\d+$/i.test(e.name))
        .map((e) => e.name).sort(natCompare));
    }
  };

  return (
    <div className={`node${open ? ' open' : ''}`}>
      <div className="row" onClick={toggle}>
        <span className="caret icon">chevron_right</span>
        <span className="kind icon">graphic_eq</span>
        <span>{group.label}</span>
        <span className="badge">{group.count}</span>
      </div>
      {open && folders && (
        <div className="children">
          {folders.map((name) => (
            <SfxFolder key={name} dir={`${group.dir}\\${name}`} name={name}
              root={group.root} meta={meta} player={player} onError={onError} settings={settings} />
          ))}
        </div>
      )}
    </div>
  );
}

function SfxFolder({ dir, name, root, meta, player, onError, settings }) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState(null);

  // Semantic category label (e.g. "Spell Sounds", "Weapon Skill Effects") from
  // Windower SFXInfo; falls back to the raw folder name.
  const category = meta.folders.get(`${root}_${name}`) ?? null;

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && files === null) {
      const list = await backend.listFiles(dir);
      setFiles(list.filter((f) => f.toLowerCase().endsWith('.spw')).sort(natCompare));
    }
  };

  return (
    <div className={`node${open ? ' open' : ''}`}>
      <div className="row" onClick={toggle}>
        <span className="caret icon">chevron_right</span>
        <span className="kind icon">{category ? 'category' : 'folder'}</span>
        <span>{category ?? name}</span>
        <span className="mono-small sfx-folder-id">{name}</span>
        {files && <span className="badge">{files.length}</span>}
      </div>
      {open && files && (
        <div className="children">
          {files.map((f) => {
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
    </div>
  );
}
