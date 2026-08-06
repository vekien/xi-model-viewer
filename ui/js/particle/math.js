// Minimal linear algebra matching xim's xim.math conventions exactly, because
// the particle transforms are ported operation-for-operation and any difference
// in multiply order or rotation sign shows up as effects pointing the wrong way.
//
// Matrices are column-major Float32Array(16), same as xim Matrix4f and WebGL:
//   0 4 8  12
//   1 5 9  13
//   2 6 10 14
//   3 7 11 15
// `xInPlace(a)` means `this = this * a` (xim multiplyInPlace), so calls read
// left-to-right as parent → child, and the last call is the innermost transform.

export const PI_f = Math.PI;

// ── Vector3 ────────────────────────────────────────────────────────────────
// Mutable, like xim Vector3f — initializers and updaters accumulate into these.

export class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }

  static get ZERO() { return new Vec3(0, 0, 0); }
  static get X() { return new Vec3(1, 0, 0); }
  static get Y() { return new Vec3(0, 1, 0); }
  static get Z() { return new Vec3(0, 0, 1); }

  clone() { return new Vec3(this.x, this.y, this.z); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copyFrom(o) { this.x = o.x; this.y = o.y; this.z = o.z; return this; }

  /** Axis access by index — xim's `vector[axis]` for the per-axis opcodes. */
  get(axis) { return axis === 0 ? this.x : axis === 1 ? this.y : this.z; }
  setAxis(axis, v) {
    if (axis === 0) this.x = v; else if (axis === 1) this.y = v; else this.z = v;
    return this;
  }

  addInPlace(o) { this.x += o.x; this.y += o.y; this.z += o.z; return this; }
  subInPlace(o) { this.x -= o.x; this.y -= o.y; this.z -= o.z; return this; }
  scaleInPlace(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  mulInPlace(o) { this.x *= o.x; this.y *= o.y; this.z *= o.z; return this; }

  add(o) { return new Vec3(this.x + o.x, this.y + o.y, this.z + o.z); }
  sub(o) { return new Vec3(this.x - o.x, this.y - o.y, this.z - o.z); }
  scale(s) { return new Vec3(this.x * s, this.y * s, this.z * s); }

  magnitudeSquare() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  magnitude() { return Math.sqrt(this.magnitudeSquare()); }

  normalizeInPlace() {
    const m = this.magnitude();
    if (m > 1e-9) { this.x /= m; this.y /= m; this.z /= m; }
    return this;
  }

  normalize() { return this.clone().normalizeInPlace(); }

  dot(o) { return this.x * o.x + this.y * o.y + this.z * o.z; }

  cross(o) {
    return new Vec3(
      this.y * o.z - this.z * o.y,
      this.z * o.x - this.x * o.z,
      this.x * o.y - this.y * o.x,
    );
  }

  withY(y) { return new Vec3(this.x, y, this.z); }

  static distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }

  static lerp(a, b, t) {
    return new Vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
  }
}

// ── Matrix4 ────────────────────────────────────────────────────────────────

export class Mat4 {
  constructor(m) { this.m = m || new Float32Array(16); if (!m) this.identity(); }

  identity() {
    const m = this.m;
    m.fill(0);
    m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
    return this;
  }

  copyFrom(o) { this.m.set(o.m); return this; }
  clone() { return new Mat4(new Float32Array(this.m)); }

  /** xim identityUpperLeft — drop rotation/scale, keep translation. */
  identityUpperLeft() {
    const m = this.m;
    m[0] = 1; m[1] = 0; m[2] = 0;
    m[4] = 0; m[5] = 1; m[6] = 0;
    m[8] = 0; m[9] = 0; m[10] = 1;
    return this;
  }

  copyUpperLeft(o) {
    const m = this.m, s = o.m;
    m[0] = s[0]; m[1] = s[1]; m[2] = s[2];
    m[4] = s[4]; m[5] = s[5]; m[6] = s[6];
    m[8] = s[8]; m[9] = s[9]; m[10] = s[10];
    return this;
  }

  getTranslation() { return new Vec3(this.m[12], this.m[13], this.m[14]); }

  zeroTranslationInPlace() { this.m[12] = 0; this.m[13] = 0; this.m[14] = 0; return this; }

  /** Adds to the translation column without composing a matrix (xim translateDirect). */
  translateDirect(v) {
    this.m[12] += v.x; this.m[13] += v.y; this.m[14] += v.z;
    return this;
  }

  translateInPlace(v) {
    if (v.x === 0 && v.y === 0 && v.z === 0) return this;
    const t = new Mat4();
    t.m[12] = v.x; t.m[13] = v.y; t.m[14] = v.z;
    return this.multiplyInPlace(t);
  }

  scaleInPlace(v) {
    const x = v.x, y = v.y, z = v.z;
    if (x === 1 && y === 1 && z === 1) return this;
    const s = new Mat4();
    s.m[0] = x; s.m[5] = y; s.m[10] = z;
    return this.multiplyInPlace(s);
  }

