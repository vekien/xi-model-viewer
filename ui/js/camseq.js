// Camera sequencer: keyframed camera poses splined into a flythrough path.
//
// A keyframe stores the pose in a form independent of both the camera mode and
// the up-vector convention — a world eye position plus a unit forward vector —
// so a sequence recorded while orbiting a model plays back identically in fly
// mode, and the Y-down entity views and Y-up zone views (see camera.js) can't
// disagree about which way "up" was. The (yaw, pitch) pair the fly camera
// actually wants is derived at drive time from the live camera's own yUp, which
// is exactly what OrbitCamera.setMode and the creation camera track already do.
//
// FOV is deliberately not part of a keyframe: the sequence is position and
// rotation only, so the Camera popover's field of view stays the user's to set
// and never drifts out from under the readout while a sequence plays.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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
 * if the framing was nudged off-centre before recording.
 */
export function poseFromCamera(camera, lockTarget = null) {
  const e = camera.eye;
  const eye = [e[0], e[1], e[2]];
  const f = (lockTarget && forwardTo(eye, lockTarget)) ?? camera.forward;
  return { eye, forward: [f[0], f[1], f[2]] };
}

/**
 * Re-aim a sampled pose at a world point, keeping its eye position.
 *
 * Used for "Lock to Actor": the eye still follows the splined path, but the
 * rotation is solved per frame rather than interpolated between keyframes, so
 * the actor stays centred even where the path swings around it — which
 * interpolated yaw/pitch cannot do (they cut the corner between two keys).
 */
export function aimPoseAt(pose, target) {
  if (!pose || !target) return pose;
  const forward = forwardTo(pose.eye, target);
  return forward ? { eye: pose.eye, forward } : pose;
}

/**
 * Point the live camera at a sampled pose. Playback always runs the camera in
 * fly mode: it is the only mode that holds an arbitrary eye plus look direction
 * (orbit derives its eye from a target, so a path through the world would have
 * to fight it). Yaw/pitch follow the camera's current up convention.
 */
export function driveCamera(camera, pose, { orbit = false, orbitTarget = null } = {}) {
  const e = pose.eye;
  const f = pose.forward;
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

/**
 * Uniform Catmull-Rom for the angle channels. Their units aren't distances, so
 * the chordal knot spacing above would be meaningless for them; both forms
 * share the segment's u, so every channel still lands exactly on its keyframe
 * value at the segment ends.
 */
function catmull1(p0, p1, p2, p3, u) {
  const t2 = u * u;
  const t3 = t2 * u;
  return 0.5 * ((2 * p1)
    + (-p0 + p2) * u
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
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

/** Centripetal (alpha 0.5) knot times for four control points. */
function knots(p0, p1, p2, p3) {
  const knot = (a, b) => Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])) || 1e-4;
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  return [t0, t1, t2, t3];
}

/** Barry–Goldman Catmull-Rom on a scalar channel with the given knots. */
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

export class CameraSequence {
  /**
   * `keys` — [{ frame, eye, forward }] in any order.
   * `totalFrames` — length of the whole sequence.
   * `curve` — 'spline' (auto Catmull-Rom through keys) or 'linear' (straight
   *   segments). Keyframes are ALWAYS hit at their exact frame times; there is
   *   no whole-timeline ease that warps the clock.
   */
  constructor(keys, { totalFrames = 300, curve = 'spline', ease, rotation = 'spline' } = {}) {
    this.totalFrames = Math.max(1, Math.round(totalFrames));
    // How the facing moves between keys: 'spline' rides the same centripetal
    // curve as the eye, 'linear' turns at a constant rate per segment while
    // the eye still follows the curve.
    this.rotation = rotation === 'linear' ? 'linear' : 'spline';
    // Migrate old `ease` flag: anything that wasn't explicitly linear → spline.
    if (curve !== 'linear' && curve !== 'spline') {
      curve = (ease === 'linear' || ease === false) ? 'linear' : 'spline';
    }
    this.curve = curve === 'linear' ? 'linear' : 'spline';
    this.keys = keys
      .slice()
      .sort((a, b) => a.frame - b.frame)
      .map((k) => {
        const f = k.forward;
        const horiz = Math.hypot(f[0], f[2]) || 1e-6;
        return {
          frame: k.frame,
          eye: k.eye,
          // Interpolation parameters only — plain world azimuth/elevation, with
          // no up-vector convention baked in (driveCamera re-derives whatever
          // the live camera needs from the forward vector below).
          yaw: Math.atan2(f[0], f[2]),
          pitch: Math.atan2(f[1], horiz),
        };
      });
    // Unwrap yaw so a turn across ±180° takes the short way instead of spinning
    // the long way round the compass.
    for (let i = 1; i < this.keys.length; i++) {
      const prev = this.keys[i - 1].yaw;
      let y = this.keys[i].yaw;
      while (y - prev > Math.PI) y -= 2 * Math.PI;
      while (prev - y > Math.PI) y += 2 * Math.PI;
      this.keys[i].yaw = y;
    }
  }

