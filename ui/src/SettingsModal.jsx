import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Field, Label } from '@headlessui/react';
import { backend } from '../js/backend.js';

/**
 * Draggable settings dialog. Dragged by its header and clamped so it can
 * never leave the viewport. Edits a draft; Save commits, Cancel discards.
 */
export function SettingsModal({ open, initial, onSave, onClose, error }) {
  const [draft, setDraft] = useState(initial);
  const [pos, setPos] = useState(null);           // null = centered
  const panelRef = useRef(null);
  const dragState = useRef(null);

  useEffect(() => {
    if (open) {
      setDraft(initial);
      setPos(null);
    }
  }, [open, initial]);

  // Keep the panel on screen when the window shrinks
  useEffect(() => {
    if (!open) return;
    const clampNow = () => setPos((p) => (p ? clamp(p, panelRef.current) : p));
    window.addEventListener('resize', clampNow);
    return () => window.removeEventListener('resize', clampNow);
  }, [open]);

  if (!open) return null;

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
    const picked = await backend.pickFolder(draft.gamePath);
    if (picked) setDraft({ ...draft, gamePath: picked });
  };

  const browseHd = async () => {
    const picked = await backend.pickFolder(draft.hdPath || draft.gamePath);
    if (picked) setDraft({ ...draft, hdPath: picked });
  };

  const browseXi = async () => {
    const picked = await backend.pickFile(draft.xiPath);
    if (picked) setDraft({ ...draft, xiPath: picked });
  };

  const style = pos
    ? { left: pos.x, top: pos.y, transform: 'none' }
    : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" ref={panelRef} style={style}>
        <div
          className="modal-header"
          onPointerDown={startDrag}
          onPointerMove={onDrag}
          onPointerUp={endDrag}
        >
          <span className="icon">settings</span>
          <span className="modal-title">Settings</span>
          <Button className="icon-btn modal-close" onClick={onClose} title="Close">
            <span className="icon">close</span>
          </Button>
        </div>

        <div className="modal-body">
          {error && (
            <div className="form-error" role="alert">
              <span className="icon">error</span>
              <span>{error}</span>
            </div>
          )}

          <div className="form-row">
            <label className="form-label">Game path</label>
            <div className="form-inline">
              <input
                type="text"
                value={draft.gamePath}
                spellCheck={false}
                onChange={(e) => setDraft({ ...draft, gamePath: e.target.value })}
              />
              <Button onClick={browse}>
                <span className="icon">folder_open</span>
                Browse
              </Button>
            </div>
          </div>

          <div className="form-row">
            <label className="form-label">HD path</label>
            <div className="form-inline">
              <input
                type="text"
                value={draft.hdPath ?? ''}
                spellCheck={false}
                placeholder="Optional HD pack / high-res install root"
                onChange={(e) => setDraft({ ...draft, hdPath: e.target.value })}
              />
              <Button onClick={browseHd}>
                <span className="icon">folder_open</span>
                Browse
              </Button>
            </div>
            <div className="form-hint">When HD is toggled on in the toolbar, files load from here first and fall back to the game path if missing.</div>
          </div>

          <div className="form-row">
            <label className="form-label">xi-tools CLI (for model export)</label>
            <div className="form-inline">
              <input
                type="text"
                value={draft.xiPath ?? ''}
                spellCheck={false}
                placeholder="Path to xi.exe — leave blank to disable model export"
                onChange={(e) => setDraft({ ...draft, xiPath: e.target.value })}
              />
              <Button onClick={browseXi}>
                <span className="icon">description</span>
                Browse
              </Button>
            </div>
            <div className="form-hint">Model (glTF/FBX) export shells out to the xi CLI. Music/SFX WAV export works without it.</div>
          </div>

          <div className="form-row">
            <Field className="check-field">
              <Checkbox
                checked={draft.autoPlay}
                onChange={(v) => setDraft({ ...draft, autoPlay: v })}
                className="checkbox"
              >
                <span className="icon check-icon">check</span>
              </Checkbox>
              <Label className="check-label">Auto-play idle animation on load</Label>
            </Field>
          </div>

          <div className="form-row">
            <Field className="check-field">
              <Checkbox
                checked={draft.autoWasdZones !== false}
                onChange={(v) => setDraft({ ...draft, autoWasdZones: v })}
                className="checkbox"
              >
                <span className="icon check-icon">check</span>
              </Checkbox>
              <Label className="check-label">Auto switch to WASD for Zones</Label>
            </Field>
            <div className="form-hint">When loading a zone, enable fly camera (WASD / QE / Shift boost / wheel speed).</div>
          </div>
        </div>

        <div className="modal-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button className="active" onClick={() => onSave(draft)}>Save</Button>
        </div>
      </div>
    </div>
  );
}

function clamp(p, panel) {
  const w = panel?.offsetWidth ?? 440;
  const h = panel?.offsetHeight ?? 280;
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}
