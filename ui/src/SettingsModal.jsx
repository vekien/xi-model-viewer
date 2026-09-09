import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Field, Label } from '@headlessui/react';
import { backend } from '../js/backend.js';
import { clampUiScale, sliderToUiScale, uiScaleToSlider } from '../js/uiScale.js';
import { loadNotes, notesFilePath, revealNotesFile } from '../js/notes.js';
import { Combo } from './Combo.jsx';
import { Tooltip } from './Tooltip.jsx';

const UV_INSTALL_URL = 'https://docs.astral.sh/uv/getting-started/installation/';
const XI_README_HINT = 'https://github.com/vekien/xi-tools#getting-started';

// What each list is for, in the user's terms. Keyed by filename because that is
// what the manifest names; anything not listed here still shows, unlabelled, so
// a list added upstream appears the day it ships rather than the day this map
// catches up.
const LIST_BLURBS = {
  'characters.json': 'Races, faces, gear and the animation catalogue',
  'npcs.json': 'NPC and monster models',
  'zone_npcs.json': 'Where each NPC stands, per zone',
  'zones.json': 'Every zone, by name and DAT',
  'effects.json': 'Spell and ability VFX',
  'images.json': 'Maps, UI art and cutscene stills',
  'music.json': 'Music track names',
  'sfx.json': 'Sound-effect folders and titles',
  'zone_music.json': 'Which BGM each zone plays',
  'floors.json': 'Ground textures for Scenes',
};

const LISTS_SOURCE_URL = 'https://github.com/vekien/xi-tools/tree/main/mv/lists';

const TOOLS_MODE_ITEMS = [
  { id: 'managed', label: 'Self-managed install' },
  { id: 'custom', label: 'Custom install' },
];

/**
 * Draggable settings dialog.
 * Tabs: General (paths + options) · XI Tools (install / update / local path).
 *
 * `initialTab` is how the rest of the app sends someone straight to the tab
 * that fixes their problem — Export with no xi-tools opens on 'xitools'.
 */
