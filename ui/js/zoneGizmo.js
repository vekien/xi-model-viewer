// Solid XYZ transform gizmo (shaft + cone + center) and axis drag math.

import { clientToNdc, cameraScreenRay } from './zonePick.js';
import { mat4Multiply } from './camera.js';

const BASE = {
  x: [0.90, 0.20, 0.22],
  y: [0.24, 0.80, 0.30],
  z: [0.24, 0.44, 0.95],
  center: [0.95, 0.95, 0.97],
};
const HOT = {
  x: [1.0, 0.55, 0.45],
  y: [0.55, 1.0, 0.50],
  z: [0.50, 0.70, 1.0],
  center: [1, 1, 1],
};

function buildAxisMesh(axis, rgb) {
  const verts = [];
  const pushTri = (a, b, c) => {
    const [r, g, bl] = rgb;
    for (const p of [a, b, c]) verts.push(p[0], p[1], p[2], r, g, bl);
  };
  const pushQuad = (a, b, c, d) => {
    pushTri(a, b, c);
    pushTri(a, c, d);
  };

  const cyl = (t0, t1, radius, segs) => {
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      const c0 = Math.cos(a0) * radius, s0 = Math.sin(a0) * radius;
      const c1 = Math.cos(a1) * radius, s1 = Math.sin(a1) * radius;
      let p0, p1, p2, p3;
      if (axis === 0) {
        p0 = [t0, c0, s0]; p1 = [t0, c1, s1]; p2 = [t1, c1, s1]; p3 = [t1, c0, s0];
      } else if (axis === 1) {
        p0 = [c0, t0, s0]; p1 = [c1, t0, s1]; p2 = [c1, t1, s1]; p3 = [c0, t1, s0];
      } else {
        p0 = [c0, s0, t0]; p1 = [c1, s1, t0]; p2 = [c1, s1, t1]; p3 = [c0, s0, t1];
      }
      pushQuad(p0, p1, p2, p3);
    }
  };

  const cone = (tBase, tTip, radius, segs) => {
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      const c0 = Math.cos(a0) * radius, s0 = Math.sin(a0) * radius;
      const c1 = Math.cos(a1) * radius, s1 = Math.sin(a1) * radius;
      let tip, b0, b1;
      if (axis === 0) {
        tip = [tTip, 0, 0]; b0 = [tBase, c0, s0]; b1 = [tBase, c1, s1];
      } else if (axis === 1) {
        tip = [0, tTip, 0]; b0 = [c0, tBase, s0]; b1 = [c1, tBase, s1];
      } else {
        tip = [0, 0, tTip]; b0 = [c0, s0, tBase]; b1 = [c1, s1, tBase];
      }
      pushTri(tip, b0, b1);
    }
  };

  const segs = 12;
  // Thinner poles; cone still readable.
  cyl(0.07, 0.72, 0.022, segs);
  cone(0.72, 1.0, 0.07, segs);
  return new Float32Array(verts);
}

function buildCenterMesh(rgb) {
  const verts = [];
  const pushTri = (a, b, c) => {
    const [r, g, bl] = rgb;
    for (const p of [a, b, c]) verts.push(p[0], p[1], p[2], r, g, bl);
  };
  const pushQuad = (a, b, c, d) => {
    pushTri(a, b, c);
    pushTri(a, c, d);
  };
  const radius = 0.07;
  const slices = 12;
  const stacks = 8;
  for (let i = 0; i < stacks; i++) {
    const v0 = i / stacks, v1 = (i + 1) / stacks;
    const y0 = Math.cos(v0 * Math.PI) * radius;
    const y1 = Math.cos(v1 * Math.PI) * radius;
    const r0 = Math.sin(v0 * Math.PI) * radius;
    const r1 = Math.sin(v1 * Math.PI) * radius;
    for (let j = 0; j < slices; j++) {
      const u0 = (j / slices) * Math.PI * 2;
      const u1 = ((j + 1) / slices) * Math.PI * 2;
      const x00 = Math.cos(u0) * r0, z00 = Math.sin(u0) * r0;
      const x01 = Math.cos(u1) * r0, z01 = Math.sin(u1) * r0;
      const x10 = Math.cos(u0) * r1, z10 = Math.sin(u0) * r1;
      const x11 = Math.cos(u1) * r1, z11 = Math.sin(u1) * r1;
      pushQuad(
        [x00, y0, z00], [x01, y0, z01], [x11, y1, z11], [x10, y1, z10],
      );
    }
  }
  return new Float32Array(verts);
}

/**
 * Separate meshes per axis so hover can brighten/scale one handle.
 * @returns {{ x: Float32Array, y: Float32Array, z: Float32Array, center: Float32Array,
 *             xHot: Float32Array, yHot: Float32Array, zHot: Float32Array }}
 */
export function buildSolidGizmoMeshes() {
  return {
    x: buildAxisMesh(0, BASE.x),
    y: buildAxisMesh(1, BASE.y),
    z: buildAxisMesh(2, BASE.z),
    center: buildCenterMesh(BASE.center),
    xHot: buildAxisMesh(0, HOT.x),
    yHot: buildAxisMesh(1, HOT.y),
    zHot: buildAxisMesh(2, HOT.z),
  };
}

