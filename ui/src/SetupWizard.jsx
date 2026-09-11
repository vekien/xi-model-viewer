import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { backend } from '../js/backend.js';
import { GAME_CHECK, checkGamePath } from '../js/gameCheck.js';
import { formatProgressDetail } from '../js/toolsBoot.js';

const STEPS = [
  { id: 'game', label: 'FFXI folder', hint: 'Where the DATs live', icon: 'folder_open' },
  { id: 'hd', label: 'HD textures', hint: 'Optional pack', icon: 'hd' },
  { id: 'tools', label: 'XI Tools', hint: 'For exporting', icon: 'terminal' },
  { id: 'ready', label: 'Ready', hint: 'Final checks', icon: 'rocket_launch' },
];

/** `characters.json` → `Characters`. */
const prettyList = (name) => String(name)
  .replace(/\.json$/i, '')
  .replace(/[_-]+/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * First-run setup. Shown only when no FFXI folder is set yet — the one thing
 * the app cannot work without — so it is the only modal here that keeps its
 * backdrop and offers no way out but finishing. Everything after step one can
 * be skipped and set later in Settings.
 *
 * The boot syncs that would normally install xi-tools and refresh the DAT lists
 * in the background stand down while this is up (App's `bootSync`): the wizard
 * asks about both in turn, and two installs writing the same folder at once is
 * how you get a half-extracted xi-tools.
 *
 * `onFinish({ gamePath, hdPath, xiPath })` saves and closes; there is no cancel.
 */
export function SetupWizard({ open, onFinish }) {
  const [step, setStep] = useState(0);
  const [gamePath, setGamePath] = useState('');
  const [gameCheck, setGameCheck] = useState(null);   // { state, message }
  const [hdPath, setHdPath] = useState('');
  const [hdCheck, setHdCheck] = useState(null);       // { state, message }
  const [hdSkipped, setHdSkipped] = useState(false);
  const [tools, setTools] = useState(null);           // ToolsStatus
  const [toolsBusy, setToolsBusy] = useState(false);
  const [toolsErr, setToolsErr] = useState('');
  const [toolsProgress, setToolsProgress] = useState(null); // { label, pct, detail }
  const [toolsSkipped, setToolsSkipped] = useState(false);
  const [lists, setLists] = useState(null);           // { busy, count, names, error }
  const [version, setVersion] = useState('');
  const panelRef = useRef(null);
  const dragState = useRef(null);
  const [pos, setPos] = useState(null);
  const unlistenRef = useRef([]);

  const detachProgress = useCallback(() => {
    for (const u of unlistenRef.current) {
      try { u(); } catch { /* */ }
    }
    unlistenRef.current = [];
  }, []);

  // Disk-only status, so opening the step costs nothing.
  const refreshTools = useCallback(async () => {
    try {
      const st = await backend.toolsStatus();
      setTools(st);
      return st;
    } catch (e) {
      setToolsErr(String(e?.message || e));
      return null;
    }
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    refreshTools();
    // Asked of the shell, like About does — a build always names its own version.
    backend.appVersion().then((v) => setVersion(String(v || '').trim())).catch(() => {});
    return () => detachProgress();
  }, [open, refreshTools, detachProgress]);

  // Live folder check on step one, debounced — the field is typed into as well
  // as browsed to, and Next is gated on the answer.
  useEffect(() => {
    if (!open) return undefined;
    const path = gamePath.trim();
    if (!path) { setGameCheck(null); return undefined; }
    let alive = true;
    setGameCheck({ state: 'checking', message: 'Checking…' });
    const t = setTimeout(() => {
      checkGamePath(path).then((res) => { if (alive) setGameCheck(res); });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [open, gamePath]);

  // HD packs are laid out however their author felt like, so this asks only
  // whether the folder is there.
  useEffect(() => {
    if (!open) return undefined;
    const path = hdPath.trim();
    if (!path) { setHdCheck(null); return undefined; }
    let alive = true;
    setHdCheck({ state: 'checking', message: 'Checking…' });
    const t = setTimeout(() => {
      backend.listDir(path)
        .then(() => { if (alive) setHdCheck({ state: 'ok', message: 'Folder found.' }); })
        .catch(() => {
          if (alive) setHdCheck({ state: 'missing', message: `Folder not found: ${path}` });
        });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [open, hdPath]);

  // The last step's "quick test": what the DAT lists look like on disk, and
  // whether xi-tools has newer copies. Runs once, when the step is reached.
  const checkLists = useCallback(async () => {
    setLists({ busy: true, count: 0, names: [], error: '' });
    try {
      const res = await backend.listsUpdate();
      setLists({
        busy: false,
        count: res?.updated?.length ?? 0,
        names: res?.updated || [],
        error: res?.error || '',
      });
    } catch (e) {
      // Offline is not a failed setup — the lists that ship with the build work.
      setLists({ busy: false, count: 0, names: [], error: String(e?.message || e) });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    if (STEPS[step]?.id !== 'ready' || lists) return;
    checkLists();
  }, [open, step, lists, checkLists]);

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

  const browseGame = async () => {
    const picked = await backend.pickFolder(gamePath);
    if (picked) setGamePath(picked);
  };
  const browseHd = async () => {
    const picked = await backend.pickFolder(hdPath || gamePath);
    if (picked) { setHdPath(picked); setHdSkipped(false); }
  };

  const installTools = async () => {
    setToolsBusy(true);
    setToolsErr('');
    setToolsSkipped(false);
    setToolsProgress({ label: 'Starting…', pct: 0, detail: '' });
    detachProgress();
    try {
      unlistenRef.current = [
        await backend.onToolsProgress((p) => setToolsProgress({
          label: p.label || '',
          pct: Number.isFinite(p.pct) ? p.pct : 0,
          detail: formatProgressDetail(p),
        })),
      ];
    } catch { /* browser */ }
    try {
      const st = await backend.toolsInstallOrUpdate();
      setTools(st);
      // Python/uv on top of the download — without it `xi` runs nothing.
      if (st.toolsDir) {
        try { await backend.xiSetup(st.toolsDir, true); } catch { /* Settings can retry */ }
      }
      await refreshTools();
    } catch (e) {
      setToolsErr(String(e?.message || e));
    } finally {
      detachProgress();
      setToolsBusy(false);
      setToolsProgress(null);
    }
  };

  const toolsReady = !!tools?.installed && !toolsErr;
  const id = STEPS[step].id;
  const gameOk = !!gameCheck && gameCheck.state !== 'missing' && gameCheck.state !== 'checking';
  const hdOk = !hdPath.trim() || hdCheck?.state === 'ok';

  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));
  const skipHd = () => { setHdPath(''); setHdSkipped(true); next(); };
  const skipTools = () => { setToolsSkipped(true); next(); };

  const style = pos
    ? { left: pos.x, top: pos.y, transform: 'none' }
    : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };

  return (
    <div className="modal-backdrop setup-backdrop">
      <div className="modal setup-modal" ref={panelRef} style={style}>
        <div
          className="modal-header setup-header"
          onPointerDown={startDrag}
          onPointerMove={onDrag}
          onPointerUp={endDrag}
        >
          <span className="icon">rocket_launch</span>
          <span className="modal-title">Welcome to XI Model Viewer</span>
          <span className="setup-count mono">{`Step ${step + 1} of ${STEPS.length}`}</span>
        </div>
        <div className="setup-progress" aria-hidden="true">
          <div
            className="setup-progress-fill"
            style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
          />
        </div>

        <div className="setup-main">
          <aside className="setup-rail">
            <img className="setup-logo" src="./icon.png" alt="" width={64} draggable={false} />
            <div className="setup-brand">XI Model Viewer</div>
            {version && <div className="setup-version mono">v{version}</div>}

            <ol className="setup-steps">
              {STEPS.map((s, i) => (
                <li
                  key={s.id}
                  className={`setup-step${i === step ? ' on' : ''}${i < step ? ' done' : ''}`}
                  aria-current={i === step ? 'step' : undefined}
                >
                  <span className="setup-dot">
                    <span className="icon">{i < step ? 'check' : s.icon}</span>
                  </span>
                  <span className="setup-step-text">
                    <span className="setup-step-label">{s.label}</span>
                    <span className="setup-step-hint">{s.hint}</span>
                  </span>
                </li>
              ))}
            </ol>
          </aside>

          <div className="modal-body setup-body">
            {id === 'game' && (
              <section className="setup-pane" key="game">
                <div className="setup-lead">Set your FINAL FANTASY XI folder</div>
                <div className="setup-blurb">
                  Everything the viewer reads — models, zones, music, images — comes out of
                  the DATs in your install. Point at the folder that holds
                  {' '}<span className="mono">ROM</span> and <span className="mono">FFXiMain.dll</span>.
                </div>
                <div className="form-inline">
                  <input
                    type="text"
                    value={gamePath}
                    spellCheck={false}
                    autoFocus
                    placeholder="Your FINAL FANTASY XI install folder"
                    onChange={(e) => setGamePath(e.target.value)}
                  />
                  <Button className="active" onClick={browseGame}>
                    <span className="icon">folder_open</span>
                    Browse
                  </Button>
                </div>
                {gameCheck ? (
                  <div className={`xi-status settings-path-status ${GAME_CHECK[gameCheck.state].cls}`}>
                    <span className={`icon${gameCheck.state === 'checking' ? ' spin' : ''}`}>
                      {GAME_CHECK[gameCheck.state].icon}
                    </span>
                    <span className="xi-status-msg">{gameCheck.message}</span>
                  </div>
                ) : (
                  <div className="setup-hint">
                    <span className="icon">lightbulb</span>
                    <span>
                      A retail install usually sits at
                      {' '}<span className="mono">C:\Program Files (x86)\PlayOnline\SquareEnix\FINAL FANTASY XI</span>.
                    </span>
                  </div>
                )}
              </section>
            )}

            {id === 'hd' && (
              <section className="setup-pane" key="hd">
                <div className="setup-lead">Using an HD texture pack?</div>
                <div className="setup-blurb">
                  Packs like Ashenbubs HD replace the game&apos;s textures with higher-resolution
                  copies. Point at the pack&apos;s root and the viewer reads from it first, with
                  the original install as the fallback.
                </div>
                <div className="form-inline">
                  <input
                    type="text"
                    value={hdPath}
                    spellCheck={false}
                    placeholder="Optional HD pack root"
                    onChange={(e) => setHdPath(e.target.value)}
                  />
                  <Button onClick={browseHd}>
                    <span className="icon">folder_open</span>
                    Browse
                  </Button>
                </div>
                {hdCheck ? (
                  <div className={`xi-status settings-path-status ${GAME_CHECK[hdCheck.state].cls}`}>
                    <span className={`icon${hdCheck.state === 'checking' ? ' spin' : ''}`}>
                      {GAME_CHECK[hdCheck.state].icon}
                    </span>
                    <span className="xi-status-msg">{hdCheck.message}</span>
                  </div>
                ) : (
                  <div className="setup-hint">
                    <span className="icon">lightbulb</span>
                    <span>
                      Typical path:
                      {' '}<span className="mono">Ashita/polplugins/DATs/ffxi-hd/</span>
                    </span>
                  </div>
                )}
              </section>
            )}

            {id === 'tools' && (
              <section className="setup-pane" key="tools">
                <div className="setup-lead">Install XI Tools?</div>
                <div className="setup-blurb">
                  XI Tools is the toolkit to support Exporting and Batch Exporting. This can be
                  installed later if you don&apos;t plan to export just yet.
                </div>

                <div className="setup-chips">
                  {['GLB / glTF', 'FBX', 'Textures', 'Animations', 'Full poses'].map((c) => (
                    <span className="setup-chip" key={c}>{c}</span>
                  ))}
                </div>

                <div className={`xi-status${toolsBusy ? ' busy' : ''}${toolsReady ? ' ok' : ''}`}>
                  <span className={`icon${toolsBusy ? ' spin' : ''}`}>
                    {toolsBusy ? 'progress_activity' : (toolsReady ? 'check_circle' : 'download')}
                  </span>
                  <span className="xi-status-msg">
                    {toolsBusy ? (toolsProgress?.label || 'Installing…')
                      : toolsReady ? `Installed${tools?.localVersion ? ` · v${tools.localVersion}` : ''}`
                        : 'Not installed yet.'}
                  </span>
                </div>

                {toolsProgress && (
                  <div className="tools-progress">
                    <div className="tools-progress-bar">
                      <div
                        className="tools-progress-fill"
                        style={{ width: `${Math.min(100, toolsProgress.pct || 0)}%` }}
                      />
                    </div>
                    <div className="tools-progress-meta mono">
                      {toolsProgress.detail || toolsProgress.label}
                    </div>
                  </div>
                )}

                <div className="form-inline tools-actions">
                  <Button className="active" disabled={toolsBusy} onClick={installTools}>
                    <span className="icon">download</span>
                    {toolsReady ? 'Reinstall' : 'Install XI Tools'}
                  </Button>
                </div>

                {toolsErr && (
                  <div className="form-error" role="alert">
                    <span className="icon">error</span>
                    <span>{toolsErr}</span>
                  </div>
                )}

                <div className="form-hint">
                  Already have XI Tools? You can point at your own copy in Settings later.
                </div>
              </section>
            )}

            {id === 'ready' && (
              <section className="setup-pane setup-pane-ready" key="ready">
                <div className="setup-lead">
                  <span className="icon setup-lead-icon">check_circle</span>
                  You&apos;re set up
                </div>
                <div className="setup-blurb">
                  One last check on the DAT lists — the names behind every gear row, zone and
                  animation, refreshed from xi-tools.
                </div>
                <ul className="setup-check">
                  <CheckRow
                    ok
                    icon="folder_open"
                    label="FINAL FANTASY XI folder"
                    detail={gamePath.trim()}
                  />
                  <CheckRow
                    ok={!!hdPath.trim()}
                    icon="hd"
                    label="HD texture pack"
                    detail={hdPath.trim() || (hdSkipped ? 'Skipped — set it later in Settings' : 'Not set')}
                  />
                  <CheckRow
                    ok={toolsReady}
                    icon="terminal"
                    label="XI Tools"
                    detail={toolsReady
                      ? `Installed${tools?.localVersion ? ` · v${tools.localVersion}` : ''}`
                      : (toolsSkipped ? 'Skipped — Export needs it' : 'Not installed')}
                  />
                  <CheckRow
                    busy={lists?.busy}
                    ok={!!lists && !lists.busy && !lists.error}
                    icon="format_list_bulleted"
                    label="DAT lists"
                    detail={listsDetail(lists)}
                  />
                </ul>
              </section>
            )}
          </div>
          <div className="modal-actions setup-actions">
            {step > 0 && (
              <Button onClick={back} disabled={toolsBusy}>
                <span className="icon">arrow_back</span>
                Back
              </Button>
            )}
            <span className="setup-spacer" />
            {id === 'hd' && <Button onClick={skipHd}>Skip</Button>}
            {id === 'tools' && <Button onClick={skipTools} disabled={toolsBusy}>Skip</Button>}
            {id === 'ready' ? (
              <Button
                className="active setup-go"
                onClick={() => onFinish({
                  gamePath: gamePath.trim(),
                  hdPath: hdPath.trim(),
                  xiPath: (tools?.toolsDir || '').trim(),
                })}
              >
                <span className="icon">rocket_launch</span>
                Ready to go!
              </Button>
            ) : (
              <Button
                className="active"
                disabled={(id === 'game' && !gameOk) || (id === 'hd' && !hdOk) || toolsBusy}
                onClick={next}
              >
                Next
                <span className="icon">arrow_forward</span>
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CheckRow({ ok, busy, icon, label, detail }) {
  const cls = busy ? 'busy' : (ok ? 'ok' : 'skip');
  const mark = busy ? 'progress_activity' : (ok ? 'check' : 'remove');
  return (
    <li className={`setup-check-row ${cls}`}>
      <span className="icon setup-check-icon">{icon}</span>
      <span className="setup-check-label">{label}</span>
      <span className="setup-check-detail mono">{detail}</span>
      <span className={`setup-check-mark icon${busy ? ' spin' : ''}`}>{mark}</span>
    </li>
  );
}

function listsDetail(lists) {
  if (!lists) return 'Waiting…';
  if (lists.busy) return 'Checking xi-tools…';
  if (lists.error) return `Offline — using the lists in this build (${lists.error})`;
  if (!lists.count) return 'Up to date';
  const names = (lists.names || []).map(prettyList).slice(0, 3).join(', ');
  const rest = (lists.names || []).length - 3;
  return `Updated ${lists.count}: ${names}${rest > 0 ? ` +${rest}` : ''}`;
}

function clamp(p, panel) {
  const w = panel?.offsetWidth ?? 780;
  const h = panel?.offsetHeight ?? 480;
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}
