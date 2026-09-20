import { useCallback, useEffect, useRef, useState } from 'react';
import { ResizeCorner } from './ResizeCorner.jsx';
import { Button, Checkbox, Field, Label } from '@headlessui/react';
import { backend } from '../js/backend.js';
import { clampUiScale, sliderToUiScale, uiScaleToSlider } from '../js/uiScale.js';
import { GAME_CHECK, checkGamePath } from '../js/gameCheck.js';
import { formatProgressDetail } from '../js/toolsBoot.js';
import { loadNotes, notesFilePath, revealNotesFile } from '../js/notes.js';
import { ANIM_BANDS_DEFAULT, STOCK_ANIM_RANGE, animBandRange } from '../js/mixer.js';
import {
  LOCAL_SERVER_DEFAULT, WS_WHY, connectionLine, localServerChanges, localServerEnv, localServerErrorText,
  readLocalServer, sameServerDir, serverCheck, serverFolderLine, wsCodeText, wsInstallReveal, wsInstallSummary,
  wsRevealTarget, wsStateLine, wsWiden,
} from '../js/localServer.js';
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
 * Draggable settings window. No backdrop: like the Sequencer and the other
 * floating panels it sits over the app rather than blocking it, so a stray
 * click on the viewport moves the camera instead of throwing the dialog away.
 * Cancel, × and Esc are the ways out.
 *
 * Tabs: General (paths + options) · XI Tools (install / update / local path) ·
 * DAT Lists (the name lists that ship with the build) · Local Server (the
 * LandSandBoat checkout and its database, for the Ability Mixer's Manage ›
 * Database Update / Client Menu Record / Lua Stub and the weapon-skill C++ patch;
 * read from and saved to xi-tools' own .env, nothing kept here) · DAT Database
 * (the prebuilt tables the Database page reads).
 *
 * `initialTab` is how the rest of the app sends someone straight to the tab
 * that fixes their problem — Export with no xi-tools opens on 'xitools'.
 *
 * `db` carries the DAT Database tab: { dir, xiConnected, updating, refreshTick,
 * onUpdate, onImport }. Omitted (the zone-preview window) the tab is not shown
 * — there is no Database page there to prebuild for.
 */
export function SettingsModal({
  open, initial, onSave, onClose, error, initialTab = 'general', onGamePathValid,
  onFocus, zIndex = 5000, db = null,
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
  const [dbManifest, setDbManifest] = useState(null);  // manifest.json of the last bake
  const [dbState, setDbState] = useState('loading');   // loading | none | bad | ok
  const [gameCheck, setGameCheck] = useState(null);  // { state, message }
  const [lists, setLists] = useState(null);       // ListsStatus from Rust
  const [listsBusy, setListsBusy] = useState(false);
  const [listsMsg, setListsMsg] = useState('');
  const [listsErr, setListsErr] = useState('');
  // Local Server: xi-tools' .env as the tab read it (srvBase), the fields as edited (srv),
  // and the xi runs the tab makes. Nothing of it is kept by the app: Save writes the
  // changed fields into that .env (App.saveSettings, localServer.js writeLocalServer).
  const [srvLoad, setSrvLoad] = useState(null);   // null | { busy, forPath } | { error, forPath } | { path, exists, forPath }
  const [srv, setSrv] = useState(LOCAL_SERVER_DEFAULT);
  const [srvBase, setSrvBase] = useState(LOCAL_SERVER_DEFAULT);
  const [srvShowPw, setSrvShowPw] = useState(false);
  const [srvCheck, setSrvCheck] = useState(null); // null | { busy, db } | { error, tested } | xi.server-check.v1 + { tested }
  const [wsRun, setWsRun] = useState(null);       // null | { busy } | { error } | xi.server-ws-widen.v1 + { revealError }
  const [wsCode, setWsCode] = useState(null);     // null | { busy } | { error } | the --print result
  const [srvCopied, setSrvCopied] = useState(''); // which Copy last worked: 'code' | 'build'
  const srvReadSeq = useRef(0);
  const srvCheckSeq = useRef(0);
  const panelRef = useRef(null);
  const dragState = useRef(null);
  const setupGen = useRef(0);
  const unlistenRef = useRef([]);

  // Slider previews live; Cancel/× put the saved scale back.
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
    // Local Server re-reads xi-tools' .env every time Settings opens on it.
    srvReadSeq.current += 1;
    srvCheckSeq.current += 1;
    setSrvLoad(null);
    setSrv(LOCAL_SERVER_DEFAULT);
    setSrvBase(LOCAL_SERVER_DEFAULT);
    setSrvShowPw(false);
    setSrvCheck(null);
    setWsRun(null);
    setWsCode(null);
    setSrvCopied('');
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

  // Every `xi mv database` bake writes a manifest.json naming the tables, their
  // row counts and the time — read it when the tab is actually on screen, and
  // again after a bake or an import (refreshTick).
  useEffect(() => {
    if (!open || tab !== 'database') return undefined;
    let alive = true;
    setDbState('loading');
    if (!db?.dir) { setDbManifest(null); setDbState('none'); return undefined; }
    backend.readTextFile(`${db.dir}\\manifest.json`)
      .then((text) => {
        if (!alive) return;
        if (!text) { setDbManifest(null); setDbState('none'); return; }
        try { setDbManifest(JSON.parse(text)); setDbState('ok'); }
        catch { setDbManifest(null); setDbState('bad'); }
      })
      .catch(() => { if (alive) { setDbManifest(null); setDbState('none'); } });
    return () => { alive = false; };
  }, [open, tab, db?.dir, db?.refreshTick, db?.updating]);

  /**
   * Local Server: `xi server check --json` with these field values as env vars for that
   * one run (non-blank only; they beat xi-tools' .env, which xi reads for the rest).
   * `db` false makes no connection — what the tab runs on its own when it opens, for
   * the folder and weapon-skill lines; Test connection is the one that connects.
   */
  const runSrvCheck = useCallback(async (xiPath, values, dbToo) => {
    const seq = ++srvCheckSeq.current;
    setSrvCheck({ busy: true, db: dbToo });
    try {
      const res = await serverCheck(xiPath, localServerEnv(values), { db: dbToo, binary: true });
      if (seq === srvCheckSeq.current) setSrvCheck({ ...res, tested: dbToo });
    } catch (e) {
      if (seq === srvCheckSeq.current) setSrvCheck({ error: localServerErrorText(e), tested: dbToo });
    }
  }, []);

  // Local Server: read xi-tools' .env when the tab is first shown in this session (and
  // again if the xi-tools folder changes before anything was edited here), then check
  // the folder and weapon skills without connecting to anything.
  const srvXiPath = (draft?.xiPath || tools?.toolsDir || '').trim();
  const srvDirty = Object.keys(localServerChanges(srv, srvBase)).length > 0;
  useEffect(() => {
    if (!open || tab !== 'server' || !srvXiPath) return;
    if (srvLoad?.forPath === srvXiPath) return;
    if (srvLoad?.forPath && srvDirty) return;   // edits made: keep them
    const seq = ++srvReadSeq.current;
    setSrvLoad({ busy: true, forPath: srvXiPath });
    readLocalServer(srvXiPath).then((r) => {
      if (seq !== srvReadSeq.current) return;
      setSrv(r.values);
      setSrvBase(r.values);
      setSrvLoad({ path: r.path, exists: r.exists, forPath: srvXiPath });
      runSrvCheck(srvXiPath, r.values, false);
    }).catch((e) => {
      if (seq === srvReadSeq.current) setSrvLoad({ error: String(e?.message ?? e), forPath: srvXiPath });
    });
  }, [open, tab, srvXiPath, srvLoad, srvDirty, runSrvCheck]);

  useEffect(() => {
    if (!open) return undefined;
    const clampNow = () => setPos((p) => (p ? clamp(p, panelRef.current) : p));
    window.addEventListener('resize', clampNow);
    return () => window.removeEventListener('resize', clampNow);
  }, [open]);

  if (!open) return null;

  // DAT Database tab: the bake in one sentence.
  const dbTables = dbManifest?.tables ? Object.keys(dbManifest.tables) : [];
  const dbLangs = [...new Set(dbTables.map((k) => k.split('.').pop()))];
  const dbStatusMsg = {
    loading: 'Checking…',
    none: 'Not built yet.',
    bad: 'These tables could not be read — build them again.',
    ok: `${dbTables.length} tables ready`
      + `${dbLangs.length ? ` in ${dbLangs.map(langName).join(' and ')}` : ''}`
      + `${dbManifest?.generated ? `, built ${fmtBaked(dbManifest.generated)}` : ''}`,
  }[dbState] ?? '';

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
  const browseBlender = async () => {
    const picked = await backend.pickFile(draft.blenderPath || '', {
      title: 'Locate blender.exe', exts: ['exe'],
    });
    if (picked) setDraft({ ...draft, blenderPath: picked });
  };

  // Custom animation bands: kept as typed while editing (digits only); Save normalises
  // them (App.jsx), so a field cleared mid-edit does not snap back under the cursor.
  const bandsDraft = { ...ANIM_BANDS_DEFAULT, ...(draft.animBands || {}) };
  const setBand = (patch) => setDraft({ ...draft, animBands: { ...bandsDraft, ...patch } });
  const bandNum = (key, label) => (
    <label className="band-num">
      <span>{label}</span>
      <input type="text" inputMode="numeric" spellCheck={false} disabled={!bandsDraft.on}
        value={bandsDraft[key] ?? ''} onChange={(e) => setBand({ [key]: e.target.value.replace(/[^0-9]/g, '') })} />
    </label>
  );
  const bandRange = (kind) => {
    const r = animBandRange(kind, bandsDraft);
    return r ? `${r[0]}–${r[1]}` : '—';
  };

  // Local Server: the fields, as read from xi-tools' .env and edited here.
  const srvReady = !!srvLoad?.path && srvLoad.forPath === srvXiPath;
  const setSrvField = (patch) => setSrv((s) => ({ ...s, ...patch }));
  const browseServerDir = async () => {
    const picked = await backend.pickFolder(srv.dir || null);
    if (picked) setSrvField({ dir: picked });
  };
  // A field cleared here is left out of a test run, so the run still sees xi-tools' .env
  // value for it until Save removes that line.
  const srvClearedNames = Object.keys(srv).filter((k) => !String(srv[k]).trim() && String(srvBase[k] ?? '').trim());
  const testConnection = () => { if (srvXiPath && srvReady) runSrvCheck(srvXiPath, srv, true); };
  /** Get the C++ patch: xi writes the patch, the SQL and a README into its own folder; Explorer opens on the patch. */
  const getWsPatch = async () => {
    if (!srvXiPath || !srvReady) return;
    setWsRun({ busy: true });
    try {
      const res = await wsWiden(srvXiPath, localServerEnv(srv));
      const target = wsRevealTarget(res);
      let revealError = null;
      if (target) {
        try { await backend.revealPath(target); } catch (e) { revealError = String(e?.message ?? e); }
      }
      setWsRun({ ...res, revealError });
    } catch (e) {
      setWsRun({ error: localServerErrorText(e) });
    }
  };
  /** Apply to server: place the patch in modules\catseyexi, widen xi_map's source in place and the DB
   *  column (ws-widen --install --apply-db), then open the patch's folder and re-check. */
  const installWs = async () => {
    if (!srvXiPath || !srvReady) return;
    setWsRun({ busy: true, install: true });
    try {
      const res = await wsWiden(srvXiPath, localServerEnv(srv), { install: true });
      const target = wsInstallReveal(res);
      let revealError = null;
      if (target) {
        try { await backend.revealPath(target); } catch (e) { revealError = String(e?.message ?? e); }
      }
      setWsRun({ ...res, install: true, revealError });
      runSrvCheck(srvXiPath, srv, srvCheck?.tested ?? false);   // refresh the state line
    } catch (e) {
      setWsRun({ error: localServerErrorText(e), install: true });
    }
  };
  /** Show the code: the patch and the SQL, read-only (ws-widen --print writes nothing). A second click hides it. */
  const toggleWsCode = async () => {
    if (wsCode && !wsCode.busy) { setWsCode(null); return; }
    if (!srvXiPath || !srvReady) return;
    setWsCode({ busy: true });
    try {
      setWsCode(await wsWiden(srvXiPath, localServerEnv(srv), { print: true }));
    } catch (e) {
      setWsCode({ error: localServerErrorText(e) });
    }
  };
  const copyText = (text, which) => {
    navigator.clipboard?.writeText(text).then(() => setSrvCopied(which), () => setSrvCopied(''));
  };
  const srvChecked = srvCheck && !srvCheck.busy && !srvCheck.error ? srvCheck : null;
  // The folder line is about the folder that check ran with, so it goes once the field changes.
  // xi reports it as Python's Path spells it (\ for /, no trailing separator), so the two
  // are compared as folders, not as text.
  const folderLine = srv.dir.trim() && sameServerDir(srvChecked?.serverDir, srv.dir)
    ? serverFolderLine(srvChecked) : null;
  const connLine = srvCheck?.tested
    ? (srvCheck.error ? { tone: 'err', text: srvCheck.error } : connectionLine(srvCheck))
    : null;
  // A failed Test connection already says why under Database; the weapon-skill line only
  // repeats a failure of the tab's own (no-connection) check.
  const wsLine = srvCheck?.busy ? null
    : srvCheck?.error ? (srvCheck.tested ? null : { tone: 'err', text: srvCheck.error })
      : wsStateLine(srvChecked?.weaponSkills);
  const wsCodeShown = wsCode && !wsCode.busy && !wsCode.error ? wsCodeText(wsCode) : '';

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
      // The desktop app records the override natively; the browser dev build has
      // no such store, so the path lives in settings (xiPath) alone.
      const st = window.__TAURI__ ? await backend.toolsSetLocalPath(path) : { toolsDir: path, mode: 'custom' };
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
    ? { left: pos.x, top: pos.y, transform: 'none', zIndex }
    : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex };

  const badge = xiBadge(xiStatus);
  const toolsBadge = toolsUiBadge(tools, toolsBusy);

  return (
    <div className="modal settings-modal" ref={panelRef} style={style} onPointerDown={onFocus}>
      <ResizeCorner containerRef={panelRef} />
      <div
        className="modal-header"
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
      >
        <span className="icon">settings</span>
        <span className="modal-title">Settings</span>
        <Button className="icon-btn modal-close" onClick={cancel}>
          <span className="icon">close</span>
        </Button>
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
        <button
          type="button"
          role="tab"
          className={`settings-tab${tab === 'server' ? ' on' : ''}`}
          aria-selected={tab === 'server'}
          onClick={() => setTab('server')}
        >
          <span className="icon">dns</span>
          Local Server
        </button>
        {db && (
          <button
            type="button"
            role="tab"
            className={`settings-tab${tab === 'database' ? ' on' : ''}`}
            aria-selected={tab === 'database'}
            onClick={() => setTab('database')}
          >
            <span className="icon">dataset</span>
            DAT Database
          </button>
        )}
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
                <Tooltip content="Snap the menu bar, the left panel and the status bars flush to the app edges — no floating margins or rounded corners.">
                  <div className="form-row">
                    <Field className="check-field">
                      <Checkbox
                        checked={!!draft.dockedUi}
                        onChange={(v) => setDraft({ ...draft, dockedUi: v })}
                        className="checkbox"
                      >
                        <span className="icon check-icon">check</span>
                      </Checkbox>
                      <Label className="check-label">Docked UI</Label>
                    </Field>
                  </div>
                </Tooltip>

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

              <section className="settings-panel">
                <div className="settings-panel-title">Blender</div>
                <div className="settings-panel-body">
                  <div className="form-row">
                    <label className="form-label">Blender executable</label>
                    <div className="form-inline">
                      <input
                        type="text"
                        value={draft.blenderPath ?? ''}
                        spellCheck={false}
                        placeholder={'e.g. C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe'}
                        onChange={(e) => setDraft({ ...draft, blenderPath: e.target.value })}
                      />
                      <Button onClick={browseBlender}>
                        <span className="icon">folder_open</span>
                        Browse
                      </Button>
                    </div>
                    <div className="form-hint">
                      Sets <span className="mono">BLENDER_PATH</span> for FBX exports. Leave empty to
                      use xi-tools&rsquo; default install path.
                    </div>
                  </div>
                </div>
              </section>
              <section className="settings-panel">
                <div className="settings-panel-title">Custom animation bands</div>
                <div className="settings-panel-body">
                  <div className="form-row">
                    <Field className="check-field">
                      <Checkbox
                        checked={!!bandsDraft.on}
                        onChange={(v) => setBand({ on: v })}
                        className="checkbox"
                      >
                        <span className="icon check-icon">check</span>
                      </Checkbox>
                      <Label className="check-label">The game client runs a band plugin (cexislots)</Label>
                    </Field>
                    <div className="form-hint">
                      A stock client loads only a few free animation numbers — weapon
                      skill {STOCK_ANIM_RANGE.ws[0]}–{STOCK_ANIM_RANGE.ws[1]}, job
                      ability {STOCK_ANIM_RANGE.ja[0]}–{STOCK_ANIM_RANGE.ja[1]},
                      spell {STOCK_ANIM_RANGE.spell[0]}–{STOCK_ANIM_RANGE.spell[1]}. With this on, the
                      Ability Mixer&rsquo;s Publish goes on into the ranges below once those are
                      used up. Off, it never hands out a number the client could not load.
                    </div>
                  </div>
                  <div className="band-row">
                    <b>Weapon skill</b>
                    {bandNum('wsFirst', 'first number')}
                    {bandNum('wsSlots', 'slots')}
                    {bandNum('wsBase', 'file id base')}
                    <span className="band-range">{bandRange('ws')}</span>
                  </div>
                  <div className="band-row">
                    <b>Job ability</b>
                    {bandNum('jaFirst', 'first number')}
                    {bandNum('jaBase', 'file id base')}
                    <span className="band-range">{bandRange('ja')}</span>
                  </div>
                  <div className="band-row">
                    <b>Spell</b>
                    {bandNum('spellFirst', 'first number')}
                    {bandNum('spellBase', 'file id base')}
                    <span className="band-range">{bandRange('spell')}</span>
                  </div>
                  <div className="form-row">
                    <div className="form-inline">
                      <Button onClick={() => setBand({ ...ANIM_BANDS_DEFAULT, on: bandsDraft.on })}>
                        <span className="icon">restart_alt</span>
                        cexislots defaults
                      </Button>
                    </div>
                    <div className="form-hint">
                      These must match the plugin the client runs (cexislots
                      <span className="mono"> sites.h</span>: WS_CUSTOM_FIRST / WS_SLOTS / WS_BASE,
                      FX_JA_*, FX_SPELL_*). They are passed to xi-tools
                      as <span className="mono">FX_*_BAND_*</span> on every run and override its
                      <span className="mono"> .env</span>. Publish with <i>Use Pivot Folder</i> so the
                      overlay&rsquo;s ROM10 tables register the ids.
                    </div>
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
                            ? ` — ${lists.downloaded} ${draft.listsLocalOnly ? 'from the lists folder' : 'updated since this build'}`
                            : ' — all from this build')
                          + (draft.listsLocalOnly ? ' · startup check off' : '')
                        : 'Reading…'))}
                  </span>
                </div>

                {lists?.generated && (
                  <div className="form-hint">
                    Built from xi-tools&rsquo; lists of{' '}
                    <span className="mono">{fmtStamp(lists.generated)}</span>.
                  </div>
                )}
                {(!!lists?.downloaded || draft.listsLocalOnly) && lists?.dir && (
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
                  {lists?.dir && (
                    <Tooltip content="Open the lists folder — a list dropped in here is what the app reads">
                      <Button
                        className="icon-btn"
                        onClick={() => backend.revealPath(lists.dir).catch(() => {})}
                      >
                        <span className="icon">folder_open</span>
                      </Button>
                    </Tooltip>
                  )}
                </div>

                <Tooltip content="Skip the GitHub check at startup and read the lists exactly as they are in the folder above. For checking an edited list before it is published — the published copy otherwise replaces it on every launch. The button above still syncs when pressed.">
                  <div className="form-row">
                    <Field className="check-field">
                      <Checkbox
                        checked={!!draft.listsLocalOnly}
                        onChange={(v) => setDraft({ ...draft, listsLocalOnly: v })}
                        className="checkbox"
                      >
                        <span className="icon check-icon">check</span>
                      </Checkbox>
                      <Label className="check-label">Local lists only — don&rsquo;t update at startup</Label>
                    </Field>
                  </div>
                </Tooltip>

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

        {tab === 'server' && (
          <div className="settings-cols settings-server">
            {!srvXiPath && (
              <div className="form-error settings-local-err settings-span" role="alert">
                <span className="icon">info</span>
                <span>Set up xi-tools first (the XI Tools tab): these settings are kept in its .env.</span>
              </div>
            )}
            {srvLoad?.error && (
              <div className="form-error settings-local-err settings-span" role="alert">
                <span className="icon">error</span>
                <span>{`Couldn't read xi-tools' .env: ${srvLoad.error}`}</span>
              </div>
            )}

            <section className="settings-panel">
              <div className="settings-panel-title">Server folder</div>
              <div className="settings-panel-body">
                <div className="form-row">
                  <label className="form-label" htmlFor="local-server-dir">LandSandBoat checkout</label>
                  <div className="form-inline">
                    <input
                      id="local-server-dir"
                      type="text"
                      value={srv.dir}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={srvLoad?.busy ? 'Reading…' : 'not set'}
                      disabled={!srvReady}
                      onChange={(e) => setSrvField({ dir: e.target.value })}
                    />
                    <Button disabled={!srvReady} onClick={browseServerDir}>
                      <span className="icon">folder_open</span>
                      Browse
                    </Button>
                  </div>
                  {folderLine && <StatusLine className="settings-path-status" tone={folderLine.tone} text={folderLine.text} />}
                  <div className="form-hint">
                    <span className="mono">XI_SERVER_DIR</span> — your LandSandBoat server checkout, the folder
                    holding <span className="mono">scripts</span> and <span className="mono">src</span>. The Ability
                    Mixer&rsquo;s Lua Stub writes a new spell, ability or weapon skill&rsquo;s script into
                    its <span className="mono">scripts\actions</span>; Weapon skills below reads its C++.
                  </div>
                </div>
              </div>
            </section>

            <section className="settings-panel">
              <div className="settings-panel-title">Database</div>
              <div className="settings-panel-body">
                <div className="local-server-pair">
                  <div className="form-row">
                    <label className="form-label" htmlFor="local-server-host">Host</label>
                    <input id="local-server-host" type="text" value={srv.host} spellCheck={false} autoComplete="off"
                      placeholder="not set" disabled={!srvReady} onChange={(e) => setSrvField({ host: e.target.value })} />
                  </div>
                  <div className="form-row">
                    <label className="form-label" htmlFor="local-server-port">Port</label>
                    <input id="local-server-port" type="text" inputMode="numeric" value={srv.port} spellCheck={false} autoComplete="off"
                      placeholder="not set" disabled={!srvReady} onChange={(e) => setSrvField({ port: e.target.value.replace(/[^0-9]/g, '') })} />
                  </div>
                </div>
                <div className="local-server-pair even">
                  <div className="form-row">
                    <label className="form-label" htmlFor="local-server-user">User</label>
                    <input id="local-server-user" type="text" value={srv.user} spellCheck={false} autoComplete="off"
                      placeholder="not set" disabled={!srvReady} onChange={(e) => setSrvField({ user: e.target.value })} />
                  </div>
                  <div className="form-row">
                    <label className="form-label" htmlFor="local-server-password">Password</label>
                    <div className="form-inline local-server-pw">
                      <input id="local-server-password" type={srvShowPw ? 'text' : 'password'} value={srv.password}
                        spellCheck={false} autoComplete="off" placeholder="not set" disabled={!srvReady}
                        onChange={(e) => setSrvField({ password: e.target.value })} />
                      <Tooltip content={srvShowPw ? 'Hide the password' : 'Show the password'}>
                        <Button className="icon-btn" aria-label={srvShowPw ? 'Hide the password' : 'Show the password'}
                          onClick={() => setSrvShowPw((v) => !v)}>
                          <span className="icon">{srvShowPw ? 'visibility_off' : 'visibility'}</span>
                        </Button>
                      </Tooltip>
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label className="form-label" htmlFor="local-server-db">Database</label>
                  <input id="local-server-db" type="text" value={srv.database} spellCheck={false} autoComplete="off"
                    placeholder="not set" disabled={!srvReady} onChange={(e) => setSrvField({ database: e.target.value })} />
                </div>
                <div className="form-inline tools-actions">
                  <Tooltip content="Connect with what is typed here, before Save (xi server check --json): read-only, nothing is changed">
                    <Button className="active" disabled={!srvReady || !!srvCheck?.busy} onClick={testConnection}>
                      <span className={`icon${srvCheck?.busy && srvCheck.db ? ' spin' : ''}`}>{srvCheck?.busy && srvCheck.db ? 'progress_activity' : 'lan'}</span>
                      Test connection
                    </Button>
                  </Tooltip>
                </div>
                {srvCheck?.busy && srvCheck.db && <StatusLine busy text="Connecting…" />}
                {connLine && !srvCheck?.busy && (
                  <StatusLine className="settings-path-status" tone={connLine.tone}
                    text={srvClearedNames.length
                      ? `${connLine.text} (cleared fields were tested with xi-tools' .env values until you Save)`
                      : connLine.text} />
                )}
                <div className="form-hint">
                  Saved to xi-tools&rsquo; .env (<span className="mono">{srvLoad?.path ?? (srvXiPath ? `${srvXiPath}\\.env` : '<xi-tools>\\.env')}</span>).
                  xi-tools never reads the server&rsquo;s settings/network.lua. Stored unencrypted on this PC.
                </div>
              </div>
            </section>

            <section className="settings-panel settings-span">
              <div className="settings-panel-title">Weapon skills</div>
              <div className="settings-panel-body">
                {/* Buttons first. Apply to server does the whole local job; the rest are read-only. */}
                <div className="form-inline tools-actions">
                  <Tooltip content="Place the patch in modules\catseyexi, widen xi_map's source and the database column. Then rebuild xi_map and restart it.">
                    <Button className="active" disabled={!srvReady || !!wsRun?.busy} onClick={installWs}>
                      <span className={`icon${wsRun?.busy && wsRun.install ? ' spin' : ''}`}>{wsRun?.busy && wsRun.install ? 'progress_activity' : 'bolt'}</span>
                      Apply to server
                    </Button>
                  </Tooltip>
                  <Tooltip content="Just write the patch, SQL and README into xi-tools and open the folder — change nothing on the server.">
                    <Button disabled={!srvReady || !!wsRun?.busy} onClick={getWsPatch}>
                      <span className={`icon${wsRun?.busy && !wsRun.install ? ' spin' : ''}`}>{wsRun?.busy && !wsRun.install ? 'progress_activity' : 'download'}</span>
                      Get the patch
                    </Button>
                  </Tooltip>
                  <Button disabled={!srvReady || !!wsCode?.busy} onClick={toggleWsCode}>
                    <span className="icon">code</span>
                    {wsCode && !wsCode.busy ? 'Hide the code' : 'Show the code'}
                  </Button>
                </div>
                {srvCheck?.busy && !srvCheck.db && <StatusLine busy text="Checking…" />}
                {wsLine && (
                  <StatusLine className="settings-path-status" tone={wsLine.tone}
                    text={wsLine.command ? `${wsLine.text} ${wsLine.command}` : wsLine.text}>
                    {wsLine.command && (
                      <div className="xi-status-actions">
                        <Button className="xi-action" onClick={() => copyText(wsLine.command, 'build')}>
                          <span className="icon">content_copy</span>
                          {srvCopied === 'build' ? 'Copied' : 'Copy'}
                        </Button>
                      </div>
                    )}
                  </StatusLine>
                )}
                <div className="form-hint">{WS_WHY}</div>
                {wsRun && !wsRun.busy && (() => {
                  const summ = wsRun.install
                    ? wsInstallSummary(wsRun)
                    : { tone: wsRun.error || !wsRun.ok ? 'err' : 'ok',
                        text: wsRun.error || (!wsRun.ok ? 'No patch from this folder — see below.'
                          : `${wsRun.patch?.action === 'already' ? 'Already there' : 'Written'} · ${wsRun.outDir ?? ''}`) };
                  return (
                    <>
                      <StatusLine className="settings-path-status" tone={summ.tone} text={summ.text} />
                      {wsRun.lines?.length > 0 && <pre className="xi-status-detail mono ws-widen-lines">{wsRun.lines.join('\n')}</pre>}
                      {wsRun.revealError && <div className="form-hint">{`Couldn't open the folder: ${wsRun.revealError}`}</div>}
                    </>
                  );
                })()}
                {wsCode?.busy && <StatusLine busy text="Reading…" />}
                {wsCode?.error && <StatusLine className="settings-path-status" tone="err" text={wsCode.error} />}
                {wsCodeShown && (
                  <div className="ws-widen-code-wrap">
                    <div className="form-inline">
                      <span className="form-hint ws-widen-code-note">
                        {wsCode.patch?.text
                          ? 'The patch (stock to 16-bit), then the SQL. Nothing was written.'
                          : 'Set the Server folder to see the exact patch. These are the four lines it changes, then the SQL.'}
                      </span>
                      <Button onClick={() => copyText(wsCodeShown, 'code')}>
                        <span className="icon">content_copy</span>
                        {srvCopied === 'code' ? 'Copied' : 'Copy'}
                      </Button>
                    </div>
                    <pre className="ws-widen-code mono">{wsCodeShown}</pre>
                  </div>
                )}
              </div>
            </section>
          </div>
        )}

        {tab === 'database' && db && (
          <div className="settings-db">
            <section className="settings-panel">
              <div className="settings-panel-title">Database tables</div>
              <div className="settings-panel-body">
                <div className="form-hint">
                  These are what the Database page shows — items, quests, spells and
                  the rest. Building them once makes it open instantly; without them
                  every table is read out of the game files each time.
                </div>

                <div className={`xi-status${db.updating ? ' busy' : ''}${!db.updating && dbState === 'ok' ? ' ok' : ''}`}>
                  <span className={`icon${db.updating ? ' spin' : ''}`}>
                    {db.updating ? 'progress_activity' : (dbState === 'ok' ? 'check_circle' : 'schedule')}
                  </span>
                  <span className="xi-status-msg">
                    {db.updating ? 'Building… this takes a minute.' : dbStatusMsg}
                  </span>
                </div>

                <div className="form-inline">
                  <span className="form-hint mono lists-dir">{db.dir || '—'}</span>
                  <Tooltip content="Show in Explorer">
                    <Button
                      className="icon-btn"
                      aria-label="Show folder"
                      onClick={() => backend.revealPath(db.dir).catch(() => {})}
                      disabled={!db.dir}
                    >
                      <span className="icon">folder_open</span>
                    </Button>
                  </Tooltip>
                </div>

                <div className="form-inline tools-actions">
                  <Button
                    className="active"
                    disabled={!db.xiConnected || db.updating}
                    onClick={db.onUpdate}
                  >
                    <span className={`icon${db.updating ? ' spin' : ''}`}>
                      {db.updating ? 'progress_activity' : 'refresh'}
                    </span>
                    {db.updating ? 'Building…' : (dbState === 'ok' ? 'Rebuild tables' : 'Build tables')}
                  </Button>
                  <Tooltip content="Copy tables already built somewhere else">
                    <Button disabled={db.updating} onClick={db.onImport}>
                      <span className="icon">drive_folder_upload</span>
                      Import…
                    </Button>
                  </Tooltip>
                </div>

                {!db.xiConnected && (
                  <div className="form-hint">
                    Building needs xi-tools — set that up in the XI Tools tab.
                  </div>
                )}
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
          // Local Server: only when a field changed; App.saveSettings checks it and writes the
          // changed keys into xi-tools' .env. It never becomes part of the app's settings.
          ...(srvDirty && srvLoad?.path ? { localServer: { values: srv, base: srvBase } } : {}),
        })}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

const TONE_ICON = { ok: 'check_circle', warn: 'warning', err: 'error', neutral: 'info' };

/** One verdict line in the house badge (.xi-status): ok / warn / err / neutral, or busy with a spinner. */
function StatusLine({ tone = 'neutral', text, busy = false, className = '', children = null }) {
  const cls = busy ? ' busy' : (tone && tone !== 'neutral' ? ` ${tone}` : '');
  return (
    <div className={`xi-status${cls}${className ? ` ${className}` : ''}`}>
      <span className={`icon${busy ? ' spin' : ''}`}>{busy ? 'progress_activity' : (TONE_ICON[tone] ?? 'info')}</span>
      <span className="xi-status-msg">{text}</span>
      {children}
    </div>
  );
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

/** The manifest's language suffixes as words. */
function langName(code) {
  return { en: 'English', jp: 'Japanese' }[code] ?? String(code).toUpperCase();
}

/**
 * A bake stamp (`2026-09-10 14:54`) as a local date and time. Falls back to the
 * raw string — it is written by xi-tools, and an odd one still says something.
 */
function fmtBaked(stamp) {
  if (!stamp) return '';
  const d = new Date(String(stamp).includes('T') ? stamp : String(stamp).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(stamp);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
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
