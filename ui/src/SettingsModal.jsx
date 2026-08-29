import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Field, Label } from '@headlessui/react';
import { backend } from '../js/backend.js';
import { loadNotes, notesFilePath, revealNotesFile } from '../js/notes.js';
import { Tooltip } from './Tooltip.jsx';

const UV_INSTALL_URL = 'https://docs.astral.sh/uv/getting-started/installation/';
const XI_README_HINT = 'https://github.com/vekien/xi-tools#getting-started';

/**
 * Draggable settings dialog.
 * Tabs: General (paths + options) · XI Tools (install / update / local path).
 */
export function SettingsModal({ open, initial, onSave, onClose, error }) {
  const [draft, setDraft] = useState(initial);
  const [tab, setTab] = useState('general');
  const [pos, setPos] = useState(null);
  const [xiStatus, setXiStatus] = useState(null); // uv/setup badge
  const [tools, setTools] = useState(null);       // ToolsStatus from Rust
  const [toolsBusy, setToolsBusy] = useState(false);
  const [toolsMsg, setToolsMsg] = useState(''); // managed install status only
  const [localMsg, setLocalMsg] = useState(''); // local checkout info (ok / neutral)
  const [localErr, setLocalErr] = useState(''); // local checkout error (red)
  const [toolsProgress, setToolsProgress] = useState(null); // { label, pct, detail }
  const [toolsLog, setToolsLog] = useState('');
  const [localPathDraft, setLocalPathDraft] = useState('');
  const [notesPath, setNotesPath] = useState('');
  const [notesErr, setNotesErr] = useState('');
  const panelRef = useRef(null);
  const dragState = useRef(null);
  const setupGen = useRef(0);
  const unlistenRef = useRef([]);

  const detachProgress = useCallback(() => {
    for (const u of unlistenRef.current) {
      try { u(); } catch { /* */ }
    }
    unlistenRef.current = [];
  }, []);

  const attachProgress = useCallback(async () => {
    detachProgress();
    try {
      unlistenRef.current = [
        await backend.onToolsProgress((p) => {
          setToolsProgress({
            label: p.label || '',
            pct: Number.isFinite(p.pct) ? p.pct : 0,
            detail: formatProgressDetail(p),
          });
          if (p.label) setToolsMsg(p.label);
        }),
        await backend.onToolsLog((line) => {
          setToolsLog((prev) => {
            const next = prev ? `${prev}\n${line}` : line;
            return next.length > 4000 ? next.slice(-3500) : next;
          });
        }),
      ];
    } catch { /* browser */ }
  }, [detachProgress]);

  const refreshTools = useCallback(async () => {
    try {
      const st = await backend.toolsStatus();
      setTools(st);
      // Only prefill the local field when an override is active — not the managed path.
      setLocalPathDraft(st.usingLocalOverride ? (st.toolsDir || '') : '');
      if (st.usingLocalOverride) {
        setToolsMsg('Managed install idle — local checkout is active.');
        setLocalMsg(`Active · v${st.localVersion || '—'}`);
        setLocalErr('');
      } else {
        setLocalMsg('');
        if (st.error && !st.installed) setToolsMsg(st.error);
        else if (st.installed) {
          const latest = st.latestVersion ? ` · latest ${st.latestVersion}` : '';
          const upd = st.updateAvailable ? ' · update available' : '';
          setToolsMsg(`Installed v${st.localVersion}${latest}${upd}`);
        } else {
          setToolsMsg('Not installed — click Install to download from GitHub.');
        }
      }
      return st;
    } catch (e) {
      setToolsMsg(e?.message || String(e));
      return null;
    }
  }, []);

  const runXiSetup = useCallback(async (folder, install) => {
    const path = (folder || '').trim();
    if (!path) {
      setXiStatus({
        busy: false,
        ok: false,
        status: 'missing_folder',
        message: 'Choose the xi-tools folder.',
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

  // Reset draft/tab/position only when the modal *opens* — not on every parent
  // re-render. App passes a fresh `initial={{...}}` each frame (FPS, etc.), and
  // depending on that object identity was snapping the panel back to General
  // and clearing drag position while the user was still in it.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      detachProgress();
      return undefined;
    }
    const justOpened = !wasOpen.current;
    wasOpen.current = true;
    if (!justOpened) return undefined;

    setDraft(initial);
    setPos(null);
    setTab('general');
    setXiStatus(null);
    setTools(null);
    setToolsBusy(false);
    setToolsMsg('');
    setLocalMsg('');
    setLocalErr('');
    setToolsProgress(null);
    setToolsLog('');
    setNotesErr('');
    loadNotes()
      .then(() => setNotesPath(notesFilePath() || ''))
      .catch(() => setNotesPath(''));
    refreshTools().then((st) => {
      const path = (initial?.xiPath || st?.toolsDir || '').trim();
      if (path) runXiSetup(path, false);
    });
    return () => detachProgress();
    // intentionally omit `initial` — snapshot only on open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, detachProgress, refreshTools, runXiSetup]);

  useEffect(() => {
    if (!open) return undefined;
    const clampNow = () => setPos((p) => (p ? clamp(p, panelRef.current) : p));
    window.addEventListener('resize', clampNow);
    return () => window.removeEventListener('resize', clampNow);
  }, [open]);

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

  const doInstallOrUpdate = async () => {
    setToolsBusy(true);
    setLocalErr('');
    setToolsLog('');
    setToolsProgress({ label: 'Starting…', pct: 0, detail: '' });
    setToolsMsg('Installing / updating xi-tools…');
    await attachProgress();
    try {
      const st = await backend.toolsInstallOrUpdate();
      setTools(st);
      setDraft((d) => ({ ...d, xiPath: st.toolsDir || d.xiPath }));
      setToolsMsg(st.installed
        ? `Installed v${st.localVersion}`
        : (st.error || 'Install finished with issues'));
      if (st.toolsDir) await runXiSetup(st.toolsDir, true);
      await refreshTools();
    } catch (e) {
      setToolsMsg(e?.message || String(e));
    } finally {
      detachProgress();
      setToolsBusy(false);
      setToolsProgress(null);
    }
  };

  const doCheckReleases = async () => {
    setToolsBusy(true);
    setToolsMsg('Checking GitHub for releases…');
    try {
      const st = await refreshTools();
      if (st?.updateAvailable) {
        setToolsMsg(`Update available: v${st.localVersion} → v${st.latestVersion}`);
      } else if (st?.installed) {
        setToolsMsg(`Up to date (v${st.localVersion})`);
      }
    } finally {
      setToolsBusy(false);
    }
  };

  const browseLocalTools = async () => {
    setLocalErr('');
    const picked = await backend.pickToolsFolder(localPathDraft || draft.xiPath || '');
    if (picked) setLocalPathDraft(picked);
  };

  const applyLocalTools = async () => {
    const path = localPathDraft.trim();
    if (!path) {
      setLocalMsg('');
      setLocalErr('Choose a folder first.');
      return;
    }
    setToolsBusy(true);
    setLocalErr('');
    setLocalMsg('Validating…');
    try {
      const st = await backend.toolsSetLocalPath(path);
      setTools(st);
      setDraft((d) => ({ ...d, xiPath: st.toolsDir }));
      setLocalPathDraft(st.toolsDir);
      setToolsMsg('Managed install idle — local checkout is active.');
      setLocalMsg(`Active · v${st.localVersion || '—'}`);
      await runXiSetup(st.toolsDir, true);
    } catch (e) {
      setLocalMsg('');
      setLocalErr(friendlyLocalErr(e?.message || String(e), path));
    } finally {
      setToolsBusy(false);
    }
  };

  const clearLocalTools = async () => {
    setToolsBusy(true);
    setLocalErr('');
    setLocalMsg('');
    try {
      const st = await backend.toolsClearLocalPath();
      setTools(st);
      setLocalPathDraft('');
      setDraft((d) => ({ ...d, xiPath: st.toolsDir || '' }));
      setToolsMsg(st.installed
        ? `Using downloaded release (v${st.localVersion})`
        : 'Override cleared — install a release when ready.');
      if (st.toolsDir && st.installed) await runXiSetup(st.toolsDir, false);
    } catch (e) {
      setLocalErr(e?.message || String(e));
    } finally {
      setToolsBusy(false);
    }
  };

  const style = pos
    ? { left: pos.x, top: pos.y, transform: 'none' }
    : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };

  const badge = xiBadge(xiStatus);
  const toolsBadge = toolsUiBadge(tools, toolsBusy);

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
          <Tooltip content="Close">
            <Button className="icon-btn modal-close" onClick={onClose}>
              <span className="icon">close</span>
            </Button>
          </Tooltip>
        </div>

        <div className="settings-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            className={`settings-tab${tab === 'general' ? ' on' : ''}`}
            aria-selected={tab === 'general'}
            onClick={() => setTab('general')}
          >
            <span className="icon">tune</span>
            General
          </button>
          <button
            type="button"
            role="tab"
            className={`settings-tab${tab === 'xitools' ? ' on' : ''}`}
            aria-selected={tab === 'xitools'}
            onClick={() => setTab('xitools')}
          >
            <span className="icon">terminal</span>
            XI Tools
          </button>
        </div>

        <div className="modal-body settings-body">
          {error && (
            <div className="form-error settings-error" role="alert">
              <span className="icon">error</span>
              <span>{error}</span>
            </div>
          )}

          {tab === 'general' && (
            <div className="settings-cols">
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
              </div>

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
          )}

          {tab === 'xitools' && (
            <div className="settings-xitools">
              <div className="settings-col-title">Managed install</div>
              <div className="form-hint" style={{ marginTop: -6 }}>
                Downloads from github.com/vekien/xi-tools into %LOCALAPPDATA%\XiModelViewer\xi-tools.
                On launch the app installs or updates automatically unless you use a local checkout.
              </div>

              <div className={`xi-status${toolsBadge ? ` ${toolsBadge.cls}` : ''}${toolsBusy ? ' busy' : ''}`}>
                <span className={`icon${toolsBusy ? ' spin' : ''}`}>{toolsBadge?.icon || 'info'}</span>
                <span className="xi-status-msg">{toolsMsg || 'Checking…'}</span>
              </div>

              {toolsProgress && (
                <div className="tools-progress">
                  <div className="tools-progress-bar">
                    <div className="tools-progress-fill" style={{ width: `${Math.min(100, toolsProgress.pct || 0)}%` }} />
                  </div>
                  <div className="tools-progress-meta mono">
                    {toolsProgress.detail || toolsProgress.label}
                  </div>
                </div>
              )}

              <div className="form-inline tools-actions">
                <Button className="active" disabled={toolsBusy} onClick={doInstallOrUpdate}>
                  <span className="icon">download</span>
                  {tools?.updateAvailable ? 'Update' : 'Install / Update'}
                </Button>
                <Button disabled={toolsBusy} onClick={doCheckReleases}>
                  <span className="icon">travel_explore</span>
                  Check for updates
                </Button>
                <Tooltip content="Setup guide">
                  <Button className="icon-btn" onClick={() => backend.openUrl(XI_README_HINT)}>
                    <span className="icon">menu_book</span>
                  </Button>
                </Tooltip>
              </div>

              {toolsLog && (
                <pre className="xi-status-detail mono tools-log">{toolsLog}</pre>
              )}

              <div className="settings-sep" role="separator" />

              <div className="settings-col-title">Local checkout (optional)</div>
              <div className="form-hint" style={{ marginTop: -6 }}>
                Point at a clone of xi-tools to skip the managed download. Must contain src\xi.
              </div>

              <div className="form-row">
                <label className="form-label">Folder</label>
                <div className="form-inline">
                  <input
                    type="text"
                    value={localPathDraft}
                    spellCheck={false}
                    placeholder="e.g. D:\xi-tools"
                    disabled={toolsBusy}
                    onChange={(e) => {
                      setLocalPathDraft(e.target.value);
                      if (localErr) setLocalErr('');
                    }}
                  />
                  <Button disabled={toolsBusy} onClick={browseLocalTools}>
                    <span className="icon">folder_open</span>
                    Browse
                  </Button>
                </div>
              </div>

              <div className="form-inline tools-actions">
                <Button disabled={toolsBusy} onClick={applyLocalTools}>
                  Use this folder
                </Button>
                <Button disabled={toolsBusy || !tools?.usingLocalOverride} onClick={clearLocalTools}>
                  Use downloaded release
                </Button>
              </div>

              {localErr && (
                <div className="form-error settings-local-err" role="alert">
                  <span className="icon">error</span>
                  <span>{localErr}</span>
                </div>
              )}
              {!localErr && localMsg && (
                <div className={`xi-status settings-local-ok${tools?.usingLocalOverride ? ' ok' : ''}`}>
                  <span className="icon">{tools?.usingLocalOverride ? 'check_circle' : 'info'}</span>
                  <span className="xi-status-msg">{localMsg}</span>
                </div>
              )}

              <div className="settings-sep" role="separator" />

              <div className="settings-col-title">CLI environment</div>
              <div className={`xi-status xi-status-compact${badge ? ` ${badge.cls}` : ''}${xiStatus?.busy ? ' busy' : ''}`}>
                <span className={`icon${xiStatus?.busy ? ' spin' : ''}`}>{badge?.icon || 'info'}</span>
                <span className="xi-status-msg">
                  {xiStatus?.message
                    || 'Python 3.14 + uv venv used for mesh export and list updates.'}
                </span>
                <div className="xi-status-actions">
                  <Tooltip content="uv sync / check">
                    <Button
                      className="xi-action"
                      disabled={xiStatus?.busy || toolsBusy || !(draft.xiPath || tools?.toolsDir || '').trim()}
                      onClick={() => runXiSetup(draft.xiPath || tools?.toolsDir, true)}
                    >
                      <span className="icon">build</span>
                      {xiStatus?.busy ? '…' : 'Setup'}
                    </Button>
                  </Tooltip>
                  {xiStatus?.status === 'missing_uv' && (
                    <Tooltip content="Install uv">
                      <Button className="xi-action" onClick={() => backend.openUrl(UV_INSTALL_URL)}>
                        <span className="icon">open_in_new</span>
                      </Button>
                    </Tooltip>
                  )}
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
          )}
        </div>

        <div className="modal-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button className="active" onClick={() => onSave({
            ...draft,
            // Prefer the active tools dir when the field is empty
            xiPath: (draft.xiPath || tools?.toolsDir || '').trim(),
          })}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Make Rust path errors readable under Local checkout. */
function friendlyLocalErr(raw, path) {
  const msg = String(raw || '').trim();
  if (!msg) return 'That folder could not be used.';
  if (/^Not a folder:/i.test(msg)) {
    return `Folder not found:\n${path || msg.replace(/^Not a folder:\s*/i, '')}\nBrowse to your xi-tools clone (must contain src\\xi).`;
  }
  if (/doesn't look like an xi-tools/i.test(msg) || /Expected:/i.test(msg)) {
    return msg;
  }
  return msg;
}

function formatProgressDetail(p) {
  const unit = p.unit || 'bytes';
  const loaded = Number(p.loaded) || 0;
  const total = p.total == null ? null : Number(p.total);
  const pct = Number(p.pct);
  if (unit === 'bytes' && (loaded > 0 || total > 0)) {
    if (total > 0) return `${fmtBytes(loaded)} / ${fmtBytes(total)}  ·  ${Math.round(pct)}%`;
    return `${fmtBytes(loaded)} downloaded`;
  }
  if (unit === 'files' && total > 0) {
    return `${loaded} / ${total} files  ·  ${Math.round(pct)}%`;
  }
  if (p.detail) return p.detail;
  return Number.isFinite(pct) && pct > 0 ? `${Math.round(pct)}%` : '';
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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

function toolsUiBadge(st, busy) {
  if (busy) return { cls: 'working', icon: 'progress_activity' };
  if (!st) return { cls: 'neutral', icon: 'info' };
  // Local checkout owns the active path — managed row stays neutral.
  if (st.usingLocalOverride) return { cls: 'neutral', icon: 'pause_circle' };
  if (st.error && !st.installed) return { cls: 'err', icon: 'error' };
  if (st.updateAvailable) return { cls: 'warn', icon: 'upgrade' };
  if (st.installed) return { cls: 'ok', icon: 'check_circle' };
  return { cls: 'warn', icon: 'download' };
}

function clamp(p, panel) {
  const w = panel?.offsetWidth ?? 720;
  const h = panel?.offsetHeight ?? 420;
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}
