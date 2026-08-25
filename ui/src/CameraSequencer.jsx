import { useEffect, useMemo, useRef, useState } from 'react';
import { Combo } from './Combo.jsx';
import { Tooltip } from './Tooltip.jsx';
import { CameraSequence, driveCamera, poseFromCamera, sampleScene, sampleTod } from '../js/camseq.js';

// Working draft is intentionally NOT restored on open — a leftover camSeq used
// to auto-paint the last flythrough on the zone whenever the panel mounted.
// Named sequences live in the library and load only via the Load control.
const LIB_KEY = 'camSeqLibrary';    // { [name]: doc } — saved sequences
const POS_KEY = 'camSeqPanelPos';
const SIZE_KEY = 'camSeqPanelSize';
const LEGACY_DOC_KEY = 'camSeq';     // old auto-restored draft — cleared once
const FPS_CHOICES = [24, 30, 60];
const MIN_FRAMES = 2;
const MAX_FRAMES = 36000;           // 20 minutes at 30fps — a sanity bound, not a target
const SCENE_HZ = 10;                // weather/time re-apply rate; see applyScene
const MIN_W = 940;
const DEFAULT_W = 940;
const PANEL_H = 320;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const EMPTY_DOC = {
  name: '', totalFrames: 300, fps: 30, curve: true, loop: false, cine: true, snap: false,
  camera: [], scene: [], tod: [],
};
const SNAP_FRAMES = 15;
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.5;

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
  const scene = Array.isArray(raw.scene) ? raw.scene : [];
  // Older docs baked time-of-day into scene keys — split onto the tod track once.
  let tod = Array.isArray(raw.tod) ? raw.tod : null;
  if (!tod) {
    tod = scene
      .filter((k) => k.timeMinutes != null && Number.isFinite(k.timeMinutes))
      .map((k, i) => ({
        id: (k.id ?? i) + 1_000_000,
        frame: k.frame,
        timeMinutes: Math.round(k.timeMinutes),
      }));
  }
  return {
    ...EMPTY_DOC,
    ...raw,
    curve: !!curve,
    // `keys` is the pre-timeline field name — carry an old saved sequence over.
    camera: Array.isArray(raw.camera) ? raw.camera : (Array.isArray(raw.keys) ? raw.keys : []),
    scene,
    tod,
    totalFrames: clamp(Math.round(raw.totalFrames ?? 300), MIN_FRAMES, MAX_FRAMES),
    fps: FPS_CHOICES.includes(raw.fps) ? raw.fps : 30,
  };
}

