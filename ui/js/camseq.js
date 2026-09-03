// Camera sequencer: keyframed camera poses splined into a flythrough path.
//
// Position and rotation are separate tracks. A position key is a world eye
// point; a rotation key is a unit forward vector plus a roll about it. That
// form is independent of both the camera mode and the up-vector convention —
// so a sequence recorded while orbiting a model plays back identically in fly
// mode, and the Y-down entity views and Y-up zone views (see camera.js) can't
// disagree about which way "up" was. The (yaw, pitch) pair the fly camera
// actually wants is derived at drive time from the live camera's own yUp, which
// is exactly what OrbitCamera.setMode and the creation camera track already do.
//
// Either track may be empty, or shorter than the other: a channel with no keys
// leaves that part of the live camera alone (see completePose), so two
// position keys and no rotation keys fly the eye along the path while the
// facing stays wherever the user last put it — or, with Lock to Actor, is
// solved per frame.
//
// FOV is deliberately not part of a keyframe: the sequence is position and
// rotation only, so the Camera popover's field of view stays the user's to set
// and never drifts out from under the readout while a sequence plays.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const byFrame = (a, b) => a.frame - b.frame;

/**
 * Unit vector from `eye` towards `target`. Null when the two coincide, which
 * would otherwise produce a zero-length forward and a NaN yaw.
 */
export function forwardTo(eye, target) {
  const d = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (!(len > 1e-6)) return null;
  return [d[0] / len, d[1] / len, d[2] / len];
}

/**
 * Capture the live camera as a keyframe pose. Works in orbit and in fly mode.
 *
 * With `lockTarget` the recorded forward points at that world point instead of
 * wherever the camera happened to be aimed, so a keyframe faces the actor even
 * if the framing was nudged off-centre before recording. Roll (Alt+Q / Alt+E)
 * is recorded as-is either way.
 */
export function poseFromCamera(camera, lockTarget = null) {
  const e = camera.eye;
  const eye = [e[0], e[1], e[2]];
  const f = (lockTarget && forwardTo(eye, lockTarget)) ?? camera.forward;
  return { eye, forward: [f[0], f[1], f[2]], roll: camera.roll ?? 0 };
}

/**
 * Re-aim a sampled pose at a world point, keeping its eye position and roll.
 *
 * Used for "Lock to Actor": the eye still follows the splined path, but the
 * rotation is solved per frame rather than interpolated between keyframes, so
 * the actor stays centred even where the path swings around it — which
 * interpolated yaw/pitch cannot do (they cut the corner between two keys).
 */
export function aimPoseAt(pose, target) {
  if (!pose || !target || !pose.eye) return pose;
  const forward = forwardTo(pose.eye, target);
  return forward ? { ...pose, forward } : pose;
}

/**
 * Fill a sampled pose's missing channels from the live camera. A sequence
 * with keys on only one of the two tracks samples to a partial pose; the
 * other half is whatever the camera is doing right now.
 */
export function completePose(camera, pose) {
  if (!pose) return null;
  if (pose.eye && pose.forward && pose.roll != null) return pose;
  const e = camera.eye;
  const f = camera.forward;
  return {
    eye: pose.eye ?? [e[0], e[1], e[2]],
    forward: pose.forward ?? [f[0], f[1], f[2]],
    roll: pose.roll ?? (camera.roll ?? 0),
  };
}

/**
 * Point the live camera at a sampled (complete) pose. Playback always runs
 * the camera in fly mode: it is the only mode that holds an arbitrary eye plus
 * look direction (orbit derives its eye from a target, so a path through the
 * world would have to fight it). Yaw/pitch follow the camera's current up
 * convention; roll is the recorded roll about the view direction.
 */
