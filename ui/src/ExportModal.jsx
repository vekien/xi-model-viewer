import { useEffect, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { backend } from '../js/backend.js';
import { ArgsInput } from './ArgsInput.jsx';
import { Combo } from './Combo.jsx';
import { Tooltip } from './Tooltip.jsx';
import { parseAudioHeader, toWav, FMT_ATRAC3 } from '../js/audio.js';
import {
  EXPORT_COMMANDS, TYPE_TO_CATALOG, addToken, removeFlag, tokenValue, tokensToArgv,
} from './exportArgs.js';

const sanitize = (name) => name.replace(/[<>:"/\\|?*]+/g, '_').trim() || 'export';

/** Per-type export folders / formats / args persist independently. */
const folderKey = (type) => `exportFolder_${type}`;
const optsKey = (type) => `exportOpts_${type}`;
const argsKey = (type) => `exportArgs_${type}`;

/** Only the output container still lives outside the args box. */
const DEFAULT_FORMAT = 'glb';
const DEFAULT_ARGS = { model: ['--all-parts'], zone: [] };

function loadFormat(type) {
  try {
    const saved = JSON.parse(localStorage.getItem(optsKey(type)) || 'null');
    return saved?.format === 'fbx' ? 'fbx' : DEFAULT_FORMAT;
  } catch {
    return DEFAULT_FORMAT;
  }
}

function saveFormat(type, format) {
  try { localStorage.setItem(optsKey(type), JSON.stringify({ format })); } catch { /* quota */ }
}

/**
 * Args the dialog used to spell as checkboxes, recovered once from the old
 * `exportOpts_*` blob so an existing setup survives the switch to the args box.
 */
function migrateArgs(type) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(optsKey(type)) || 'null'); } catch { /* corrupt */ }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return [...(DEFAULT_ARGS[type] ?? [])];
  const out = [];
  if (type === 'model') {
    if (saved.allParts) out.push('--all-parts');
    if (saved.weld === false) out.push('--no-weld');
    if (saved.splitTex) out.push('--split-tex');
    if (saved.animEnabled && saved.anim) {
      out.push(`--anim ${saved.anim}`);
      out.push(`--frame ${Number(saved.frame) || 0}`);
    }
  } else {
    if (saved.noSky) out.push('--no-sky');
    if (saved.noVfx) out.push('--no-vfx');
    if (saved.objects) out.push('--objects');
    if (saved.collision) out.push('--collision');
    if (saved.useBase) out.push('--base');
  }
  return out;
}

function loadArgs(type) {
  try {
    const raw = localStorage.getItem(argsKey(type));
    if (raw == null) return migrateArgs(type);
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved)) return [...(DEFAULT_ARGS[type] ?? [])];
    return saved.map((t) => String(t).trim()).filter(Boolean);
  } catch {
    return [...(DEFAULT_ARGS[type] ?? [])];
  }
}

function saveArgs(type, args) {
  try { localStorage.setItem(argsKey(type), JSON.stringify(args)); } catch { /* quota */ }
}