/** Evenly spaced second ticks across the ruler, snapped to a readable interval. */
function rulerTicks(totalFrames, fps, zoom = 1) {
  const dur = totalFrames / fps;
  const niches = Math.max(8, Math.round(8 * zoom));
  const step = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120].find((s) => s >= dur / niches) ?? 300;
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
  // Always start blank. Load a saved sequence from the library explicitly.
  const [doc, setDoc] = useState(() => ({ ...EMPTY_DOC }));
  const [library, setLibrary] = useState(() => readJson(LIB_KEY) ?? {});
  const [pos, setPos] = useState(() => readJson(POS_KEY));
  const [width, setWidth] = useState(() => {
    const s = readJson(SIZE_KEY);
    return clamp(Math.round(s?.w ?? s ?? DEFAULT_W), MIN_W, 1600);
  });
  const [name, setName] = useState('');
  const [lengthText, setLengthText] = useState(() => String(EMPTY_DOC.totalFrames));

  // Drop the legacy auto-restored draft so a refresh never resurrects it.
  useEffect(() => {
    try { localStorage.removeItem(LEGACY_DOC_KEY); } catch { /* quota */ }
  }, []);

  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [hidden, setHidden] = useState(false);      // cinematic playback in progress
  /** Multi-select: { track, id }[]. Shift+click toggles; plain click replaces (or keeps if already in set). */
  const [selected, setSelected] = useState([]);
  const [zoom, setZoom] = useState(1);

  const { totalFrames, fps, curve, loop, cine, snap } = doc;

  const panelRef = useRef(null);
  const scrollRef = useRef(null);
  const bodyRef = useRef(null);
  const playheadRef = useRef(null);
  const readoutRef = useRef(null);
  const dragRef = useRef(null);
  const kfDragRef = useRef(null);
  const idRef = useRef(
    [...doc.camera, ...doc.scene, ...doc.tod].reduce((m, k) => Math.max(m, k.id ?? 0), 0) + 1,
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
   * Push scene weather + time-of-day tracks for a frame.
   *
   * Time-of-day applies every frame (smooth sun lerp — same path as the slider).
   * Weather still fires immediately on change; when neither weather nor time
   * moved, a small throttle avoids redundant work while scrubbing the same spot.
   */
  sceneApplyRef.current = (easedF, force) => {
    const d = docRef.current;
    if (!onScene) return;
    const s = d.scene.length ? sampleScene(d.scene, easedF) : null;
    const t = d.tod.length ? sampleTod(d.tod, easedF) : null;
    if (!s && !t) return;
    const w = s?.weather ?? sceneRef.current.weather ?? weather;
    // Dedicated tod track wins; legacy scene.timeMinutes is the fallback.
    const minutes = t?.timeMinutes ?? s?.timeMinutes;
    if (minutes == null && !s) return;
    const now = performance.now();
    const prevM = sceneRef.current.minutes;
    const weatherChanged = w !== sceneRef.current.weather;
    const timeChanged = minutes != null
      && (prevM == null || Math.abs(minutes - prevM) > 1e-3);
    if (!force && !weatherChanged && !timeChanged
      && now - sceneRef.current.at < 1000 / SCENE_HZ) return;
    sceneRef.current = { at: now, weather: w, minutes: minutes ?? prevM };
    onScene(w, minutes != null ? minutes : timeMinutes);
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
    const hasCam = doc.camera.length >= 2;
    const hasTod = doc.tod.length >= 2 || doc.scene.length >= 1;
    if (!cam || (!hasCam && !hasTod)) return;
    if (hasCam) markRestore();
    onStopClock?.();   // the zone day-clock would fight the scene/tod tracks
    // Parked at the end from the last run — start over rather than sit still.
    if (frameRef.current >= totalFrames) { frameRef.current = 0; setFrame(0); }
    playingRef.current = true;
    setPlaying(true);
    if (hasCam) cam.sequenceLock = true;
    if (cine && hasCam) enterCinematic();
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
      if (!cam) return;
      const hasCam = s?.length >= 2;
      if (!hasCam && !d.tod?.length && !d.scene?.length) return;
      let f = frameRef.current + dt * d.fps;
      let done = false;
      if (f >= d.totalFrames) {
        if (d.loop) f %= d.totalFrames;
        else { f = d.totalFrames; done = true; }
      }
      frameRef.current = f;
      if (hasCam) {
        const pose = s.sample(f);
        if (pose) driveCamera(cam, pose);
      }
      const easedF = hasCam ? s.easedFrame(f) : f;
      sceneApplyRef.current(easedF, false);

      // The playhead and the readout are written straight to the DOM: a React
      // update per frame would re-render the whole timeline 60 times a second.
      // State still catches up a few times a second so an unrelated re-render
      // (a weather keyframe firing, say) doesn't snap the playhead backwards.
      const pct = (f / d.totalFrames) * 100;
      if (playheadRef.current) playheadRef.current.style.left = `${pct}%`;
      if (readoutRef.current) readoutRef.current.textContent = String(Math.round(f));
      // Keep the playhead in the zoomed viewport while playing.
      const sc = scrollRef.current;
      const track = bodyRef.current;
      if (sc && track && sc.scrollWidth > sc.clientWidth + 1) {
        const x = (f / d.totalFrames) * track.offsetWidth;
        const pad = 48;
        if (x < sc.scrollLeft + pad) sc.scrollLeft = Math.max(0, x - pad);
        else if (x > sc.scrollLeft + sc.clientWidth - pad) {
          sc.scrollLeft = x - sc.clientWidth + pad;
        }
      }
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
    setSelected([{ track, id }]);
  };

  const recordCamera = () => {
    const cam = camera();
    if (cam) recordAt('camera', poseFromCamera(cam));
  };

  const recordScene = () => recordAt('scene', { weather });
  const recordTod = () => recordAt('tod', { timeMinutes: Math.round(timeMinutes) });

  const selKey = (track, id) => `${track}:${id}`;

  const removeKeys = (pairs) => {
    if (!pairs?.length) return;
    const drop = new Set(pairs.map((p) => selKey(p.track, p.id)));
    setDoc((d) => ({
      ...d,
      camera: d.camera.filter((k) => !drop.has(selKey('camera', k.id))),
      scene: d.scene.filter((k) => !drop.has(selKey('scene', k.id))),
      tod: d.tod.filter((k) => !drop.has(selKey('tod', k.id))),
    }));
    setSelected((s) => s.filter((x) => !drop.has(selKey(x.track, x.id))));
  };

  // Delete / Backspace removes every selected keyframe (not clear-all).
  useEffect(() => {
    if (!selected.length) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const t = e.target;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
      e.preventDefault();
      removeKeys(selected);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  /**
   * Move a set of keys by a shared frame delta (from drag-start origins).
   * Non-selected keys sitting on a landing frame are replaced.
   */
  const moveKeysByDelta = (items, delta) => {
    if (!items.length) return;
    const dMin = Math.max(...items.map((it) => -it.frame0));
    const dMax = Math.min(...items.map((it) => totalFrames - it.frame0));
    const d = clamp(Math.round(delta), dMin, dMax);
    setDoc((doc0) => {
      const byTrack = { camera: new Map(), scene: new Map(), tod: new Map() };
      for (const it of items) {
        byTrack[it.track].set(it.id, it.frame0 + d);
      }
      const next = { ...doc0 };
      for (const track of ['camera', 'scene', 'tod']) {
        const moves = byTrack[track];
        if (!moves.size) continue;
        const land = new Set(moves.values());
        next[track] = doc0[track]
          .filter((k) => moves.has(k.id) || !land.has(k.frame))
          .map((k) => (moves.has(k.id) ? { ...k, frame: moves.get(k.id) } : k))
          .sort((a, b) => a.frame - b.frame);
      }
      return next;
    });
  };

  const selectedSet = useMemo(
    () => new Set(selected.map((s) => selKey(s.track, s.id))),
    [selected],
  );
  const hasSelection = selected.length > 0;

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
    const track = bodyRef.current;
    if (!track) return 0;
    // Track moves with scroll, so clientX − left is already in content space.
    const r = track.getBoundingClientRect();
    const w = track.offsetWidth || r.width || 1;
    const raw = ((clientX - r.left) / w) * totalFrames;
    return snapFrame(raw);
  };

  /** Wheel pans the timeline left/right (vertical wheel → horizontal scroll). */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      // Prefer explicit horizontal delta; otherwise map vertical wheel to pan.
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!dx) return;
      if (el.scrollWidth <= el.clientWidth + 1) return;
      e.preventDefault();
      el.scrollLeft += dx;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const setZoomAround = (nextZoom) => {
    const z = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    const el = scrollRef.current;
    const track = bodyRef.current;
    if (!el || !track) {
      setZoom(z);
      return;
    }
    // Keep the viewport center (in frames) stable across the zoom change.
    const midX = el.scrollLeft + el.clientWidth / 2;
    const midFrac = midX / (track.offsetWidth || 1);
    setZoom(z);
    requestAnimationFrame(() => {
      const t = bodyRef.current;
      const sc = scrollRef.current;
      if (!t || !sc) return;
      sc.scrollLeft = midFrac * t.offsetWidth - sc.clientWidth / 2;
    });
  };
  const zoomIn = () => setZoomAround(zoom * ZOOM_STEP);
  const zoomOut = () => setZoomAround(zoom / ZOOM_STEP);

  const onBodyDown = (e) => {
    if (playing) stop(false);
    setSelected([]);
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
      if (kd.moved) {
        moveKeysByDelta(kd.items, f - kd.frame0);
        goTo(kd.frame0 + clamp(
          Math.round(f - kd.frame0),
          Math.max(...kd.items.map((it) => -it.frame0)),
          Math.min(...kd.items.map((it) => totalFrames - it.frame0)),
        ));
        return;
      }
    }
    goTo(f);
  };
  const onBodyUp = (e) => {
    // Click (no drag) on a keyframe keeps the selection for Delete.
    dragRef.current = null;
    kfDragRef.current = null;
    try { bodyRef.current?.releasePointerCapture(e.pointerId); } catch { /* */ }
  };

  const onDotDown = (e, track, k) => {
    e.stopPropagation();
    e.preventDefault();
    if (playing) stop(false);

    const hit = { track, id: k.id };
    const inSel = selected.some((s) => s.track === track && s.id === k.id);
    let nextSel;
    if (e.shiftKey) {
      nextSel = inSel
        ? selected.filter((s) => !(s.track === track && s.id === k.id))
        : [...selected, hit];
    } else if (inSel) {
      // Keep multi-select so a drag moves the whole group.
      nextSel = selected;
    } else {
      nextSel = [hit];
    }
    setSelected(nextSel);

    const d = docRef.current;
    const items = nextSel
      .map((s) => {
        const key = d[s.track].find((x) => x.id === s.id);
        return key ? { track: s.track, id: s.id, frame0: key.frame } : null;
      })
      .filter(Boolean);
    if (!items.length) return;

    bodyRef.current.setPointerCapture(e.pointerId);
    dragRef.current = 'keyframe';
    kfDragRef.current = {
      frame0: k.frame,
      x0: e.clientX,
      y0: e.clientY,
      moved: false,
      items,
    };
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
    setSelected([]);
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
    setSelected([]);
    frameRef.current = 0;
    setFrame(0);
  };

  /** Blank sequence — clears keys + name; keeps fps / toggle prefs. */
  const newSequence = () => {
    if (playing) stop(true);
    setDoc({ ...EMPTY_DOC, fps, curve, loop, cine, snap });
    setName('');
    setSelected([]);
    setZoom(1);
    idRef.current = 1;
    frameRef.current = 0;
    setFrame(0);
    const sc = scrollRef.current;
    if (sc) sc.scrollLeft = 0;
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
  const ticks = rulerTicks(totalFrames, fps, zoom);
  const seconds = (totalFrames / fps).toFixed(1);
  const shown = Math.round(frame);
  const canRecordScene = weathers.length > 0;
  const canPlay = doc.camera.length >= 2 || doc.tod.length >= 2 || doc.scene.length >= 1;
  const style = {
    width,
    ...(pos ? { left: pos.x, top: pos.y, right: 'auto' } : null),
  };

  const fmtTod = (m) => {
    const mins = ((Math.round(m) % 1440) + 1440) % 1440;
    const h = Math.floor(mins / 60);
    const mm = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };

  const dot = (track, k, cls) => {
    const past = k.frame > totalFrames;
    const sel = selectedSet.has(selKey(track, k.id));
    let tip = past
      ? `Frame ${k.frame} — past the end of the sequence`
      : `Frame ${k.frame} · ${(k.frame / fps).toFixed(2)}s · Shift+click multi · Del to remove`;
    if (track === 'tod' && k.timeMinutes != null) tip = `${fmtTod(k.timeMinutes)} · ${tip}`;
    if (track === 'scene' && k.weather) tip = `${k.weather} · ${tip}`;
    return (
      <Tooltip key={k.id} content={tip} placement="top">
        <span
          className={`cseq-dot ${cls}${sel ? ' sel' : ''}${past ? ' past' : ''}`}
          style={{ left: `${(clamp(k.frame, 0, totalFrames) / totalFrames) * 100}%` }}
          onPointerDown={(e) => onDotDown(e, track, k)}
        />
      </Tooltip>
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
        <Tooltip content="Close" placement="left">
          <button type="button" className="icon-btn cseq-close" onClick={onClose} aria-label="Close">
            <span className="icon">close</span>
          </button>
        </Tooltip>
      </div>

      <div className="cseq-body">
        {/* Saved sequences */}
        <div className="cseq-row">
          <Tooltip content="Start a new empty sequence" placement="top">
            <button type="button" className="cseq-btn" onClick={newSequence}>New</button>
          </Tooltip>
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
          <div className="cseq-bar-group cseq-zoom">
            <Tooltip content="Zoom out" placement="top">
              <button
                type="button"
                className="icon-btn cseq-icon"
                aria-label="Zoom out"
                disabled={zoom <= MIN_ZOOM + 1e-6}
                onClick={zoomOut}
              >
                <span className="icon">zoom_out</span>
              </button>
            </Tooltip>
            <Tooltip content="Zoom in" placement="top">
              <button
                type="button"
                className="icon-btn cseq-icon"
                aria-label="Zoom in"
                disabled={zoom >= MAX_ZOOM - 1e-6}
                onClick={zoomIn}
              >
                <span className="icon">zoom_in</span>
              </button>
            </Tooltip>
          </div>
        </div>

        {/* Timeline — zoom widens the track; wheel pans horizontally */}
        <div className="cseq-tl">
          <div className="cseq-tl-labels">
            <div className="cseq-tl-spacer" />
            <div className="cseq-tl-label">Camera</div>
            <div className="cseq-tl-label">Scene</div>
            <div className="cseq-tl-label">Time</div>
          </div>
          <div className="cseq-tl-scroll" ref={scrollRef}>
            <div
              className="cseq-tl-track"
              ref={bodyRef}
              style={{ width: `${zoom * 100}%` }}
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
              <div className="cseq-lane">{doc.tod.map((k) => dot('tod', k, 'tod'))}</div>
              <div
                className="cseq-playhead"
                ref={playheadRef}
                style={{ left: `${(shown / totalFrames) * 100}%` }}
              />
            </div>
          </div>
        </div>

        {/* Compact toolbar: transport | record | step | toggles | frame */}
        <div className="cseq-bar">
          <div className="cseq-bar-group">
            <Tooltip content={playing ? 'Pause (Space)' : 'Play (Space)'} placement="top">
              <button
                type="button"
                className={`cseq-play${playing ? ' playing' : ''}`}
                disabled={!canPlay}
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
              content={canRecordScene ? 'Record weather at playhead' : 'Load a zone with a sky first'}
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
            <Tooltip
              content={canRecordScene ? 'Record time of day at playhead (lerps between keys)' : 'Load a zone with a sky first'}
              placement="top"
            >
              <button
                type="button"
                className="cseq-record cseq-record-tod"
                disabled={!canRecordScene}
                onClick={recordTod}
              >
                <span className="icon fill">radio_button_checked</span>
                Time
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
            <Tooltip
              content={selected.length > 1 ? `Delete ${selected.length} keyframes` : 'Delete selected keyframe'}
              placement="top"
            >
              <button
                type="button"
                className="icon-btn cseq-icon cseq-del"
                aria-label="Delete keyframe"
                disabled={!hasSelection}
                onClick={() => removeKeys(selected)}
              >
                <span className="icon">delete</span>
              </button>
            </Tooltip>
            <Tooltip content="Clear all keyframes" placement="top">
              <button
                type="button"
                className="icon-btn cseq-icon cseq-del"
                aria-label="Clear all keyframes"
                disabled={!doc.camera.length && !doc.scene.length && !doc.tod.length}
                onClick={clearAll}
              >
                <span className="icon">layers_clear</span>
              </button>
            </Tooltip>
          </div>

          <div className="cseq-bar-sep" />

          <div className="cseq-bar-group cseq-toggles">
            <Tooltip content="Loop playback" placement="top">
              <label className="switch cseq-switch">
                <input type="checkbox" checked={loop} onChange={(e) => patch({ loop: e.target.checked })} />
                <span className="track" />
                <span className="cseq-switch-label">Loop</span>
              </label>
            </Tooltip>
            <Tooltip content="Spline path through keys (off = straight lines)" placement="top">
              <label className="switch cseq-switch">
                <input type="checkbox" checked={!!curve} onChange={(e) => patch({ curve: e.target.checked })} />
                <span className="track" />
                <span className="cseq-switch-label">Curve</span>
              </label>
            </Tooltip>
            <Tooltip content="Hide UI while playing (Esc restores)" placement="top">
              <label className="switch cseq-switch">
                <input type="checkbox" checked={cine} onChange={(e) => patch({ cine: e.target.checked })} />
                <span className="track" />
                <span className="cseq-switch-label">Hide UI</span>
              </label>
            </Tooltip>
            <Tooltip content={`Snap to every ${SNAP_FRAMES} frames`} placement="top">
              <label className="switch cseq-switch">
                <input type="checkbox" checked={!!snap} onChange={(e) => patch({ snap: e.target.checked })} />
                <span className="track" />
                <span className="cseq-switch-label">Snap</span>
              </label>
            </Tooltip>
          </div>

          <span className="cseq-frame mono">
            <b ref={readoutRef}>{shown}</b>
            <span className="cseq-frame-dim"> / {totalFrames}</span>
            <span className="cseq-frame-s">{(shown / fps).toFixed(2)}s</span>
          </span>
        </div>

      </div>

      <Tooltip content="Resize width" placement="left">
        <div
          className="cseq-resize"
          onPointerDown={startResize}
          onPointerMove={onResizeMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        />
      </Tooltip>
    </div>
  );
}