export function driveCamera(camera, pose, { orbit = false, orbitTarget = null } = {}) {
  const e = pose.eye;
  const f = pose.forward;
  if (pose.roll != null) camera.roll = pose.roll;
  if (!orbit) {
    camera.mode = 'fly';
    camera.pos = [e[0], e[1], e[2]];
    camera.yaw = Math.atan2(f[0], f[2]);
    const horiz = Math.hypot(f[0], f[2]) || 1e-6;
    camera.pitch = camera.yUp ? Math.atan2(f[1], horiz) : Math.atan2(-f[1], horiz);
    return;
  }

  // Same eye and look direction, expressed as an orbit pivot the user can
  // tumble around. Scrubbing the timeline is not playback — leaving the camera
  // in fly mode there means the next drag flies instead of orbiting, and the
  // viewport reads as having switched into some other mode.
  //
  // Orbit derives its eye from (target, yaw, pitch, distance), and the offset
  // from target to eye is the *reverse* of the look direction — so the angles
  // are those of −forward, not forward.
  let dist = null;
  let target = null;
  if (orbitTarget) {
    const v = [orbitTarget[0] - e[0], orbitTarget[1] - e[1], orbitTarget[2] - e[2]];
    const len = Math.hypot(v[0], v[1], v[2]);
    // Only adopt it when it genuinely lies along the view ray (Lock to Actor
    // puts it there); off-axis it would swing the framing rather than pivot it.
    const along = len > 1e-6 ? (v[0] * f[0] + v[1] * f[1] + v[2] * f[2]) / len : 0;
    if (along > 0.999) { dist = len; target = orbitTarget; }
  }
  if (dist == null) {
    dist = Math.min(Math.max(camera.distance, camera.minDistance), camera.maxDistance);
    target = [e[0] + f[0] * dist, e[1] + f[1] * dist, e[2] + f[2] * dist];
  }
  const u = [-f[0], -f[1], -f[2]];
  const horiz = Math.hypot(u[0], u[2]) || 1e-6;
  camera.mode = 'orbit';
  camera.target = target;
  camera.distance = dist;
  camera.yaw = Math.atan2(u[0], u[2]);
  camera.pitch = camera.yUp ? Math.atan2(u[1], horiz) : Math.atan2(-u[1], horiz);
}

/**
 * Centripetal Catmull-Rom (alpha 0.5) through p1→p2, with p0/p3 as the
 * neighbouring control points — the same evaluation the level editor uses for
 * cutscene camera routes. Knots spaced by sqrt(distance): unlike the uniform
 * variant this never loops or overshoots at a sharp turn, so the path arcs
 * through the recorded points instead of swinging past them. Barry-Goldman
 * pyramidal evaluation.
 *
 * Duplicated control points (the clamped ends, or two keyframes recorded from
 * the same spot) are safe: the guarded knot makes the first blend ratio large,
 * but it multiplies a zero-length segment, so the result is just the point.
 */
function catmull3(p0, p1, p2, p3, u) {
  const knot = (a, b) => Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])) || 1e-4;
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = t1 + u * (t2 - t1);
  const lerp = (a, b, s) => [
    a[0] + (b[0] - a[0]) * s,
    a[1] + (b[1] - a[1]) * s,
    a[2] + (b[2] - a[2]) * s,
  ];
  const A1 = lerp(p0, p1, (t - t0) / (t1 - t0));
  const A2 = lerp(p1, p2, (t - t1) / (t2 - t1));
  const A3 = lerp(p2, p3, (t - t2) / (t3 - t2));
  const B1 = lerp(A1, A2, (t - t0) / (t2 - t0));
  const B2 = lerp(A2, A3, (t - t1) / (t3 - t1));
  return lerp(B1, B2, (t - t1) / (t2 - t1));
}

function lerp3(a, b, u) {
  return [
    a[0] + (b[0] - a[0]) * u,
    a[1] + (b[1] - a[1]) * u,
    a[2] + (b[2] - a[2]) * u,
  ];
}

// Kept for older saved docs that still store ease: 'smooth' | 'linear'.
export const EASINGS = {
  linear: (t) => t,
  smooth: (t) => t,
};

/**
 * Barry–Goldman Catmull-Rom on a scalar channel with the given knots.
 * Duplicate knots (the clamped ends) collapse the blend onto the repeated
 * value rather than dividing by zero.
 */
function catmullKnots(v0, v1, v2, v3, [t0, t1, t2, t3], u) {
  const t = t1 + u * (t2 - t1);
  const L = (a, b, ta, tb) => (tb - ta < 1e-9 ? a : a + (b - a) * ((t - ta) / (tb - ta)));
  const A1 = L(v0, v1, t0, t1);
  const A2 = L(v1, v2, t1, t2);
  const A3 = L(v2, v3, t2, t3);
  const B1 = L(A1, A2, t0, t2);
  const B2 = L(A2, A3, t1, t3);
  return L(B1, B2, t1, t2);
}

/** Unwrap an angle channel so a step across ±180° takes the short way round. */
function unwrap(keys, field) {
  for (let i = 1; i < keys.length; i++) {
    const prev = keys[i - 1][field];
    let v = keys[i][field];
    while (v - prev > Math.PI) v -= 2 * Math.PI;
    while (prev - v > Math.PI) v += 2 * Math.PI;
    keys[i][field] = v;
  }
}

