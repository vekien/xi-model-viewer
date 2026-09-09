import { useEffect, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { backend } from '../js/backend.js';
import { ArgsInput } from './ArgsInput.jsx';
import { Combo } from './Combo.jsx';
import { Tooltip } from './Tooltip.jsx';
import { parseAudioHeader, toWav, FMT_ATRAC3 } from '../js/audio.js';
import {
  EXPORT_COMMANDS, addToken, removeFlag, tokenValue, tokensToArgv,
} from './exportArgs.js';

/** Windows-illegal characters out of a name we're about to make a filename of. */
export const sanitizeFileName = (name) => String(name ?? '').replace(/[<>:"/\\|?*]+/g, '_').trim() || 'export';

/** Per-kind export folders / formats / args persist independently. */
const folderKey = (type) => `exportFolder_${type}`;
const optsKey = (key) => `exportOpts_${key}`;
const argsKey = (key) => `exportArgs_${key}`;

/**
 * What each export kind runs and how its output is named. `store` is the
 * localStorage suffix — mesh keeps the historical `model` so an existing
 * folder/format/args setup carries over.
 */
export const EXPORT_KINDS = {
  mesh: {
    catalog: 'mesh', store: 'model', label: 'Mesh', icon: 'deployed_code',
    tabIcon: 'deployed_code', ext: (fbx) => (fbx ? 'fbx' : 'glb'),
  },
  pose: {
    catalog: 'pose', store: 'pose', label: 'Full Pose', icon: 'accessibility_new',
    tabIcon: 'accessibility_new', ext: (fbx) => (fbx ? 'fbx' : 'glb'),
  },
  anim: {
    catalog: 'anim', store: 'anim', label: 'Animation', icon: 'directions_run',
    tabIcon: 'directions_run', ext: (fbx) => (fbx ? 'fbx' : 'gltf'),
  },
  zone: {
    catalog: 'zone', store: 'zone', label: 'Zone', icon: 'map',
    tabIcon: 'map', ext: (fbx) => (fbx ? 'fbx' : 'glb'),
  },
};

/** xi's own default when `anim export` isn't given a clip. */
const DEFAULT_ANIM = 'idl';

const DEFAULT_FORMAT = 'glb';
const DEFAULT_ARGS = { model: ['--all-parts'], pose: [], anim: [], zone: [] };

function loadFormat(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(optsKey(key)) || 'null');
    return saved?.format === 'fbx' ? 'fbx' : DEFAULT_FORMAT;
  } catch {
    return DEFAULT_FORMAT;
  }
}

function saveFormat(key, format) {
  try { localStorage.setItem(optsKey(key), JSON.stringify({ format })); } catch { /* quota */ }
}

/**
 * Args the dialog used to spell as checkboxes, recovered once from the old
 * `exportOpts_*` blob so an existing setup survives the switch to the args box.
 */
function migrateArgs(key) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(optsKey(key)) || 'null'); } catch { /* corrupt */ }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return [...(DEFAULT_ARGS[key] ?? [])];
  const out = [];
  if (key === 'model') {
    if (saved.allParts) out.push('--all-parts');
    if (saved.weld === false) out.push('--no-weld');
    if (saved.splitTex) out.push('--split-tex');
    if (saved.animEnabled && saved.anim) {
      out.push(`--anim ${saved.anim}`);
      out.push(`--frame ${Number(saved.frame) || 0}`);
    }
  } else if (key === 'zone') {
    if (saved.noSky) out.push('--no-sky');
    if (saved.noVfx) out.push('--no-vfx');
    if (saved.objects) out.push('--objects');
    if (saved.collision) out.push('--collision');
    if (saved.useBase) out.push('--base');
  }
  return out;
}

export function loadArgs(key) {
  try {
    const raw = localStorage.getItem(argsKey(key));
    if (raw == null) return migrateArgs(key);
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved)) return [...(DEFAULT_ARGS[key] ?? [])];
    return saved.map((t) => String(t).trim()).filter(Boolean);
  } catch {
    return [...(DEFAULT_ARGS[key] ?? [])];
  }
}

