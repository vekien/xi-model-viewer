import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { backend } from '../js/backend.js';
import { loadList } from '../js/lists.js';
import { gameCandidates } from '../js/gamePath.js';
import { parseAudioHeader, toWav, FMT_ATRAC3 } from '../js/audio.js';
import {
  SOUND_ROOTS, listSfxFiles, listSfxFolders, loadMusicNames, loadSfxMeta, musicMatches,
  musicTrackName, rootMatches, scanMusicRoots, sfxFileMatches, sfxFileStem, sfxFileTitle,
  sfxFolderLabel,
} from '../js/soundLists.js';
import { ArgsInput } from './ArgsInput.jsx';
import { Combo } from './Combo.jsx';
import { Tooltip } from './Tooltip.jsx';
import { EXPORT_COMMANDS, addToken, tokenValue } from './exportArgs.js';
import {
  EXPORT_KINDS, buildXiArgs, loadArgs, sanitizeFileName, shellQuote, xiEnvFromSpec,
} from './ExportModal.jsx';

// File > Batch Export. A loop around whichever single export the picked tab
// makes: DAT tabs run the same `xi … export` call the Export dialog does, the
// Music and Sound FX tabs decode to WAV in-app the same way it does. Pick where
// the list comes from, narrow it (or don't — the default is everything), then
// run it with a line of feedback per file.
//
// Runs strictly one at a time — xi shells out to Python (and Blender for FBX),
// so parallel jobs would just thrash the disk, and the Rust side tracks a
// single child pid for Stop.

const SLOTS = ['face', 'main', 'sub', 'range', 'head', 'body', 'hands', 'legs', 'feet'];

const TABS = [
  { id: 'npcs', label: 'NPCs', icon: 'pets' },
  { id: 'characters', label: 'Characters', icon: 'person' },
  { id: 'zones', label: 'Zones', icon: 'map' },
  { id: 'music', label: 'Music', icon: 'library_music' },
  { id: 'sfx', label: 'Sound FX', icon: 'graphic_eq' },
  { id: 'custom', label: 'Custom list', icon: 'edit_note' },
];

const isAudioTab = (tab) => tab === 'music' || tab === 'sfx';

/** Feed lines kept in the DOM — a full character run is tens of thousands. */
const FEED_CAP = 400;
const TAIL_CAP = 8;

/** `seNNN` folders sfx.json has no real name for; one bucket, not 370 entries. */
const CAT_UNNAMED = '\u0000unnamed';
const isPlaceholderCat = (label) => !label || /^NEW\s*-\s*se\d+$/i.test(label);

const folderKey = 'exportFolder_batch';
const optsKey = (store) => `batchOpts_${store}`;
const argsKey = (store) => `batchArgs_${store}`;
const namingKey = 'batchAudioNaming';

const normRel = (p) => String(p || '').replace(/\//g, '\\').replace(/^[\\]+/, '');

/**
 * The game's own folder for a file (`ROM2\27`, `sound2\win\music\data`), so
 * `ROM\27\82.DAT` and `ROM2\27\82.DAT` don't both try to write `82.glb` into
 * one directory.
 */
function gameSubdir(rel) {
  const clean = normRel(rel);
  const m = clean.match(/(?:^|\\)((?:ROM\d*|sound\d*|maps)\\.*)$/i);
  return (m ? m[1] : clean).split('\\').slice(0, -1).join('\\');
}

/** Mirror that layout under the export root. */
function outDirFor(folder, rel) {
  const dir = gameSubdir(rel);
  return dir ? `${folder}\\${dir}` : folder;
}

function loadFormat(store) {
  try {
    const saved = JSON.parse(localStorage.getItem(optsKey(store)) || 'null');
    return saved?.format === 'fbx' ? 'fbx' : 'glb';
  } catch { return 'glb'; }
}

function saveFormat(store, format) {
  try { localStorage.setItem(optsKey(store), JSON.stringify({ format })); } catch { /* quota */ }
}

/** Batch args are their own setting, seeded once from the single dialog's. */
function loadBatchArgs(store) {
  let out = null;
  try {
    const raw = localStorage.getItem(argsKey(store));
    if (raw != null) {
      const saved = JSON.parse(raw);
      if (Array.isArray(saved)) out = saved.map((t) => String(t).trim()).filter(Boolean);
    }
  } catch { /* corrupt */ }
  if (out == null) out = loadArgs(store);
  // No model is loaded here to read clips off, so spell xi's own default out —
  // it decides the filename (<stem>_<anim>.gltf), which shouldn't be a surprise.
  if (store === 'anim' && tokenValue(out, '--anim') == null) out = addToken('anim', out, '--anim idl');
  return out;
}

/** Job lists, built from the baked asset lists in `ui/public/lists/`. */
async function jobsFromNpcs(category) {
  const data = await loadList('npcs.json');
  const out = [];
  for (const cat of data.categories ?? []) {
    if (category && cat.name !== category) continue;
    for (const entry of cat.entries ?? []) {
      const variants = entry.variants ?? [];
      variants.forEach((path, i) => {
        out.push({
          path: normRel(path),
          label: variants.length > 1 ? `${entry.name} (${i + 1}/${variants.length})` : entry.name,
        });
      });
    }
  }
  return out;
}

async function jobsFromCharacters(raceId, slot) {
  const data = await loadList('characters.json');
  const out = [];
  for (const race of data.races ?? []) {
    if (raceId && race.id !== raceId) continue;
    if (!slot && race.base) out.push({ path: normRel(race.base), label: `${race.label} — skeleton` });
    for (const s of SLOTS) {
      if (slot && s !== slot) continue;
      for (const item of race.slots?.[s] ?? []) {
        for (const path of item.paths ?? []) {
          out.push({ path: normRel(path), label: `${race.label} · ${s} · ${item.label}` });
        }
      }
    }
  }
  return out;
}

async function jobsFromZones() {
  const data = await loadList('zones.json');
  return (data ?? []).map((z) => ({
    // zones.json stores `game/ROM3/5/7.DAT`; the `game/` prefix is display-only.
    path: normRel(String(z.path || '').replace(/^game[\\/]/i, '')),
    label: z.name || String(z.id),
  }));
}

function jobsFromText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => ({ path: normRel(l), label: l }));
}