export function SettingsModal({
  open, initial, onSave, onClose, error, initialTab = 'general', onGamePathValid,
}) {
  const [draft, setDraft] = useState(initial);
  const [tab, setTab] = useState(initialTab);
  const [pos, setPos] = useState(null);
  const [xiStatus, setXiStatus] = useState(null); // uv/setup badge (custom verify)
  const [tools, setTools] = useState(null);       // ToolsStatus from Rust
  const [toolsBusy, setToolsBusy] = useState(false);
  const [toolsMsg, setToolsMsg] = useState('');
  const [toolsErr, setToolsErr] = useState('');
  const [toolsProgress, setToolsProgress] = useState(null); // { label, pct, detail }
  const [toolsLog, setToolsLog] = useState('');
  const [localPathDraft, setLocalPathDraft] = useState('');
  // 'managed' = AppData + GitHub releases; 'custom' = user checkout path
  const [toolsMode, setToolsMode] = useState('managed');
  const [notesPath, setNotesPath] = useState('');
  const [notesErr, setNotesErr] = useState('');
  const [gameCheck, setGameCheck] = useState(null);  // { state, message }
  const [lists, setLists] = useState(null);       // ListsStatus from Rust
  const [listsBusy, setListsBusy] = useState(false);
  const [listsMsg, setListsMsg] = useState('');
  const [listsErr, setListsErr] = useState('');
  const panelRef = useRef(null);
  const dragState = useRef(null);
  const setupGen = useRef(0);
  const unlistenRef = useRef([]);

  // Slider previews live; Cancel/backdrop/× put the saved scale back.
  const cancel = useCallback(() => {
    backend.setUiScale(clampUiScale(initial?.uiScale));
    onClose();
  }, [initial?.uiScale, onClose]);

  /** Disk-only list status. Never throws — an unreachable backend just shows nothing. */
  const refreshLists = useCallback(async () => {
    try {
      const st = await backend.listsStatus();
      setLists(st);
      return st;
    } catch (e) {
      setListsErr(String(e?.message || e));
      return null;
    }
  }, []);

  /**
   * The one network action on this tab: fetch xi-tools' manifest and pull
   * whatever no longer matches. Reports "up to date" rather than silence, so a
   * deliberate press always gets an answer.
   */
  const doUpdateLists = useCallback(async () => {
    setListsBusy(true);
    setListsErr('');
    setListsMsg('Checking xi-tools…');
    try {
      const res = await backend.listsUpdate();
      await refreshLists();
      const n = res?.updated?.length ?? 0;
      if (res?.error) setListsErr(res.error);
      if (n) {
        const mb = (res.bytes || 0) / (1024 * 1024);
        setListsMsg(`Updated ${n} list${n === 1 ? '' : 's'} (${mb.toFixed(1)} MB). `
          + 'Reload the app to use them.');
      } else if (!res?.error) {
        setListsMsg('Already up to date.');
      } else {
        setListsMsg('');
      }
    } catch (e) {
      setListsMsg('');
      setListsErr(String(e?.message || e));
    } finally {
      setListsBusy(false);
    }
  }, [refreshLists]);

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
      const custom = !!st.usingLocalOverride;
      setToolsMode(custom ? 'custom' : 'managed');
      setLocalPathDraft(custom ? (st.toolsDir || '') : '');
      setToolsErr('');
      if (custom) {
        setToolsMsg(st.toolsDir
          ? `Custom path · ${st.toolsDir}`
          : 'Choose your xi-tools folder.');
      } else if (st.error && !st.installed) {
        setToolsMsg(st.error);
      } else if (st.installed) {
        const latest = st.latestVersion ? ` · latest ${st.latestVersion}` : '';
        const upd = st.updateAvailable ? ' · update available' : ' · up to date';
        setToolsMsg(`v${st.localVersion}${latest}${upd}`);
      } else {
        setToolsMsg('Not installed yet — click Install / Update to download the latest release.');
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
    setTab(initialTab || 'general');
    setGameCheck(null);
    setXiStatus(null);
    setTools(null);
    setToolsBusy(false);
    setToolsMsg('');
    setToolsErr('');
    setToolsProgress(null);
    setToolsLog('');
    setNotesErr('');
    setLists(null);
    setListsBusy(false);
    setListsMsg('');
    setListsErr('');
    refreshLists();
    loadNotes()
      .then(() => setNotesPath(notesFilePath() || ''))
      .catch(() => setNotesPath(''));
    refreshTools().then((st) => {
      // Only auto-verify CLI when on a custom path (managed runs setup after install).
      if (st?.usingLocalOverride && st.toolsDir) runXiSetup(st.toolsDir, false);
    });
    return () => detachProgress();
    // intentionally omit `initial` — snapshot only on open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialTab, detachProgress, refreshTools, runXiSetup, refreshLists]);

  // Live game-path check. The startup banner is written before the user has
  // typed anything, so it goes stale the moment the field points at a real
  // install — clear it here rather than making them press Save to find out.
  // Debounced: the field is typed into as well as browsed to.
  useEffect(() => {
    if (!open) return undefined;
    const path = (draft?.gamePath || '').trim();
    if (!path) {
      setGameCheck(null);
      return undefined;
    }
    let alive = true;
    setGameCheck({ state: 'checking', message: 'Checking…' });
    const t = setTimeout(() => {
      checkGamePath(path).then((res) => {
        if (!alive) return;
        setGameCheck(res);
        // A folder that exists is enough to retire "not set" / "not found";
        // "looks wrong" is said inline, next to the field it is about.
        if (res.state !== 'missing') onGamePathValid?.();
      });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [open, draft?.gamePath, onGamePathValid]);

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
  const browseNavmesh = async () => {
    const picked = await backend.pickFolder(
      draft.navmeshPath || draft.pivotPath || draft.hdPath || draft.gamePath,
    );
    if (picked) setDraft({ ...draft, navmeshPath: picked });
  };

  const doInstallOrUpdate = async () => {
    setToolsBusy(true);
    setToolsErr('');
    setToolsLog('');
    setToolsProgress({ label: 'Starting…', pct: 0, detail: '' });
    setToolsMsg('Installing / updating xi-tools…');
    await attachProgress();
    try {
      // Ensure managed mode (no local override) before download.
      try { await backend.toolsClearLocalPath(); } catch { /* */ }
      const st = await backend.toolsInstallOrUpdate();
      setTools(st);
      setDraft((d) => ({ ...d, xiPath: st.toolsDir || d.xiPath }));
      setToolsMsg(st.installed
        ? `Installed v${st.localVersion}`
        : (st.error || 'Install finished with issues'));
      if (st.toolsDir) await runXiSetup(st.toolsDir, true);
      await refreshTools();
    } catch (e) {
      setToolsErr(e?.message || String(e));
    } finally {
      detachProgress();
      setToolsBusy(false);
      setToolsProgress(null);
    }
  };

  const doCheckReleases = async () => {
    setToolsBusy(true);
    setToolsErr('');
    setToolsMsg('Checking GitHub for releases…');
    try {
      const st = await backend.toolsCheckUpdates();
      setTools(st);
      if (st.error) setToolsErr(st.error);
      if (st.updateAvailable) {
        setToolsMsg(`Update available: v${st.localVersion} → v${st.latestVersion}`);
      } else if (st.installed) {
        setToolsMsg(`Up to date (v${st.localVersion})`);
      } else {
        setToolsMsg('Not installed yet — click Install / Update to download the latest release.');
      }
    } catch (e) {
      setToolsErr(e?.message || String(e));
    } finally {
      setToolsBusy(false);
    }
  };

  const browseLocalTools = async () => {
    setToolsErr('');
    const picked = await backend.pickToolsFolder(localPathDraft || draft.xiPath || '');
    if (picked) setLocalPathDraft(picked);
  };

  /** Custom install: verify folder then lock it in as the active override. */
  const applyCustomPath = async () => {
    const path = localPathDraft.trim();
    if (!path) {
      setToolsErr('Choose your xi-tools folder first.');
      return;
    }
    setToolsBusy(true);
    setToolsErr('');
    setToolsMsg('Verifying xi-tools…');
    try {
      // Check only (no uv sync) — user said they already set it up.
      const report = await backend.xiSetup(path, false);
      setXiStatus({ busy: false, ...report });
      if (!report?.ok) {
        setToolsErr(report?.message || 'That folder does not look like a working xi-tools install.');
        setToolsMsg('');
        return;
      }
      const st = await backend.toolsSetLocalPath(path);
      setTools(st);
      setDraft((d) => ({ ...d, xiPath: st.toolsDir }));
      setLocalPathDraft(st.toolsDir);
      setToolsMode('custom');
      setToolsMsg(`Ready · ${st.toolsDir}`);
    } catch (e) {
      setToolsErr(friendlyLocalErr(e?.message || String(e), path));
      setToolsMsg('');
    } finally {
      setToolsBusy(false);
    }
  };

  const switchToolsMode = async (mode) => {
    if (mode === toolsMode || toolsBusy) return;
    setToolsErr('');
    setToolsLog('');
    setToolsProgress(null);
    if (mode === 'managed') {
      setToolsBusy(true);
      setToolsMsg('Switching to self-managed install…');
      try {
        const st = await backend.toolsClearLocalPath();
        setTools(st);
        setToolsMode('managed');
        setLocalPathDraft(st.toolsDir || '');
        setDraft((d) => ({ ...d, xiPath: st.toolsDir || d.xiPath }));
        setXiStatus(null);
        if (st.installed) {
          setToolsMsg(`v${st.localVersion}${st.updateAvailable ? ' · update available' : ' · up to date'}`);
        } else {
          setToolsMsg('Not installed yet — click Install / Update to download the latest release.');
        }
      } catch (e) {
        setToolsErr(e?.message || String(e));
      } finally {
        setToolsBusy(false);
      }
      return;
    }
    // custom — show path form; seed from draft.xiPath when empty
    setToolsMode('custom');
    setLocalPathDraft((prev) => prev.trim() || (draft.xiPath || '').trim() || '');
    setToolsMsg('Browse to your existing xi-tools folder, then Verify & use.');
    setXiStatus(null);
  };

  const style = pos
    ? { left: pos.x, top: pos.y, transform: 'none' }
    : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };

  const badge = xiBadge(xiStatus);
  const toolsBadge = toolsUiBadge(tools, toolsBusy);

  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) cancel(); }}>
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
            <Button className="icon-btn modal-close" onClick={cancel}>
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
          <button
            type="button"
            role="tab"
            className={`settings-tab${tab === 'lists' ? ' on' : ''}`}
            aria-selected={tab === 'lists'}
            onClick={() => setTab('lists')}
          >
            <span className="icon">database</span>
            DAT Lists
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
              <section className="settings-panel">
                <div className="settings-panel-title">Data paths</div>
                <div className="settings-panel-body">
                  <div className="form-row">
                    <label className="form-label">Game path</label>
                    <div className="form-inline">
                      <input
                        type="text"
                        value={draft.gamePath}
                        spellCheck={false}
                        placeholder="Your FINAL FANTASY XI install folder"
                        onChange={(e) => setDraft({ ...draft, gamePath: e.target.value })}
                      />
                      <Button onClick={browse}>
                        <span className="icon">folder_open</span>
                        Browse
                      </Button>
                    </div>
                    {gameCheck && (
                      <div className={`xi-status settings-path-status ${GAME_CHECK[gameCheck.state].cls}`}>
                        <span className={`icon${gameCheck.state === 'checking' ? ' spin' : ''}`}>
                          {GAME_CHECK[gameCheck.state].icon}
                        </span>
                        <span className="xi-status-msg">{gameCheck.message}</span>
                      </div>
                    )}
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

                  <div className="form-row">
                    <label className="form-label">Navmesh Folder</label>
                    <div className="form-inline">
                      <input
                        type="text"
                        value={draft.navmeshPath ?? ''}
                        spellCheck={false}
                        placeholder="Folder of zone .nav files (e.g. server navmeshes)"
                        onChange={(e) => setDraft({ ...draft, navmeshPath: e.target.value })}
                      />
                      <Button onClick={browseNavmesh}>
                        <span className="icon">folder_open</span>
                        Browse
                      </Button>
                    </div>
                    <div className="form-hint">
                      Optional. Zone overlay reads <span className="mono">ZoneName.nav</span> from here first.
                    </div>
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
              </section>

              <section className="settings-panel">
                <div className="settings-panel-title">Options</div>
                <div className="settings-panel-body">
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

                  <Tooltip content="Fly camera on zone load (WASD / QE / Shift / wheel).">
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
                    </div>
                  </Tooltip>

                  <Tooltip content="A zone opens with its sky and weather running, even if you switched them off in the last one.">
                    <div className="form-row">
                      <Field className="check-field">
                        <Checkbox
                          checked={draft.autoWeatherZones !== false}
                          onChange={(v) => setDraft({ ...draft, autoWeatherZones: v })}
                          className="checkbox"
                        >
                          <span className="icon check-icon">check</span>
                        </Checkbox>
                        <Label className="check-label">Auto Enable Weather</Label>
                      </Field>
                    </div>
                  </Tooltip>

                  <Tooltip content="Clicking a row in the Objects list frames the camera on it. Off = select only, camera stays put.">
                    <div className="form-row">
                      <Field className="check-field">
                        <Checkbox
                          checked={draft.autoFocusZoneObject !== false}
                          onChange={(v) => setDraft({ ...draft, autoFocusZoneObject: v })}
                          className="checkbox"
                        >
                          <span className="icon check-icon">check</span>
                        </Checkbox>
                        <Label className="check-label">Auto Focus Zone Object</Label>
                      </Field>
                    </div>
                  </Tooltip>

                  <Tooltip content="Off: picking another actor keeps your view. F reframes.">
                    <div className="form-row">
                      <Field className="check-field">
                        <Checkbox
                          checked={!!draft.reframeOnSelect}
                          onChange={(v) => setDraft({ ...draft, reframeOnSelect: v })}
                          className="checkbox"
                        >
                          <span className="icon check-icon">check</span>
                        </Checkbox>
                        <Label className="check-label">Reframe camera on Actor Selection</Label>
                      </Field>
                    </div>
                  </Tooltip>

                  <div className="form-row">
                    <label className="form-label">Day Length</label>
                    {/* A few digits at most; form-inline stretches otherwise. */}
                    <div className="form-inline">
                      <input
                        type="text"
                        inputMode="numeric"
                        spellCheck={false}
                        style={{ flex: '0 0 auto', width: 100 }}
                        value={draft.dayLength ?? ''}
                        onChange={(e) => setDraft({ ...draft, dayLength: e.target.value })}
                      />
                    </div>
                    <div className="form-hint">
                      Seconds of real time for one in-game day when the day/night
                      cycle is playing (Zone panel). Default 60.
                    </div>
                  </div>

                  <div className="form-row">
                    <label className="form-label">Weather Transition</label>
                    <div className="form-inline">
                      <input
                        type="text"
                        inputMode="numeric"
                        spellCheck={false}
                        style={{ flex: '0 0 auto', width: 100 }}
                        value={draft.weatherFadeMs ?? ''}
                        onChange={(e) => setDraft({ ...draft, weatherFadeMs: e.target.value })}
                      />
                      <span className="form-suffix">ms</span>
                    </div>
                    <div className="form-hint">
                      How long a weather change takes to cross-fade — sky, fog,
                      lighting, particles and the ambient bed. Default 3330
                      (the game's 3.33s); 0 snaps straight over.
                    </div>
                  </div>

                  <div className="form-row">
                    <label className="form-label">UI Scale</label>
                    <div className="form-inline ui-scale-row">
                      <input
                        type="range"
                        className="vol-slider"
                        min={-100}
                        max={100}
                        step={1}
                        value={uiScaleToSlider(draft.uiScale)}
                        style={{ '--fill': `${(uiScaleToSlider(draft.uiScale) + 100) / 2}%` }}
                        aria-label="UI scale"
                        title="Double-click to reset to 100%"
                        onChange={(e) => setDraft({ ...draft, uiScale: sliderToUiScale(e.target.value) })}
                        // Apply on release only — zooming mid-drag moves the
                        // slider out from under the pointer.
                        onPointerUp={(e) => backend.setUiScale(sliderToUiScale(e.currentTarget.value))}
                        onKeyUp={(e) => backend.setUiScale(sliderToUiScale(e.currentTarget.value))}
                        onDoubleClick={() => {
                          setDraft({ ...draft, uiScale: 1 });
                          backend.setUiScale(1);
                        }}
                      />
                      <span className="mono ui-scale-num">{Math.round(clampUiScale(draft.uiScale) * 100)}%</span>
                    </div>
                    <div className="form-hint">
                      Zoom the whole window, 20% – 200% in 5% steps. Centre is 100%; double-click to reset.
                      Ctrl +/− and Ctrl 0 also work anywhere.
                    </div>
                  </div>

                  <Tooltip content="Only the whole-DAT Notes window (status bar), not UiMenu notes.">
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
                    </div>
                  </Tooltip>
                </div>
              </section>
            </div>
          )}

          {tab === 'xitools' && (
            <div className="settings-xitools">
              <div className="settings-xitools-main">
                <section className="settings-panel">
                  <div className="settings-panel-title">Install mode</div>
                  <div className="settings-panel-body">
                    <div className="form-row">
                      <label className="form-label">How xi-tools is provided</label>
                      <Combo
                        value={toolsMode}
                        items={TOOLS_MODE_ITEMS}
                        onChange={(id) => { if (!toolsBusy) switchToolsMode(id); }}
                      />
                    </div>
                    <div className="form-hint">
                      {toolsMode === 'managed'
                        ? 'Downloads the latest GitHub release into AppData, sets up Python/uv, and checks for updates on launch (same as XI Zone Editor).'
                        : 'Point at an xi-tools checkout you already built. The app will only verify it — no download or uv sync.'}
                    </div>
                  </div>
                </section>

                {toolsMode === 'managed' && (
                  <section className="settings-panel">
                    <div className="settings-panel-title">Self-managed install</div>
                    <div className="settings-panel-body">
                      <div className={`xi-status${toolsBadge ? ` ${toolsBadge.cls}` : ''}${toolsBusy ? ' busy' : ''}`}>
                        <span className={`icon${toolsBusy ? ' spin' : ''}`}>{toolsBadge?.icon || 'info'}</span>
                        <span className="xi-status-msg">{toolsMsg || 'Checking…'}</span>
                      </div>

                      {tools?.toolsDir && !tools.usingLocalOverride && (
                        <div className="form-hint mono">{tools.toolsDir}</div>
                      )}

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
                          Install / Update
                        </Button>
                        <Button disabled={toolsBusy} onClick={doCheckReleases}>
                          <span className="icon">travel_explore</span>
                          Check for updates
                        </Button>
                        <Tooltip content="xi-tools on GitHub">
                          <Button className="icon-btn" onClick={() => backend.openUrl(XI_README_HINT)}>
                            <span className="icon">open_in_new</span>
                          </Button>
                        </Tooltip>
                      </div>

                      {toolsErr && (
                        <div className="form-error settings-local-err" role="alert">
                          <span className="icon">error</span>
                          <span>{toolsErr}</span>
                        </div>
                      )}
                      {toolsLog && (
                        <pre className="xi-status-detail mono tools-log">{toolsLog}</pre>
                      )}
                    </div>
                  </section>
                )}

                {toolsMode === 'custom' && (
                  <section className="settings-panel">
                    <div className="settings-panel-title">Custom install</div>
                    <div className="settings-panel-body">
                      <div className="form-row">
                        <label className="form-label">xi-tools folder</label>
                        <div className="form-inline">
                          <input
                            type="text"
                            value={localPathDraft}
                            spellCheck={false}
                            placeholder="e.g. D:\xi-tools"
                            disabled={toolsBusy}
                            onChange={(e) => {
                              setLocalPathDraft(e.target.value);
                              if (toolsErr) setToolsErr('');
                            }}
                          />
                          <Button disabled={toolsBusy} onClick={browseLocalTools}>
                            <span className="icon">folder_open</span>
                            Browse
                          </Button>
                        </div>
                      </div>

                      <div className="form-inline tools-actions">
                        <Button className="active" disabled={toolsBusy} onClick={applyCustomPath}>
                          <span className="icon">verified</span>
                          {toolsBusy ? 'Verifying…' : 'Verify & use'}
                        </Button>
                        <Tooltip content="Setup guide">
                          <Button className="icon-btn" onClick={() => backend.openUrl(XI_README_HINT)}>
                            <span className="icon">menu_book</span>
                          </Button>
                        </Tooltip>
                        {xiStatus?.status === 'missing_uv' && (
                          <Button onClick={() => backend.openUrl(UV_INSTALL_URL)}>
                            <span className="icon">open_in_new</span>
                            Install uv
                          </Button>
                        )}
                      </div>

                      {(toolsMsg || xiStatus?.message) && !toolsErr && (
                        <div className={`xi-status${xiStatus?.ok || tools?.usingLocalOverride ? ' ok' : ''}${xiStatus?.busy || toolsBusy ? ' busy' : ''}`}>
                          <span className={`icon${xiStatus?.busy || toolsBusy ? ' spin' : ''}`}>
                            {xiStatus?.busy || toolsBusy ? 'progress_activity' : (xiStatus?.ok ? 'check_circle' : 'info')}
                          </span>
                          <span className="xi-status-msg">{xiStatus?.message || toolsMsg}</span>
                        </div>
                      )}
                      {toolsErr && (
                        <div className="form-error settings-local-err" role="alert">
                          <span className="icon">error</span>
                          <span>{toolsErr}</span>
                        </div>
                      )}
                      {xiStatus?.detail && xiStatus.status === 'error' && (
                        <pre className="xi-status-detail mono">{xiStatus.detail.slice(0, 600)}</pre>
                      )}
                    </div>
                  </section>
                )}
              </div>

              <div className="settings-xitools-side">
                <section className="settings-panel">
                  <div className="settings-panel-title">Console</div>
                  <div className="settings-panel-body">
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
                </section>
              </div>
            </div>
          )}

          {tab === 'lists' && (
            <div className="settings-cols settings-lists">
              <section className="settings-panel">
                <div className="settings-panel-title">Where these come from</div>
                <div className="settings-panel-body">
                  <div className="form-hint">
                    The DAT lists are what turns raw DAT paths into names — races and
                    gear, NPCs, zones, music, sound effects. They are generated by{' '}
                    <a
                      className="inline-link"
                      href={LISTS_SOURCE_URL}
                      onClick={(e) => { e.preventDefault(); backend.openUrl(LISTS_SOURCE_URL); }}
                    >
                      xi-tools
                    </a>{' '}
                    and ship inside this build, so the app works with no network at all.
                  </div>
                  <div className="form-hint">
                    On launch it checks xi-tools for newer copies and downloads only the
                    ones whose contents changed, so a model or gear row found after this
                    release still shows up. Each download is checked against its
                    published checksum before it replaces anything.
                  </div>
                </div>
              </section>

              <section className="settings-panel">
                <div className="settings-panel-title">Status</div>
                <div className="settings-panel-body">
                  <div className={`xi-status${listsBusy ? ' busy' : ''}`}>
                    <span className={`icon${listsBusy ? ' spin' : ''}`}>
                      {listsBusy ? 'progress_activity' : 'inventory_2'}
                    </span>
                    <span className="xi-status-msg">
                      {listsBusy
                        ? (listsMsg || 'Checking…')
                        : (listsMsg || (lists
                          ? `${lists.files.length} lists, ${fmtMb(lists.bytes)}`
                            + (lists.downloaded
                              ? ` — ${lists.downloaded} updated since this build`
                              : ' — all from this build')
                          : 'Reading…'))}
                    </span>
                  </div>

                  {lists?.generated && (
                    <div className="form-hint">
                      Built from xi-tools&rsquo; lists of{' '}
                      <span className="mono">{fmtStamp(lists.generated)}</span>.
                    </div>
                  )}
                  {!!lists?.downloaded && lists.dir && (
                    <div className="form-hint mono lists-dir">{lists.dir}</div>
                  )}

                  <div className="form-inline tools-actions">
                    <Button className="active" disabled={listsBusy} onClick={doUpdateLists}>
                      <span className="icon">download</span>
                      Check for list updates
                    </Button>
                    <Tooltip content="The published lists on GitHub">
                      <Button
                        className="icon-btn"
                        onClick={() => backend.openUrl(LISTS_SOURCE_URL)}
                      >
                        <span className="icon">open_in_new</span>
                      </Button>
                    </Tooltip>
                  </div>

                  {listsErr && (
                    <div className="form-error settings-local-err" role="alert">
                      <span className="icon">error</span>
                      <span>{listsErr}</span>
                    </div>
                  )}
                </div>
              </section>

              <section className="settings-panel settings-lists-table-panel">
                <div className="settings-panel-title">The lists</div>
                <div className="settings-panel-body">
                  <div className="lists-table" role="table">
                    {(lists?.files ?? []).map((f) => (
                      <div className="lists-row" role="row" key={f.name}>
                        <div className="lists-name mono">{f.name}</div>
                        <div className="lists-blurb">{LIST_BLURBS[f.name] || ''}</div>
                        <div className="lists-size mono">{fmtMb(f.bytes)}</div>
                        <div className={`lists-src${f.source === 'downloaded' ? ' updated' : ''}`}>
                          {f.source === 'downloaded' ? 'Updated' : 'In build'}
                        </div>
                      </div>
                    ))}
                    {!lists && <div className="form-hint">Reading…</div>}
                  </div>
                </div>
              </section>
            </div>
          )}
        </div>

        <div className="modal-actions">
          <Button onClick={cancel}>Cancel</Button>
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