  scaleUniformInPlace(s) { return this.scaleInPlace(new Vec3(s, s, s)); }

  rotateXInPlace(rad) {
    if (rad === 0) return this;
    const sin = Math.sin(rad), cos = Math.cos(rad);
    const r = new Mat4();
    r.m[5] = cos; r.m[6] = sin; r.m[9] = -sin; r.m[10] = cos;
    return this.multiplyInPlace(r);
  }

  rotateYInPlace(rad) {
    if (rad === 0) return this;
    const sin = Math.sin(rad), cos = Math.cos(rad);
    const r = new Mat4();
    r.m[0] = cos; r.m[2] = -sin; r.m[8] = sin; r.m[10] = cos;
    return this.multiplyInPlace(r);
  }

  rotateZInPlace(rad) {
    if (rad === 0) return this;
    const sin = Math.sin(rad), cos = Math.cos(rad);
    const r = new Mat4();
    r.m[0] = cos; r.m[1] = sin; r.m[4] = -sin; r.m[5] = cos;
    return this.multiplyInPlace(r);
  }

  rotateZYXInPlace(xRad, yRad, zRad) {
    if (xRad === 0 && yRad === 0 && zRad === 0) return this;
    const sX = Math.sin(xRad), sY = Math.sin(yRad), sZ = Math.sin(zRad);
    const cX = Math.cos(xRad), cY = Math.cos(yRad), cZ = Math.cos(zRad);
    const r = new Mat4();
    const m = r.m;
    m[0] = cY * cZ;               m[1] = cY * sZ;               m[2] = -sY;      m[3] = 0;
    m[4] = sX * sY * cZ - cX * sZ; m[5] = sX * sY * sZ + cX * cZ; m[6] = sX * cY;  m[7] = 0;
    m[8] = cX * sY * cZ + sX * sZ; m[9] = cX * sY * sZ - sX * cZ; m[10] = cX * cY; m[11] = 0;
    m[12] = 0; m[13] = 0; m[14] = 0; m[15] = 1;
    return this.multiplyInPlace(r);
  }

  rotateXYZInPlace(xRad, yRad, zRad) {
    if (xRad === 0 && yRad === 0 && zRad === 0) return this;
    const sX = Math.sin(xRad), sY = Math.sin(yRad), sZ = Math.sin(zRad);
    const cX = Math.cos(xRad), cY = Math.cos(yRad), cZ = Math.cos(zRad);
    const r = new Mat4();
    const m = r.m;
    m[0] = cY * cZ;               m[1] = sX * sY * cZ + cX * sZ; m[2] = sX * sZ - cX * sY * cZ; m[3] = 0;
    m[4] = cY * -sZ;              m[5] = cX * cZ - sX * sY * sZ; m[6] = cX * sY * sZ + sX * cZ; m[7] = 0;
    m[8] = sY;                    m[9] = -sX * cY;              m[10] = cX * cY;               m[11] = 0;
    m[12] = 0; m[13] = 0; m[14] = 0; m[15] = 1;
    return this.multiplyInPlace(r);
  }

  multiplyInPlace(o) { return this.multiply(o, this); }

  /** store = this * o (column-major), xim Matrix4f.multiply. */
  multiply(o, store) {
    const a = this.m, b = o.m;
    const t = MUL_TEMP;
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        t[col * 4 + row] = a[row] * b[col * 4]
          + a[row + 4] * b[col * 4 + 1]
          + a[row + 8] * b[col * 4 + 2]
          + a[row + 12] * b[col * 4 + 3];
      }
    }
    store.m.set(t);
    return store;
  }

  /** Transform a point (w=1) or direction (w=0). */
  transform(v, w = 1) {
    const m = this.m;
    return new Vec3(
      m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12] * w,
      m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13] * w,
      m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14] * w,
    );
  }

  transformInPlace(v, w = 1) {
    const r = this.transform(v, w);
    return v.copyFrom(r);
  }

  /**
   * xim axisBillboardInPlace: orient +Z along `dir` with world-up, i.e. the
   * change-of-basis that makes a flat quad face the camera.
   */
  axisBillboardInPlace(dir) {
    const d = dir.clone().normalizeInPlace();
    if (d.magnitudeSquare() === 0) return this;
    const left = Vec3.Y.cross(d).normalizeInPlace();
    const up = d.cross(left).normalizeInPlace();
    return this.changeOfBasisWithoutTranslate(d, up, left);
  }

  /** Columns become (left, up, forward) — xim changeOfBasisWithoutTranslate. */
  changeOfBasisWithoutTranslate(forward, up, left) {
    const b = new Mat4();
    const m = b.m;
    m[0] = left.x; m[1] = left.y; m[2] = left.z;
    m[4] = up.x;   m[5] = up.y;   m[6] = up.z;
    m[8] = forward.x; m[9] = forward.y; m[10] = forward.z;
    return this.multiplyInPlace(b);
  }

  /** Rodrigues rotation about an arbitrary axis — xim axisAngleRotationInPlace. */
  axisAngleRotationInPlace(axis, angle) {
    if (angle === 0) return this;
    const a = axis.clone().normalizeInPlace();
    const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
    const r = new Mat4();
    const m = r.m;
    m[0] = t * a.x * a.x + c;       m[1] = t * a.x * a.y + s * a.z; m[2] = t * a.x * a.z - s * a.y;
    m[4] = t * a.x * a.y - s * a.z; m[5] = t * a.y * a.y + c;       m[6] = t * a.y * a.z + s * a.x;
    m[8] = t * a.x * a.z + s * a.y; m[9] = t * a.y * a.z - s * a.x; m[10] = t * a.z * a.z + c;
    return this.multiplyInPlace(r);
  }
}