export function saveArgs(key, args) {
  try { localStorage.setItem(argsKey(key), JSON.stringify(args)); } catch { /* quota */ }
}

export function shellQuote(s) {
  const t = String(s ?? '');
  if (!/[ \t"&|<>^%!()]/.test(t)) return t;
  return `"${t.replace(/"/g, '\\"')}"`;
}

/** Env map xi needs so FFXI_DIR / pivot / HD resolve (Settings paths). */
export function xiEnvFromSpec(spec) {
  const env = {};
  if (spec?.gamePath) env.FFXI_DIR = spec.gamePath;
  if (spec?.pivotPath) env.FFXI_PIVOT_DIR = spec.pivotPath;
  if (spec?.hdPath) env.FFXI_HD_DIR = spec.hdPath;
  return Object.keys(env).length ? env : null;
}

/**
 * `xi <cmd> <dat> --output <dir> [--fbx] <user args…>`. Anything the user typed
 * for a flag the dialog owns wins, so a hand-written `--output` isn't doubled.
 */
export function buildXiArgs(catalog, datPath, folder, format, userArgs) {
  const argv = tokensToArgv(userArgs);
  const has = (flag) => argv.includes(flag);
  const args = [...EXPORT_COMMANDS[catalog], datPath];
  if (!has('--output')) args.push('--output', folder);
  if (format === 'fbx' && !has('--fbx')) args.push('--fbx');
  return [...args, ...argv];
}

/**
 * `xi gear pose <every worn DAT> --main <weapon> … --output <dir> [--fbx] <user args…>`.
 *
 * Unlike the other kinds this is not one DAT: the whole worn set goes on the command
 * line at once, because the occlusion pass needs to see every piece before it can tell
 * which are hidden — a helmet only drops the hair if the hair is in the same run. The
 * hand slots are named separately so xi can re-parent them onto the hands; passing a
 * weapon positionally would leave it at its bind pose on the floor. The anim-only DATs
 * go in as `--anim-dat`: they carry the upper-body and waist layers of the clip the pose
 * is frozen at, and without them only the legs are posed.
 */
export function buildPoseArgs(pose, folder, format, userArgs, poseFile = null) {
  const argv = tokensToArgv(userArgs);
  const has = (flag) => argv.includes(flag);
  const args = [...EXPORT_COMMANDS.pose, ...(pose.gear ?? [])];
  for (const [flag, paths] of [['--main', pose.main], ['--sub', pose.sub], ['--ranged', pose.ranged],
    ['--anim-dat', pose.motion]]) {
    for (const path of paths ?? []) args.push(flag, path);
  }
  if (pose.drawRanged && !has('--draw-ranged')) args.push('--draw-ranged');
  if (!has('--output')) args.push('--output', folder);
  if (!has('--name') && pose.stem) args.push('--name', pose.stem);
  // The evaluated joints of whatever the viewport is playing. Written beside the model
  // at export time; named here too so the previewed command is the one that runs.
  if (poseFile && !has('--pose-file')) args.push('--pose-file', poseFile);
  if (format === 'fbx' && !has('--fbx')) args.push('--fbx');
  return [...args, ...argv];
}

const stemOf = (path) => (String(path || '').split(/[\\/]/).pop() || 'export').replace(/\.dat$/i, '');

/**
 * File > Export dialog. Music/SFX export to WAV in-app; models/zones shell out
 * to `xi mesh|anim|zone export` and dump the CLI log into the bottom console
 * (same path as DAT edits). Draggable and screen-clamped like SettingsModal.
 *
 * `onDone` reports the finished export to the banner App puts on screen — the
 * xi path closes this dialog the moment it starts, so a status line that scrolls
 * past is otherwise all there is to say it worked.
 */
export function ExportModal({ open, spec, onClose, onStatus, onCliLog, onDone }) {
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('mesh');
  const [sourcePath, setSourcePath] = useState('');
  const [format, setFormat] = useState(DEFAULT_FORMAT);
  const [args, setArgs] = useState([]);
  const [pos, setPos] = useState(null);
  const panelRef = useRef(null);
  const dragState = useRef(null);
  // Only hydrate from disk when the dialog *opens* — not on every parent re-render
  // with a fresh `spec` object identity (that was wiping in-session ticks).
  const wasOpen = useRef(false);

  const isXi = spec?.type === 'model' || spec?.type === 'zone';
  const kindId = spec?.type === 'zone' ? 'zone' : mode;
  const kind = EXPORT_KINDS[kindId];
  // Full Pose needs a composed character (race skeleton + worn slots). A single-DAT
  // model has nothing to assemble, so the tab only appears when App supplies one.
  const pose = spec?.pose ?? null;
  const modeIds = pose ? ['mesh', 'pose', 'anim'] : ['mesh', 'anim'];
  const isPose = kindId === 'pose';

  /** Read a kind's saved folder + format + args, dropping an --anim this model lacks. */
  const hydrate = (id) => {
    const k = EXPORT_KINDS[id];
    setFolder(localStorage.getItem(folderKey(k.store)) || '');
    setFormat(loadFormat(k.store));
    let next = loadArgs(k.store);
    const anim = tokenValue(next, '--anim');
    if (anim != null && !(spec?.animations ?? []).some((a) => a.id === anim)) {
      next = removeFlag(removeFlag(next, '--anim'), '--frame');
    }
    // `anim export` is about one clip, so it always names one.
    if (id === 'anim' && tokenValue(next, '--anim') == null) {
      const first = spec?.animations?.[0]?.id;
      if (first) next = addToken('anim', next, `--anim ${first}`);
    }
    // Full Pose exports what is on screen, so it re-seeds the frame from the viewport
    // every time it opens rather than restoring whatever was exported last. No --anim:
    // the pose itself is captured, and a schedule has no clip name to give.
    if (id === 'pose') {
      next = removeFlag(next, '--anim');
      next = addToken('pose', next, `--frame ${spec?.playing?.frame ?? 0}`);
    }
    setArgs(next);
    saveArgs(k.store, next);
  };

  useEffect(() => {
    if (!open || !spec) {
      wasOpen.current = false;
      return;
    }
    const justOpened = !wasOpen.current;
    wasOpen.current = true;
    if (!justOpened) return;

    setSourcePath(spec.sourcePath || '');
    setMode('mesh');
    if (spec.type === 'model' || spec.type === 'zone') hydrate(spec.type === 'zone' ? 'zone' : 'mesh');
    else setFolder(localStorage.getItem(folderKey(spec.type)) || '');
    setPos(null);
    setBusy(false);
  }, [open, spec]);

  if (!open || !spec) return null;

  const needsXi = isXi && !spec.xiPath;
  const needsGame = isXi && !spec.gamePath;
  const catalog = kind?.catalog;
  const store = kind?.store;

  // Character / NPC composites load several DATs; each is separately exportable.
  // Not in Full Pose, which is the whole set at once by definition.
  const sources = (!isPose && spec.type === 'model' && spec.sources?.length > 1) ? spec.sources : null;
  const activePath = sources
    ? (sources.find((s) => s.path.toLowerCase() === sourcePath.toLowerCase())?.path ?? sources[0].path)
    : (spec.sourcePath || '');
  const datStem = stemOf(activePath);

  const switchMode = (id) => { setMode(id); hydrate(id); };
  const setFmt = (v) => { setFormat(v); saveFormat(store, v); };
  const setArgList = (next) => { setArgs(next); saveArgs(store, next); };

  const animId = tokenValue(args, '--anim');
  // Full Pose exports either the single frame on screen or the whole clip.
  const allFrames = args.some((t) => t.trim() === '--all-frames');
  const setAllFrames = (on) => setArgList(on
    ? addToken(catalog, args, '--all-frames')
    : removeFlag(args, '--all-frames'));
  const animEntry = spec.animations?.find((a) => a.id === animId);
  // Full Pose scrubs the played timeline of whatever the viewport is showing — a
  // schedule as readily as a clip — so its length comes from the viewport rather than
  // from an --anim lookup. Mesh export indexes the DAT's stored keyframes instead.
  const playingLabel = spec.playing?.label ?? null;
  const animFrames = (isPose ? spec.playing?.frames : animEntry?.frames) ?? 1;
  const frame = Math.min(Math.max(Number(tokenValue(args, '--frame')) || 0, 0), Math.max(animFrames - 1, 0));
  const setFrame = (n) => setArgList(addToken(catalog, args, `--frame ${n}`));

  const startDrag = (e) => {
    if (e.target.closest('button, input, a, [role="button"]')) return;
    const rect = panelRef.current.getBoundingClientRect();
    dragState.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDrag = (e) => {
    if (!dragState.current) return;
    setPos(clamp({ x: e.clientX - dragState.current.dx, y: e.clientY - dragState.current.dy }, panelRef.current));
  };
  const endDrag = () => { dragState.current = null; };

  const fkey = isXi ? store : spec.type;
  const browse = async () => {
    const picked = await backend.pickFolder(folder);
    if (picked) { setFolder(picked); localStorage.setItem(folderKey(fkey), picked); }
  };

  const outExt = isXi ? kind.ext(format === 'fbx') : 'wav';
  const poseStem = pose ? sanitizeFileName(pose.stem || spec.name || datStem) : datStem;
  const outStem = !isXi
    ? sanitizeFileName(spec.outStem)
    : (isPose ? poseStem
      : kindId === 'anim' ? `${datStem}_${animId || DEFAULT_ANIM}` : datStem);
  const headTitle = isXi
    ? `Export ${kind.label}: ${spec.name || datStem}`
    : `Export ${spec.typeLabel}: ${spec.title}`;
  // Written next to the model at export time, and named in the preview so the command
  // shown is the command that runs. It stays behind as a record of the exact pose.
  const poseFileName = isPose ? `${poseStem}.pose.json` : null;
  const poseFileFor = (dir) => (isPose && spec.capturePose ? `${dir}\\${poseFileName}` : null);
  const previewArgs = !isXi ? null
    : (isPose
      ? buildPoseArgs({ ...pose, stem: poseStem }, folder || '…', format, args,
        poseFileFor(folder || '…'))
      : buildXiArgs(catalog, activePath, folder || '…', format, args));

  const doExport = async () => {
    if (!folder) { onStatus?.('Choose an export folder first.'); return; }
    if (needsXi) { onStatus?.('Set the xi-tools folder in Settings first.'); return; }
    if (needsGame) { onStatus?.('Set the Game path in Settings first (FFXI_DIR).'); return; }
    setBusy(true);
    const env = xiEnvFromSpec(spec);
    // A hand-written --output wins over the folder picker, so that is where the
    // file actually lands and where the banner's "Open folder" has to point.
    const outDir = (isXi && tokenValue(args, '--output')) || folder;
    // Snapshot before onClose unmounts this modal (xi path closes early).
    const snap = {
      xiPath: spec.xiPath,
      datStem,
      outExt,
      outStem,
      outDir,
      kindLabel: isXi ? kind.label : spec.typeLabel,
    };
    const done = (extra) => onDone?.({
      kind: snap.kindLabel, file: `${snap.outStem}.${snap.outExt}`, folder: snap.outDir, ...extra,
    });
    try {
      if (isXi) {
        // Snapshot the joints the renderer has evaluated and hand them to xi, so the
        // export is the pose on screen rather than xi's own reading of a clip name —
        // which for a schedule there isn't one of. Failing to write it is not fatal:
        // xi falls back to posing from its default clip, and the log says which ran.
        let poseFile = null;
        if (isPose && spec.capturePose) {
          try {
            const captured = spec.capturePose({ all: allFrames, frame });
            if (captured?.frames?.length) {
              poseFile = `${folder}\\${poseFileName}`;
              await backend.writeFile(poseFile,
                new TextEncoder().encode(JSON.stringify(captured)));
            }
          } catch (e) {
            poseFile = null;
            onStatus?.(`Could not write the pose file (${e?.message ?? e}) — exporting from the clip instead.`);
          }
        }
        const xiArgs = isPose
          ? buildPoseArgs({ ...pose, stem: poseStem }, folder, format, args, poseFile)
          : buildXiArgs(catalog, activePath, folder, format, args);
        const cmd = `xi ${xiArgs.map(shellQuote).join(' ')}`;
        const title = `xi ${EXPORT_COMMANDS[catalog].join(' ')} · ${snap.datStem}`;
        const head = [];
        if (env?.FFXI_DIR) head.push(`# FFXI_DIR=${env.FFXI_DIR}`);
        head.push(`$ ${cmd}`);
        head.push('# running…');
        // Close first so the UI stays usable; xi continues in the background.
        onClose();
        onCliLog?.({ title, text: head.join('\n') });
        onStatus?.(`Exporting ${snap.datStem}…`);

        const lines = [...head];
        const push = (line) => {
          lines.push(line);
          onCliLog?.({ title, text: lines.join('\n') });
        };

        try {
          await backend.xiRunStream(xiArgs, snap.xiPath, env, (line) => {
            // Drop the Rust-side exit marker from the live dump; we add our own.
            if (/^# exit /.test(line)) return;
            push(line);
          });
          push('# done');
          onCliLog?.({ title: `${title} · ok`, text: lines.join('\n') });
          onStatus?.(`Exported ${snap.outStem}.${snap.outExt} → ${snap.outDir}`);
          done({ ok: true, path: `${snap.outDir}\\${snap.outStem}.${snap.outExt}` });
        } catch (e) {
          const msg = e?.message || String(e);
          push(msg);
          onCliLog?.({ title: `${title} · failed`, text: lines.join('\n') });
          onStatus?.(`Export failed: ${msg}`);
          done({ ok: false, error: msg });
        }
        return;
      }

      const outPath = `${folder}\\${outStem}.wav`;
      const buffer = await backend.readFile(spec.sourcePath);
      const header = parseAudioHeader(buffer);
      const wav = header.sampleFormat === FMT_ATRAC3
        ? new Uint8Array(await backend.decodeVgmstream(spec.sourcePath))
        : toWav(buffer).wav;
      await backend.writeFile(outPath, wav);
      onStatus?.(`Exported ${outStem}.wav → ${folder}`);
      done({ ok: true, path: outPath });
      onClose();
    } catch (e) {
      const msg = e?.message ?? String(e);
      onStatus?.(`Export failed: ${msg}`);
      done({ ok: false, error: msg });
    } finally {
      setBusy(false);
    }
  };

  const style = pos
    ? { left: pos.x, top: pos.y, transform: 'none' }
    : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal export-modal" ref={panelRef} style={style}>
        <div className="modal-header" onPointerDown={startDrag} onPointerMove={onDrag} onPointerUp={endDrag}>
          <span className="icon">download</span>
          <Tooltip content={headTitle}>
            <span className="modal-title export-title">{headTitle}</span>
          </Tooltip>
          <Tooltip content="Close">
            <Button className="icon-btn modal-close" onClick={onClose}>
              <span className="icon">close</span>
            </Button>
          </Tooltip>
        </div>

        {spec.type === 'model' && (
          <div className="settings-tabs" role="tablist">
            {modeIds.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                className={`settings-tab${mode === id ? ' on' : ''}`}
                aria-selected={mode === id}
                onClick={() => switchMode(id)}
              >
                <span className="icon">{EXPORT_KINDS[id].tabIcon}</span>
                {EXPORT_KINDS[id].label}
              </button>
            ))}
          </div>
        )}

        <div className="modal-body">
          <div className="export-summary">
            <span className="icon export-glyph">{isXi ? kind.icon : spec.icon}</span>
            <div>
              <div className="export-name">{spec.title}</div>
              {spec.details && <div className="export-details mono">{spec.details}</div>}
            </div>
          </div>

          {sources && (
            <div className="form-row">
              <label className="form-label">Part</label>
              <Combo
                value={activePath}
                items={sources.map((s) => ({ id: s.path, label: s.label }))}
                onChange={setSourcePath}
                className="export-select"
              />
              <div className="form-hint mono export-srcpath">{activePath}</div>
            </div>
          )}

          <div className="export-outrow">
            <span className="icon">{isXi ? kind.icon : 'audio_file'}</span>
            <span>Exports to <strong>{outStem}.{outExt}</strong></span>
          </div>

          {needsXi && (
            <div className="export-warn">
              <span className="icon">info</span>
              <span>Export needs the <strong>xi-tools</strong> folder (Python 3.14). Set it in
                <em> File → Settings</em>.</span>
            </div>
          )}
          {needsGame && !needsXi && (
            <div className="export-warn">
              <span className="icon">info</span>
              <span>Export needs the <strong>Game path</strong> (FFXI_DIR for FFXiMain.dll). Set it in
                <em> File → Settings</em>.</span>
            </div>
          )}

          {isXi && (
            <>
              {isPose && (
                <div className="form-row">
                  <label className="form-label">Contents</label>
                  <Combo
                    value={allFrames ? 'anim' : 'frame'}
                    items={[
                      { id: 'frame', label: playingLabel ? `Frame ${frame} of ${playingLabel}` : 'Current pose' },
                      { id: 'anim', label: playingLabel ? `Whole ${playingLabel} animation` : 'Whole animation' },
                    ]}
                    onChange={(v) => setAllFrames(v === 'anim')}
                    className="export-select"
                  />
                  <div className="form-hint">
                    {allFrames
                      ? 'Every frame is embedded, so the export plays in a DCC.'
                      : 'The pose the viewport is showing, frozen into the mesh.'}
                  </div>
                </div>
              )}

              <div className="form-row">
                <label className="form-label">Output type</label>
                <Combo
                  value={format}
                  items={[
                    { id: 'glb', label: kindId === 'anim' ? 'glTF (.gltf + .bin)' : 'glTF (.glb)' },
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
                <ArgsInput type={catalog} tokens={args} onChange={setArgList}
                  dynamicValues={{ '--anim': (spec.animations ?? []).map((a) => ({ value: a.id })) }} />
                <textarea
                  className="args-preview mono"
                  readOnly
                  spellCheck={false}
                  rows={3}
                  value={previewArgs.map(shellQuote).join(' ')}
                  onFocus={(e) => e.target.select()}
                />
              </div>

              {((kindId === 'mesh' && animId) || (isPose && animFrames > 1)) && !allFrames && (
                <div className="export-frame-row">
                  <span className="export-frame-label mono">--frame</span>
                  <input type="range" min="0" max={Math.max(animFrames - 1, 0)} value={frame}
                    onChange={(e) => setFrame(+e.target.value)} className="vol-slider"
                    style={{ '--fill': `${animFrames > 1 ? (frame / (animFrames - 1)) * 100 : 0}%` }} />
                  <span className="mono export-frame-num">{frame}/{Math.max(animFrames - 1, 0)}</span>
                </div>
              )}
            </>
          )}

          <div className="form-row">
            <label className="form-label">Export folder ({isXi ? kind.label : spec.typeLabel})</label>
            <div className="form-inline">
              <input type="text" value={folder} spellCheck={false} placeholder="Choose a destination…"
                onChange={(e) => {
                  setFolder(e.target.value);
                  try { localStorage.setItem(folderKey(fkey), e.target.value); } catch { /* quota */ }
                }} />
              <Button onClick={browse}><span className="icon">folder_open</span>Browse</Button>
            </div>
          </div>
        </div>

        <div className="modal-actions">
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            className={`active export-go${busy ? ' busy' : ''}`}
            onClick={doExport}
            disabled={busy || !folder || needsXi || needsGame}
          >
            {busy
              ? <><span className="icon spin">progress_activity</span>Exporting…</>
              : <><span className="icon">download</span>Export</>}
          </Button>
        </div>
      </div>
    </div>
  );
}

function clamp(p, panel) {
  const w = panel?.offsetWidth ?? 460;
  const h = panel?.offsetHeight ?? 260;
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}