/** Segment of sorted `keys` containing frame `f`: [i, u]. Caller handles the ends. */
function segmentAt(keys, f) {
  let i = 0;
  while (i < keys.length - 2 && f > keys[i + 1].frame) i++;
  const a = keys[i];
  const b = keys[i + 1];
  return [i, (f - a.frame) / ((b.frame - a.frame) || 1)];
}

function forwardOf(r) {
  const cp = Math.cos(r.pitch);
  return [cp * Math.sin(r.yaw), Math.sin(r.pitch), cp * Math.cos(r.yaw)];
}

export class CameraSequence {
  /**
   * `tracks` — { pos: [{ frame, eye }], rot: [{ frame, forward, roll }] } in
   *   any order. A plain array of { frame, eye, forward, roll? } keys (the
   *   pre-split format) feeds both tracks.
   * `totalFrames` — length of the whole sequence.
   * `curve` — 'spline' (auto Catmull-Rom through keys) or 'linear' (straight
   *   segments). Keyframes are ALWAYS hit at their exact frame times; there is
   *   no whole-timeline ease that warps the clock.
   * `rotation` — 'spline' or 'linear' for the facing between rotation keys.
   */
  constructor(tracks, { totalFrames = 300, curve = 'spline', ease, rotation = 'spline' } = {}) {
    this.totalFrames = Math.max(1, Math.round(totalFrames));
    this.rotation = rotation === 'linear' ? 'linear' : 'spline';
    // Migrate old `ease` flag: anything that wasn't explicitly linear → spline.
    if (curve !== 'linear' && curve !== 'spline') {
      curve = (ease === 'linear' || ease === false) ? 'linear' : 'spline';
    }
    this.curve = curve === 'linear' ? 'linear' : 'spline';

    const posIn = Array.isArray(tracks) ? tracks : (tracks?.pos ?? []);
    const rotIn = Array.isArray(tracks) ? tracks : (tracks?.rot ?? []);
    this.pos = posIn
      .filter((k) => Array.isArray(k?.eye))
      .map((k) => ({ frame: k.frame, eye: k.eye }))
      .sort(byFrame);
    this.rot = rotIn
      .filter((k) => Array.isArray(k?.forward))
      .map((k) => {
        const f = k.forward;
        const horiz = Math.hypot(f[0], f[2]) || 1e-6;
        return {
          frame: k.frame,
          // Interpolation parameters only — plain world azimuth/elevation, with
          // no up-vector convention baked in (driveCamera re-derives whatever
          // the live camera needs from the forward vector).
          yaw: Math.atan2(f[0], f[2]),
          pitch: Math.atan2(f[1], horiz),
          roll: Number.isFinite(k.roll) ? k.roll : 0,
        };
      })
      .sort(byFrame);
    // A turn across ±180° takes the short way instead of spinning the long
    // way round the compass; likewise a roll through the inverted point.
    unwrap(this.rot, 'yaw');
    unwrap(this.rot, 'roll');
  }

  /** Longest track — what "the sequence has N keys" means for playability. */
  get length() { return Math.max(this.pos.length, this.rot.length); }

  /**
   * Playhead frame → sample frame. Identity: timing matches the timeline.
   * Kept so scene/camera stay on one clock without a second code path.
   */
  easedFrame(frame) {
    return clamp(frame, 0, this.totalFrames);
  }

  /** Pose at a playhead frame. Null when there is nothing to play. */
  sample(frame) {
    if (!this.length) return null;
    return this.at(this.easedFrame(frame));
  }

  /**
   * Pose at frame `f`: { eye, forward, roll }, each null when its track is
   * empty. Lands exactly on keyframe values at keyframe frames; between them,
   * either linear lerp or auto Catmull-Rom spline.
   */
  at(f) {
    const eye = this.eyeAt(f);
    const r = this.rotAt(f);
    return { eye, forward: r ? forwardOf(r) : null, roll: r ? r.roll : null };
  }

  /** Eye position at `f` from the position track; null with no keys. */
  eyeAt(f) {
    const k = this.pos;
    if (!k.length) return null;
    if (k.length === 1 || f <= k[0].frame) return k[0].eye;
    const last = k[k.length - 1];
    if (f >= last.frame) return last.eye;
    const [i, u] = segmentAt(k, f);
    const a = k[i];
    const b = k[i + 1];
    if (this.curve === 'linear') return lerp3(a.eye, b.eye, u);
    const p0 = k[Math.max(0, i - 1)];
    const p3 = k[Math.min(k.length - 1, i + 2)];
    return catmull3(p0.eye, a.eye, b.eye, p3.eye, u);
  }