// Badge look per game-path verdict.
const GAME_CHECK = {
  checking: { cls: 'busy', icon: 'progress_activity' },
  ok: { cls: 'ok', icon: 'check_circle' },
  warn: { cls: 'warn', icon: 'warning' },
  missing: { cls: 'err', icon: 'error' },
};

/**
 * Does this folder exist, and does it look like an FFXI install? A folder that
 * merely exists opens no DAT, so `ok` wants the ROM tree (or FFXiMain.dll) —
 * anything else is a warning, not a refusal, since odd layouts do exist.
 */
async function checkGamePath(path) {
  let entries;
  try {
    entries = await backend.listDir(path);
  } catch {
    return { state: 'missing', message: `Folder not found: ${path}` };
  }
  const names = new Set((entries || []).map((e) => String(e?.name || '').toLowerCase()));
  if (names.has('rom') || names.has('ffximain.dll')) {
    return { state: 'ok', message: 'FINAL FANTASY XI install found.' };
  }
  return {
    state: 'warn',
    message: 'Folder found, but no ROM folder or FFXiMain.dll inside — is this the install root?',
  };
}

/** Bytes as MB/KB, for the list sizes. */
function fmtMb(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The manifest's ISO stamp as a plain date. Falls back to the raw string: this
 * is written by xi-tools, and an unparseable one is still worth showing.
 */
function fmtStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Make Rust path errors readable under Local checkout. */
function friendlyLocalErr(raw, path) {
  const msg = String(raw || '').trim();
  if (!msg) return 'That folder could not be used.';
  if (/^Not a folder:/i.test(msg)) {
    return `Folder not found:\n${path || msg.replace(/^Not a folder:\s*/i, '')}\nBrowse to your xi-tools clone (must contain src/xi).`;
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
