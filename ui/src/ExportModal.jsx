import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Field, Label } from '@headlessui/react';
import { backend } from '../js/backend.js';
import { Combo } from './Combo.jsx';
import { Tooltip } from './Tooltip.jsx';
import { parseAudioHeader, toWav, FMT_ATRAC3 } from '../js/audio.js';

const sanitize = (name) => name.replace(/[<>:"/\\|?*]+/g, '_').trim() || 'export';

/** Per-type export folders persist independently (music, sfx, model, zone, …). */
const folderKey = (type) => `exportFolder_${type}`;
const optsKey = (type) => `exportOpts_${type}`;

const DEFAULT_MODEL_OPTS = {
  format: 'glb', allParts: true, animEnabled: false, anim: '', frame: 0, weld: true, splitTex: false,
};

const DEFAULT_ZONE_OPTS = {
  format: 'glb', noSky: false, noVfx: false, objects: false, collision: false, useBase: false,
};

function loadOpts(type, defaults) {
  try {
    const raw = localStorage.getItem(optsKey(type));
    if (!raw) return { ...defaults };
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return { ...defaults };
    // Only keep known keys so stale fields don't linger.
    const out = { ...defaults };
    for (const k of Object.keys(defaults)) {
      if (!(k in saved)) continue;
      const v = saved[k];
      // Coerce JSON booleans/numbers; ignore wrong types.
      if (typeof defaults[k] === 'boolean') out[k] = !!v;
      else if (typeof defaults[k] === 'number') out[k] = Number(v) || 0;
      else if (typeof defaults[k] === 'string') out[k] = v == null ? defaults[k] : String(v);
      else out[k] = v;
    }
    return out;
  } catch {
    return { ...defaults };
  }
}

function saveOpts(type, opts) {
  try {
    // Strip per-session fields that shouldn't stick across models.
    const { anim: _a, frame: _f, ...rest } = opts;
    const payload = type === 'model'
      ? { ...rest, anim: opts.anim || '', frame: opts.frame || 0 }
      : { ...opts };
    localStorage.setItem(optsKey(type), JSON.stringify(payload));
  } catch { /* quota */ }
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
  const [modelOpts, setModelOpts] = useState(() => loadOpts('model', DEFAULT_MODEL_OPTS));
  const [zoneOpts, setZoneOpts] = useState(() => loadOpts('zone', DEFAULT_ZONE_OPTS));
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
    const m = loadOpts('model', DEFAULT_MODEL_OPTS);
    // Re-seed anim from the loaded model; frame stays if same clip still exists.
    const anims = spec.animations ?? [];
    const anim = anims.some((a) => a.id === m.anim) ? m.anim : (anims[0]?.id ?? '');
    setModelOpts({ ...m, anim, frame: anim === m.anim ? (Number(m.frame) || 0) : 0 });
    setZoneOpts(loadOpts('zone', DEFAULT_ZONE_OPTS));
    setPos(null);
    setBusy(false);
  }, [open, spec]);

  if (!open || !spec) return null;

  const isModel = spec.type === 'model';
  const isZone = spec.type === 'zone';
  const isXi = isModel || isZone;
  const needsXi = isXi && !spec.xiPath;
  const needsGame = isXi && !spec.gamePath;
  const setM = (patch) => setModelOpts((o) => {
    const next = { ...o, ...patch };
    saveOpts('model', next);
    return next;
  });
  const setZ = (patch) => setZoneOpts((o) => {
    const next = { ...o, ...patch };
    saveOpts('zone', next);
    return next;
  });
  const animFrames = spec.animations?.find((a) => a.id === modelOpts.anim)?.frames ?? 1;

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

  const format = isZone ? zoneOpts.format : modelOpts.format;
  const outExt = isXi ? (format === 'fbx' ? 'fbx' : 'glb') : 'wav';
  const outStem = isXi ? spec.datStem : sanitize(spec.outStem);

  const doExport = async () => {
    if (!folder) { onStatus?.('Choose an export folder first.'); return; }
    if (needsXi) { onStatus?.('Set the xi-tools folder in Settings first.'); return; }
    if (needsGame) { onStatus?.('Set the Game path in Settings first (FFXI_DIR).'); return; }
    setBusy(true);
    // Persist current toggles before closing (in case last click hadn't flushed).
    if (isModel) saveOpts('model', modelOpts);
    if (isZone) saveOpts('zone', zoneOpts);
    const env = xiEnvFromSpec(spec);
    // Snapshot before onClose unmounts this modal (xi path closes early).
    const snap = {
      xiPath: spec.xiPath,
      datStem: spec.datStem,
      sourcePath: spec.sourcePath,
      outExt,
      isZone,
      modelOpts: { ...modelOpts },
      zoneOpts: { ...zoneOpts },
    };
    try {
      if (isXi) {
        const xiArgs = snap.isZone
          ? buildZoneArgs(snap.sourcePath, folder, snap.zoneOpts)
          : buildModelArgs(snap.sourcePath, folder, snap.modelOpts);
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

          {isModel && (
            <>
              <div className="form-row">
                <label className="form-label">Output type</label>
                <Combo
                  value={modelOpts.format}
                  items={[
                    { id: 'glb', label: 'glTF (.glb)' },
                    { id: 'fbx', label: 'FBX (needs Blender)' },
                  ]}
                  onChange={(v) => setM({ format: v })}
                  className="export-select"
                />
              </div>

              <Toggle checked={modelOpts.allParts} onChange={(v) => setM({ allParts: v })}
                title="All parts" hint="Merge every mesh section into one model (multi-part gear)." />

              <Toggle checked={modelOpts.weld} onChange={(v) => setM({ weld: v })}
                title="Weld vertices" hint="Join sections by world position + UV (Noesis-style)." />

              <Toggle checked={modelOpts.splitTex} onChange={(v) => setM({ splitTex: v })}
                title="Split texture" hint="Un-mirror the skin into a stacked 2-up atlas; no overlapping UVs." />

              <div className="export-anim">
                <Toggle checked={modelOpts.animEnabled} onChange={(v) => setM({ animEnabled: v })}
                  title="Animation freeze frame" hint="Pose the mesh by an animation instead of bind pose." />
                {modelOpts.animEnabled && (
                  <div className="export-anim-controls">
                    <Combo
                      value={modelOpts.anim}
                      items={(spec.animations ?? []).map((a) => ({ id: a.id, label: a.id }))}
                      onChange={(v) => setM({ anim: v, frame: 0 })}
                      placeholder="— pick —"
                    />
                    <div className="export-frame">
                      <input type="range" min="0" max={Math.max(animFrames - 1, 0)} value={modelOpts.frame}
                        onChange={(e) => setM({ frame: +e.target.value })} className="vol-slider"
                        style={{ '--fill': `${animFrames > 1 ? (modelOpts.frame / (animFrames - 1)) * 100 : 0}%` }} />
                      <span className="mono export-frame-num">frame {modelOpts.frame}/{Math.max(animFrames - 1, 0)}</span>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {isZone && (
            <>
              <div className="form-row">
                <label className="form-label">Output type</label>
                <Combo
                  value={zoneOpts.format}
                  items={[
                    { id: 'glb', label: 'glTF (.glb)' },
                    { id: 'fbx', label: 'FBX (needs Blender)' },
                  ]}
                  onChange={(v) => setZ({ format: v })}
                  className="export-select"
                />
              </div>

              <Toggle checked={zoneOpts.noSky} onChange={(v) => setZ({ noSky: v })}
                title="Omit skybox" hint="Drop sun/moon/stars/clouds chunks (unplaced celestial)." />

              <Toggle checked={zoneOpts.noVfx} onChange={(v) => setZ({ noVfx: v })}
                title="Omit VFX / unplaced" hint="Drop effect-placed VFX and unreferenced meshes (water jets, glows, dead geo)." />

              <Toggle checked={zoneOpts.objects} onChange={(v) => setZ({ objects: v })}
                title="Per-object files" hint="One .glb per mesh into a _objects folder (local space), not one combined zone." />

              <Toggle checked={zoneOpts.collision} onChange={(v) => setZ({ collision: v })}
                title="Collision mesh" hint="Also dump the player-collision MZB as .collision.obj overlay." />

              <Toggle checked={zoneOpts.useBase} onChange={(v) => setZ({ useBase: v })}
                title="Pristine base" hint="Export from the original .base backup instead of the live/edited DAT." />
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

function buildModelArgs(datPath, folder, opts) {
  const args = ['mesh', 'export', datPath, '--output', folder];
  if (opts.format === 'fbx') args.push('--fbx');
  if (opts.allParts) args.push('--all-parts');
  args.push(opts.weld ? '--weld' : '--no-weld');
  if (opts.splitTex) args.push('--split-tex');
  if (opts.animEnabled && opts.anim) {
    args.push('--anim', opts.anim, '--frame', String(opts.frame));
  }
  return args;
}

function buildZoneArgs(datPath, folder, opts) {
  const args = ['zone', 'export', datPath, '--output', folder];
  if (opts.format === 'fbx') args.push('--fbx');
  if (opts.noSky) args.push('--no-sky');
  if (opts.noVfx) args.push('--no-vfx');
  if (opts.objects) args.push('--objects');
  if (opts.collision) args.push('--collision');
  if (opts.useBase) args.push('--base');
  return args;
}

function Toggle({ checked, onChange, title, hint }) {
  return (
    <Field className="export-toggle">
      <Checkbox checked={checked} onChange={onChange} className="checkbox">
        <span className="icon check-icon">check</span>
      </Checkbox>
      <div className="export-toggle-text">
        <Label className="export-toggle-title">{title}</Label>
        {hint && <div className="export-toggle-hint">{hint}</div>}
      </div>
    </Field>
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