  /** { yaw, pitch, roll } at `f` from the rotation track; null with no keys. */
  rotAt(f) {
    const k = this.rot;
    if (!k.length) return null;
    if (k.length === 1 || f <= k[0].frame) return k[0];
    const last = k[k.length - 1];
    if (f >= last.frame) return last;
    const [i, u] = segmentAt(k, f);
    const a = k[i];
    const b = k[i + 1];
    let yaw;
    let pitch;
    let roll;
    if (this.curve === 'linear' || this.rotation === 'linear') {
      yaw = a.yaw + (b.yaw - a.yaw) * u;
      pitch = a.pitch + (b.pitch - a.pitch) * u;
      roll = a.roll + (b.roll - a.roll) * u;
    } else {
      // Angles splined on frame-time knots. A uniform (by key index) spline
      // would swing a short segment next to a long one through most of its
      // turn in the first few frames — the "snap" mid-curve; timing the knots
      // by frame keeps the turn rate proportional to the gap between keys.
      const p0 = k[Math.max(0, i - 1)];
      const p3 = k[Math.min(k.length - 1, i + 2)];
      const kn = [p0.frame, a.frame, b.frame, p3.frame];
      yaw = catmullKnots(p0.yaw, a.yaw, b.yaw, p3.yaw, kn, u);
      pitch = catmullKnots(p0.pitch, a.pitch, b.pitch, p3.pitch, kn, u);
      roll = catmullKnots(p0.roll, a.roll, b.roll, p3.roll, kn, u);
    }
    // The spline can overshoot slightly on the angle channels; the fly camera
    // clamps pitch to ±1.55 anyway, so clamp here and stay in sync with it.
    return { yaw, pitch: clamp(pitch, -1.55, 1.55), roll };
  }

  /** Eye positions along the whole path, for the viewport overlay. */
  path(steps = 128) {
    const k = this.pos;
    if (k.length < 2) return [];
    const from = k[0].frame;
    const span = k[k.length - 1].frame - from;
    const out = [];
    for (let i = 0; i <= steps; i++) out.push(this.eyeAt(from + (span * i) / steps));
    return out;
  }
}

/**
 * Scene track: [{ frame, weather, timeMinutes? }] → weather (and legacy time).
 *
 * Weather STEPS — it is an id, there is nothing between "Rain" and "Clear", and
 * the environment manager runs its own 3.33s cross-fade when the id changes.
 * Time of day lives on the dedicated `tod` track (`sampleTod`); older saves
 * that baked minutes into scene keys still expose `timeMinutes` here as a
 * fallback. Empty track → leave the zone as the user set it.
 */
export function sampleScene(keys, f) {
  if (!keys?.length) return null;
  const k = keys.slice().sort((a, b) => a.frame - b.frame);
  if (f <= k[0].frame) {
    return { weather: k[0].weather, timeMinutes: k[0].timeMinutes };
  }
  const last = k[k.length - 1];
  if (f >= last.frame) {
    return { weather: last.weather, timeMinutes: last.timeMinutes };
  }
  let i = 0;
  while (i < k.length - 2 && f > k[i + 1].frame) i++;
  const a = k[i];
  const b = k[i + 1];
  const u = (f - a.frame) / ((b.frame - a.frame) || 1);
  const ta = a.timeMinutes, tb = b.timeMinutes;
  return {
    weather: a.weather,
    timeMinutes: (ta != null && tb != null) ? ta + (tb - ta) * u : ta ?? tb,
  };
}

/**
 * Time-of-day track: [{ frame, timeMinutes }] → minutes past midnight at `f`.
 * Lerps between keys so a sunset can span a shot. Empty → null (caller keeps
 * the live clock).
 */
export function sampleTod(keys, f) {
  if (!keys?.length) return null;
  const k = keys.slice().sort((a, b) => a.frame - b.frame);
  if (f <= k[0].frame) return { timeMinutes: k[0].timeMinutes };
  const last = k[k.length - 1];
  if (f >= last.frame) return { timeMinutes: last.timeMinutes };
  let i = 0;
  while (i < k.length - 2 && f > k[i + 1].frame) i++;
  const a = k[i];
  const b = k[i + 1];
  const u = (f - a.frame) / ((b.frame - a.frame) || 1);
  return { timeMinutes: a.timeMinutes + (b.timeMinutes - a.timeMinutes) * u };
}
