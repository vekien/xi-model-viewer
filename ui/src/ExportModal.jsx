import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Field, Label } from '@headlessui/react';
import { backend } from '../js/backend.js';
import { Combo } from './Combo.jsx';
import { parseAudioHeader, toWav, FMT_ATRAC3 } from '../js/audio.js';

const sanitize = (name) => name.replace(/[<>:"/\\|?*]+/g, '_').trim() || 'export';

/** Per-type export folders persist independently (music, sfx, model, …). */
const folderKey = (type) => `exportFolder_${type}`;

const DEFAULT_MODEL_OPTS = {
  format: 'glb', allParts: true, animEnabled: false, anim: '', frame: 0, weld: true, splitTex: false,
};

/**
 * File > Export dialog. Music/SFX export to WAV in-app; models shell out to
 * `xi mesh export` with the chosen options (glTF/FBX, parts, pose, weld, …).
 * Draggable and screen-clamped like SettingsModal.
 */
export function ExportModal({ open, spec, onClose, onStatus }) {
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [opts, setOpts] = useState(DEFAULT_MODEL_OPTS);
  const [pos, setPos] = useState(null);
  const panelRef = useRef(null);
  const dragState = useRef(null);

  useEffect(() => {
    if (open && spec) {
      setFolder(localStorage.getItem(folderKey(spec.type)) || '');
      setOpts({ ...DEFAULT_MODEL_OPTS, anim: spec.animations?.[0]?.id ?? '' });
      setPos(null);
      setBusy(false);
    }
  }, [open, spec]);

  if (!open || !spec) return null;

  const isModel = spec.type === 'model';
  const needsXi = isModel && !spec.xiPath;   // model export requires the xi CLI
  const set = (patch) => setOpts((o) => ({ ...o, ...patch }));
  const animFrames = spec.animations?.find((a) => a.id === opts.anim)?.frames ?? 1;

  const startDrag = (e) => {
    // Don't start a drag from header controls (e.g. the close button) — capturing
    // the pointer here would swallow their click event.
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

  const outExt = isModel ? (opts.format === 'fbx' ? 'fbx' : 'glb') : 'wav';
  const outStem = isModel ? spec.datStem : sanitize(spec.outStem);

  const doExport = async () => {
    if (!folder) { onStatus?.('Choose an export folder first.'); return; }
    setBusy(true);
    try {
      if (isModel) {
        const args = [];
        if (opts.format === 'fbx') args.push('--fbx');
        if (opts.allParts) args.push('--all-parts');
        args.push(opts.weld ? '--weld' : '--no-weld');
        if (opts.splitTex) args.push('--split-tex');
        if (opts.animEnabled && opts.anim) { args.push('--anim', opts.anim, '--frame', String(opts.frame)); }
        const out = await backend.xiMeshExport(spec.sourcePath, folder, args, spec.xiPath);
        onStatus?.(`Exported ${spec.datStem}.${outExt} → ${folder}`);
        console.log('[xi mesh export]', out);
        onClose();
      } else {
        const outPath = `${folder}\\${outStem}.wav`;
        const buffer = await backend.readFile(spec.sourcePath);
        const header = parseAudioHeader(buffer);
        const wav = header.sampleFormat === FMT_ATRAC3
          ? new Uint8Array(await backend.decodeVgmstream(spec.sourcePath))
          : toWav(buffer).wav;
        await backend.writeFile(outPath, wav);
        onStatus?.(`Exported ${outStem}.wav → ${folder}`);
        onClose();
      }
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
          <Button className="icon-btn modal-close" onClick={onClose} title="Close">
            <span className="icon">close</span>
          </Button>
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
            <span className="icon">{isModel ? 'view_in_ar' : 'audio_file'}</span>
            <span>Exports to <strong>{outStem}.{outExt}</strong></span>
          </div>

          {needsXi && (
            <div className="export-warn">
              <span className="icon">info</span>
              <span>Model export needs the <strong>xi-tools</strong> CLI. Set its path in
                <em> File → Settings</em> to enable it.</span>
            </div>
          )}

          {isModel && (
            <>
              <div className="form-row">
                <label className="form-label">Output type</label>
                <Combo
                  value={opts.format}
                  items={[
                    { id: 'glb', label: 'glTF (.glb)' },
                    { id: 'fbx', label: 'FBX (needs Blender)' },
                  ]}
                  onChange={(v) => set({ format: v })}
                  className="export-select"
                />
              </div>

              <Toggle checked={opts.allParts} onChange={(v) => set({ allParts: v })}
                title="All parts" hint="Merge every mesh section into one model (multi-part gear)." />

              <Toggle checked={opts.weld} onChange={(v) => set({ weld: v })}
                title="Weld vertices" hint="Join sections by world position + UV (Noesis-style)." />

              <Toggle checked={opts.splitTex} onChange={(v) => set({ splitTex: v })}
                title="Split texture" hint="Un-mirror the skin into a stacked 2-up atlas; no overlapping UVs." />

              <div className="export-anim">
                <Toggle checked={opts.animEnabled} onChange={(v) => set({ animEnabled: v })}
                  title="Animation freeze frame" hint="Pose the mesh by an animation instead of bind pose." />
                {opts.animEnabled && (
                  <div className="export-anim-controls">
                    <Combo
                      value={opts.anim}
                      items={(spec.animations ?? []).map((a) => ({ id: a.id, label: a.id }))}
                      onChange={(v) => set({ anim: v, frame: 0 })}
                      placeholder="— pick —"
                    />
                    <div className="export-frame">
                      <input type="range" min="0" max={Math.max(animFrames - 1, 0)} value={opts.frame}
                        onChange={(e) => set({ frame: +e.target.value })} className="vol-slider"
                        style={{ '--fill': `${animFrames > 1 ? (opts.frame / (animFrames - 1)) * 100 : 0}%` }} />
                      <span className="mono export-frame-num">frame {opts.frame}/{Math.max(animFrames - 1, 0)}</span>
                    </div>
                  </div>
                )}
              </div>
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
          <Button className={`active export-go${busy ? ' busy' : ''}`} onClick={doExport} disabled={busy || !folder || needsXi}>
            {busy
              ? <><span className="icon spin">progress_activity</span>Exporting…</>
              : <><span className="icon">download</span>Export</>}
          </Button>
        </div>
      </div>
    </div>
  );
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