function shellQuote(s) {
  const t = String(s ?? '');
  if (!/[ \t"&|<>^%!()]/.test(t)) return t;
  return `"${t.replace(/"/g, '\\"')}"`;
}

/** Env map xi needs so FFXI_DIR / pivot / HD resolve (Settings paths). */
function xiEnvFromSpec(spec) {
  const env = {};
  if (spec?.gamePath) env.FFXI_DIR = spec.gamePath;
  if (spec?.pivotPath) env.FFXI_PIVOT_DIR = spec.pivotPath;
  if (spec?.hdPath) env.FFXI_HD_DIR = spec.hdPath;
  return Object.keys(env).length ? env : null;
}

/**
 * File > Export dialog. Music/SFX export to WAV in-app; models/zones shell out
 * to `xi mesh|zone export` and dump the CLI log into the bottom console (same
 * path as DAT edits). Draggable and screen-clamped like SettingsModal.
 */
export function ExportModal({ open, spec, onClose, onStatus, onCliLog }) {
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [format, setFormat] = useState(DEFAULT_FORMAT);
  const [args, setArgs] = useState([]);
  const [pos, setPos] = useState(null);
  const panelRef = useRef(null);
  const dragState = useRef(null);
  // Only hydrate from disk when the dialog *opens* — not on every parent re-render
  // with a fresh `spec` object identity (that was wiping in-session ticks).
  const wasOpen = useRef(false);

  useEffect(() => {
    if (!open || !spec) {
      wasOpen.current = false;
      return;
    }
    const justOpened = !wasOpen.current;
    wasOpen.current = true;
    if (!justOpened) return;

    setFolder(localStorage.getItem(folderKey(spec.type)) || '');
    if (spec.type === 'model' || spec.type === 'zone') {
      setFormat(loadFormat(spec.type));
      // A saved --anim naming a clip this model doesn't have would fail the
      // export, so it (and the frame it indexes) is dropped on open.
      let next = loadArgs(spec.type);
      const anim = tokenValue(next, '--anim');
      if (anim != null && !(spec.animations ?? []).some((a) => a.id === anim)) {
        next = removeFlag(removeFlag(next, '--anim'), '--frame');
      }
      setArgs(next);
      // Pin the result now: the first format change rewrites exportOpts_*, and
      // with it the old checkbox blob the migration reads from.
      saveArgs(spec.type, next);
    }
    setPos(null);
    setBusy(false);
  }, [open, spec]);

  if (!open || !spec) return null;

  const isModel = spec.type === 'model';
  const isZone = spec.type === 'zone';
  const isXi = isModel || isZone;
  const needsXi = isXi && !spec.xiPath;
  const needsGame = isXi && !spec.gamePath;
  const catalog = TYPE_TO_CATALOG[spec.type];

  const setFmt = (v) => { setFormat(v); saveFormat(spec.type, v); };
  const setArgList = (next) => { setArgs(next); saveArgs(spec.type, next); };

  const animId = tokenValue(args, '--anim');
  const animFrames = spec.animations?.find((a) => a.id === animId)?.frames ?? 1;
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

  const browse = async () => {
    const picked = await backend.pickFolder(folder);
    if (picked) { setFolder(picked); localStorage.setItem(folderKey(spec.type), picked); }
  };

  const outExt = isXi ? (format === 'fbx' ? 'fbx' : 'glb') : 'wav';
  const outStem = isXi ? spec.datStem : sanitize(spec.outStem);
  const previewArgs = isXi ? buildXiArgs(catalog, spec.sourcePath, folder || '…', format, args) : null;

  const doExport = async () => {
    if (!folder) { onStatus?.('Choose an export folder first.'); return; }
    if (needsXi) { onStatus?.('Set the xi-tools folder in Settings first.'); return; }
    if (needsGame) { onStatus?.('Set the Game path in Settings first (FFXI_DIR).'); return; }
    setBusy(true);
    const env = xiEnvFromSpec(spec);
    // Snapshot before onClose unmounts this modal (xi path closes early).
    const snap = {
      xiPath: spec.xiPath,
      datStem: spec.datStem,
      sourcePath: spec.sourcePath,
      outExt,
      isZone,
    };
    try {
      if (isXi) {
        const xiArgs = buildXiArgs(catalog, snap.sourcePath, folder, format, args);
        const cmd = `xi ${xiArgs.map(shellQuote).join(' ')}`;
        const kind = snap.isZone ? 'zone' : 'mesh';
        const title = `xi ${kind} export · ${snap.datStem}`;
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
          onStatus?.(`Exported ${snap.datStem}.${snap.outExt} → ${folder}`);
        } catch (e) {
          const msg = e?.message || String(e);
          push(msg);
          onCliLog?.({ title: `${title} · failed`, text: lines.join('\n') });
          onStatus?.(`Export failed: ${msg}`);
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
      onClose();
    } catch (e) {
      onStatus?.(`Export failed: ${e.message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  const style = pos
    ? { left: pos.x, top: pos.y, transform: 'none' }
    : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" ref={panelRef} style={style}>
        <div className="modal-header" onPointerDown={startDrag} onPointerMove={onDrag} onPointerUp={endDrag}>
          <span className="icon">download</span>
          <span className="modal-title">Export {spec.typeLabel}</span>
          <Tooltip content="Close">
            <Button className="icon-btn modal-close" onClick={onClose}>
              <span className="icon">close</span>
            </Button>
          </Tooltip>
        </div>

        <div className="modal-body">
          <div className="export-summary">
            <span className="icon export-glyph">{spec.icon}</span>
            <div>
              <div className="export-name">{spec.title}</div>
              {spec.details && <div className="export-details mono">{spec.details}</div>}
            </div>
          </div>

          <div className="export-outrow">
            <span className="icon">{isXi ? (isZone ? 'map' : 'view_in_ar') : 'audio_file'}</span>
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
              <div className="form-row">
                <label className="form-label">Output type</label>
                <Combo
                  value={format}
                  items={[
                    { id: 'glb', label: 'glTF (.glb)' },
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
                  dynamicValues={isModel ? { '--anim': (spec.animations ?? []).map((a) => ({ value: a.id })) } : undefined} />
                <div className="args-preview mono">
                  {previewArgs.map(shellQuote).join(' ')}
                </div>
              </div>

              {isModel && animId && (
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
            <label className="form-label">Export folder ({spec.typeLabel})</label>
            <div className="form-inline">
              <input type="text" value={folder} spellCheck={false} placeholder="Choose a destination…"
                onChange={(e) => setFolder(e.target.value)} />
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

/**
 * `xi <cmd> <dat> --output <dir> [--fbx] <user args…>`. Anything the user typed
 * for a flag the dialog owns wins, so a hand-written `--output` isn't doubled.
 */
function buildXiArgs(catalog, datPath, folder, format, userArgs) {
  const argv = tokensToArgv(userArgs);
  const has = (flag) => argv.includes(flag);
  const args = [...EXPORT_COMMANDS[catalog], datPath];
  if (!has('--output')) args.push('--output', folder);
  if (format === 'fbx' && !has('--fbx')) args.push('--fbx');
  return [...args, ...argv];
}

function clamp(p, panel) {
  const w = panel?.offsetWidth ?? 460;
  const h = panel?.offsetHeight ?? 260;
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}