const MUL_TEMP = new Float32Array(16);

// ── Color ──────────────────────────────────────────────────────────────────
// xim Color is float rgba 0..1 (mutable). `modulate(other, 2)` is the D3D
// MODULATE2X the particle pipeline uses for day-of-week / moon-phase tints.

export class Color {
  constructor(r = 1, g = 1, b = 1, a = 1) { this.rgba = [r, g, b, a]; }

  static fromBytes(c) { return new Color(c[0] / 255, c[1] / 255, c[2] / 255, c[3] / 255); }
  static get NO_MASK() { return new Color(1, 1, 1, 1); }

  r(v) { if (v === undefined) return this.rgba[0]; this.rgba[0] = v; return this; }
  g(v) { if (v === undefined) return this.rgba[1]; this.rgba[1] = v; return this; }
  b(v) { if (v === undefined) return this.rgba[2]; this.rgba[2] = v; return this; }
  a(v) { if (v === undefined) return this.rgba[3]; this.rgba[3] = v; return this; }

  clone() { return new Color(...this.rgba); }
  copyFrom(o) { for (let i = 0; i < 4; i++) this.rgba[i] = o.rgba[i]; return this; }

  mul(o) {
    return new Color(
      this.rgba[0] * o.rgba[0], this.rgba[1] * o.rgba[1],
      this.rgba[2] * o.rgba[2], this.rgba[3] * o.rgba[3],
    );
  }

  addInPlace(o) { for (let i = 0; i < 4; i++) this.rgba[i] += o.rgba[i]; return this; }

  withMultiplied(s) {
    return new Color(this.rgba[0] * s, this.rgba[1] * s, this.rgba[2] * s, this.rgba[3] * s);
  }

  withMultipliedAlpha(s) {
    return new Color(this.rgba[0], this.rgba[1], this.rgba[2], this.rgba[3] * s);
  }

  multiplyAlphaInPlace(s) { this.rgba[3] *= s; return this; }

  /** rgba *= other * factor (xim modulateInPlace). */
  modulateInPlace(o, factor) {
    for (let i = 0; i < 4; i++) this.rgba[i] *= o.rgba[i] * factor;
    return this;
  }

  /** rgb only — used by the daylight-based colour appliers. */
  modulateRgbInPlace(o, factor) {
    for (let i = 0; i < 3; i++) this.rgba[i] *= o.rgba[i] * factor;
    return this;
  }

  clamp(max = 1) {
    for (let i = 0; i < 4; i++) this.rgba[i] = Math.min(max, Math.max(0, this.rgba[i]));
    return this;
  }

  static interpolate(c0, c1, t) {
    const out = new Color();
    for (let i = 0; i < 4; i++) out.rgba[i] = c0.rgba[i] + (c1.rgba[i] - c0.rgba[i]) * t;
    return out;
  }
}

// ── misc helpers mirrored from xim.util ────────────────────────────────────

export const lerp = (a, b, t) => a + (b - a) * t;

/** xim RandHelper.rand(): uniform in [-1, 1). */
export const rand = () => Math.random() * 2 - 1;

/** xim RandHelper.posRand(x): uniform in [0, x). */
export const posRand = (x = 1) => Math.random() * x;

/**
 * xim Float.fallOff(near, far): 1 inside `near`, 0 beyond `far`, linear between.
 * Used for draw-distance alpha and audio volume.
 */
export function fallOff(distance, near, far) {
  if (far <= near) return distance <= near ? 1 : 0;
  if (distance <= near) return 1;
  if (distance >= far) return 0;
  return (far - distance) / (far - near);
}

/**
 * The FFXI effect engine ticks at 60 frames per second — routines, generators
 * and particles all on the one clock (FFXIEngine FFXIEffectFacade.cpp:2108
 * "DeltaSeconds * 60.0f // xim/FFXI internal rate is 60 fps", consumed
 * unchanged by EffectRoutineInstance and the generators). An earlier port
 * comment claimed 30 and ran every effect at half speed. Model animation clips
 * are the exception — they are 30fps and the renderer advances them with their
 * own literal (see renderer.js animFrame), which is also why scheduler
 * durations for natural-speed clip playback are written as 2 × clip length.
 */
export const FPS = 60;
export const secondsToFrames = (s) => s * FPS;