  get length() { return this.keys.length; }

  /**
   * Playhead frame → sample frame. Identity: timing matches the timeline.
   * Kept so scene/camera stay on one clock without a second code path.
   */
  easedFrame(frame) {
    return clamp(frame, 0, this.totalFrames);
  }

  /** Pose at a playhead frame. Null when there is nothing to play. */
  sample(frame) {
    if (!this.keys.length) return null;
    return this.at(this.easedFrame(frame));
  }

  /**
   * Pose at frame `f`. Lands exactly on keyframe poses at keyframe frames;
   * between them, either linear lerp or auto Catmull-Rom spline.
   */
  at(f) {
    const k = this.keys;
    if (!k.length) return null;
    if (k.length === 1 || f <= k[0].frame) return poseOf(k[0]);
    const last = k[k.length - 1];
    if (f >= last.frame) return poseOf(last);

    let i = 0;
    while (i < k.length - 2 && f > k[i + 1].frame) i++;
    const a = k[i];
    const b = k[i + 1];
    const u = (f - a.frame) / ((b.frame - a.frame) || 1);

    if (this.curve === 'linear') {
      const yaw = a.yaw + (b.yaw - a.yaw) * u;
      const pitch = clamp(a.pitch + (b.pitch - a.pitch) * u, -1.55, 1.55);
      const cp = Math.cos(pitch);
      return {
        eye: lerp3(a.eye, b.eye, u),
        forward: [cp * Math.sin(yaw), Math.sin(pitch), cp * Math.cos(yaw)],
      };
    }

    const p0 = k[Math.max(0, i - 1)];
    const p3 = k[Math.min(k.length - 1, i + 2)];
    let yaw;
    let pitch;
    if (this.rotation === 'linear') {
      yaw = a.yaw + (b.yaw - a.yaw) * u;
      pitch = a.pitch + (b.pitch - a.pitch) * u;
    } else {
      // Angles on the same centripetal knots as the eye path. The uniform
      // Catmull-Rom this replaced parameterised by key index, so a short
      // segment next to a long one swung the view through most of its turn
      // in the first few frames — the "snap" mid-curve.
      const kn = knots(p0.eye, a.eye, b.eye, p3.eye);
      yaw = catmullKnots(p0.yaw, a.yaw, b.yaw, p3.yaw, kn, u);
      pitch = catmullKnots(p0.pitch, a.pitch, b.pitch, p3.pitch, kn, u);
    }
    // The spline can overshoot slightly on the angle channels; the fly camera
    // clamps pitch to ±1.55 anyway, so clamp here and stay in sync with it.
    pitch = clamp(pitch, -1.55, 1.55);
    const cp = Math.cos(pitch);
    return {
      eye: catmull3(p0.eye, a.eye, b.eye, p3.eye, u),
      forward: [cp * Math.sin(yaw), Math.sin(pitch), cp * Math.cos(yaw)],
    };
  }

  /** Eye positions along the whole path, for the viewport overlay. */
  path(steps = 128) {
    const k = this.keys;
    if (k.length < 2) return [];
    const from = k[0].frame;
    const span = k[k.length - 1].frame - from;
    const out = [];
    for (let i = 0; i <= steps; i++) out.push(this.at(from + (span * i) / steps).eye);
    return out;
  }
}

function poseOf(k) {
  const cp = Math.cos(k.pitch);
  return {
    eye: k.eye,
    forward: [cp * Math.sin(k.yaw), Math.sin(k.pitch), cp * Math.cos(k.yaw)],
  };
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
