import { useEffect, useMemo, useRef, useState } from 'react';
import { Combo } from './Combo.jsx';
import { Tooltip } from './Tooltip.jsx';
import {
  ActorTrack, aimPoseAt, CameraSequence, completePose, driveCamera, poseFromCamera, sampleAnim,
  sampleScene, sampleTod,
} from '../js/camseq.js';

// Working draft is intentionally NOT restored on open — a leftover camSeq used
// to auto-paint the last flythrough on the zone whenever the panel mounted.
// Named sequences live in the library and load only via the Load control.
const LIB_KEY = 'camSeqLibrary';    // { [name]: doc } — saved sequences
const POS_KEY = 'camSeqPanelPos';
const SIZE_KEY = 'camSeqPanelSize';
const LEGACY_DOC_KEY = 'camSeq';     // old auto-restored draft — cleared once
const DRAFT_KEY = 'camSeqDraft';    // the working document, across open/close
const FPS_CHOICES = [24, 30, 60];
const MIN_FRAMES = 2;
const MAX_FRAMES = 36000;           // 20 minutes at 30fps — a sanity bound, not a target
const SCENE_HZ = 10;                // weather/time re-apply rate; see applyScene
const MIN_W = 940;
const DEFAULT_W = 940;
const PANEL_H = 348;                // height with no actor lanes; drag clamp fallback
const LANE_H = 25;                  // one timeline lane (see .cseq-lane)
const TL_BASE_H = 135;              // ruler + the four fixed lanes + scrollbar (see .cseq-tl)
const CLIP_FPS = 30;                // FFXI motion clips run at 30 game-frames a second
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const byFrame = (a, b) => a.frame - b.frame;

const EMPTY_DOC = {
  name: '', totalFrames: 300, fps: 30, curve: true, loop: false, cine: true, snap: false,
  lockActor: false, linearRotation: false,
  // One take records onto both camera tracks; each key can be removed alone.
  camPos: [], camRot: [], scene: [], tod: [],
  // Placed zone actors added from Actors › Add to Camera Sequence, each with
  // a movement track (xf: { frame, pos, rot }) and an animation track (anim:
  // { frame, motion, pack, label }). `actorId` is the stage id; ids restart
  // every launch, so `name` is how a saved sequence finds its actor again.
  actors: [],
};
const TRACKS = ['camPos', 'camRot', 'scene', 'tod'];
// Lane and path colours for actors, by position in the sequence — the same
// palette the renderer draws their routes in (ACTOR_PATH_COLORS).
const ACTOR_COLORS = ['#fa739e', '#8cd9fa', '#facc66', '#9eeb9e', '#cca6fa', '#faa66b'];
const actorColor = (i) => ACTOR_COLORS[i % ACTOR_COLORS.length];

// --- tracks -------------------------------------------------------------------
//
// The four fixed tracks are arrays on the document; an actor's two are nested
// under doc.actors and addressed as 'xf:<actorId>' / 'anim:<actorId>', so the
// keyframe code (record, select, drag, delete) is written once against a
// track name and never cares which kind it has hold of.

