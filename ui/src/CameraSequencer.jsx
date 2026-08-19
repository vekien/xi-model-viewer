import { useEffect, useMemo, useRef, useState } from 'react';
import { Combo } from './Combo.jsx';
import { Tooltip } from './Tooltip.jsx';
import { CameraSequence, driveCamera, poseFromCamera, sampleScene } from '../js/camseq.js';

const DOC_KEY = 'camSeq';           // the sequence currently being edited
const LIB_KEY = 'camSeqLibrary';    // { [name]: doc } — saved sequences
const POS_KEY = 'camSeqPanelPos';
const SIZE_KEY = 'camSeqPanelSize';
const FPS_CHOICES = [24, 30, 60];
const MIN_FRAMES = 2;
const MAX_FRAMES = 36000;           // 20 minutes at 30fps — a sanity bound, not a target
const SCENE_HZ = 10;                // weather/time re-apply rate; see applyScene
const MIN_W = 940;
const DEFAULT_W = 940;
const PANEL_H = 300;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const EMPTY_DOC = {
  name: '', totalFrames: 300, fps: 30, curve: true, loop: false, cine: true, snap: false,
  camera: [], scene: [],
};
const SNAP_FRAMES = 15;

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
}

/** Normalise anything that comes back out of storage into a full document. */
function toDoc(raw) {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_DOC };
  // Migrate old whole-timeline `ease` → path `curve` (spline on/off).
  let curve = raw.curve;
  if (curve == null && raw.ease != null) curve = !!raw.ease;
  if (curve == null) curve = true;
  return {
    ...EMPTY_DOC,
    ...raw,
    curve: !!curve,
    // `keys` is the pre-timeline field name — carry an old saved sequence over.
    camera: Array.isArray(raw.camera) ? raw.camera : (Array.isArray(raw.keys) ? raw.keys : []),
    scene: Array.isArray(raw.scene) ? raw.scene : [],
    totalFrames: clamp(Math.round(raw.totalFrames ?? 300), MIN_FRAMES, MAX_FRAMES),
    fps: FPS_CHOICES.includes(raw.fps) ? raw.fps : 30,
  };
}

/** Evenly spaced second ticks across the ruler, snapped to a readable interval. */
function rulerTicks(totalFrames, fps) {
  const dur = totalFrames / fps;
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120].find((s) => s >= dur / 8) ?? 300;
  const out = [];
  for (let t = 0; t <= dur + 1e-3; t += step) {
    out.push({ t, x: ((t * fps) / totalFrames) * 100 });
  }
  return out;
}

/**
 * Camera Sequencer: a two-track timeline you scrub, record onto, and fly.
 *
 * A floating panel rather than a modal — the camera has to stay flyable between
 * takes, so this must never put a backdrop over the viewport. It owns its own
 * playhead and drives the camera straight through `rendererRef`, which keeps a
 * 60fps playback out of App's render tree; App only lends it a slot in the
 * existing rAF loop (`tickRef`) so the pose is set in the frame it is drawn.
 *
 * Recording is playhead-based, like any sequencer: a take lands on whatever
 * frame the playhead is parked at, and recording again on the same frame
 * replaces it. Nothing is ever auto-spaced behind your back.
 *
 * Mounted only while open — the unmount cleanup is what releases the camera and
 * puts the UI back if a take is still running when the panel is closed.
 */
