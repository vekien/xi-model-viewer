// Skeleton pose evaluation — port of XiViewer.Data SkeletonPose (from xim's
// SkeletonInstance.kt). Per-joint world transform: world(v) = rotate(R, S*v) + T.
// Verified skinning math (docs/mesh/format.md):
//   single: world = t0 + rot(q0, p0)
//   double: world = (rot(q0,p0) + w0*t0) + (rot(q1,p1) + w1*t1)   [p pre-weighted]

// --- Quaternion helpers (x,y,z,w arrays) -----------------------------------

export function qMul(a, b) {
  // Hamilton product a⊗b (apply b first, then a)
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function qRotate(q, v) {
  // v + 2*cross(q.xyz, cross(q.xyz, v) + w*v)
  const [qx, qy, qz, qw] = q, [vx, vy, vz] = v;
  const cx = qy * vz - qz * vy + qw * vx;
  const cy = qz * vx - qx * vz + qw * vy;
  const cz = qx * vy - qy * vx + qw * vz;
  return [
    vx + 2 * (qy * cz - qz * cy),
    vy + 2 * (qz * cx - qx * cz),
    vz + 2 * (qx * cy - qy * cx),
  ];
}

function qNlerp(a, b, t) {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = dot < 0 ? -1 : 1;
  const x = a[0] * (1 - t) + b[0] * s * t;
  const y = a[1] * (1 - t) + b[1] * s * t;
  const z = a[2] * (1 - t) + b[2] * s * t;
  const w = a[3] * (1 - t) + b[3] * s * t;
  const len = Math.hypot(x, y, z, w) || 1;
  return [x / len, y / len, z / len, w / len];
}

function lerp3(a, ai, b, bi, t) {
  return [
    a[ai] * (1 - t) + b[bi] * t,
    a[ai + 1] * (1 - t) + b[bi + 1] * t,
    a[ai + 2] * (1 - t) + b[bi + 2] * t,
  ];
}

// A sampled track value: { q (rotation), t (translation), s (scale) }.
const IDENTITY_SAMPLE = { q: [0, 0, 0, 1], t: [0, 0, 0], s: [1, 1, 1] };

/** Interpolate two samples (u: 0 = a, 1 = b). Used to blend a finishing schedule segment back to base idle. */
function blendSample(a, b, u) {
  return {
    q: qNlerp(a.q, b.q, u),
    t: [a.t[0] * (1 - u) + b.t[0] * u, a.t[1] * (1 - u) + b.t[1] * u, a.t[2] * (1 - u) + b.t[2] * u],
    s: [a.s[0] * (1 - u) + b.s[0] * u, a.s[1] * (1 - u) + b.s[1] * u, a.s[2] * (1 - u) + b.s[2] * u],
  };
}

// ---------------------------------------------------------------------------

export class SkeletonPose {
  constructor(skeleton, parentOverrides = null) {
    this.skeleton = skeleton;
    // jointIndex -> replacement parent joint index. Used to re-parent a drawn
    // weapon's grip joint onto the hand attach joint (xim jointParentOverrides).
    this.parentOverrides = parentOverrides;
    const n = skeleton.joints.length;
    this.rot = new Array(n);      // per-joint world rotation quaternion
    this.trans = new Array(n);    // per-joint world translation
    this.scale = new Array(n);    // per-joint world scale
    this.evaluate(null, 0);
  }

  evaluate(clip, frame) {
    const joints = this.skeleton.joints;
    const n = joints.length;
    const computed = new Array(n).fill(false);
    let missing;

    // Schedule sequences: each 0x05 command is a segment on a timeline. A
    // segment plays over [delay, delay+len], then blends back out to the base
    // idle over transOut frames — so a short command doesn't freeze its joints
    // for the rest of the loop (the "held/reset pause"). Later segments win
    // joints they share with earlier ones.
    const active = [];
    let basePhase = 0;
    if (clip?.segments) {
      for (const seg of clip.segments) {
        if (frame < seg.delay) continue;
        const len = seg.clip.lengthInFrames;
        const local = frame - seg.delay;
        if (local <= len || len <= 0) {
          // `ease` is the mirror of `release` below: blend IN from the base over
          // transIn frames, so a montage laid over a resting clip starts from
          // the pose already on screen instead of snapping to its first frame.
          // Retail schedules leave transIn unset, so they are unaffected.
          const ease = seg.transIn > 0 ? Math.min(1, local / seg.transIn) : 1;
          active.push({ clip: seg.clip, phase: len > 0 ? local / len : 0, release: 0, ease });
        } else if (seg.transOut > 0) {
          const release = (local - len) / seg.transOut;   // 0 at end → 1 fully back to base
          // `<= 1`, not `< 1`: dropping the segment at release == 1 cut the fade
          // one step short, so the last 1/rel of the travel happened in a single
          // frame — a visible snap back to idle on a short transOut. At exactly
          // 1 the blend already yields the base pose, so keeping it is a no-op
          // for the result and makes the hand-off continuous.
          if (release <= 1) active.push({ clip: seg.clip, phase: 1, release, ease: 1 });
        } else {
          // transOut 0 means "hand straight over", not "blend out over some
          // default". Every such segment in the PC set is followed by one
          // starting exactly where it ends (cait mi0@0+14 -> mi1@14), so the
          // successor claims the joints on the very next frame and nothing is
          // held for long. Substituting a default release instead made the
          // pose drift back toward the battle stance in any gap — Eagle Eye
          // Shot's routine leaves two frames between yu0 ending at 58 and yu1
          // starting at 60, which read as a jitter mid-weapon-skill. Holding
          // the final pose is also what a trailing 0 wants: `dead` ends on
          // cor@58+1/out0 and should stay down.
          active.push({ clip: seg.clip, phase: 1, release: 0, ease: 1 });
        }
      }
      // Base idle underlay, looping on its own length so it stays continuous
      // across the schedule's loop point. Joints no segment drives (and the
      // release target for finished segments) rest here instead of bind pose.
      const baseLen = clip.baseClip?.lengthInFrames ?? 0;
      basePhase = baseLen > 0 ? (frame % baseLen) / baseLen : 0;
    }

    do {
      missing = false;
      for (let i = 0; i < n; i++) {
        if (computed[i]) continue;

        // Hand re-parenting applies only while no clip drives the grip joint —
        // weapon-skill clips animate it (relative to its real parent) and the
        // override would double-transform the swing. When it applies, the joint
        // adopts the hand transform wholesale: bind local dropped, scale reset
        // (xim updateCurrentJointTransformWithParentOverride).
        // A reset track (negative offsets in the DAT) pins the joint to bind,
        // which for a re-parented grip is "hang off the hand" — so it does not
        // count as the clip driving the joint.
        const override = this.parentOverrides?.get(i);
        const driven = clip?.jointTracks.get(i);
        if (override !== undefined && !(driven && !driven.reset)) {
          if (!computed[override]) { missing = true; continue; }
          this.rot[i] = this.rot[override];
          this.trans[i] = this.trans[override];
          this.scale[i] = [1, 1, 1];
          computed[i] = true;
          continue;
        }

        const parent = joints[i].parent;
        if (parent >= 0 && !computed[parent]) { missing = true; continue; }

        let translation = joints[i].trans.slice();
        let rotation = joints[i].rot;
        let scale = [1, 1, 1];

        if (clip) {
          let s = null;
          if (clip.segments) {
            // Base idle sample for this joint (release target + fallback).
            const bt = clip.baseClip?.jointTracks.get(i);
            const baseS = bt ? sampleTrack(bt, basePhase) : null;
            let win = null;
            for (const seg of active) if (seg.clip.jointTracks.has(i)) win = seg;   // last wins
            if (win) {
              s = sampleTrack(win.clip.jointTracks.get(i), win.phase);
              // Blend a starting segment in from the base idle (or bind)...
              if (win.ease < 1) s = blendSample(baseS ?? IDENTITY_SAMPLE, s, win.ease);
              // ...and a releasing one back out to it.
              if (win.release > 0) s = blendSample(s, baseS ?? IDENTITY_SAMPLE, win.release);
            } else if (baseS) {
              s = baseS;   // no segment here — rest in idle, not bind pose
            }
          } else {
            const track = clip.jointTracks.get(i);
            // Phase-based so a merged clip's parts (different frame counts) stay
            // in sync — same as the in-game routine scaling each clip to one window.
            if (track) {
              s = sampleTrack(track, clip.lengthInFrames > 0 ? frame / clip.lengthInFrames : 0);
            } else if (clip.baseClip) {
              // Partial body clips (battle btl0+btl1, no waist btl2): undriven
              // joints rest on idle/waist instead of bind pose.
              const bt = clip.baseClip.jointTracks.get(i);
              if (bt) {
                const baseLen = clip.baseClip.lengthInFrames ?? 0;
                const bp = baseLen > 0 ? (frame % baseLen) / baseLen : 0;
                s = sampleTrack(bt, bp);
              }
            }
          }
          if (s) {
            translation = [translation[0] + s.t[0], translation[1] + s.t[1], translation[2] + s.t[2]];
            rotation = qMul(s.q, rotation);              // anim applied after bind
            if (i !== 0) scale = s.s;                    // root scale ignored
          }
        }

        // Root translation is not in skeleton-space: (x,y,z) -> (-z,y,x)
        if (i === 0) translation = [-translation[2], translation[1], translation[0]];

        if (parent < 0) {
          this.rot[i] = rotation;
          this.trans[i] = translation;
          this.scale[i] = scale;
        } else {
          const ps = this.scale[parent];
          const scaled = [ps[0] * translation[0], ps[1] * translation[1], ps[2] * translation[2]];
          const rotated = qRotate(this.rot[parent], scaled);
          const pt = this.trans[parent];
          this.trans[i] = [pt[0] + rotated[0], pt[1] + rotated[1], pt[2] + rotated[2]];
          this.scale[i] = [ps[0] * scale[0], ps[1] * scale[1], ps[2] * scale[2]];
          this.rot[i] = qMul(this.rot[parent], rotation); // local first, then parent
        }

        computed[i] = true;
      }
    } while (missing);
  }

  /** Packs the pose into flat arrays for shader uniforms: vec4 rot, vec4 trans, vec4 scale. */
  pack(rotOut, transOut, scaleOut) {
    const n = this.skeleton.joints.length;
    for (let i = 0; i < n; i++) {
      rotOut.set(this.rot[i], i * 4);
      transOut[i * 4] = this.trans[i][0];
      transOut[i * 4 + 1] = this.trans[i][1];
      transOut[i * 4 + 2] = this.trans[i][2];
      transOut[i * 4 + 3] = 0;
      scaleOut[i * 4] = this.scale[i][0];
      scaleOut[i * 4 + 1] = this.scale[i][1];
      scaleOut[i * 4 + 2] = this.scale[i][2];
      scaleOut[i * 4 + 3] = 0;
    }
  }

  /** CPU-skins one vertex (used for camera-fit bounds at bind pose). */
  skinPosition(v) {
    const j0 = Math.min(Math.max(v.joint0, 0), this.rot.length - 1);
    const s0 = this.scale[j0];
    const p0 = qRotate(this.rot[j0], [s0[0] * v.p0[0], s0[1] * v.p0[1], s0[2] * v.p0[2]]);
    const t0 = this.trans[j0];

    if (v.joint1 < 0)
      return [t0[0] + p0[0], t0[1] + p0[1], t0[2] + p0[2]];

    const j1 = Math.min(Math.max(v.joint1, 0), this.rot.length - 1);
    const s1 = this.scale[j1];
    const p1 = qRotate(this.rot[j1], [s1[0] * v.p1[0], s1[1] * v.p1[1], s1[2] * v.p1[2]]);
    const t1 = this.trans[j1];
    return [
      p0[0] + v.w0 * t0[0] + p1[0] + v.w1 * t1[0],
      p0[1] + v.w0 * t0[1] + p1[1] + v.w1 * t1[1],
      p0[2] + v.w0 * t0[2] + p1[2] + v.w1 * t1[2],
    ];
  }
}

/** Samples a track at normalized phase [0,1]. Uses the track's own frame count. */
function sampleTrack(track, phase) {
  const frames = track.frames;
  const last = frames - 1;

  if (last <= 0 || phase >= 1) {
    const f = Math.max(last, 0);
    return {
      q: [track.rotations[f * 4], track.rotations[f * 4 + 1], track.rotations[f * 4 + 2], track.rotations[f * 4 + 3]],
      t: [track.translations[f * 3], track.translations[f * 3 + 1], track.translations[f * 3 + 2]],
      s: [track.scales[f * 3], track.scales[f * 3 + 1], track.scales[f * 3 + 2]],
    };
  }

  const p = phase < 0 ? 0 : phase;
  const pos = p * last;
  const lower = Math.min(Math.floor(pos), last - 1);
  const upper = lower + 1;
  const t = pos - lower;

  const qa = [track.rotations[lower * 4], track.rotations[lower * 4 + 1], track.rotations[lower * 4 + 2], track.rotations[lower * 4 + 3]];
  const qb = [track.rotations[upper * 4], track.rotations[upper * 4 + 1], track.rotations[upper * 4 + 2], track.rotations[upper * 4 + 3]];

  return {
    q: qNlerp(qa, qb, t),
    t: lerp3(track.translations, lower * 3, track.translations, upper * 3, t),
    s: lerp3(track.scales, lower * 3, track.scales, upper * 3, t),
  };
}
