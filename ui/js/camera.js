// Orbit + WASD fly camera. Entities use FFXI Y-down (up = −Y); zones match the
// level editor's Y-up display (−x, −y, z).

export function mat4Perspective(fovYRad, aspect, near, far) {
  const f = 1 / Math.tan(fovYRad / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

/** Column-major orthographic projection (glOrtho): visible z ∈ [−far, −near]. */
export function mat4Ortho(left, right, bottom, top, near, far) {
  const out = new Float32Array(16);
  out[0] = 2 / (right - left);
  out[5] = 2 / (top - bottom);
  out[10] = -2 / (far - near);
  out[12] = -(right + left) / (right - left);
  out[13] = -(top + bottom) / (top - bottom);
  out[14] = -(far + near) / (far - near);
  out[15] = 1;
  return out;
}

export function mat4LookAt(eye, target, up) {
  const zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let zl = Math.hypot(zx, zy, zz) || 1;
  const z = [zx / zl, zy / zl, zz / zl];
  const x = norm(cross(up, z));
  const y = cross(z, x);
  const out = new Float32Array(16);
  out[0] = x[0]; out[4] = x[1]; out[8] = x[2];
  out[1] = y[0]; out[5] = y[1]; out[9] = y[2];
  out[2] = z[0]; out[6] = z[1]; out[10] = z[2];
  out[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]);
  out[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]);
  out[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
  out[15] = 1;
  return out;
}

export function mat4Multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return out;
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Rotate vector `v` about unit-ish `axis` by `angle` (Rodrigues). */
function rotateVec(v, axis, angle) {
  if (Math.abs(angle) < 1e-12) return [v[0], v[1], v[2]];
  const a = norm(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = (1 - c) * (a[0] * v[0] + a[1] * v[1] + a[2] * v[2]);
  return [
    c * v[0] + s * (a[1] * v[2] - a[2] * v[1]) + d * a[0],
    c * v[1] + s * (a[2] * v[0] - a[0] * v[2]) + d * a[1],
    c * v[2] + s * (a[0] * v[1] - a[1] * v[0]) + d * a[2],
  ];
}

export const FLY_SPEED_MIN = 1;
export const FLY_SPEED_MAX = 300;
/** Zone fly default (half the old 50). Entity default is 1/6 of this. */
export const FLY_SPEED_ZONE = 25;
export const FLY_SPEED_ENTITY = FLY_SPEED_ZONE / 6; // ≈ 4.17

function loadFlySpeed(key, fallback) {
  try {
    const v = parseFloat(localStorage.getItem(key));
    return Number.isFinite(v) ? Math.min(FLY_SPEED_MAX, Math.max(FLY_SPEED_MIN, v)) : fallback;
  } catch {
    return fallback;
  }
}

export class OrbitCamera {
  constructor() {
    this.mode = 'orbit';          // 'orbit' | 'fly'
    this.yUp = true;             // display space is Y-up for every content kind
    this.rangeKind = 'entity';    // 'zone' | 'entity' — picks default fly speed
    this.target = [0, 0, 0];
    this.yaw = 0.6;
    this.pitch = 0.3;
    this.distance = 5;
    this.fovDegrees = 45;
    // Roll about the view direction (Alt+Q / Alt+E); reset by fit().
    this.roll = 0;
    this.minDistance = 0.1;
    this.maxDistance = 500;
    this.near = 0.05;
    this.far = 1000;
    // Graphics › Render Distance: zone far plane override (0 = the 5000 default).
    this.renderDistance = 0;
    // Fly state — separate remembered speeds per context
    this.pos = [0, 0, 5];
    // Set while the Camera Sequencer is flying a recorded path: WASD, drags and
    // the wheel all stand down rather than fight it for the pose.
    this.sequenceLock = false;
    // User orbit/pan/zoom/fly — keep this framing across DAT loads until fit().
    this.userFramed = false;
    this.flySpeedZone = loadFlySpeed('flySpeedZone', FLY_SPEED_ZONE);
    this.flySpeedEntity = loadFlySpeed('flySpeedEntity', FLY_SPEED_ENTITY);
    this.flySpeed = this.flySpeedEntity;
  }

  /** World up for the current handedness, before any roll. */
  get baseUp() {
    return this.yUp ? [0, 1, 0] : [0, -1, 0];
  }

  /** View up: world up rotated about the view direction by `roll`. */
  get up() {
    const base = this.baseUp;
    if (!this.roll) return base;
    let f;
    if (this.mode === 'fly') f = this.lookDir;
    else {
      const e = this.eye;
      f = norm([this.target[0] - e[0], this.target[1] - e[1], this.target[2] - e[2]]);
    }
    // Rodrigues: rotate `base` about unit axis `f`.
    const c = Math.cos(this.roll);
    const s = Math.sin(this.roll);
    const d = f[0] * base[0] + f[1] * base[1] + f[2] * base[2];
    const cr = cross(f, base);
    return [
      base[0] * c + cr[0] * s + f[0] * d * (1 - c),
      base[1] * c + cr[1] * s + f[1] * d * (1 - c),
      base[2] * c + cr[2] * s + f[2] * d * (1 - c),
    ];
  }

  /** Unit look direction for fly mode (pitch > 0 = look "up" on screen). */
  get lookDir() {
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const y = this.yUp ? sp : -sp;
    return [
      cp * Math.sin(this.yaw),
      y,
      cp * Math.cos(this.yaw),
    ];
  }

  get eye() {
    if (this.mode === 'fly') return this.pos;
    // Orbit: eye on a sphere around target (legacy entity framing preserved).
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const yOff = this.yUp ? sp : -sp;
    return [
      this.target[0] + cp * Math.sin(this.yaw) * this.distance,
      this.target[1] + yOff * this.distance,
      this.target[2] + cp * Math.cos(this.yaw) * this.distance,
    ];
  }

  get forward() {
    if (this.mode === 'fly') return this.lookDir;
    const e = this.eye;
    return norm([this.target[0] - e[0], this.target[1] - e[1], this.target[2] - e[2]]);
  }

  viewMatrix() {
    if (this.mode === 'fly') {
      const e = this.pos;
      const f = this.lookDir;
      return mat4LookAt(e, [e[0] + f[0], e[1] + f[1], e[2] + f[2]], this.up);
    }
    return mat4LookAt(this.eye, this.target, this.up);
  }

  projectionMatrix(aspect) {
    // Graphics › Render Distance pins the zone far plane; entities keep the
    // distance-scaled far so close-up depth precision is unaffected.
    const far = (this.rangeKind === 'zone' && this.renderDistance > 0)
      ? Math.max(this.renderDistance, this.near * 4)
      : Math.max(this.far, (this.mode === 'fly' ? this.flySpeed * 40 : this.distance * 8) + 50);
    const near = Math.min(this.near, Math.max((this.mode === 'fly' ? this.flySpeed : this.distance) * 0.0005, 0.05));
    return mat4Perspective((this.fovDegrees * Math.PI) / 180, aspect, near, far);
  }

  /**
   * Orbit the view.
   *  - No pivot: tumble around the look-at target (zones / default).
   *  - With pivot (entity centre): rotate eye + target around that point so a
   *    prior pan is kept — the character stays put on screen while the camera
   *    swings around them.
   *
   * Yaw sign matches flyLook (Y-up needs the opposite sign). Pitch is clamped on
   * the pivot→eye elevation so top-down never crosses the pole and flips.
   */
  orbit(dx, dy, pivot = null) {
    const yawSign = this.yUp ? -1 : 1;
    const dYaw = yawSign * dx * 0.01;
    const dPitch = dy * 0.01;
    const pitchLimit = 1.55;

    if (!pivot || this.mode === 'fly') {
      this.yaw += dYaw;
      this.pitch = Math.min(Math.max(this.pitch + dPitch, -pitchLimit), pitchLimit);
      this.userFramed = true;
      return;
    }

    const up = this.up;
    const e = this.eye;
    const t = this.target;
    // Offsets from the model pivot — rotate these rigidly (same yaw then pitch).
    let eOff = [e[0] - pivot[0], e[1] - pivot[1], e[2] - pivot[2]];
    let tOff = [t[0] - pivot[0], t[1] - pivot[1], t[2] - pivot[2]];

    // Elevation of the eye above the pivot (same convention as this.pitch).
    const eDist = Math.hypot(eOff[0], eOff[1], eOff[2]);
    if (eDist < 1e-6) return;
    const eHoriz = Math.hypot(eOff[0], eOff[2]) || 1e-6;
    const elev = this.yUp
      ? Math.atan2(eOff[1], eHoriz)
      : Math.atan2(-eOff[1], eHoriz);
    // Clamp the applied pitch so we never cross ±pitchLimit about the pivot.
    const aPitch = Math.min(Math.max(elev + dPitch, -pitchLimit), pitchLimit) - elev;

    // 1) Yaw around world-up through the pivot.
    if (Math.abs(dYaw) > 1e-12) {
      eOff = rotateVec(eOff, up, dYaw);
      tOff = rotateVec(tOff, up, dYaw);
    }

    // 2) Pitch around the horizontal axis ⊥ up and pivot→eye (stable at poles:
    //    length → 0 and we skip, already clamped by elev).
    if (Math.abs(aPitch) > 1e-12) {
      // right = up × eOff  →  screen-right when looking toward the pivot
      const r = cross(up, eOff);
      const rLen = Math.hypot(r[0], r[1], r[2]);
      if (rLen > 1e-5) {
        const right = [r[0] / rLen, r[1] / rLen, r[2] / rLen];
        // Negate so drag-down matches classic orbit (pitch += dy).
        eOff = rotateVec(eOff, right, -aPitch);
        tOff = rotateVec(tOff, right, -aPitch);
      }
    }

    const e2 = [pivot[0] + eOff[0], pivot[1] + eOff[1], pivot[2] + eOff[2]];
    const t2 = [pivot[0] + tOff[0], pivot[1] + tOff[1], pivot[2] + tOff[2]];
    this.target = t2;

    // Rebuild spherical eye-about-target state so getters stay consistent.
    const ox = e2[0] - t2[0];
    const oy = e2[1] - t2[1];
    const oz = e2[2] - t2[2];
    const dist = Math.hypot(ox, oy, oz);
    if (dist < 1e-6) return;
    this.distance = Math.min(Math.max(dist, this.minDistance), this.maxDistance);
    const horiz = Math.hypot(ox, oz);
    // Near top-down, atan2 yaw chatters — keep the previous yaw.
    if (horiz > dist * 0.002) this.yaw = Math.atan2(ox, oz);
    const pitch = this.yUp ? Math.atan2(oy, horiz || 1e-6) : Math.atan2(-oy, horiz || 1e-6);
    this.pitch = Math.min(Math.max(pitch, -pitchLimit), pitchLimit);
    this.userFramed = true;
  }

  /**
   * Fly look. Y-up (zones) matches the level editor: drag right → look right.
   * Y-down (entities) needs the opposite yaw sign because up is flipped and
   * otherwise left/right invert.
   */
  flyLook(dx, dy) {
    const sens = 0.0026;
    const yawSign = this.yUp ? -1 : 1;
    this.yaw += yawSign * dx * sens;
    this.pitch = Math.min(Math.max(this.pitch - dy * sens, -1.55), 1.55);
    this.userFramed = true;
  }

  pan(dx, dy) {
    const f = this.forward;
    const right = norm(cross(f, this.up));
    const up = cross(right, f);
    const s = this.distance * 0.0015;
    this.target = [
      this.target[0] - right[0] * dx * s + up[0] * dy * s,
      this.target[1] - right[1] * dx * s + up[1] * dy * s,
      this.target[2] - right[2] * dx * s + up[2] * dy * s,
    ];
    this.userFramed = true;
  }

  zoom(wheelDelta) {
    this.distance = Math.min(
      Math.max(this.distance * Math.pow(0.999, wheelDelta), this.minDistance),
      this.maxDistance,
    );
    this.userFramed = true;
  }

  /**
   * Orbit zoom anchored at the cursor: the world point under (ndcX, ndcY)
   * stays put on screen while the distance changes, so zooming dives toward
   * wherever the mouse is instead of the panel centre.
   *
   * The anchor is the cursor ray's intersection with the plane through the
   * target perpendicular to the view — no depth readback needed. Scaling the
   * (target − anchor) offset by the same factor as the distance keeps the
   * anchor's projection fixed: both the lateral offset and the depth shrink
   * together, so the angle from the eye to the anchor never changes.
   */
  zoomAt(wheelDelta, ndcX, ndcY, aspect) {
    if (this.mode === 'fly') { this.zoom(wheelDelta); return; }
    const oldDistance = this.distance;
    this.zoom(wheelDelta);
    const k = this.distance / oldDistance;
    if (k === 1) return;

    // View basis straight off the view matrix (rows), so yUp handling and any
    // future camera change stay in one place. Row 3 is "back" (+eye direction).
    const m = this.viewMatrix();
    const right = [m[0], m[4], m[8]];
    const upv = [m[1], m[5], m[9]];
    const fwd = [-m[2], -m[6], -m[10]];

    const th = Math.tan((this.fovDegrees * Math.PI) / 360);
    const dir = norm([
      fwd[0] + right[0] * ndcX * th * aspect + upv[0] * ndcY * th,
      fwd[1] + right[1] * ndcX * th * aspect + upv[1] * ndcY * th,
      fwd[2] + right[2] * ndcX * th * aspect + upv[2] * ndcY * th,
    ]);
    const denom = dir[0] * fwd[0] + dir[1] * fwd[1] + dir[2] * fwd[2];
    if (denom < 1e-4) return;   // grazing ray; plain zoom already applied

    const e = this.eyeAt(oldDistance);
    const t = oldDistance / denom;   // target plane sits oldDistance ahead
    const anchor = [e[0] + dir[0] * t, e[1] + dir[1] * t, e[2] + dir[2] * t];
    this.target = [
      anchor[0] + (this.target[0] - anchor[0]) * k,
      anchor[1] + (this.target[1] - anchor[1]) * k,
      anchor[2] + (this.target[2] - anchor[2]) * k,
    ];
  }

  /** Orbit eye position for an arbitrary distance (zoomAt needs the pre-zoom eye). */
  eyeAt(distance) {
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const yOff = this.yUp ? sp : -sp;
    return [
      this.target[0] + cp * Math.sin(this.yaw) * distance,
      this.target[1] + yOff * distance,
      this.target[2] + cp * Math.cos(this.yaw) * distance,
    ];
  }

  setFlySpeed(v) {
    this.flySpeed = Math.min(FLY_SPEED_MAX, Math.max(FLY_SPEED_MIN, v));
    if (this.rangeKind === 'zone') {
      this.flySpeedZone = this.flySpeed;
      try { localStorage.setItem('flySpeedZone', String(this.flySpeed)); } catch { /* quota */ }
    } else {
      this.flySpeedEntity = this.flySpeed;
      try { localStorage.setItem('flySpeedEntity', String(this.flySpeed)); } catch { /* quota */ }
    }
  }

  /** Wheel adjusts fly speed in steps of 5 (snapping onto the 5 grid). */
  adjustFlySpeed(direction) {
    const step = 5;
    const dir = Math.sign(direction) || 1;
    const q = this.flySpeed / step;
    const onGrid = Math.abs(q - Math.round(q)) < 1e-6;
    // Off the grid (e.g. an old 4.17 entity speed): the first notch lands on
    // the next grid value in that direction rather than skipping past it.
    const next = onGrid
      ? this.flySpeed + step * dir
      : (dir > 0 ? Math.ceil(q) : Math.floor(q)) * step;
    this.setFlySpeed(Math.max(step, next));
  }

  /** Alt+Q / Alt+E roll (any mode); `keys` carries 'rollL' / 'rollR'. */
  rollUpdate(dt, keys) {
    const rate = 1.4;   // rad/s
    if (keys.has('rollL')) this.roll -= rate * dt;
    if (keys.has('rollR')) this.roll += rate * dt;
  }

  resetRoll() { this.roll = 0; }

  /**
   * WASD/QE fly move. `keys` is a Set of lowercase key names; shift boosts ×3.
   * Matches leveleditor fly-camera.js (WORLD_UP vertical, forward/right planar).
   */
  flyUpdate(dt, keys) {
    if (this.mode !== 'fly') return;
    const fwd = this.lookDir;
    // Movement stays on the world axes even while the view is rolled.
    const up = this.baseUp;
    const right = norm(cross(fwd, up));
    let mx = 0, my = 0, mz = 0;
    if (keys.has('w')) { mx += fwd[0]; my += fwd[1]; mz += fwd[2]; }
    if (keys.has('s')) { mx -= fwd[0]; my -= fwd[1]; mz -= fwd[2]; }
    if (keys.has('d')) { mx += right[0]; my += right[1]; mz += right[2]; }
    if (keys.has('a')) { mx -= right[0]; my -= right[1]; mz -= right[2]; }
    if (keys.has('e')) { mx += up[0]; my += up[1]; mz += up[2]; }
    if (keys.has('q')) { mx -= up[0]; my -= up[1]; mz -= up[2]; }
    const len = Math.hypot(mx, my, mz);
    if (len < 1e-8) return;
    const boost = (keys.has('shift') ? 3 : 1);
    const s = (this.flySpeed * boost * dt) / len;
    this.pos = [this.pos[0] + mx * s, this.pos[1] + my * s, this.pos[2] + mz * s];
    this.userFramed = true;
  }

  /** Entity-scale defaults, or zone-scale when `kind === 'zone'`. */
  setRangeFor(kind) {
    this.rangeKind = kind === 'zone' ? 'zone' : 'entity';
    if (this.rangeKind === 'zone') {
      this.yUp = true;
      this.minDistance = 1;
      this.maxDistance = 20000;
      this.near = 0.5;
      this.far = 5000;
      this.flySpeed = Math.min(FLY_SPEED_MAX, Math.max(FLY_SPEED_MIN, this.flySpeedZone));
    } else {
      // Y-up like zones and effects: the entity pass renders through
      // ENTITY_ROT_M (Renderer#render) rather than flipping the camera, so
      // every view shares one convention.
      this.yUp = true;
      this.minDistance = 0.1;
      this.maxDistance = 500;
      this.near = 0.05;
      this.far = 1000;
      this.flySpeed = Math.min(FLY_SPEED_MAX, Math.max(FLY_SPEED_MIN, this.flySpeedEntity));
    }
  }

  setMode(mode) {
    if (mode === this.mode) return;
    if (mode === 'fly') {
      // Enter fly at the current orbit eye, looking at the orbit target.
      const e = this.eye;
      const f = this.forward;
      this.pos = [e[0], e[1], e[2]];
      this.yaw = Math.atan2(f[0], f[2]);
      const horiz = Math.hypot(f[0], f[2]) || 1e-6;
      this.pitch = this.yUp ? Math.atan2(f[1], horiz) : Math.atan2(-f[1], horiz);
      this.mode = 'fly';
    } else {
      // Drop an orbit target ahead of the fly camera. The 5-unit floor keeps a
      // zone pivot off the camera's nose, but a whole entity is only a couple
      // of units across — applying it there shoves the pivot straight past the
      // model, so orbiting a just-framed actor swung around empty space.
      const f = this.lookDir;
      const floor = this.rangeKind === 'zone' ? 5 : this.minDistance;
      const dist = Math.min(Math.max(this.distance, floor), this.maxDistance);
      this.target = [
        this.pos[0] + f[0] * dist,
        this.pos[1] + f[1] * dist,
        this.pos[2] + f[2] * dist,
      ];
      this.distance = dist;
      this.mode = 'orbit';
    }
  }

  /** Serializable pose for restore (zone re-open, HD reload). */
  snapshot() {
    return {
      mode: this.mode,
      target: this.target.slice(),
      pos: this.pos.slice(),
      yaw: this.yaw,
      pitch: this.pitch,
      distance: this.distance,
      flySpeed: this.flySpeed,
    };
  }

  /** Apply a snapshot after setRangeFor so limits/yUp match the content kind. */
  restore(snap) {
    if (!snap) return;
    if (Array.isArray(snap.target) && snap.target.length === 3) this.target = snap.target.slice();
    if (Array.isArray(snap.pos) && snap.pos.length === 3) this.pos = snap.pos.slice();
    if (Number.isFinite(snap.yaw)) this.yaw = snap.yaw;
    if (Number.isFinite(snap.pitch)) this.pitch = snap.pitch;
    if (Number.isFinite(snap.distance)) {
      this.distance = Math.min(Math.max(snap.distance, this.minDistance), this.maxDistance);
    }
    if (Number.isFinite(snap.flySpeed)) {
      this.flySpeed = Math.min(FLY_SPEED_MAX, Math.max(FLY_SPEED_MIN, snap.flySpeed));
    }
    // Assign mode directly — setMode() would re-derive eye/look from the old pose.
    this.mode = snap.mode === 'fly' ? 'fly' : 'orbit';
  }

  /**
   * Frame an AABB in camera/display space.
   *
   * Entities / effects: classic radius×2.4 (stable orbit pivot + zoom).
   * Zones: FOV-aware fill so outdoor maps aren't a tiny island in the sky.
   * Optional `opts.distance` overrides either path.
   */
  fit(min, max, opts = {}) {
    this.userFramed = false;
    this.roll = 0;
    this.target = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const sx = Math.max(Math.abs(max[0] - min[0]), 0.5);
    const sy = Math.max(Math.abs(max[1] - min[1]), 0.5);
    const sz = Math.max(Math.abs(max[2] - min[2]), 0.5);
    const radius = Math.max(Math.hypot(sx, sy, sz) / 2, 0.5);
    this.yaw = opts.yaw ?? 0.6;
    this.pitch = opts.pitch ?? 0.3;

    let dist;
    if (opts.distance != null) {
      dist = opts.distance;
    } else if (this.rangeKind === 'zone') {
      // FOV fit: project AABB onto view right/up, fill the frustum with margin.
      const aspect = opts.aspect > 0.1 ? opts.aspect : 16 / 9;
      const fovY = (this.fovDegrees * Math.PI) / 180;
      const halfY = Math.tan(fovY * 0.5) || 0.4;
      const halfX = halfY * aspect;
      const cp = Math.cos(this.pitch);
      const sp = Math.sin(this.pitch);
      const cy = Math.cos(this.yaw);
      const syaw = Math.sin(this.yaw);
      const ox = cp * syaw;
      const oy = this.yUp ? sp : -sp;
      const oz = cp * cy;
      const fx = -ox;
      const fy = -oy;
      const fz = -oz;
      const upY = this.yUp ? 1 : -1;
      let rx = -fz * upY;
      let rz = fx * upY;
      const rl = Math.hypot(rx, rz) || 1;
      rx /= rl;
      rz /= rl;
      const ry = 0;
      let ux = ry * fz - rz * fy;
      let uy = rz * fx - rx * fz;
      let uz = rx * fy - ry * fx;
      const ul = Math.hypot(ux, uy, uz) || 1;
      ux /= ul; uy /= ul; uz /= ul;
      const hx = sx * 0.5;
      const hy = sy * 0.5;
      const hz = sz * 0.5;
      const extR = Math.abs(rx) * hx + Math.abs(ry) * hy + Math.abs(rz) * hz;
      const extU = Math.abs(ux) * hx + Math.abs(uy) * hy + Math.abs(uz) * hz;
      const dFit = Math.max(extU / halfY, extR / halfX, radius * 0.35);
      const pad = opts.padding != null ? opts.padding : 1.12;
      dist = dFit * pad;
      // Stay inside the zone far plane so the subject isn't clipped away.
      if (this.far > this.near * 2) {
        dist = Math.min(dist, this.far * 0.85);
      }
    } else {
      // Entity / effect — known-good framing (FOV path zoomed these into the face
      // and left orbit/zoom pivoting off the model centre).
      dist = radius * 2.4;
    }
    this.distance = Math.min(Math.max(dist, this.minDistance), this.maxDistance);

    if (this.mode === 'fly') {
      // Seat fly camera on the fitted orbit eye, looking at the target.
      const cp = Math.cos(this.pitch);
      const sp = Math.sin(this.pitch);
      const yOff = this.yUp ? sp : -sp;
      this.pos = [
        this.target[0] + cp * Math.sin(this.yaw) * this.distance,
        this.target[1] + yOff * this.distance,
        this.target[2] + cp * Math.cos(this.yaw) * this.distance,
      ];
      const f = norm([
        this.target[0] - this.pos[0],
        this.target[1] - this.pos[1],
        this.target[2] - this.pos[2],
      ]);
      this.yaw = Math.atan2(f[0], f[2]);
      const horiz = Math.hypot(f[0], f[2]) || 1e-6;
      this.pitch = this.yUp ? Math.atan2(f[1], horiz) : Math.atan2(-f[1], horiz);
    }
  }
}