const actorTrack = (kind, actorId) => `${kind}:${actorId}`;
function parseTrack(track) {
  const m = /^(xf|anim):(\d+)$/.exec(track);
  return m ? { kind: m[1], actorId: +m[2] } : null;
}
function trackKeys(doc, track) {
  const p = parseTrack(track);
  if (!p) return doc[track] ?? [];
  return doc.actors.find((a) => a.actorId === p.actorId)?.[p.kind] ?? [];
}
function withTrack(doc, track, keys) {
  const p = parseTrack(track);
  if (!p) return { ...doc, [track]: keys };
  return { ...doc, actors: doc.actors.map((a) => (a.actorId === p.actorId ? { ...a, [p.kind]: keys } : a)) };
}
function allTracks(doc) {
  return [
    ...TRACKS,
    ...doc.actors.flatMap((a) => [actorTrack('xf', a.actorId), actorTrack('anim', a.actorId)]),
  ];
}
const allKeys = (doc) => allTracks(doc).flatMap((t) => trackKeys(doc, t));
const actorHasKeys = (a) => a.xf.length > 0 || a.anim.length > 0;
// Joint Lock to Actor aims at. FFXI skeletons carry no names — a joint is an
// index — and index 2 is `bone0002` in the Skeleton panel's numbering: the
// pelvis, which is the actor's centre of mass through a jump or a lunge.
const LOCK_JOINT = 2;
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
  // Pre-split docs kept one `camera` track of { eye, forward } keys (`keys`
  // before the timeline) — fan it out onto the position and rotation tracks.
  let camPos = Array.isArray(raw.camPos) ? raw.camPos : null;
  let camRot = Array.isArray(raw.camRot) ? raw.camRot : null;
  if (!camPos && !camRot) {
    const legacy = Array.isArray(raw.camera) ? raw.camera : (Array.isArray(raw.keys) ? raw.keys : []);
    camPos = legacy
      .filter((k) => Array.isArray(k.eye))
      .map((k, i) => ({ id: k.id ?? i, frame: k.frame, eye: k.eye }));
    camRot = legacy
      .filter((k) => Array.isArray(k.forward))
      .map((k, i) => ({ id: (k.id ?? i) + 2_000_000, frame: k.frame, forward: k.forward, roll: k.roll ?? 0 }));
  }
  const actors = (Array.isArray(raw.actors) ? raw.actors : [])
    .filter((a) => a && Number.isFinite(a.actorId))
    .map((a) => ({
      actorId: a.actorId,
      name: String(a.name ?? ''),
      xf: (Array.isArray(a.xf) ? a.xf : [])
        .filter((k) => Number.isFinite(k?.frame) && (Array.isArray(k.pos) || Array.isArray(k.rot)))
        .sort(byFrame),
      anim: (Array.isArray(a.anim) ? a.anim : [])
        .filter((k) => Number.isFinite(k?.frame))
        .sort(byFrame),
    }));
  const rest = { ...raw };
  delete rest.camera;
  delete rest.keys;
  return {
    ...EMPTY_DOC,
    ...rest,
    curve: !!curve,
    lockActor: !!raw.lockActor,
    linearRotation: !!raw.linearRotation,
    camPos: camPos ?? [],
    camRot: camRot ?? [],
    scene,
    tod,
    actors,
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
 * Camera Sequencer: a multi-track timeline you scrub, record onto, and fly.
 * Camera position and rotation are separate tracks (one take records both).
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
  /** Play the loaded NPC/PC clip once from frame 0 (no loop) with the sequence. */
  onPlayActorOnce,
  // 'fly' when the user has WASD on, 'orbit' otherwise. Playback always takes
  // fly — it is the only mode that holds an arbitrary path — so this is the
  // mode to hand back afterwards, and to scrub in.
  restingMode = 'orbit',
  /** Restore normal loop prefs when the sequence stops. */
  onStopActor,
  /** Zone lock actor (Place Lock Actor): see actorTarget. */
  zoneLoaded = false,
  lockActorId = null,
  lockActorPlacing = false,
  onPlaceLockActor,
  onCancelLockActor,
  onRemoveLockActor,
  /** () => world point of the placed lock actor, or null. */
  lockTarget,
  /** Placed zone actors (App's zoneActors) — read for names and liveness. */
  actors = [],
  /** The actor with the gizmo / open editor: Actor and Anim record onto it. */
  selectedActorId = null,
  /** App's actorSeqApi: resolve / select / transform / motion / apply / restore. */
  actorApi = null,
  /** Actors › Add to Camera Sequence request: { id, nonce }; acked with onAddActorDone. */
  addActor = null,
  onAddActorDone,
}) {
  // The panel unmounts when it is closed, so the working document is kept in
  // storage rather than in component state alone: closing it to reach a control
  // underneath should not throw away the keyframes and length just set. Named
  // sequences in the library are still a separate, explicit save.
  const [doc, setDoc] = useState(() => toDoc(readJson(DRAFT_KEY)));
  const [library, setLibrary] = useState(() => readJson(LIB_KEY) ?? {});
  const [pos, setPos] = useState(() => readJson(POS_KEY));
  const [width, setWidth] = useState(() => {
    const s = readJson(SIZE_KEY);
    return clamp(Math.round(s?.w ?? s ?? DEFAULT_W), MIN_W, 1600);
  });
  const [name, setName] = useState('');
  const [lengthText, setLengthText] = useState(() => String(EMPTY_DOC.totalFrames));

  // Drop the pre-library draft key; the current one is DRAFT_KEY below.
  useEffect(() => {
    try { localStorage.removeItem(LEGACY_DOC_KEY); } catch { /* quota */ }
  }, []);

  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [hidden, setHidden] = useState(false);      // cinematic playback in progress
  /** Multi-select: { track, id }[]. Shift+click toggles; plain click replaces (or keeps if already in set). */
  const [selected, setSelected] = useState([]);
  const [zoom, setZoom] = useState(1);

  const { totalFrames, fps, curve, loop, cine, snap, lockActor, linearRotation } = doc;

  /**
   * World point "the actor" means in the current view. In a zone it is the
   * placed lock actor (Place Lock Actor), or nothing — Lock to Actor then has
   * no aim and leaves the recorded rotation alone. For a loaded model it is
   * bone0002, which travels with the actor so a leap or a step stays framed
   * (the bounds centre is rest-pose and would let them walk out of shot);
   * anything without a skeleton (a bare effect) falls back to the orbit pivot.
   */
  const lockTargetRef = useRef(lockTarget);
  lockTargetRef.current = lockTarget;
  const actorTarget = () => {
    const r = rendererRef.current;
    if (r?.model?.kind === 'zone') return lockTargetRef.current?.() ?? null;
    return r?.getJointPosition?.(LOCK_JOINT) ?? r?.getOrbitPivot?.() ?? null;
  };
  // Read through a ref inside the rAF loop, which closes over its own scope.
  const lockActorRef = useRef(lockActor);
  lockActorRef.current = lockActor;
  const onPlayActorOnceRef = useRef(onPlayActorOnce);
  onPlayActorOnceRef.current = onPlayActorOnce;
  const onStopActorRef = useRef(onStopActor);
  onStopActorRef.current = onStopActor;

  const panelRef = useRef(null);
  const scrollRef = useRef(null);
  const bodyRef = useRef(null);
  const playheadRef = useRef(null);
  const readoutRef = useRef(null);
  const dragRef = useRef(null);
  const kfDragRef = useRef(null);
  const idRef = useRef(
    allKeys(doc).reduce((m, k) => Math.max(m, k.id ?? 0), 0) + 1,
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
  const goToRef = useRef(null);
  const restingModeRef = useRef(restingMode);
  restingModeRef.current = restingMode;
  const drivenRef = useRef(false);
  const cineRef = useRef(null);
  const stopRef = useRef(null);
  const sceneApplyRef = useRef(null);

  docRef.current = doc;

  const seq = useMemo(
    () => new CameraSequence({ pos: doc.camPos, rot: doc.camRot }, {
      totalFrames, curve: curve ? 'spline' : 'linear', rotation: linearRotation ? 'linear' : 'spline',
    }),
    [doc.camPos, doc.camRot, totalFrames, curve, linearRotation],
  );
  seqRef.current = seq;

  // One sampler per sequenced actor; the movement path follows the Curve
  // toggle like the camera eye does.
  const actorSeqs = useMemo(
    () => doc.actors.map((a) => ({ ...a, track: new ActorTrack(a.xf, { curve: curve ? 'spline' : 'linear' }) })),
    [doc.actors, curve],
  );
  const actorSeqsRef = useRef(actorSeqs);
  actorSeqsRef.current = actorSeqs;
  const actorApiRef = useRef(actorApi);
  actorApiRef.current = actorApi;
  const selectedActorIdRef = useRef(selectedActorId);
  selectedActorIdRef.current = selectedActorId;
  // Where each driven actor stood (and what it played) before the sequence
  // first moved it — put back by Stop. Recording a key for an actor drops its
  // entry: the user just said "this is where it goes", so there is nothing
  // older to go back to.
  const actorRestoreRef = useRef(new Map());
  // Animation key currently in force on each actor, so a scrub inside one
  // key's span seeks the clip instead of restarting it.
  const appliedAnimRef = useRef(new Map());

  useEffect(() => { writeJson(DRAFT_KEY, doc); }, [doc]);
  useEffect(() => { writeJson(POS_KEY, pos); }, [pos]);
  useEffect(() => { writeJson(SIZE_KEY, { w: width }); }, [width]);
  useEffect(() => { setLengthText(String(totalFrames)); }, [totalFrames]);

  const patch = (fields) => setDoc((d) => ({ ...d, ...fields }));

  // --- sequenced actors ------------------------------------------------------

  /** Live stage actor for a sequenced one (by id, then by name), or null. */
  const liveActor = (sa) => actorApiRef.current?.resolve?.(sa.actorId, sa.name) ?? null;

  // Actors › Add to Camera Sequence. Adding twice is a no-op; the request is
  // acked either way so App can clear it.
  const onAddActorDoneRef = useRef(onAddActorDone);
  onAddActorDoneRef.current = onAddActorDone;
  useEffect(() => {
    if (!addActor) return;
    const live = actorApiRef.current?.resolve?.(addActor.id, null);
    if (live) {
      setDoc((d) => (d.actors.some((a) => a.actorId === live.id)
        ? d
        : { ...d, actors: [...d.actors, { actorId: live.id, name: live.name, xf: [], anim: [] }] }));
    }
    onAddActorDoneRef.current?.();
  }, [addActor]);

  // Keep each sequenced actor bound to the stage: a renamed actor updates the
  // stored name, and one whose id is gone (a reloaded set, a new launch) is
  // re-found by name and takes the new id — unless another sequenced actor
  // already has it.
  useEffect(() => {
    if (!actorApi || !doc.actors.length) return;
    const taken = new Set(doc.actors.map((a) => a.actorId));
    let changed = false;
    const next = doc.actors.map((sa) => {
      const live = actorApi.resolve(sa.actorId, sa.name);
      if (!live) return sa;
      if (live.id !== sa.actorId && taken.has(live.id)) return sa;
      if (live.id === sa.actorId && live.name === sa.name) return sa;
      changed = true;
      taken.add(live.id);
      return { ...sa, actorId: live.id, name: live.name };
    });
    if (changed) setDoc((d) => ({ ...d, actors: next }));
  }, [actors, doc.actors, actorApi]);

  const removeSeqActor = (actorId) => {
    actorRestoreRef.current.delete(actorId);
    appliedAnimRef.current.delete(actorId);
    setDoc((d) => ({ ...d, actors: d.actors.filter((a) => a.actorId !== actorId) }));
    setSelected((s) => s.filter((x) => parseTrack(x.track)?.actorId !== actorId));
  };

  /**
   * Put every sequenced actor where the tracks say it is at frame `f`.
   * Position and rotation come from the movement track; the animation track
   * switches the clip when the playhead crosses a key, offset by how far past
   * the key the playhead is so the clip starts at the key and runs from
   * there. `scrub` also seeks a clip that is already the right one, so
   * dragging the playhead is deterministic; playback leaves a running clip
   * alone (the renderer advances it, and re-fires its effect at each loop).
   * `sync` writes the placement into App's actor records too — cheap on a
   * scrub, throttled by the caller at 60fps.
   */
  const driveActors = (f, { sync = true, scrub = false } = {}) => {
    const api = actorApiRef.current;
    if (!api) return;
    const d = docRef.current;
    for (const sa of actorSeqsRef.current) {
      if (!actorHasKeys(sa)) continue;
      // Resolve by name as well as id: a set that just reloaded may have
      // handed this id to another actor, and the rebinding effect only
      // catches up after the render.
      const live = api.resolve(sa.actorId, sa.name);
      if (!live) continue;
      const id = live.id;
      if (!actorRestoreRef.current.has(id)) {
        const snap = api.snapshot(id);
        if (snap) actorRestoreRef.current.set(id, snap);
      }
      if (sa.xf.length) {
        const { pos, rot } = sa.track.at(f);
        api.setTransform(id, pos, rot, sync);
      }
      if (sa.anim.length) {
        const key = sampleAnim(sa.anim, f);
        if (!key) continue;
        const clipFrame = ((f - key.frame) / d.fps) * CLIP_FPS;
        if (appliedAnimRef.current.get(id) !== key.id) {
          appliedAnimRef.current.set(id, key.id);
          api.applyMotion(id, key, clipFrame);
        } else if (scrub) {
          api.seekMotion(id, clipFrame);
        }
      }
    }
  };

  /** Write where the sequence left each driven actor into App's records. */
  const syncActorState = () => {
    const api = actorApiRef.current;
    if (!api) return;
    for (const sa of actorSeqsRef.current) {
      const live = sa.xf.length ? api.resolve(sa.actorId, sa.name) : null;
      if (!live) continue;
      const t = api.transform(live.id);
      if (t) api.setTransform(live.id, t.pos, t.rot, true);
    }
  };
  const syncActorStateRef = useRef(syncActorState);
  syncActorStateRef.current = syncActorState;

  /** Stop › restore: every actor back to where it stood before the take. */
  const restoreActors = () => {
    const api = actorApiRef.current;
    if (api) for (const [id, snap] of actorRestoreRef.current) api.restore(id, snap);
    actorRestoreRef.current.clear();
    appliedAnimRef.current.clear();
  };

  // --- route overlay in the viewport ---------------------------------------

  useEffect(() => {
    const r = rendererRef.current;
    if (!r?.setCameraPath) return undefined;
    // Actor routes are passed in sequence order, empties included, so the
    // renderer's colour index lines up with the lane colours.
    const actorRoutes = actorSeqs.map((a) => ({
      points: a.track.path(96),
      keys: a.xf.map((k) => ({ pos: k.pos, rot: k.rot })),
    }));
    const anyActor = actorRoutes.some((a) => a.keys.length);
    if (hidden || (!doc.camPos.length && !anyActor)) r.setCameraPath(null);
    else {
      // A marker per position key, with an aim stub from wherever the
      // rotation track points at that frame.
      const keys = doc.camPos.map((k) => ({ eye: k.eye, forward: seq.at(k.frame).forward }));
      r.setCameraPath({ points: seq.path(160), keys, actors: actorRoutes });
    }
    return () => r.setCameraPath?.(null);
  }, [seq, doc.camPos, actorSeqs, hidden, rendererRef]);

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
      const t = actorTarget();
      // Scrubbing leaves the viewport in the mode the user drives in, rather
      // than stranding it in the fly mode playback needs.
      const asOrbit = restingMode !== 'fly';
      const full = completePose(cam, pose);
      driveCamera(cam, lockActor ? aimPoseAt(full, t) : full,
        { orbit: asOrbit, orbitTarget: (asOrbit && lockActor) ? t : null });
    }
    // Actors move with the playhead too — before the camera aims, so a
    // Lock to Actor scrub frames where the actor now stands.
    if (!opts.timeOnly) driveActors(clamped, { sync: true, scrub: true });
    sceneApplyRef.current(easedF, true);
  };

  const play = () => {
    const cam = camera();
    const hasCam = seq.length >= 2;
    const hasTod = doc.tod.length >= 2 || doc.scene.length >= 1;
    const hasActors = doc.actors.some(actorHasKeys);
    if (!cam || (!hasCam && !hasTod && !hasActors)) return;
    if (hasCam) markRestore();
    // A take starts every actor clip from its first key, not from wherever a
    // scrub last left it.
    appliedAnimRef.current.clear();
    onStopClock?.();   // the zone day-clock would fight the scene/tod tracks
    // Play always runs the shot from the top. The playhead is a scrubbing tool,
    // not a resume point: leaving it where it sat gave a part-length take, and
    // the actor clip below is rewound to match either way.
    frameRef.current = 0;
    setFrame(0);
    playingRef.current = true;
    setPlaying(true);
    if (hasCam) cam.sequenceLock = true;
    if (cine && hasCam) enterCinematic();
    // NPC/PC clip: rewound and cut like Stop, then played through once (not
    // looped). It enters at the same point of the shot as the camera, which is
    // the top — the two run on different frame rates, so the handoff is in
    // seconds rather than frames.
    try { onPlayActorOnceRef.current?.(frameRef.current, fps); } catch { /* optional */ }
  };

  /** `restore` puts the camera back where it was before the sequence took it. */
  const stop = (restore) => {
    const cam = camera();
    playingRef.current = false;
    setPlaying(false);
    setFrame(Math.round(frameRef.current));
    if (cam) cam.sequenceLock = false;
    if (cineRef.current) exitCinematic();
    // Playback runs in fly mode. Restoring puts the whole snapshot back (mode
    // included); ending where the sequence left off still has to hand the
    // camera back in the mode the user drives in, or the next drag behaves as
    // the sequence left it rather than as they set it.
    if (!restore && cam) cam.setMode(restingModeRef.current);
    if (restore && cam && restoreRef.current) cam.restore(restoreRef.current);
    if (restore) { restoreRef.current = null; drivenRef.current = false; }
    // Sequenced actors: Stop puts them back where they stood; a pause leaves
    // them where the take got to, with App's records caught up.
    if (restore) restoreActors();
    else syncActorState();
    try { onStopActorRef.current?.(); } catch { /* optional */ }
  };
  stopRef.current = stop;
  goToRef.current = goTo;

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
      const hasActors = d.actors?.some(actorHasKeys);
      if (!hasCam && !d.tod?.length && !d.scene?.length && !hasActors) return;
      let f = frameRef.current + dt * d.fps;
      let done = false;
      if (f >= d.totalFrames) {
        if (d.loop) {
          f %= d.totalFrames;
          // Sequence looped — fire the actor clip once from the top again.
          try { onPlayActorOnceRef.current?.(0, d.fps); } catch { /* optional */ }
          // Sequenced actors restart their first animation key too.
          appliedAnimRef.current.clear();
        } else { f = d.totalFrames; done = true; }
      }
      frameRef.current = f;
      const now = performance.now();
      const uiSync = now - uiSyncRef.current > 200;
      // Actors first: Lock to Actor aims at where they are this frame.
      if (hasActors) driveActors(f, { sync: uiSync, scrub: false });
      if (hasCam) {
        const pose = completePose(cam, s.sample(f));
        // Solved per frame, not interpolated: see aimPoseAt.
        const aimed = (pose && lockActorRef.current)
          ? aimPoseAt(pose, actorTarget())
          : pose;
        if (aimed) driveCamera(cam, aimed);
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
      if (uiSync) { uiSyncRef.current = now; setFrame(Math.round(f)); }

      // Ran to the end: stop, then rewind to the opening shot — Play always
      // starts from the top, so the timeline and the viewport agree on where
      // the next take begins.
      if (done) {
        stopRef.current(false);
        goToRef.current?.(0);
      }
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
  // Actors stay where the sequence left them, with App's records caught up.
  useEffect(() => () => {
    const cam = rendererRef.current?.camera;
    if (cam) cam.sequenceLock = false;
    document.body.classList.remove('cinematic');
    if (rendererRef.current && cineRef.current) {
      rendererRef.current.screenOffsetX = cineRef.current.screenOffsetX;
    }
    syncActorStateRef.current?.();
  }, [rendererRef]);

  // --- keyframes ------------------------------------------------------------

  /**
   * Record onto `track` at the playhead, replacing whatever is already there.
   * Returns the { track, id } of the key written.
   */
  const recordAt = (track, payload, { select = true } = {}) => {
    const at = snapFrame(frameRef.current);
    // Reuse the id when overwriting so the row stays the selected one.
    const id = trackKeys(docRef.current, track).find((k) => k.frame === at)?.id ?? idRef.current++;
    setDoc((d) => withTrack(d, track,
      [...trackKeys(d, track).filter((k) => k.frame !== at), { id, frame: at, ...payload }].sort(byFrame)));
    const hit = { track, id };
    if (select) setSelected([hit]);
    return hit;
  };

  /** One take lands a key on both camera tracks; either can be deleted alone. */
  const recordCamera = () => {
    const cam = camera();
    if (!cam) return;
    const { eye, forward, roll } = poseFromCamera(cam, lockActor ? actorTarget() : null);
    const p = recordAt('camPos', { eye }, { select: false });
    const q = recordAt('camRot', { forward, roll }, { select: false });
    setSelected([p, q]);
  };

  const recordScene = () => recordAt('scene', { weather });
  const recordTod = () => recordAt('tod', { timeMinutes: Math.round(timeMinutes) });

  /** The selected actor's sequence entry, if it has been added. */
  const seqActorFor = (id) => (id != null ? docRef.current.actors.find((a) => a.actorId === id) ?? null : null);

  /**
   * Record where the selected actor stands (position and rotation, read from
   * the renderer so a gizmo drag in progress counts) at the playhead.
   */
  const recordActor = () => {
    const id = selectedActorIdRef.current;
    const t = seqActorFor(id) ? actorApiRef.current?.transform?.(id) : null;
    if (!t) return;
    actorRestoreRef.current.delete(id);
    recordAt(actorTrack('xf', id), { pos: t.pos, rot: t.rot });
  };

  /** Record which motion the selected actor's editor is playing at the playhead. */
  const recordAnim = () => {
    const id = selectedActorIdRef.current;
    const m = seqActorFor(id) ? actorApiRef.current?.motion?.(id) : null;
    if (!m) return;
    actorRestoreRef.current.delete(id);
    const hit = recordAt(actorTrack('anim', id), { motion: m.motion, pack: m.pack, label: m.label });
    // The actor is already playing what this key says — no restart on the next scrub.
    appliedAnimRef.current.set(id, hit.id);
  };

  const selKey = (track, id) => `${track}:${id}`;

  const removeKeys = (pairs) => {
    if (!pairs?.length) return;
    const drop = new Set(pairs.map((p) => selKey(p.track, p.id)));
    setDoc((d) => {
      let next = d;
      for (const t of allTracks(d)) {
        const keys = trackKeys(d, t);
        const kept = keys.filter((k) => !drop.has(selKey(t, k.id)));
        if (kept.length !== keys.length) next = withTrack(next, t, kept);
      }
      return next;
    });
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
      const byTrack = new Map();
      for (const it of items) {
        if (!byTrack.has(it.track)) byTrack.set(it.track, new Map());
        byTrack.get(it.track).set(it.id, it.frame0 + d);
      }
      let next = doc0;
      for (const [track, moves] of byTrack) {
        const land = new Set(moves.values());
        const keys = trackKeys(doc0, track)
          .filter((k) => moves.has(k.id) || !land.has(k.frame))
          .map((k) => (moves.has(k.id) ? { ...k, frame: moves.get(k.id) } : k))
          .sort(byFrame);
        next = withTrack(next, track, keys);
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
        const key = trackKeys(d, s.track).find((x) => x.id === s.id);
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

  /** Every keyframe off every track; the actors stay in the sequence, empty. */
  const clearAll = () => {
    if (playing) stop(true);
    actorRestoreRef.current.clear();
    appliedAnimRef.current.clear();
    setDoc({
      ...EMPTY_DOC, fps, totalFrames, curve, loop, cine, snap, lockActor, linearRotation,
      actors: doc.actors.map((a) => ({ ...a, xf: [], anim: [] })),
    });
    setSelected([]);
    frameRef.current = 0;
    setFrame(0);
  };

  /** Blank sequence — clears keys, actors + name; keeps fps / toggle prefs. */
  const newSequence = () => {
    if (playing) stop(true);
    actorRestoreRef.current.clear();
    appliedAnimRef.current.clear();
    setDoc({ ...EMPTY_DOC, fps, curve, loop, cine, snap, lockActor, linearRotation });
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
    const h = el?.offsetHeight ?? PANEL_H;
    setPos({
      x: clamp(e.clientX - panelDrag.current.dx, 0, Math.max(window.innerWidth - w, 0)),
      y: clamp(e.clientY - panelDrag.current.dy, 0, Math.max(window.innerHeight - h, 0)),
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
  const hasActorKeys = doc.actors.some(actorHasKeys);
  const canPlay = seq.length >= 2 || doc.tod.length >= 2 || doc.scene.length >= 1 || hasActorKeys;
  // Actor / Anim record onto the selected actor, once it is in the sequence.
  const selLive = selectedActorId != null ? (actorApi?.resolve?.(selectedActorId, null) ?? null) : null;
  const selInSeq = !!selLive && doc.actors.some((a) => a.actorId === selLive.id);
  const selMotion = selInSeq ? actorApi?.motion?.(selLive.id) : null;
  const canRecordActor = selInSeq;
  const canRecordAnim = !!selMotion;
  const actorTip = !zoneLoaded
    ? 'Load a zone and place actors first'
    : !selLive
      ? 'Select an actor (click it in the zone or in the Actors panel)'
      : !selInSeq
        ? `${selLive.name} is not in the sequence — Actors › Add to Camera Sequence`
        : `Record where ${selLive.name} stands at the playhead — position and rotation. Move it with the gizmo and record again for a path`;
  const animTip = !zoneLoaded
    ? 'Load a zone and place actors first'
    : !selLive
      ? 'Select an actor (click it in the zone or in the Actors panel)'
      : !selInSeq
        ? `${selLive.name} is not in the sequence — Actors › Add to Camera Sequence`
        : !selMotion
          ? 'Lights have no motion to record'
          : `Record the motion ${selLive.name}'s editor is playing (${selMotion.label}) at the playhead — it switches to it when the playhead gets there`;
  const lockTip = !zoneLoaded
    ? 'Load a zone first — outside a zone, Lock to Actor aims at the loaded model'
    : lockActorPlacing
      ? 'Click on the zone terrain to place the lock actor'
      : lockActorId != null
        ? 'Click on the zone to move the lock actor — Lock to Actor aims at it'
        : 'Place an actor on the zone for Lock to Actor to aim at';
  // Two lanes per sequenced actor grow the timeline and the panel with it;
  // past the window the body scrolls.
  const actorLanes = doc.actors.length * 2;
  const tlHeight = TL_BASE_H + actorLanes * LANE_H;
  const style = {
    width,
    height: actorLanes ? Math.min(PANEL_H + actorLanes * LANE_H, Math.max(window.innerHeight - 70, PANEL_H)) : PANEL_H,
    ...(pos ? { left: pos.x, top: pos.y, right: 'auto' } : null),
  };

  const fmtTod = (m) => {
    const mins = ((Math.round(m) % 1440) + 1440) % 1440;
    const h = Math.floor(mins / 60);
    const mm = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };

  const deg = (r) => `${Math.round((r * 180) / Math.PI)}°`;
  const fmtRot = (k) => {
    const f = k.forward;
    const yaw = Math.atan2(f[0], f[2]);
    const pitch = Math.atan2(f[1], Math.hypot(f[0], f[2]) || 1e-6);
    return `yaw ${deg(yaw)} · pitch ${deg(pitch)} · roll ${deg(k.roll ?? 0)}`;
  };

  const fmtXf = (k) => {
    const p = k.pos;
    const R = k.rot;
    const at = p ? `${p[0].toFixed(1)}, ${p[1].toFixed(1)}, ${p[2].toFixed(1)}` : 'no position';
    // Column 2 of the placement rotation, mirrored like the renderer places it.
    const facing = R ? ` · facing ${deg(Math.atan2(-R[6], -R[8]))}` : '';
    return `${at}${facing}`;
  };

  const dot = (track, k, cls, color = null) => {
    const past = k.frame > totalFrames;
    const sel = selectedSet.has(selKey(track, k.id));
    let tip = past
      ? `Frame ${k.frame} — past the end of the sequence`
      : `Frame ${k.frame} · ${(k.frame / fps).toFixed(2)}s · Shift+click multi · Del to remove`;
    if (track === 'tod' && k.timeMinutes != null) tip = `${fmtTod(k.timeMinutes)} · ${tip}`;
    if (track === 'scene' && k.weather) tip = `${k.weather} · ${tip}`;
    if (track === 'camRot' && k.forward) tip = `${fmtRot(k)} · ${tip}`;
    if (cls === 'act') tip = `${fmtXf(k)} · ${tip}`;
    if (cls === 'anm') tip = `${k.label || k.motion?.id || 'bind pose'} · ${tip}`;
    return (
      <Tooltip key={k.id} content={tip} placement="top">
        <span
          className={`cseq-dot ${cls}${sel ? ' sel' : ''}${past ? ' past' : ''}`}
          style={{
            left: `${(clamp(k.frame, 0, totalFrames) / totalFrames) * 100}%`,
            ...(color ? { background: color } : null),
          }}
          onPointerDown={(e) => onDotDown(e, track, k)}
        />
      </Tooltip>
    );
  };

  /** Label column entry for a sequenced actor: name row (click selects) + Anim row. */
  const actorLabels = (sa, i) => {
    const live = liveActor(sa);
    const name = live?.name || sa.name || `Actor ${sa.actorId}`;
    const isSel = !!live && live.id === selectedActorId;
    const color = actorColor(i);
    const tip = !live
      ? `${name} is not on the stage — load the actor set it belongs to, or remove it from the sequence`
      : isSel
        ? `${name} — selected: Actor and Anim record onto it`
        : `Select ${name} in the zone so Actor and Anim record onto it`;
    return [
      <div
        key={`${sa.actorId}:xf`}
        className={`cseq-tl-label cseq-tl-actor${isSel ? ' on' : ''}${live ? '' : ' missing'}`}
        style={{ '--actor': color }}
      >
        <Tooltip content={tip} placement="right">
          <button
            type="button"
            className="cseq-actor-pick"
            disabled={!live}
            onClick={() => { if (live) actorApiRef.current?.select?.(live.id); }}
          >
            <span className="cseq-actor-swatch" />
            <span className="cseq-actor-name">{name}</span>
          </button>
        </Tooltip>
        <Tooltip content="Remove this actor and its keyframes from the sequence" placement="right">
          <button
            type="button"
            className="icon-btn cseq-icon cseq-del cseq-actor-x"
            aria-label="Remove actor from sequence"
            onClick={() => removeSeqActor(sa.actorId)}
          >
            <span className="icon">close</span>
          </button>
        </Tooltip>
      </div>,
      <div key={`${sa.actorId}:anim`} className={`cseq-tl-label cseq-tl-actor sub${isSel ? ' on' : ''}`}>
        Anim
      </div>,
    ];
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
          <div className="cseq-bar-sep" />
          <div className="cseq-bar-group">
            <Tooltip content={lockTip} placement="top">
              <button
                type="button"
                className={`cseq-btn cseq-lock${lockActorPlacing ? ' placing' : ''}`}
                disabled={!zoneLoaded}
                onClick={() => (lockActorPlacing ? onCancelLockActor?.() : onPlaceLockActor?.())}
              >
                <span className="icon">{lockActorPlacing ? 'close' : 'my_location'}</span>
                {lockActorPlacing ? 'Cancel' : (lockActorId != null ? 'Move Lock Actor' : 'Place Lock Actor')}
              </button>
            </Tooltip>
            {lockActorId != null && !lockActorPlacing && (
              <Tooltip content="Remove the lock actor" placement="top">
                <button
                  type="button"
                  className="icon-btn cseq-icon cseq-del"
                  aria-label="Remove lock actor"
                  onClick={() => onRemoveLockActor?.()}
                >
                  <span className="icon">delete</span>
                </button>
              </Tooltip>
            )}
          </div>
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
        <div className={`cseq-tl${doc.actors.length ? ' has-actors' : ''}`} style={{ height: tlHeight }}>
          <div className="cseq-tl-labels">
            <div className="cseq-tl-spacer" />
            <div className="cseq-tl-label">Cam Pos</div>
            <div className="cseq-tl-label">Cam Rot</div>
            <div className="cseq-tl-label">Scene</div>
            <div className="cseq-tl-label">Time</div>
            {doc.actors.map(actorLabels)}
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
              <div className="cseq-lane">{doc.camPos.map((k) => dot('camPos', k, 'cam'))}</div>
              <div className="cseq-lane">{doc.camRot.map((k) => dot('camRot', k, 'rot'))}</div>
              <div className="cseq-lane">{doc.scene.map((k) => dot('scene', k, 'scn'))}</div>
              <div className="cseq-lane">{doc.tod.map((k) => dot('tod', k, 'tod'))}</div>
              {doc.actors.map((sa, i) => [
                <div key={`${sa.actorId}:xf`} className="cseq-lane cseq-lane-actor">
                  {sa.xf.map((k) => dot(actorTrack('xf', sa.actorId), k, 'act', actorColor(i)))}
                </div>,
                <div key={`${sa.actorId}:anim`} className="cseq-lane cseq-lane-actor sub">
                  {sa.anim.map((k) => dot(actorTrack('anim', sa.actorId), k, 'anm', actorColor(i)))}
                </div>,
              ])}
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
            <Tooltip content="Record camera at playhead — a position key and a rotation key (yaw, pitch, roll)" placement="top">
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
            <Tooltip content={actorTip} placement="top">
              <button
                type="button"
                className="cseq-record cseq-record-actor"
                disabled={!canRecordActor}
                onClick={recordActor}
              >
                <span className="icon fill">radio_button_checked</span>
                Actor
              </button>
            </Tooltip>
            <Tooltip content={animTip} placement="top">
              <button
                type="button"
                className="cseq-record cseq-record-anim"
                disabled={!canRecordAnim}
                onClick={recordAnim}
              >
                <span className="icon fill">radio_button_checked</span>
                Anim
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
                disabled={!allKeys(doc).length}
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
            <Tooltip content="Turn at a constant rate between keys while the eye still follows the curve (off = facing rides the curve too)" placement="top">
              <label className="switch cseq-switch">
                <input type="checkbox" checked={!!linearRotation} disabled={!curve} onChange={(e) => patch({ linearRotation: e.target.checked })} />
                <span className="track" />
                <span className="cseq-switch-label">Linear rotation</span>
              </label>
            </Tooltip>
            <Tooltip content="Keep the camera pointed at the actor (in a zone: the placed lock actor) — keyframes record facing it, and playback re-aims every frame" placement="top">
              <label className="switch cseq-switch">
                <input
                  type="checkbox"
                  checked={!!lockActor}
                  onChange={(e) => patch({ lockActor: e.target.checked })}
                />
                <span className="track" />
                <span className="cseq-switch-label">Lock to Actor</span>
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