export function CameraSequencer({
  onClose, rendererRef, tickRef,
  weathers = [], weather = '', timeMinutes = 720, onScene, onStopClock,
}) {
  const [doc, setDoc] = useState(() => toDoc(readJson(DOC_KEY)));
  const [library, setLibrary] = useState(() => readJson(LIB_KEY) ?? {});
  const [pos, setPos] = useState(() => readJson(POS_KEY));
  const [width, setWidth] = useState(() => {
    const s = readJson(SIZE_KEY);
    return clamp(Math.round(s?.w ?? s ?? DEFAULT_W), MIN_W, 1600);
  });
  const [name, setName] = useState(() => toDoc(readJson(DOC_KEY)).name ?? '');
  const [lengthText, setLengthText] = useState(() => String(toDoc(readJson(DOC_KEY)).totalFrames));

  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [hidden, setHidden] = useState(false);      // cinematic playback in progress
  const [selected, setSelected] = useState(null);   // { track: 'camera'|'scene', id }

  const { totalFrames, fps, curve, loop, cine, snap } = doc;

  const panelRef = useRef(null);
  const bodyRef = useRef(null);
  const playheadRef = useRef(null);
  const readoutRef = useRef(null);
  const dragRef = useRef(null);
  const kfDragRef = useRef(null);
  const idRef = useRef(
    [...doc.camera, ...doc.scene].reduce((m, k) => Math.max(m, k.id ?? 0), 0) + 1,
  );
  // Playback reads these from inside the rAF tick, where React state is stale.
  const playingRef = useRef(false);
  const frameRef = useRef(0);
  const docRef = useRef(doc);
  const seqRef = useRef(null);
  const sceneRef = useRef({ at: -1, weather: null });
  const uiSyncRef = useRef(0);
  // Pose to put the camera back to when playback is cancelled, plus whether the
  // camera is currently ours to put back.
  const restoreRef = useRef(null);
  const drivenRef = useRef(false);
  const cineRef = useRef(null);
  const stopRef = useRef(null);
  const sceneApplyRef = useRef(null);

  docRef.current = doc;

  const seq = useMemo(
    () => new CameraSequence(doc.camera, { totalFrames, curve: curve ? 'spline' : 'linear' }),
    [doc.camera, totalFrames, curve],
  );
  seqRef.current = seq;

  useEffect(() => { writeJson(DOC_KEY, { ...doc, name }); }, [doc, name]);
  useEffect(() => { writeJson(POS_KEY, pos); }, [pos]);
  useEffect(() => { writeJson(SIZE_KEY, { w: width }); }, [width]);
  useEffect(() => { setLengthText(String(totalFrames)); }, [totalFrames]);

  const patch = (fields) => setDoc((d) => ({ ...d, ...fields }));

  // --- route overlay in the viewport ---------------------------------------

  useEffect(() => {
    const r = rendererRef.current;
    if (!r?.setCameraPath) return undefined;
    if (hidden || !doc.camera.length) r.setCameraPath(null);
    else r.setCameraPath({ points: seq.path(160), keys: doc.camera });
    return () => r.setCameraPath?.(null);
  }, [seq, doc.camera, hidden, rendererRef]);

  // --- cinematic (hide everything but the render) ---------------------------

  const enterCinematic = () => {
    const r = rendererRef.current;
    // The Explorer nudges the scene right to stay centred under it; with the
    // panels gone that shift would frame the shot off-centre.
    cineRef.current = { screenOffsetX: r?.screenOffsetX ?? 0 };
    if (r) r.screenOffsetX = 0;
    document.body.classList.add('cinematic');
    setHidden(true);
  };

  const exitCinematic = () => {
    const r = rendererRef.current;
    if (r && cineRef.current) r.screenOffsetX = cineRef.current.screenOffsetX;
    cineRef.current = null;
    document.body.classList.remove('cinematic');
    setHidden(false);
  };

  // --- driving the scene ----------------------------------------------------

  /**
   * Push the scene track's weather / time of day for a frame.
   *
   * Rate-limited: each call re-resolves the environment and rebuilds the sky
   * dome, which is interactive-rate work, not 60 Hz work (the zone panel's own
   * day clock ticks at the same 10 Hz for the same reason). A weather *change*
   * always goes through immediately — that's a 3.33s cross-fade you don't want
   * starting up to a tenth of a second late.
   */
  sceneApplyRef.current = (easedF, force) => {
    const d = docRef.current;
    if (!d.scene.length || !onScene) return;
    const s = sampleScene(d.scene, easedF);
    if (!s) return;
    const now = performance.now();
    const changed = s.weather !== sceneRef.current.weather;
    if (!force && !changed && now - sceneRef.current.at < 1000 / SCENE_HZ) return;
    sceneRef.current = { at: now, weather: s.weather };
    onScene(s.weather, s.timeMinutes);
  };

  // --- transport ------------------------------------------------------------

  const camera = () => rendererRef.current?.camera ?? null;

  const markRestore = () => {
    const cam = camera();
    if (!cam || drivenRef.current) return;
    restoreRef.current = cam.snapshot();
    drivenRef.current = true;
  };

  /** Move the playhead and show that frame — the scrub path and the seek path. */
  const goTo = (f, opts = {}) => {
    const clamped = clamp(Math.round(f), 0, totalFrames);
    frameRef.current = clamped;
    setFrame(clamped);
    const cam = camera();
    if (!cam) return;
    const easedF = seqRef.current?.easedFrame(clamped) ?? clamped;
    const pose = seqRef.current?.sample(clamped);
    if (pose && !opts.timeOnly) {
      markRestore();
      driveCamera(cam, pose);
    }
    sceneApplyRef.current(easedF, true);
  };

  const play = () => {
    const cam = camera();
    if (!cam || doc.camera.length < 2) return;
    markRestore();
    onStopClock?.();   // the zone day-clock would fight the scene track
    // Parked at the end from the last run — start over rather than sit still.
    if (frameRef.current >= totalFrames) { frameRef.current = 0; setFrame(0); }
    playingRef.current = true;
    setPlaying(true);
    cam.sequenceLock = true;
    if (cine) enterCinematic();
  };

  /** `restore` puts the camera back where it was before the sequence took it. */
  const stop = (restore) => {
    const cam = camera();
    playingRef.current = false;
    setPlaying(false);
    setFrame(Math.round(frameRef.current));
    if (cam) cam.sequenceLock = false;
    if (cineRef.current) exitCinematic();
    if (restore && cam && restoreRef.current) cam.restore(restoreRef.current);
    if (restore) { restoreRef.current = null; drivenRef.current = false; }
  };
  stopRef.current = stop;

  // --- the per-frame tick, borrowed from App's render loop ------------------

  useEffect(() => {
    if (!tickRef) return undefined;
    tickRef.current = (dt) => {
      if (!playingRef.current) return;
      const s = seqRef.current;
      const cam = rendererRef.current?.camera;
      const d = docRef.current;
      if (!s?.length || !cam) return;
      let f = frameRef.current + dt * d.fps;
      let done = false;
      if (f >= d.totalFrames) {
        if (d.loop) f %= d.totalFrames;
        else { f = d.totalFrames; done = true; }
      }
      frameRef.current = f;
      const pose = s.sample(f);
      if (pose) driveCamera(cam, pose);
      sceneApplyRef.current(s.easedFrame(f), false);

      // The playhead and the readout are written straight to the DOM: a React
      // update per frame would re-render the whole timeline 60 times a second.
      // State still catches up a few times a second so an unrelated re-render
      // (a weather keyframe firing, say) doesn't snap the playhead backwards.
      const pct = (f / d.totalFrames) * 100;
      if (playheadRef.current) playheadRef.current.style.left = `${pct}%`;
      if (readoutRef.current) readoutRef.current.textContent = String(Math.round(f));
      const now = performance.now();
      if (now - uiSyncRef.current > 200) { uiSyncRef.current = now; setFrame(Math.round(f)); }

      // Ran to the end: stop, but leave the camera on the closing shot — you
      // just watched it land there, so yanking it back would be the surprise.
      if (done) stopRef.current(false);
    };
    return () => { tickRef.current = null; };
  }, [tickRef, rendererRef]);

  // Escape ends a run and puts everything back. Capture phase so it beats App's
  // modal handler, which would otherwise also act on the same key.
  useEffect(() => {
    if (!playing) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      stopRef.current(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [playing]);

  // Space toggles play / pause (same as the transport button).
  const playRef = useRef(play);
  playRef.current = play;
  useEffect(() => {
    const isTyping = (t) => {
      const tag = t?.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable;
    };
    const onKey = (e) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (isTyping(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (playingRef.current) stopRef.current(false);
      else playRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Closing the panel must not leave the camera locked or the UI hidden.
  useEffect(() => () => {
    const cam = rendererRef.current?.camera;
    if (cam) cam.sequenceLock = false;
    document.body.classList.remove('cinematic');
    if (rendererRef.current && cineRef.current) {
      rendererRef.current.screenOffsetX = cineRef.current.screenOffsetX;
    }
  }, [rendererRef]);

  // --- keyframes ------------------------------------------------------------

  /** Record onto `track` at the playhead, replacing whatever is already there. */
  const recordAt = (track, payload) => {
    const at = snapFrame(frameRef.current);
    // Reuse the id when overwriting so the row stays the selected one.
    const id = docRef.current[track].find((k) => k.frame === at)?.id ?? idRef.current++;
    setDoc((d) => ({
      ...d,
      [track]: [...d[track].filter((k) => k.frame !== at), { id, frame: at, ...payload }]
        .sort((a, b) => a.frame - b.frame),
    }));
    setSelected({ track, id });
  };

  const recordCamera = () => {
    const cam = camera();
    if (cam) recordAt('camera', poseFromCamera(cam));
  };

  const recordScene = () => recordAt('scene', { weather, timeMinutes: Math.round(timeMinutes) });

  const removeKey = (track, id) => {
    setDoc((d) => ({ ...d, [track]: d[track].filter((k) => k.id !== id) }));
    setSelected((s) => (s && s.track === track && s.id === id ? null : s));
  };

  // Delete / Backspace removes the selected keyframe only (not clear-all).
  useEffect(() => {
    if (!selected) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const t = e.target;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
      e.preventDefault();
      removeKey(selected.track, selected.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  const moveKey = (track, id, toFrame) => {
    const f = snapFrame(toFrame);
    setDoc((d) => ({
      ...d,
      [track]: d[track]
        // Landing on another keyframe's frame replaces it, same as recording there.
        .filter((k) => k.id === id || k.frame !== f)
        .map((k) => (k.id === id ? { ...k, frame: f } : k))
        .sort((a, b) => a.frame - b.frame),
    }));
  };

  const selectedKey = selected
    ? doc[selected.track].find((k) => k.id === selected.id) ?? null
    : null;

  // --- timeline pointer handling -------------------------------------------

  const snapFrame = (f) => {
    const raw = clamp(Math.round(f), 0, totalFrames);
    if (!docRef.current.snap) return raw;
    // Quantize to SNAP_FRAMES; keep 0 and the end frame reachable.
    if (raw <= 0) return 0;
    if (raw >= totalFrames) return totalFrames;
    return clamp(Math.round(raw / SNAP_FRAMES) * SNAP_FRAMES, 0, totalFrames);
  };

  const frameAtClientX = (clientX) => {
    const r = bodyRef.current?.getBoundingClientRect();
    if (!r) return 0;
    const raw = ((clientX - r.left) / (r.width || 1)) * totalFrames;
    return snapFrame(raw);
  };

  const onBodyDown = (e) => {
    if (playing) stop(false);
    bodyRef.current.setPointerCapture(e.pointerId);
    dragRef.current = 'scrub';
    goTo(frameAtClientX(e.clientX));
  };
  const onBodyMove = (e) => {
    if (!dragRef.current) return;
    const f = frameAtClientX(e.clientX);
    if (kfDragRef.current) {
      const kd = kfDragRef.current;
      if (!kd.moved && Math.hypot(e.clientX - kd.x0, e.clientY - kd.y0) > 3) kd.moved = true;
      if (kd.moved) moveKey(kd.track, kd.id, f);
    }
    goTo(f);
  };
  const onBodyUp = (e) => {
    // Click (no drag) on a keyframe keeps it selected for Delete.
    dragRef.current = null;
    kfDragRef.current = null;
    try { bodyRef.current?.releasePointerCapture(e.pointerId); } catch { /* */ }
  };

  const onDotDown = (e, track, k) => {
    e.stopPropagation();
    e.preventDefault();
    if (playing) stop(false);
    setSelected({ track, id: k.id });
    bodyRef.current.setPointerCapture(e.pointerId);
    dragRef.current = 'keyframe';
    kfDragRef.current = { track, id: k.id, x0: e.clientX, y0: e.clientY, moved: false };
    goTo(k.frame);
  };

  // --- saved sequences ------------------------------------------------------

  const saveAs = () => {
    const key = name.trim();
    if (!key) return;
    const next = { ...library, [key]: { ...doc, name: key } };
    setLibrary(next);
    writeJson(LIB_KEY, next);
  };

  const load = (key) => {
    const raw = library[key];
    if (!raw) return;
    if (playing) stop(true);
    const loaded = toDoc(raw);
    setDoc(loaded);
    setName(key);
    setSelected(null);
    frameRef.current = 0;
    setFrame(0);
  };

  const removeSaved = () => {
    const key = name.trim();
    if (!library[key]) return;
    const next = { ...library };
    delete next[key];
    setLibrary(next);
    writeJson(LIB_KEY, next);
  };

  const clearAll = () => {
    if (playing) stop(true);
    setDoc({ ...EMPTY_DOC, fps, totalFrames, curve, loop, cine, snap });
    setSelected(null);
    frameRef.current = 0;
    setFrame(0);
  };

  /** Nudge playhead by ±1 frame (respects Snap when on). */
  const stepFrame = (dir) => {
    if (playing) stop(false);
    const step = docRef.current.snap ? SNAP_FRAMES : 1;
    goTo(Math.round(frameRef.current) + dir * step);
  };

  // --- panel drag / resize --------------------------------------------------

  const panelDrag = useRef(null);
  const resizeRef = useRef(null);
  const startDrag = (e) => {
    if (e.target.closest('button, input, select, a, [role="button"], .cseq-resize')) return;
    const rect = panelRef.current.getBoundingClientRect();
    // Pin absolute coords so width resize doesn't fight right:auto layout.
    if (!pos) setPos({ x: rect.left, y: rect.top });
    panelDrag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPanelDrag = (e) => {
    if (!panelDrag.current) return;
    const el = panelRef.current;
    const w = el?.offsetWidth ?? width;
    setPos({
      x: clamp(e.clientX - panelDrag.current.dx, 0, Math.max(window.innerWidth - w, 0)),
      y: clamp(e.clientY - panelDrag.current.dy, 0, Math.max(window.innerHeight - PANEL_H, 0)),
    });
  };
  const endDrag = () => { panelDrag.current = null; };

  const startResize = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = panelRef.current.getBoundingClientRect();
    if (!pos) setPos({ x: rect.left, y: rect.top });
    resizeRef.current = { x0: e.clientX, w0: rect.width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e) => {
    if (!resizeRef.current) return;
    const { x0, w0 } = resizeRef.current;
    const maxW = Math.max(MIN_W, window.innerWidth - 16);
    setWidth(clamp(Math.round(w0 + (e.clientX - x0)), MIN_W, maxW));
  };
  const endResize = () => { resizeRef.current = null; };

  // --- render ---------------------------------------------------------------

  const savedNames = Object.keys(library).sort((a, b) => a.localeCompare(b));
  const ticks = rulerTicks(totalFrames, fps);
  const seconds = (totalFrames / fps).toFixed(1);
  const shown = Math.round(frame);
  const canRecordScene = weathers.length > 0;
  const style = {
    width,
    ...(pos ? { left: pos.x, top: pos.y, right: 'auto' } : null),
  };

  const dot = (track, k, cls) => {
    const past = k.frame > totalFrames;
    const sel = selectedKey?.id === k.id && selected?.track === track;
    return (
      <span
        key={k.id}
        className={`cseq-dot ${cls}${sel ? ' sel' : ''}${past ? ' past' : ''}`}
        style={{ left: `${(clamp(k.frame, 0, totalFrames) / totalFrames) * 100}%` }}
        title={past
          ? `Frame ${k.frame} — past the end of the sequence`
          : `Frame ${k.frame} · ${(k.frame / fps).toFixed(2)}s · Del to remove`}
        onPointerDown={(e) => onDotDown(e, track, k)}
      />
    );
  };

  return (
    <div id="camseq" className="panel" ref={panelRef} style={style}>
      <div
        className="cseq-header"
        onPointerDown={startDrag}
        onPointerMove={onPanelDrag}
        onPointerUp={endDrag}
      >
        <span className="icon">movie</span>
        <span className="cseq-title">Camera Sequencer</span>
        <button type="button" className="icon-btn cseq-close" onClick={onClose} title="Close">
          <span className="icon">close</span>
        </button>
      </div>

      <div className="cseq-body">
        {/* Saved sequences */}
        <div className="cseq-row">
          <input
            type="text"
            className="cseq-text"
            placeholder="Sequence name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Tooltip content="Save under this name" placement="top">
            <button type="button" className="cseq-btn" disabled={!name.trim()} onClick={saveAs}>Save</button>
          </Tooltip>
          <Tooltip content={savedNames.length ? 'Load a saved sequence' : 'Nothing saved yet'} placement="top">
            <div className="cseq-load">
              <Combo
                value={savedNames.includes(name.trim()) ? name.trim() : ''}
                items={savedNames.map((n) => ({ id: n, label: n }))}
                placeholder={savedNames.length ? 'Load…' : 'None saved'}
                onChange={load}
              />
            </div>
          </Tooltip>
          <Tooltip content="Delete the saved sequence with this name" placement="top">
            <button
              type="button"
              className="icon-btn cseq-icon cseq-del"
              aria-label="Delete saved sequence"
              disabled={!library[name.trim()]}
              onClick={removeSaved}
            >
              <span className="icon">delete</span>
            </button>
          </Tooltip>
        </div>

        {/* Length */}
        <div className="cseq-row">
          <span className="cseq-label">Length</span>
          <input
            type="text"
            inputMode="numeric"
            className="cseq-text cseq-len mono"
            value={lengthText}
            onChange={(e) => setLengthText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            onBlur={() => patch({ totalFrames: clamp(Math.round(Number(lengthText) || totalFrames), MIN_FRAMES, MAX_FRAMES) })}
          />
          <Tooltip content="Apply the length" placement="top">
            <button
              type="button"
              className="cseq-btn"
              onClick={() => patch({ totalFrames: clamp(Math.round(Number(lengthText) || totalFrames), MIN_FRAMES, MAX_FRAMES) })}
            >
              Set
            </button>
          </Tooltip>
          <span className="cseq-label">frames @</span>
          <select className="cseq-fps" value={fps} onChange={(e) => patch({ fps: +e.target.value })}>
            {FPS_CHOICES.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <span className="cseq-secs mono">{seconds}s</span>
        </div>

        {/* Timeline */}
        <div className="cseq-tl">
          <div className="cseq-tl-labels">
            <div className="cseq-tl-spacer" />
            <div className="cseq-tl-label">Camera</div>
            <div className="cseq-tl-label">Scene</div>
          </div>
          <div
            className="cseq-tl-track"
            ref={bodyRef}
            onPointerDown={onBodyDown}
            onPointerMove={onBodyMove}
            onPointerUp={onBodyUp}
            onPointerCancel={onBodyUp}
          >
            <div className="cseq-ruler">
              {ticks.map((t) => (
                <span className="cseq-tick" key={t.t} style={{ left: `${t.x}%` }}>
                  <i />
                  <span>{t.t < 10 ? t.t.toFixed(1) : t.t.toFixed(0)}s</span>
                </span>
              ))}
            </div>
            <div className="cseq-lane">{doc.camera.map((k) => dot('camera', k, 'cam'))}</div>
            <div className="cseq-lane">{doc.scene.map((k) => dot('scene', k, 'scn'))}</div>
            <div
              className="cseq-playhead"
              ref={playheadRef}
              style={{ left: `${(shown / totalFrames) * 100}%` }}
            />
          </div>
        </div>

        {/* Compact toolbar: transport | record | step | toggles | frame */}
        <div className="cseq-bar">
          <div className="cseq-bar-group">
            <Tooltip content={playing ? 'Pause (Space)' : 'Play (Space)'} placement="top">
              <button
                type="button"
                className={`cseq-play${playing ? ' playing' : ''}`}
                disabled={doc.camera.length < 2}
                onClick={() => (playing ? stop(false) : play())}
              >
                <span className="icon fill">{playing ? 'pause' : 'play_arrow'}</span>
              </button>
            </Tooltip>
            <Tooltip content="Stop and restore camera" placement="top">
              <button
                type="button"
                className="cseq-stop"
                onClick={() => { stop(true); frameRef.current = 0; setFrame(0); }}
              >
                <span className="icon fill">stop</span>
              </button>
            </Tooltip>
          </div>

          <div className="cseq-bar-sep" />

          <div className="cseq-bar-group">
            <Tooltip content="Record camera at playhead" placement="top">
              <button type="button" className="cseq-record" onClick={recordCamera}>
                <span className="icon fill">radio_button_checked</span>
                Camera
              </button>
            </Tooltip>
            <Tooltip
              content={canRecordScene ? 'Record weather & time at playhead' : 'Load a zone with a sky first'}
              placement="top"
            >
              <button
                type="button"
                className="cseq-record cseq-record-scene"
                disabled={!canRecordScene}
                onClick={recordScene}
              >
                <span className="icon fill">radio_button_checked</span>
                Scene
              </button>
            </Tooltip>
          </div>

          <div className="cseq-bar-sep" />

          <div className="cseq-bar-group">
            <Tooltip content={snap ? `−${SNAP_FRAMES} frames` : '−1 frame'} placement="top">
              <button type="button" className="icon-btn cseq-icon" aria-label="Previous frame" onClick={() => stepFrame(-1)}>
                <span className="icon">skip_previous</span>
              </button>
            </Tooltip>
            <Tooltip content={snap ? `+${SNAP_FRAMES} frames` : '+1 frame'} placement="top">
              <button type="button" className="icon-btn cseq-icon" aria-label="Next frame" onClick={() => stepFrame(1)}>
                <span className="icon">skip_next</span>
              </button>
            </Tooltip>
            <Tooltip content="Delete selected keyframe" placement="top">
              <button
                type="button"
                className="icon-btn cseq-icon cseq-del"
                aria-label="Delete keyframe"
                disabled={!selectedKey}
                onClick={() => selectedKey && removeKey(selected.track, selectedKey.id)}
              >
                <span className="icon">delete</span>
              </button>
            </Tooltip>
            <Tooltip content="Clear all keyframes" placement="top">
              <button
                type="button"
                className="icon-btn cseq-icon cseq-del"
                aria-label="Clear all keyframes"
                disabled={!doc.camera.length && !doc.scene.length}
                onClick={clearAll}
              >
                <span className="icon">layers_clear</span>
              </button>
            </Tooltip>
          </div>

          <div className="cseq-bar-sep" />

          <div className="cseq-bar-group cseq-toggles">
            <label className="switch cseq-switch" title="Loop playback">
              <input type="checkbox" checked={loop} onChange={(e) => patch({ loop: e.target.checked })} />
              <span className="track" />
              <span className="cseq-switch-label">Loop</span>
            </label>
            <label className="switch cseq-switch" title="Spline path through keys (off = straight lines)">
              <input type="checkbox" checked={!!curve} onChange={(e) => patch({ curve: e.target.checked })} />
              <span className="track" />
              <span className="cseq-switch-label">Curve</span>
            </label>
            <label className="switch cseq-switch" title="Hide UI while playing (Esc restores)">
              <input type="checkbox" checked={cine} onChange={(e) => patch({ cine: e.target.checked })} />
              <span className="track" />
              <span className="cseq-switch-label">Hide UI</span>
            </label>
            <label className="switch cseq-switch" title={`Snap to every ${SNAP_FRAMES} frames`}>
              <input type="checkbox" checked={!!snap} onChange={(e) => patch({ snap: e.target.checked })} />
              <span className="track" />
              <span className="cseq-switch-label">Snap</span>
            </label>
          </div>

          <span className="cseq-frame mono">
            <b ref={readoutRef}>{shown}</b>
            <span className="cseq-frame-dim"> / {totalFrames}</span>
            <span className="cseq-frame-s">{(shown / fps).toFixed(2)}s</span>
          </span>
        </div>

      </div>

      <div
        className="cseq-resize"
        title="Resize"
        onPointerDown={startResize}
        onPointerMove={onResizeMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
      />
    </div>
  );
}