/** @deprecated use buildSolidGizmoMeshes */
export function buildSolidGizmoMesh() {
  const m = buildSolidGizmoMeshes();
  // Concat for any leftover single-mesh callers.
  const parts = [m.x, m.y, m.z, m.center];
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function gizmoSize(renderer, gizmo) {
  if (gizmo?.size) return gizmo.size;
  if (!renderer?.camera || !gizmo?.pos) return 1;
  const eye = renderer.camera.eye;
  const d = Math.hypot(
    gizmo.pos[0] - eye[0],
    gizmo.pos[1] - eye[1],
    gizmo.pos[2] - eye[2],
  ) || 1;
  return Math.min(80, Math.max(0.75, d * 0.1));
}

/** World → canvas pixel (matching renderer projection + Explorer offset). */
function worldToScreen(renderer, x, y, z) {
  const canvas = renderer.canvas;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const aspect = rect.width / rect.height;
  let proj = renderer.camera.projectionMatrix(aspect);
  const off = renderer.screenOffsetX || 0;
  if (off) {
    const dx = (2 * off) / Math.max(canvas.clientWidth, 1);
    const shift = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      dx, 0, 0, 1,
    ]);
    proj = mat4Multiply(shift, proj);
  }
  const view = renderer.camera.viewMatrix();
  const vp = mat4Multiply(proj, view);
  const clipX = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
  const clipY = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
  const clipW = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
  if (!(Math.abs(clipW) > 1e-8) || clipW < 0) return null;
  const ndcX = clipX / clipW;
  const ndcY = clipY / clipW;
  return {
    x: (ndcX * 0.5 + 0.5) * rect.width,
    y: (-ndcY * 0.5 + 0.5) * rect.height,
  };
}

function distPointSeg2d(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  let t = ab2 > 1e-12 ? (apx * abx + apy * aby) / ab2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + abx * t, qy = ay + aby * t;
  return Math.hypot(px - qx, py - qy);
}

/**
 * Pick which gizmo axis the cursor is on (screen-space, pixel threshold).
 * @returns {'x'|'y'|'z'|null}
 */
export function pickGizmoAxis(renderer, gizmo, clientX, clientY) {
  if (!renderer || !gizmo?.pos) return null;
  const canvas = renderer.canvas;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;

  const size = gizmoSize(renderer, gizmo);
  const o = gizmo.pos;
  const origin = worldToScreen(renderer, o[0], o[1], o[2]);
  if (!origin) return null;

  const mx = clientX - rect.left;
  const my = clientY - rect.top;
  const PIXEL = 18;
  const axes = [
    { id: 'x', p: [o[0] + size, o[1], o[2]] },
    { id: 'y', p: [o[0], o[1] + size, o[2]] },
    { id: 'z', p: [o[0], o[1], o[2] + size] },
  ];

  let best = null;
  let bestDist = PIXEL;
  for (const ax of axes) {
    const end = worldToScreen(renderer, ax.p[0], ax.p[1], ax.p[2]);
    if (!end) continue;
    const d = distPointSeg2d(mx, my, origin.x, origin.y, end.x, end.y);
    if (d < bestDist) {
      bestDist = d;
      best = ax.id;
    }
  }
  return best;
}

/**
 * Mouse-pixel drag → world delta along a gizmo axis (screen-projected).
 */
export function axisDragDelta(renderer, gizmo, axis, prevX, prevY, clientX, clientY) {
  if (!renderer || !gizmo?.pos) return null;
  const size = gizmoSize(renderer, gizmo);
  const o = gizmo.pos;
  const dir = axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : [0, 0, 1];
  const end = [o[0] + dir[0] * size, o[1] + dir[1] * size, o[2] + dir[2] * size];
  const s0 = worldToScreen(renderer, o[0], o[1], o[2]);
  const s1 = worldToScreen(renderer, end[0], end[1], end[2]);
  if (!s0 || !s1) return null;

  let sx = s1.x - s0.x;
  let sy = s1.y - s0.y;
  const slen = Math.hypot(sx, sy);
  if (slen < 1e-3) return null;
  sx /= slen;
  sy /= slen;

  const pixels = (clientX - prevX) * sx + (clientY - prevY) * sy;
  const world = (pixels / slen) * size;
  return {
    dx: dir[0] * world,
    dy: dir[1] * world,
    dz: dir[2] * world,
  };
}

export function projectRayOnAxis(renderer, gizmo, axis, clientX, clientY) {
  if (!renderer || !gizmo?.pos) return null;
  const ndc = clientToNdc(renderer, clientX, clientY);
  if (!ndc) return null;
  const ray = cameraScreenRay(renderer.camera, ndc.ndcX, ndc.ndcY, ndc.aspect);
  if (!ray) return null;
  const o = gizmo.pos;
  const axisDir = axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : [0, 0, 1];
  const d1 = ray.dir;
  const d2 = axisDir;
  const r = [o[0] - ray.origin[0], o[1] - ray.origin[1], o[2] - ray.origin[2]];
  const a = d1[0] * d1[0] + d1[1] * d1[1] + d1[2] * d1[2];
  const b = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2];
  const c = d2[0] * d2[0] + d2[1] * d2[1] + d2[2] * d2[2];
  const d = d1[0] * r[0] + d1[1] * r[1] + d1[2] * r[2];
  const e = d2[0] * r[0] + d2[1] * r[1] + d2[2] * r[2];
  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-12) return e / (c || 1);
  return (a * e - b * d) / denom;
}
