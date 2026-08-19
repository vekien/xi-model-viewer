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

/** Capture the live camera as a keyframe pose. Works in orbit and in fly mode. */
export function poseFromCamera(camera) {
  const e = camera.eye;
  const f = camera.forward;
  return { eye: [e[0], e[1], e[2]], forward: [f[0], f[1], f[2]] };
}

/**
 * Point the live camera at a sampled pose. Playback always runs the camera in
 * fly mode: it is the only mode that holds an arbitrary eye plus look direction
 * (orbit derives its eye from a target, so a path through the world would have
 * to fight it). Yaw/pitch follow the camera's current up convention.
 */
export function driveCamera(camera, pose) {
  const f = pose.forward;
  camera.mode = 'fly';
  camera.pos = [pose.eye[0], pose.eye[1], pose.eye[2]];
  camera.yaw = Math.atan2(f[0], f[2]);
  const horiz = Math.hypot(f[0], f[2]) || 1e-6;
  camera.pitch = camera.yUp ? Math.atan2(f[1], horiz) : Math.atan2(-f[1], horiz);
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

export class CameraSequence {
  /**
   * `keys` — [{ frame, eye, forward }] in any order.
   * `totalFrames` — length of the whole sequence.
   * `curve` — 'spline' (auto Catmull-Rom through keys) or 'linear' (straight
   *   segments). Keyframes are ALWAYS hit at their exact frame times; there is
   *   no whole-timeline ease that warps the clock.
   */
  constructor(keys, { totalFrames = 300, curve = 'spline', ease } = {}) {
    this.totalFrames = Math.max(1, Math.round(totalFrames));
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
    const yaw = catmull1(p0.yaw, a.yaw, b.yaw, p3.yaw, u);
    // The spline can overshoot slightly on the angle channels; the fly camera
    // clamps pitch to ±1.55 anyway, so clamp here and stay in sync with it.
    const pitch = clamp(catmull1(p0.pitch, a.pitch, b.pitch, p3.pitch, u), -1.55, 1.55);
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
 * Scene track: [{ frame, weather, timeMinutes }] → the zone state at frame `f`.
 *
 * Weather STEPS — it is an id, there is nothing between "Rain" and "Clear", and
 * the environment manager runs its own 3.33s cross-fade when the id changes.
 * Time of day LERPS between keyframes, which is what makes a sunset possible
 * over the length of a shot. Nothing before the first keyframe: an empty track
 * leaves the zone exactly as the user set it.
 */
export function sampleScene(keys, f) {
  if (!keys?.length) return null;
  const k = keys.slice().sort((a, b) => a.frame - b.frame);
  if (f <= k[0].frame) return { weather: k[0].weather, timeMinutes: k[0].timeMinutes };
  const last = k[k.length - 1];
  if (f >= last.frame) return { weather: last.weather, timeMinutes: last.timeMinutes };
  let i = 0;
  while (i < k.length - 2 && f > k[i + 1].frame) i++;
  const a = k[i];
  const b = k[i + 1];
  const u = (f - a.frame) / ((b.frame - a.frame) || 1);
  return {
    weather: a.weather,
    timeMinutes: a.timeMinutes + (b.timeMinutes - a.timeMinutes) * u,
  };
}