/**
 * Every `seNNN` folder under every sound root, with its `.spw` files. ~520
 * directory reads, so it is done once per game path and then filtered in
 * memory — the live count would otherwise re-walk the disk on every keystroke.
 */
async function scanSfxIndex(gamePath, onProgress) {
  const folders = [];
  for (const { root, label } of SOUND_ROOTS) {
    const dir = `${gamePath}\\${root}\\win\\se`;
    // eslint-disable-next-line no-await-in-loop
    const names = await listSfxFolders(dir);
    for (const name of names) folders.push({ root, label, name, dir: `${dir}\\${name}` });
  }
  const out = [];
  const CHUNK = 16;
  for (let i = 0; i < folders.length; i += CHUNK) {
    const slice = folders.slice(i, i + CHUNK);
    // eslint-disable-next-line no-await-in-loop
    const lists = await Promise.all(slice.map((f) => listSfxFiles(f.dir)));
    slice.forEach((f, k) => { if (lists[k].length) out.push({ ...f, files: lists[k] }); });
    onProgress?.(Math.min(i + CHUNK, folders.length), folders.length);
  }
  return out;
}

/**
 * Cached music groups / sfx folders for one game path. Promises, not values, so
 * two overlapping counts share the one scan instead of racing it.
 */
function audioCache(cache, gamePath) {
  if (cache.gamePath !== gamePath) {
    Object.assign(cache, { gamePath, names: null, meta: null, music: null, sfx: null });
  }
  return cache;
}

function jobsFromMusic(groups, { root, q }) {
  const out = [];
  for (const g of groups) {
    if (root && g.root !== root) continue;
    // Typing an expansion's name takes the whole expansion, as in the Music panel.
    const all = !q || rootMatches(g, q);
    for (const t of g.tracks) {
      if (!all && !musicMatches(t, q)) continue;
      out.push({
        path: t.rel,
        label: `${g.label} · ${musicTrackName(t)}`,
        stem: t.file.replace(/\.bgw$/i, ''),
        name: t.name,
      });
    }
  }
  return out;
}

function jobsFromSfx(index, meta, { root, category, q }) {
  const out = [];
  for (const f of index) {
    if (root && f.root !== root) continue;
    const cat = sfxFolderLabel(f.root, f.name, meta);
    if (category) {
      const matchesCat = category === CAT_UNNAMED ? isPlaceholderCat(cat) : cat === category;
      if (!matchesCat) continue;
    }
    // A hit on the expansion, the folder id or its category takes the folder whole.
    const all = !q || rootMatches(f, q) || f.name.toLowerCase().includes(q)
      || (!!cat && cat.toLowerCase().includes(q));
    for (const file of f.files) {
      if (!all && !sfxFileMatches(file, meta, q)) continue;
      const title = sfxFileTitle(file, meta);
      out.push({
        path: `${f.root}\\win\\se\\${f.name}\\${file}`,
        label: `${f.label} · ${cat ?? f.name} · ${title ?? sfxFileStem(file)}`,
        stem: sfxFileStem(file),
        name: title,
      });
    }
  }
  return out;
}

