import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Field, Label } from '@headlessui/react';
import { backend } from '../js/backend.js';
import { loadNotes, notesFilePath, revealNotesFile } from '../js/notes.js';

const UV_INSTALL_URL = 'https://docs.astral.sh/uv/getting-started/installation/';
const XI_README_HINT = 'https://github.com/vekien/xi-tools#getting-started';

/**
 * Draggable settings dialog. Two columns:
 *   left  — Game / HD / Pivot paths
 *   right — options + xi-tools setup
 */
export function SettingsModal({ open, initial, onSave, onClose, error }) {
  const [draft, setDraft] = useState(initial);
  const [pos, setPos] = useState(null);
  const [xiStatus, setXiStatus] = useState(null); // null | { busy, ok, status, message, detail, … }
  const [notesPath, setNotesPath] = useState('');
  const [notesErr, setNotesErr] = useState('');
  const panelRef = useRef(null);
  const dragState = useRef(null);
  const setupGen = useRef(0);

  useEffect(() => {
    if (open) {
      setDraft(initial);
      setPos(null);
      setXiStatus(null);
      setNotesErr('');
      loadNotes()
        .then(() => setNotesPath(notesFilePath() || ''))
        .catch(() => setNotesPath(''));
      if ((initial?.xiPath || '').trim()) {
        // Lightweight check on open (no install) so the badge is current.
        runXiSetup(initial.xiPath, false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial]);

  useEffect(() => {
    if (!open) return;
    const clampNow = () => setPos((p) => (p ? clamp(p, panelRef.current) : p));
    window.addEventListener('resize', clampNow);
    return () => window.removeEventListener('resize', clampNow);
  }, [open]);

  const runXiSetup = useCallback(async (folder, install) => {
    const path = (folder || '').trim();
    if (!path) {
      setXiStatus({
        busy: false,
        ok: false,
        status: 'missing_folder',
        message: 'Choose the xi-tools repo folder.',
        detail: '',
      });
      return null;
    }
    const gen = ++setupGen.current;
    setXiStatus((s) => ({
      ...(s || {}),
      busy: true,
      ok: false,
      status: 'working',
      message: install
        ? 'Checking / installing (uv, Python 3.14, deps)…'
        : 'Checking xi-tools…',
      detail: s?.detail || '',
    }));
    try {
      const report = await backend.xiSetup(path, install);
      if (gen !== setupGen.current) return null;
      setXiStatus({ busy: false, ...report });
      return report;
    } catch (e) {
      if (gen !== setupGen.current) return null;
      const msg = e?.message || String(e);
      setXiStatus({
        busy: false,
        ok: false,
        status: 'error',
        message: msg,
        detail: '',
      });
      return null;
    }
  }, []);

  if (!open) return null;

  const startDrag = (e) => {
    if (e.target.closest('button, input, a, [role="button"]')) return;
    const rect = panelRef.current.getBoundingClientRect();
    dragState.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDrag = (e) => {
    if (!dragState.current) return;
    setPos(clamp({
      x: e.clientX - dragState.current.dx,
      y: e.clientY - dragState.current.dy,
    }, panelRef.current));
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
  const browsePivot = async () => {
    const picked = await backend.pickFolder(draft.pivotPath || draft.hdPath || draft.gamePath);
    if (picked) setDraft({ ...draft, pivotPath: picked });
  };
  const browseXi = async () => {
    const picked = await backend.pickFolder(draft.xiPath || '');
    if (!picked) return;
    setDraft({ ...draft, xiPath: picked });
    await runXiSetup(picked, true);
  };

  const style = pos
    ? { left: pos.x, top: pos.y, transform: 'none' }
    : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };

  const badge = xiBadge(xiStatus);

  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal settings-modal" ref={panelRef} style={style}>
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

        <div className="modal-body settings-body">
          {error && (
            <div className="form-error settings-error" role="alert">
              <span className="icon">error</span>
              <span>{error}</span>
            </div>
          )}

          <div className="settings-cols">
            {/* —— Left: game trees —— */}
            <div className="settings-col">
              <div className="settings-col-title">Data paths</div>

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
                    placeholder="Optional HD pack root"
                    onChange={(e) => setDraft({ ...draft, hdPath: e.target.value })}
                  />
                  <Button onClick={browseHd}>
                    <span className="icon">folder_open</span>
                    Browse
                  </Button>
                </div>
              </div>

              <div className="form-row">
                <label className="form-label">Pivot path</label>
                <div className="form-inline">
                  <input
                    type="text"
                    value={draft.pivotPath ?? ''}
                    spellCheck={false}
                    placeholder="Ashita / override DAT root"
                    onChange={(e) => setDraft({ ...draft, pivotPath: e.target.value })}
                  />
                  <Button onClick={browsePivot}>
                    <span className="icon">folder_open</span>
                    Browse
                  </Button>
                </div>
              </div>

              <div className="settings-sep" role="separator" />

              <div className="settings-col-title">xi-tools</div>

              <div className="form-row">
                <label className="form-label">Folder</label>
                <div className="form-inline">
                  <input
                    type="text"
                    value={draft.xiPath ?? ''}
                    spellCheck={false}
                    placeholder="Path to xi-tools checkout"
                    onChange={(e) => {
                      setDraft({ ...draft, xiPath: e.target.value });
                      setXiStatus(null);
                    }}
                    onBlur={() => {
                      if ((draft.xiPath || '').trim()) runXiSetup(draft.xiPath, false);
                    }}
                  />
                  <Button onClick={browseXi} disabled={xiStatus?.busy}>
                    <span className="icon">folder_open</span>
                    Browse
                  </Button>
                </div>
              </div>

              <div className={`xi-status xi-status-compact${badge ? ` ${badge.cls}` : ''}${xiStatus?.busy ? ' busy' : ''}`}>
                <span className={`icon${xiStatus?.busy ? ' spin' : ''}`}>{badge?.icon || 'info'}</span>
                <span className="xi-status-msg">
                  {xiStatus?.message
                    || 'Link xi-tools for model export (Python 3.14 + uv).'}
                </span>
                <div className="xi-status-actions">
                  <Button
                    className="xi-action"
                    disabled={xiStatus?.busy || !(draft.xiPath || '').trim()}
                    onClick={() => runXiSetup(draft.xiPath, true)}
                    title="Check / Install"
                  >
                    <span className="icon">build</span>
                    {xiStatus?.busy ? '…' : 'Check'}
                  </Button>
                  {xiStatus?.status === 'missing_uv' && (
                    <Button className="xi-action" onClick={() => backend.openUrl(UV_INSTALL_URL)} title="Install uv">
                      <span className="icon">open_in_new</span>
                    </Button>
                  )}
                  <Button className="xi-action ghost" onClick={() => backend.openUrl(XI_README_HINT)} title="Setup guide">
                    <span className="icon">menu_book</span>
                  </Button>
                </div>
              </div>
              {xiStatus?.detail && xiStatus.status === 'error' && (
                <pre className="xi-status-detail mono">{xiStatus.detail.slice(0, 600)}</pre>
              )}

              <div className="form-row">
                <Field className="check-field">
                  <Checkbox
                    checked={draft.showXiConsole !== false}
                    onChange={(v) => setDraft({ ...draft, showXiConsole: v })}
                    className="checkbox"
                  >
                    <span className="icon check-icon">check</span>
                  </Checkbox>
                  <Label className="check-label">Show console output</Label>
                </Field>
              </div>

              <div className="form-row">
                <Field className="check-field">
                  <Checkbox
                    checked={!!draft.autoCloseXiConsole}
                    onChange={(v) => setDraft({ ...draft, autoCloseXiConsole: v })}
                    className="checkbox"
                    disabled={draft.showXiConsole === false}
                  >
                    <span className="icon check-icon">check</span>
                  </Checkbox>
                  <Label className="check-label">Auto-close console (10s)</Label>
                </Field>
              </div>
            </div>

            {/* —— Right: options —— */}
            <div className="settings-col">
              <div className="settings-col-title">Options</div>

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
                <div className="form-hint">Fly camera on zone load (WASD / QE / Shift / wheel).</div>
              </div>

              <div className="form-row">
                <Field className="check-field">
                  <Checkbox
                    checked={!!draft.closeDatNotesOnSave}
                    onChange={(v) => setDraft({ ...draft, closeDatNotesOnSave: v })}
                    className="checkbox"
                  >
                    <span className="icon check-icon">check</span>
                  </Checkbox>
                  <Label className="check-label">Close DAT Notes on Save</Label>
                </Field>
                <div className="form-hint">Only the whole-DAT Notes window (status bar), not UiMenu notes.</div>
              </div>

              <div className="form-row">
                <label className="form-label">Notes file</label>
                <div className="form-inline">
                  <input
                    type="text"
                    readOnly
                    className="mono"
                    value={notesPath || '%LOCALAPPDATA%\\XiModelViewer\\notes.json'}
                    spellCheck={false}
                  />
                  <Button
                    onClick={async () => {
                      setNotesErr('');
                      try {
                        await revealNotesFile();
                        setNotesPath(notesFilePath() || notesPath);
                      } catch (e) {
                        setNotesErr(e?.message || String(e));
                      }
                    }}
                  >
                    <span className="icon">folder_open</span>
                    Open file
                  </Button>
                </div>
                <div className="form-hint">
                  Shared notes for DATs, UiMenus, and UiElementGroups.
                  {notesErr ? ` ${notesErr}` : ''}
                </div>
              </div>
            </div>
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

function xiBadge(s) {
  if (!s) return { cls: 'neutral', icon: 'info' };
  if (s.busy) return { cls: 'working', icon: 'progress_activity' };
  if (s.ok) return { cls: 'ok', icon: 'check_circle' };
  if (s.status === 'missing_uv' || s.status === 'missing_folder') {
    return { cls: 'warn', icon: 'warning' };
  }
  return { cls: 'err', icon: 'error' };
}

function clamp(p, panel) {
  const w = panel?.offsetWidth ?? 720;
  const h = panel?.offsetHeight ?? 420;
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}