/** One job per DAT — gear items share DATs across races, slots and NPC variants. */
const dedupe = (jobs) => {
  const seen = new Set();
  return jobs.filter((j) => {
    const k = j.path.toLowerCase();
    if (!j.path || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/**
 * Output stem per audio job. Track names are not guaranteed unique inside a
 * folder (and sanitizing can collide two that were), so the first repeat is
 * qualified with the game filename rather than silently overwritten.
 */
function nameAudioJobs(jobs, naming) {
  const used = new Set();
  return jobs.map((j) => {
    const dir = gameSubdir(j.path).toLowerCase();
    const base = (naming === 'file' || !j.name) ? j.stem : sanitizeFileName(j.name);
    const taken = (n) => used.has(`${dir}\\${n.toLowerCase()}`);
    let out = base;
    if (taken(out)) {
      out = `${base} (${j.stem})`;
      for (let n = 2; taken(out); n += 1) out = `${base} (${j.stem}-${n})`;
    }
    used.add(`${dir}\\${out.toLowerCase()}`);
    return { ...j, out };
  });
}

export function BatchExportModal({ open, settings, onClose, onStatus, onRunning }) {
  const [tab, setTab] = useState('npcs');
  const [kindId, setKindId] = useState('mesh');
  const [npcCategory, setNpcCategory] = useState('');
  const [race, setRace] = useState('');
  const [slot, setSlot] = useState('');
  const [customText, setCustomText] = useState('');
  const [soundRoot, setSoundRoot] = useState('');
  const [sfxCategory, setSfxCategory] = useState('');
  const [audioQuery, setAudioQuery] = useState('');
  const [naming, setNaming] = useState(() => (localStorage.getItem(namingKey) === 'file' ? 'file' : 'name'));
  const [folder, setFolder] = useState('');
  const [format, setFormat] = useState('glb');
  const [args, setArgs] = useState([]);
  const [catalogs, setCatalogs] = useState({ npc: [], race: [] });
  const [scan, setScan] = useState(null);   // { done, total } while walking win\se
  const [sfxCats, setSfxCats] = useState([]);
  const [preview, setPreview] = useState({ count: null, loading: false, error: '' });
  const [run, setRun] = useState(null);   // { total, done, ok, fail, current, feed[], tail[] }
  const [result, setResult] = useState(null);   // finished run: { ok, fail, stopped, folder }
  const [running, setRunning] = useState(false);
  const [pos, setPos] = useState(null);
  const panelRef = useRef(null);
  const dragState = useRef(null);
  const stopRef = useRef(false);
  const runningRef = useRef(false);
  runningRef.current = running;
  const feedRef = useRef(null);
  const wasOpen = useRef(false);
  const cacheRef = useRef({ gamePath: '', names: null, meta: null, music: null, sfx: null });

  const isAudio = isAudioTab(tab);
  // Zones only have `zone export`; everything else is a mesh or an animation.
  const effKind = tab === 'zones' ? 'zone' : kindId;
  const kind = EXPORT_KINDS[effKind];
  const store = kind.store;
  const catalog = kind.catalog;
  const gamePath = settings?.gamePath || '';

  const hydrate = useCallback((id) => {
    const k = EXPORT_KINDS[id];
    setFormat(loadFormat(k.store));
    setArgs(loadBatchArgs(k.store));
  }, []);

  useEffect(() => {
    if (!open) { wasOpen.current = false; return; }
    if (wasOpen.current) return;
    wasOpen.current = true;
    setFolder(localStorage.getItem(folderKey) || '');
    setRun(null);
    setResult(null);
    setRunning(false);
    stopRef.current = false;
    setPos(null);
    if (!isAudioTab(tab)) hydrate(tab === 'zones' ? 'zone' : kindId);
  }, [open, hydrate, tab, kindId]);

  // Category / race pickers come from the lists themselves, fetched once.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      try {
        const [npcs, chars] = await Promise.all([
          loadList('npcs.json'),
          loadList('characters.json'),
        ]);
        if (!alive) return;
        setCatalogs({
          npc: (npcs.categories ?? []).map((c) => ({ id: c.name, label: `${c.name} (${c.entries?.length ?? 0})` })),
          race: (chars.races ?? []).map((r) => ({ id: r.id, label: r.label })),
        });
      } catch { /* pickers stay at "All" */ }
    })();
    return () => { alive = false; };
  }, [open]);

  /** Music groups (7 reads) or the sfx folder index (~520), cached per game path. */
  const audioIndex = useCallback(async (which) => {
    if (!gamePath) return null;
    const c = audioCache(cacheRef.current, gamePath);
    if (which === 'music') {
      c.names ??= loadMusicNames();
      c.music ??= c.names.then((names) => scanMusicRoots(gamePath, names));
      return c.music;
    }
    c.meta ??= loadSfxMeta();
    if (!c.sfx) {
      setScan({ done: 0, total: 0 });
      c.sfx = scanSfxIndex(gamePath, (done, total) => setScan({ done, total }))
        .finally(() => setScan(null));
    }
    return Promise.all([c.sfx, c.meta]).then(([index, meta]) => ({ index, meta }));
  }, [gamePath]);

  const buildJobs = useCallback(async () => {
    if (tab === 'npcs') return dedupe(await jobsFromNpcs(npcCategory));
    if (tab === 'characters') return dedupe(await jobsFromCharacters(race, slot));
    if (tab === 'zones') return dedupe(await jobsFromZones());
    if (tab === 'custom') return dedupe(jobsFromText(customText));
    const q = audioQuery.trim().toLowerCase();
    if (tab === 'music') {
      const groups = await audioIndex('music');
      return nameAudioJobs(dedupe(jobsFromMusic(groups ?? [], { root: soundRoot, q })), naming);
    }
    const sfx = await audioIndex('sfx');
    if (!sfx) return [];
    return nameAudioJobs(
      dedupe(jobsFromSfx(sfx.index, sfx.meta, { root: soundRoot, category: sfxCategory, q })),
      naming,
    );
  }, [tab, npcCategory, race, slot, customText, soundRoot, sfxCategory, audioQuery, naming, audioIndex]);

  // Live count so the size of the run is obvious before starting it.
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setPreview((p) => ({ ...p, loading: true, error: '' }));
    const t = window.setTimeout(() => {
      buildJobs()
        .then((jobs) => { if (alive) setPreview({ count: jobs.length, loading: false, error: '' }); })
        .catch((e) => { if (alive) setPreview({ count: null, loading: false, error: e.message ?? String(e) }); });
    }, 200);
    return () => { alive = false; window.clearTimeout(t); };
  }, [open, buildJobs]);

  // Category picker for Sound FX: the labels sfx.json actually names, plus one
  // bucket for the `NEW - seNNN` placeholders, counted over the chosen root.
  useEffect(() => {
    if (!open || tab !== 'sfx') return undefined;
    let alive = true;
    audioIndex('sfx').then((sfx) => {
      if (!alive || !sfx) return;
      const counts = new Map();
      let unnamed = 0;
      for (const f of sfx.index) {
        if (soundRoot && f.root !== soundRoot) continue;
        const cat = sfxFolderLabel(f.root, f.name, sfx.meta);
        if (isPlaceholderCat(cat)) unnamed += f.files.length;
        else counts.set(cat, (counts.get(cat) ?? 0) + f.files.length);
      }
      const named = [...counts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([label, n]) => ({ id: label, label, badge: n.toLocaleString() }));
      setSfxCats(unnamed
        ? [...named, { id: CAT_UNNAMED, label: 'Uncategorised (NEW - se…)', badge: unnamed.toLocaleString() }]
        : named);
    }).catch(() => { if (alive) setSfxCats([]); });
    return () => { alive = false; };
  }, [open, tab, soundRoot, audioIndex]);

  // A category that the newly-picked root doesn't have would silently queue nothing.
  useEffect(() => {
    if (sfxCategory && sfxCats.length && !sfxCats.some((c) => c.id === sfxCategory)) setSfxCategory('');
  }, [sfxCats, sfxCategory]);

  // Naming an example in the command preview shouldn't re-split a pasted list
  // of thousands on every keystroke.
  const firstCustom = useMemo(
    () => customText.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || '',
    [customText],
  );

  const soundRootItems = useMemo(() => [
    { id: '', label: 'Everything — all sound folders' },
    ...SOUND_ROOTS.map((r) => ({ id: r.root, label: r.label, badge: r.root })),
  ], []);

  // A changed selection makes the previous run's feed stale, not current.
  useEffect(() => {
    if (!runningRef.current) { setRun(null); setResult(null); }
  }, [tab, npcCategory, race, slot, customText, soundRoot, sfxCategory, audioQuery]);

  // Escape and the backdrop must not close the dialog mid-run; App owns both.
  useEffect(() => { onRunning?.(running); }, [running, onRunning]);

  // Keep the newest result in view without yanking the page around it.
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run?.feed?.length]);

  if (!open) return null;

  const needsXi = !isAudio && !settings?.xiPath;
  const needsGame = !gamePath;
  const setFmt = (v) => { setFormat(v); saveFormat(store, v); };
  const setArgList = (next) => {
    setArgs(next);
    try { localStorage.setItem(argsKey(store), JSON.stringify(next)); } catch { /* quota */ }
  };
  const setNameStyle = (v) => {
    setNaming(v);
    try { localStorage.setItem(namingKey, v); } catch { /* quota */ }
  };
  const switchTab = (id) => {
    setTab(id);
    if (!isAudioTab(id)) hydrate(id === 'zones' ? 'zone' : kindId);
  };
  const switchKind = (id) => { setKindId(id); hydrate(id); };

  const startDrag = (e) => {
    if (e.target.closest('button, input, textarea, a, [role="button"]')) return;
    const rect = panelRef.current.getBoundingClientRect();
    dragState.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDrag = (e) => {
    if (!dragState.current) return;
    setPos(clamp({ x: e.clientX - dragState.current.dx, y: e.clientY - dragState.current.dy }, panelRef.current));
  };
  const endDrag = () => { dragState.current = null; };

  const browse = async () => {
    const picked = await backend.pickFolder(folder);
    if (picked) { setFolder(picked); localStorage.setItem(folderKey, picked); }
  };

  // Show the command against a real DAT from the current selection, so the
  // mirrored output folder in it is the one this run would actually write to.
  const sampleDat = normRel(
    (tab === 'custom' && firstCustom)
    || (tab === 'zones' ? 'ROM\\1\\41.DAT' : 'ROM\\27\\82.DAT'),
  );
  const sampleArgs = isAudio
    ? null
    : buildXiArgs(catalog, sampleDat, outDirFor(folder || '…', sampleDat), format, args);
  const sampleOut = tab === 'music'
    ? `…\\sound\\win\\music\\data\\${naming === 'file' ? 'music101' : 'Ronfaure'}.wav`
    : `…\\sound\\win\\se\\se003\\${naming === 'file' ? 'se003022' : 'Fire'}.wav`;

  /** Decode one .bgw/.spw to WAV beside its mirrored game folder. */
  const exportAudio = async (job) => {
    const src = await backend.resolvePrefer(gameCandidates(job.path, settings));
    const buffer = await backend.readFile(src);
    const header = parseAudioHeader(buffer);
    // ATRAC3 is an MDCT codec — not hand-decodable, so it goes through vgmstream.
    const wav = header.sampleFormat === FMT_ATRAC3
      ? new Uint8Array(await backend.decodeVgmstream(src))
      : toWav(buffer).wav;
    await backend.writeFile(`${outDirFor(folder, job.path)}\\${job.out}.wav`, wav);
    return `${job.out}.wav`;
  };

  const start = async () => {
    if (!folder) { onStatus?.('Choose an export folder first.'); return; }
    if (needsXi) { onStatus?.('Set the xi-tools folder in Settings first.'); return; }
    if (needsGame) { onStatus?.('Set the Game path in Settings first (FFXI_DIR).'); return; }
    let jobs;
    try {
      jobs = await buildJobs();
    } catch (e) {
      onStatus?.(`Batch export: could not build the list — ${e.message ?? e}`);
      return;
    }
    if (!jobs.length) { onStatus?.('Nothing matches that selection.'); return; }

    stopRef.current = false;
    setRunning(true);
    setResult(null);
    setRun({ total: jobs.length, done: 0, ok: 0, fail: 0, current: '', feed: [], tail: [] });

    const env = xiEnvFromSpec(settings);
    const xiPath = settings.xiPath;
    let ok = 0;
    let fail = 0;

    for (let i = 0; i < jobs.length; i += 1) {
      if (stopRef.current) break;
      const job = jobs[i];
      const tail = [];
      setRun((r) => ({ ...r, current: `${job.label} · ${job.path}`, tail: [] }));
      let status = 'ok';
      let note = '';
      try {
        if (isAudio) {
          // eslint-disable-next-line no-await-in-loop
          note = await exportAudio(job);
        } else {
          const xiArgs = buildXiArgs(catalog, job.path, outDirFor(folder, job.path), format, args);
          // eslint-disable-next-line no-await-in-loop
          await backend.xiRunStream(xiArgs, xiPath, env, (line) => {
            if (/^# exit /.test(line)) return;
            tail.push(line);
            if (tail.length > TAIL_CAP) tail.shift();
            setRun((r) => (r ? { ...r, tail: [...tail] } : r));
          });
          note = tail.filter(Boolean).slice(-1)[0] ?? '';
        }
        ok += 1;
      } catch (e) {
        status = 'fail';
        fail += 1;
        // xi's own complaint says more than "exited with code 1" — but only if
        // it looks like one; the tail's last line is often just progress.
        const said = [...tail].reverse()
          .find((l) => /error|exception|traceback|not found|no such|usage:/i.test(l));
        note = said || (e?.message ?? String(e));
      }
      const row = { status, label: job.label, path: job.path, note };
      setRun((r) => (r ? {
        ...r,
        done: i + 1,
        ok,
        fail,
        feed: [...r.feed, row].slice(-FEED_CAP),
      } : r));
    }

    const stopped = stopRef.current;
    setRun((r) => (r ? { ...r, current: '', tail: [] } : r));
    setResult({ ok, fail, stopped, folder });
    setRunning(false);
    onStatus?.(stopped
      ? `Batch export stopped — ${ok} exported, ${fail} failed.`
      : `Batch export finished — ${ok} exported, ${fail} failed → ${folder}`);
  };

  const stop = async () => {
    stopRef.current = true;
    if (!isAudio) {
      try { await backend.xiRunCancel(); } catch { /* already gone */ }
    }
  };

  const style = pos
    ? { left: pos.x, top: pos.y, transform: 'none' }
    : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };

  const pct = run?.total ? Math.round((run.done / run.total) * 100) : 0;
  const unit = isAudio ? 'file' : 'DAT';
  const scanning = tab === 'sfx' && !!scan;

  return (
    <div className="modal-backdrop" onPointerDown={(e) => {
      if (e.target === e.currentTarget && !running) onClose();
    }}>
      <div className="modal batch-modal" ref={panelRef} style={style}>
        <div className="modal-header" onPointerDown={startDrag} onPointerMove={onDrag} onPointerUp={endDrag}>
          <span className="icon">library_add_check</span>
          <span className="modal-title">Batch Export</span>
          <Tooltip content={running ? 'Stop the run first' : 'Close'}>
            <Button className="icon-btn modal-close" onClick={onClose} disabled={running}>
              <span className="icon">close</span>
            </Button>
          </Tooltip>
        </div>

        <div className="settings-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              className={`settings-tab${tab === t.id ? ' on' : ''}`}
              aria-selected={tab === t.id}
              disabled={running}
              onClick={() => switchTab(t.id)}
            >
              <span className="icon">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>

        <div className="modal-body batch-body">
          {needsXi && (
            <div className="export-warn">
              <span className="icon">info</span>
              <span>Batch export needs the <strong>xi-tools</strong> folder (Python 3.14). Set it in
                <em> File → Settings</em>.</span>
            </div>
          )}
          {needsGame && !needsXi && (
            <div className="export-warn">
              <span className="icon">info</span>
              <span>Batch export needs the <strong>Game path</strong>{isAudio ? '' : ' (FFXI_DIR)'}. Set it in
                <em> File → Settings</em>.</span>
            </div>
          )}

          <div className={`batch-cols${running ? ' locked' : ''}`} aria-disabled={running}>
            <div className="batch-col">
              {tab === 'npcs' && (
                <div className="form-row">
                  <label className="form-label">Category</label>
                  <Combo
                    value={npcCategory}
                    items={[{ id: '', label: 'All categories' }, ...catalogs.npc]}
                    onChange={setNpcCategory}
                    className="export-select"
                  />
                </div>
              )}

              {tab === 'characters' && (
                <>
                  <div className="form-row">
                    <label className="form-label">Race</label>
                    <Combo
                      value={race}
                      items={[{ id: '', label: 'All races' }, ...catalogs.race]}
                      onChange={setRace}
                      className="export-select"
                    />
                  </div>
                  <div className="form-row">
                    <label className="form-label">Gear slot</label>
                    <Combo
                      value={slot}
                      items={[{ id: '', label: 'All slots (+ race skeleton)' },
                        ...SLOTS.map((s) => ({ id: s, label: s }))]}
                      onChange={setSlot}
                      className="export-select"
                    />
                  </div>
                </>
              )}

              {tab === 'zones' && (
                <div className="form-hint">
                  Every zone in <span className="mono">lists/zones.json</span> — the same list the
                  Zones panel shows.
                </div>
              )}

              {isAudio && (
                <>
                  <div className="form-row">
                    <label className="form-label">Sound folder</label>
                    <Combo
                      value={soundRoot}
                      items={soundRootItems}
                      onChange={setSoundRoot}
                      className="export-select"
                    />
                  </div>

                  {tab === 'sfx' && (
                    <div className="form-row">
                      <label className="form-label">Category</label>
                      <Combo
                        value={sfxCategory}
                        items={[{ id: '', label: 'All categories' }, ...sfxCats]}
                        onChange={setSfxCategory}
                        className="export-select"
                      />
                    </div>
                  )}

                  <div className="form-row">
                    <label className="form-label">Filter</label>
                    <div className="form-inline">
                      <input
                        type="text"
                        value={audioQuery}
                        spellCheck={false}
                        placeholder={tab === 'music' ? 'Leave empty for everything…' : 'Leave empty for everything…'}
                        onChange={(e) => setAudioQuery(e.target.value)}
                        disabled={running}
                      />
                      {audioQuery && (
                        <Tooltip content="Clear the filter">
                          <Button onClick={() => setAudioQuery('')} disabled={running}>
                            <span className="icon">close</span>
                          </Button>
                        </Tooltip>
                      )}
                    </div>
                    <div className="form-hint">
                      {tab === 'music'
                        ? 'Matches the same things the Music panel’s search does — track name, filename or number. Naming an expansion takes all of it.'
                        : 'Matches the same things the Sound FX panel’s search does — sound title, id, or a seNNN folder. Naming a folder or category takes all of it.'}
                    </div>
                  </div>
                </>
              )}

              {tab === 'custom' && (
                <div className="form-row">
                  <label className="form-label">DATs — one per line</label>
                  <textarea
                    className="batch-text mono"
                    spellCheck={false}
                    value={customText}
                    placeholder={'ROM/28/52.DAT\nROM2/9/14\n# lines starting with # are ignored'}
                    onChange={(e) => setCustomText(e.target.value)}
                    disabled={running}
                  />
                  <div className="form-hint">
                    Game-relative (<span className="mono">ROM/28/52</span>) or a full path. The
                    <span className="mono"> .DAT</span> suffix is optional.
                  </div>
                </div>
              )}

              {!isAudio && tab !== 'zones' && (
                <div className="form-row">
                  <label className="form-label">Export type</label>
                  <div className="radio-row" role="radiogroup" aria-label="Export type">
                    {['mesh', 'anim'].map((id) => (
                      <button
                        key={id}
                        type="button"
                        role="radio"
                        aria-checked={kindId === id}
                        className={`radio-opt${kindId === id ? ' on' : ''}`}
                        disabled={running}
                        onClick={() => switchKind(id)}
                      >
                        <span className="icon">
                          {kindId === id ? 'radio_button_checked' : 'radio_button_unchecked'}
                        </span>
                        {EXPORT_KINDS[id].label}
                      </button>
                    ))}
                  </div>
                  {effKind === 'anim' && (
                    <div className="form-hint">
                      One clip per DAT — the <span className="mono">--anim</span> argument below
                      picks which (<span className="mono">idl</span> if unset).
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="batch-col">
              {isAudio ? (
                <>
                  <div className="export-outrow">
                    <span className="icon">audio_file</span>
                    <span>Every sound exports as <strong>.wav</strong></span>
                  </div>

                  <div className="form-row">
                    <label className="form-label">File names</label>
                    <Combo
                      value={naming}
                      items={[
                        { id: 'name', label: tab === 'music' ? 'Track name (Ronfaure.wav)' : 'Sound title (Fire.wav)' },
                        { id: 'file', label: tab === 'music' ? 'Game filename (music101.wav)' : 'Game filename (se003022.wav)' },
                      ]}
                      onChange={setNameStyle}
                      className="export-select"
                    />
                    <div className="form-hint">
                      Anything with no known name keeps its game filename, and a repeat inside one
                      folder is qualified with it.
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="form-row">
                    <label className="form-label">Output type</label>
                    <Combo
                      value={format}
                      items={[
                        { id: 'glb', label: effKind === 'anim' ? 'glTF (.gltf + .bin)' : 'glTF (.glb)' },
                        { id: 'fbx', label: 'FBX (needs Blender)' },
                      ]}
                      onChange={setFmt}
                      className="export-select"
                    />
                  </div>

                  <div className="form-row">
                    <label className="form-label">
                      Arguments <span className="form-label-dim">· xi {EXPORT_COMMANDS[catalog].join(' ')}</span>
                    </label>
                    <ArgsInput type={catalog} tokens={args} onChange={setArgList} />
                    <div className="args-preview mono">{sampleArgs.map(shellQuote).join(' ')}</div>
                  </div>
                </>
              )}

              <div className="form-row">
                <label className="form-label">Export folder</label>
                <div className="form-inline">
                  <input type="text" value={folder} spellCheck={false} placeholder="Choose a destination…"
                    onChange={(e) => {
                      setFolder(e.target.value);
                      try { localStorage.setItem(folderKey, e.target.value); } catch { /* quota */ }
                    }} disabled={running} />
                  <Button onClick={browse} disabled={running}>
                    <span className="icon">folder_open</span>Browse
                  </Button>
                </div>
                <div className="form-hint">
                  {isAudio ? (
                    <>Each sound lands under its own game folder
                      (<span className="mono">{sampleOut}</span>) so same-named files from different
                      expansions don&apos;t collide.</>
                  ) : (
                    <>Each DAT lands under its own game folder
                      (<span className="mono">…\ROM\27\82.{kind.ext(format === 'fbx')}</span>) so
                      same-named files from different ROMs don&apos;t collide.</>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="batch-queue">
            <div className="batch-queue-head">
              <span className="icon">playlist_play</span>
              {run ? (
                <span className="batch-counts mono">
                  {run.done}/{run.total}
                  <span className="batch-ok"> · {run.ok} ok</span>
                  {run.fail > 0 && <span className="batch-fail"> · {run.fail} failed</span>}
                </span>
              ) : (
                <span className="batch-counts mono">
                  {preview.error
                    ? `list unavailable — ${preview.error}`
                    : scanning
                      ? `scanning sound effects… ${scan.done}/${scan.total || '…'} folders`
                      : preview.count == null
                        ? 'counting…'
                        : `${preview.count.toLocaleString()} ${unit}${preview.count === 1 ? '' : 's'} queued`}
                </span>
              )}
              {(running || scanning) && <span className="icon spin batch-spin">progress_activity</span>}
            </div>

            {result && (
              <div className={`batch-result${result.fail ? ' warn' : ''}${result.stopped ? ' stopped' : ''}`} role="status">
                <span className="icon batch-result-icon">
                  {result.stopped ? 'stop_circle' : result.fail ? 'warning' : 'check_circle'}
                </span>
                <div className="batch-result-text">
                  <strong>{result.stopped ? 'Stopped' : 'Export complete'}</strong>
                  {' — '}
                  {result.ok.toLocaleString()} exported
                  {result.fail > 0 && `, ${result.fail.toLocaleString()} failed`}
                  <div className="batch-result-path mono">{result.folder}</div>
                </div>
                <Tooltip content="Show in Explorer">
                  <Button onClick={() => backend.revealPath(result.folder)
                    .catch((e) => onStatus?.(`Could not show in Explorer: ${e?.message ?? e}`))}>
                    <span className="icon">folder_open</span>Open folder
                  </Button>
                </Tooltip>
              </div>
            )}

            {!run && preview.count > 500 && (
              <div className="export-warn batch-warn">
                <span className="icon">schedule</span>
                <span>
                  {isAudio ? (
                    <>That&apos;s <strong>{preview.count.toLocaleString()}</strong> sounds to decode, one
                      after another — this will take a while. Narrow it down above, or leave it
                      running.</>
                  ) : (
                    <>That&apos;s <strong>{preview.count.toLocaleString()}</strong> separate xi runs, one
                      after another{format === 'fbx' ? ', each going through Blender' : ''} — this
                      will take a while. Narrow it down above, or leave it running.</>
                  )}
                </span>
              </div>
            )}

            {run && (
              <div className="batch-bar"><div className="batch-bar-fill" style={{ width: `${pct}%` }} /></div>
            )}

            {run?.current && (
              <div className="batch-current">
                <div className="batch-current-name mono">{run.current}</div>
                {run.tail.length > 0 && (
                  <div className="batch-tail mono">{run.tail.join('\n')}</div>
                )}
              </div>
            )}

            {run && (
              <div className="batch-feed" ref={feedRef}>
                {run.feed.length === 0 && !running && (
                  <div className="combo-empty">Nothing ran.</div>
                )}
                {run.feed.map((row, i) => (
                  <div key={`${row.path}-${i}`} className={`batch-row ${row.status}`}>
                    <span className="icon batch-row-icon">
                      {row.status === 'ok' ? 'check_circle' : 'error'}
                    </span>
                    <span className="batch-row-label">{row.label}</span>
                    <span className="batch-row-path mono">{row.path}</span>
                    {row.status === 'fail' && row.note && (
                      <Tooltip content={row.note}>
                        <span className="batch-row-note mono">{row.note}</span>
                      </Tooltip>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="modal-actions">
          <Button onClick={onClose} disabled={running}>Close</Button>
          {running ? (
            <Button className="active export-go" onClick={stop}>
              <span className="icon">stop_circle</span>Stop
            </Button>
          ) : (
            <Button
              className="active export-go"
              onClick={start}
              disabled={!folder || needsXi || needsGame || !preview.count}
            >
              <span className="icon">download</span>
              Export {preview.count ? preview.count.toLocaleString() : ''}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function clamp(p, panel) {
  const w = panel?.offsetWidth ?? 760;
  const h = panel?.offsetHeight ?? 480;
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}
