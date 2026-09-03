// WebGL2 renderer for FFXI entity models. Skinning runs on the GPU: the vertex
// shader rotates pre-weighted joint-local positions by per-joint pose
// quaternions (same math as the verified CPU path in pose.js).

import { OrbitCamera, mat4Multiply, mat4LookAt, mat4Ortho } from './camera.js';
import { SkeletonPose, qRotate } from './pose.js';
import { ParticleDrawer } from './particleDrawer.js';
import { Vec3, Mat4 } from './particle/math.js';
import { AttachType } from './particle/types.js';
import { buildSolidGizmoMeshes, gizmoSize } from './zoneGizmo.js';
import { bakeSpinnerDraws } from './zoneModel.js';

// References 49-51 stand for the eight-point ring (13..20) around an actor.
const RING_REF_START = 13;

const MAX_JOINTS = 160;

// Entity/creation views have no zone environment, so their shadow sun is a
// fixed key rather than the game clock. Authored in display space (Y-up, same
// as the renderer's default terrain sun) and mapped into the raw Y-DOWN DAT
// space entity models are drawn in — DISPLAY_ROT = diag(−1,−1,1), its own
// inverse. Both point *toward* the light, matching uSunDir everywhere else.
const ENTITY_SUN_DISPLAY = [0.35, 0.9, 0.25];
const ENTITY_SUN_DAT = [-ENTITY_SUN_DISPLAY[0], -ENTITY_SUN_DISPLAY[1], ENTITY_SUN_DISPLAY[2]];

// Texture units the shadow cascades live on, near first. Unit 0 is always the
// diffuse texture, in every program.
const SHADOW_UNITS = [0x84C1 /* TEXTURE1 */, 0x84C2 /* TEXTURE2 */];

/**
 * Entity DAT -> screen: a 180-degree turn about X, diag(1, -1, -1).
 *
 * Entity geometry is uploaded raw (Y-down), so the entity pass carries this in
 * its viewProj and every view can share one Y-up camera. Entities used to run a
 * Y-down camera to compensate, which put Characters/NPCs in a different space
 * from Zones and Effects — an effect composited onto a character then differed
 * by a roll about the view axis, which no per-particle matrix can undo.
 *
 * About X, not Z. Zone geometry uses diag(-1,-1,1) (180 about Z), which flips Y
 * but also MIRRORS X — fine for terrain, wrong for a character, whose gear and
 * handedness would swap sides. Turning about X flips Y and Z instead: upright
 * under a Y-up camera, facing reversed, nothing mirrored. det +1 either way, so
 * both are proper rotations rather than reflections.
 */
const ENTITY_ROT_M = new Float32Array([
  1, 0, 0, 0,
  0, -1, 0, 0,
  0, 0, -1, 0,
  0, 0, 0, 1,
]);

/** The matrix above applied to a point — for anything comparing against raw DAT. */
const toEntityPt = (p) => [p[0], -p[1], -p[2]];

const IDENTITY_M = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * Zone actor placement: display-space translation and a yaw about +Y, then
 * ENTITY_ROT_M so the raw DAT mesh lands in display space like the main
 * entity does. Column-major: M = T(pos) · Ry(yaw) · ENTITY_ROT.
 */
function actorModelMatrix(pos, rot, out = new Float32Array(16), scale = 1) {
  const k = scale > 0 ? scale : 1;
  const R = rot || MAT3_IDENTITY;
  // M = T · R · S · ENTITY_ROT; ENTITY_ROT = diag(1,-1,-1) negates columns 1 and 2.
  out[0] = R[0] * k; out[1] = R[1] * k; out[2] = R[2] * k; out[3] = 0;
  out[4] = -R[3] * k; out[5] = -R[4] * k; out[6] = -R[5] * k; out[7] = 0;
  out[8] = -R[6] * k; out[9] = -R[7] * k; out[10] = -R[8] * k; out[11] = 0;
  out[12] = pos[0]; out[13] = pos[1]; out[14] = pos[2]; out[15] = 1;
  return out;
}

const MAT3_IDENTITY = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** Column-major 3x3 rotation about a world axis ('x' | 'y' | 'z'). */
function mat3AxisRotation(axis, angle) {
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  if (axis === 'x') return new Float32Array([1, 0, 0, 0, c, sn, 0, -sn, c]);
  if (axis === 'z') return new Float32Array([c, sn, 0, -sn, c, 0, 0, 0, 1]);
  return new Float32Array([c, 0, -sn, 0, 1, 0, sn, 0, c]);
}

/** out = a · b for column-major 3x3 matrices. */
function mat3Mul(a, b, out = new Float32Array(9)) {
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      out[col * 3 + row] = a[row] * b[col * 3] + a[3 + row] * b[col * 3 + 1] + a[6 + row] * b[col * 3 + 2];
    }
  }
  return out;
}

/** Flat annulus in the XZ plane (radius 1) — the rotate-gizmo ring. */
function buildRingMesh(rgb, r0 = 0.9, r1 = 1.0, segs = 56) {
  const verts = [];
  const push = (p) => verts.push(p[0], p[1], p[2], rgb[0], rgb[1], rgb[2]);
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    const p0 = [c0 * r0, 0, s0 * r0], p1 = [c0 * r1, 0, s0 * r1];
    const p2 = [c1 * r1, 0, s1 * r1], p3 = [c1 * r0, 0, s1 * r0];
    push(p0); push(p1); push(p2);
    push(p0); push(p2); push(p3);
  }
  return new Float32Array(verts);
}

/** Small sphere (overlay triangles) marking a light-source actor. */
function lightMarkerFigure(center, rgb, R = 0.22) {
  const positions = [];
  const colors = [];
  const SEG = 12, RINGS = 8;
  const pt = (i, j) => {
    const th = (i / RINGS) * Math.PI;
    const ph = (j / SEG) * Math.PI * 2;
    return [
      center[0] + R * Math.sin(th) * Math.cos(ph),
      center[1] + R * Math.cos(th),
      center[2] + R * Math.sin(th) * Math.sin(ph),
    ];
  };
  const push = (p) => { positions.push(...p); colors.push(rgb[0], rgb[1], rgb[2]); };
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEG; j++) {
      const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1);
      push(a); push(b); push(c);
      push(a); push(c); push(d);
    }
  }
  return { positions, colors };
}

/** Thin square prism from `c` along unit `axis` (spot-light aim stub). */
function spotStubFigure(c, axis, rgb, len = 0.9, w = 0.05) {
  const positions = [];
  const colors = [];
  // Any two vectors perpendicular to the axis.
  const ref = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u = [axis[1] * ref[2] - axis[2] * ref[1], axis[2] * ref[0] - axis[0] * ref[2], axis[0] * ref[1] - axis[1] * ref[0]];
  const ul = Math.hypot(u[0], u[1], u[2]) || 1;
  u = [u[0] / ul * w, u[1] / ul * w, u[2] / ul * w];
  const v = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]];
  const vl = Math.hypot(v[0], v[1], v[2]) || 1;
  const vv = [v[0] / vl * w, v[1] / vl * w, v[2] / vl * w];
  const p = (t, su, sv) => [
    c[0] + axis[0] * t + u[0] * su + vv[0] * sv,
    c[1] + axis[1] * t + u[1] * su + vv[1] * sv,
    c[2] + axis[2] * t + u[2] * su + vv[2] * sv,
  ];
  const corners = [
    p(0, -1, -1), p(0, 1, -1), p(0, 1, 1), p(0, -1, 1),
    p(len, -1, -1), p(len, 1, -1), p(len, 1, 1), p(len, -1, 1),
  ];
  const faces = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]];
  for (const [a, b, d, e] of faces) {
    for (const i of [a, b, d, a, d, e]) { positions.push(...corners[i]); colors.push(...rgb); }
  }
  return { positions, colors };
}

/**
 * Placeholder figure for an actor with no model yet: a body box and a head
 * box standing on `pos` (display space, feet at y = 0), as overlay triangles.
 */
function placeholderFigure(pos, rot, color, scale = 1) {
  const positions = [];
  const colors = [];
  const R = rot || MAT3_IDENTITY;
  const box = (cx, cy, cz, hx, hy, hz, rgb) => {
    const corner = (x, y, z) => {
      // display-space local point (feet at the origin, Y up, -Z forward)
      const lx = x * scale, ly = y * scale, lz = z * scale;
      return [
        pos[0] + R[0] * lx + R[3] * ly + R[6] * lz,
        pos[1] + R[1] * lx + R[4] * ly + R[7] * lz,
        pos[2] + R[2] * lx + R[5] * ly + R[8] * lz,
      ];
    };
    const p = [
      corner(cx - hx, cy - hy, cz - hz), corner(cx + hx, cy - hy, cz - hz),
      corner(cx + hx, cy + hy, cz - hz), corner(cx - hx, cy + hy, cz - hz),
      corner(cx - hx, cy - hy, cz + hz), corner(cx + hx, cy - hy, cz + hz),
      corner(cx + hx, cy + hy, cz + hz), corner(cx - hx, cy + hy, cz + hz),
    ];
    const faces = [
      [0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0],
    ];
    for (const [a, b, d, e] of faces) {
      for (const i of [a, b, d, a, d, e]) {
        positions.push(...p[i]);
        colors.push(...rgb);
      }
    }
  };
  // Body, head, and a small nose wedge so the facing direction is readable.
  box(0, 0.75, 0, 0.28, 0.75, 0.16, color);
  box(0, 1.72, 0, 0.2, 0.2, 0.2, color);
  box(0, 1.72, -0.28, 0.06, 0.06, 0.1, [1, 1, 1]);
  return { positions, colors };
}

// Full-screen background image (Scene > Background Image).
// uCoverScale = fraction of the texture kept on each axis (cover = fill the
// viewport, crop the overflow). See the draw site for how it is derived.
const BG_IMAGE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aUV;
uniform vec2 uCoverScale;
out vec2 vUV;
void main() {
  // Quad always fills the viewport; the crop happens in UV space so there are
  // never bars. uCoverScale is <= 1 on the overflowing axis, selecting a
  // centred sub-rect of the texture.
  vUV = (aUV - 0.5) * uCoverScale + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;
const BG_IMAGE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTexture;
out vec4 outColor;
void main() {
  outColor = texture(uTexture, vUV);
}
`;

const VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location=0) in vec3 aP0;
layout(location=1) in vec3 aP1;
layout(location=2) in vec3 aN0;
layout(location=3) in vec3 aN1;
layout(location=4) in vec2 aWeights;
layout(location=5) in vec2 aJoints;
layout(location=6) in vec2 aUV;
layout(location=7) in vec4 aColor;

uniform mat4 uViewProj;
uniform mat4 uModel;      // identity for the main model; placement for zone actors
uniform vec4 uRot[${MAX_JOINTS}];
uniform vec4 uTrans[${MAX_JOINTS}];
uniform vec4 uScale[${MAX_JOINTS}];

out vec2 vUV;
out vec4 vColor;
out vec3 vNormal;
out vec3 vWorld;

vec3 qrot(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

void main() {
  int j0 = int(aJoints.x);
  int j1 = int(aJoints.y);

  // Positions are pre-weighted; weights scale only the bone translations.
  // Single-jointed vertices have p1 = n1 = 0 and weights (1, 0), so the
  // unified expression reduces to the single-joint formula.
  vec3 world = qrot(uRot[j0], uScale[j0].xyz * aP0) + aWeights.x * uTrans[j0].xyz
             + qrot(uRot[j1], uScale[j1].xyz * aP1) + aWeights.y * uTrans[j1].xyz;

  vec3 nrm = aWeights.x * qrot(uRot[j0], aN0) + aWeights.y * qrot(uRot[j1], aN1);
  vec4 placed = uModel * vec4(world, 1.0);
  vNormal = mat3(uModel) * nrm;
  vUV = aUV;
  vColor = aColor;
  vWorld = placed.xyz;
  gl_Position = uViewProj * placed;
}
`;

// Zone light-source actors (Actors › Light Source): up to MAX_PLIGHTS point
// lights plus one summed ambient term, applied on top of the xim terrain
// lighting for zone geometry and for actors standing in it.
const MAX_PLIGHTS = 8;
const PLIGHT_UNIFORMS = `
uniform int uPointCount;
uniform vec3 uPointPos[${MAX_PLIGHTS}];
uniform vec3 uPointColor[${MAX_PLIGHTS}];   // colour × intensity
uniform float uPointRadius[${MAX_PLIGHTS}];
uniform vec3 uPointDir[${MAX_PLIGHTS}];     // spot axis (unit); unused for omni
uniform float uPointCone[${MAX_PLIGHTS}];   // cos(half-angle) for spots, 0 = omni
uniform vec3 uExtraAmbient;
`;
const PLIGHT_APPLY = `
vec3 pointLighting(vec3 world, vec3 n, vec3 base) {
  vec3 acc = base * uExtraAmbient;
  for (int i = 0; i < ${MAX_PLIGHTS}; i++) {
    if (i >= uPointCount) break;
    vec3 d = uPointPos[i] - world;
    float dist = length(d);
    float r = max(uPointRadius[i], 0.01);
    if (dist >= r) continue;
    float att = 1.0 - dist / r;
    att *= att;
    float cone = uPointCone[i];
    if (cone > 0.0) {
      // Spot: fade over the outer ~8° of the cone.
      float cd = dot(-d / max(dist, 1e-4), uPointDir[i]);
      att *= smoothstep(cone, min(1.0, cone + 0.08), cd);
      if (att <= 0.0) continue;
    }
    float ndl = clamp(dot(n, d / max(dist, 1e-4)), 0.0, 1.0);
    // A little wrap so the ground right under a lamp is not black on the
    // far side of a bump; keeps lamps reading as lamps at low poly counts.
    ndl = mix(0.2, 1.0, ndl);
    acc += base * ndl * uPointColor[i] * att;
  }
  return acc;
}
`;

// Shared fog snippet: mixes toward uFogColor by camera distance.
const FOG_UNIFORMS = `
uniform vec3 uCameraPos;
uniform vec3 uFogColor;
uniform vec2 uFogRange;   // (near, far); far <= 0 disables fog
`;
const FOG_APPLY = `
  if (uFogRange.y > 0.0) {
    float d = length(vWorld - uCameraPos);
    float f = clamp((d - uFogRange.x) / max(uFogRange.y - uFogRange.x, 0.001), 0.0, 1.0);
    outColor.rgb = mix(outColor.rgb, uFogColor, f);
  }
`;

// --- Cast shadows (View > Toggle Shadows) ----------------------------------
// A single directional light — the sun — rendered into cascaded depth maps and
// sampled by every receiver. FFXI itself has no such pass (retail draws a blob
// sprite under the actor); this is purely a "what would it look like" viewer
// toggle, so it stacks on top of the xim lighting rather than replacing it.
//
// Two cascades, both 2048², sharing one light basis and centre so the near one
// nests inside the far one. Cascade 0 covers a quarter of the draw distance, so
// it holds ~4x the texel density wherever you are actually looking; cascade 1
// takes over past that. One map stretched over the whole radius is what made
// contact shadows go chunky as the distance slider went up.
//
// Shared by the zone, entity and floor fragment shaders.
//   uShadowParams  = (enabled, strength, texel0, bias0)
//   uShadowParams1 = (texel1, bias1, blendStart, farCascadeValid)
// `blendStart` is where in cascade 0's extent (0 centre .. 1 border) the
// cross-fade to cascade 1 begins. Model views fit one cascade to the model and
// set farCascadeValid to 0.
const SHADOW_UNIFORMS = `
precision highp sampler2DShadow;   // ES 3.00 has no default precision for these
uniform sampler2DShadow uShadowMap0;
uniform sampler2DShadow uShadowMap1;
uniform mat4 uLightViewProj0;
uniform mat4 uLightViewProj1;
uniform vec4 uShadowParams;
uniform vec4 uShadowParams1;
`;
const SHADOW_SAMPLE = `
// 3x3 taps on top of the hardware 2x2 compare filter (COMPARE_REF_TO_TEXTURE).
float shadowPcf(sampler2DShadow map, vec3 uvz) {
  float s = 0.0;
  s += textureOffset(map, uvz, ivec2(-1, -1));
  s += textureOffset(map, uvz, ivec2( 0, -1));
  s += textureOffset(map, uvz, ivec2( 1, -1));
  s += textureOffset(map, uvz, ivec2(-1,  0));
  s += textureOffset(map, uvz, ivec2( 0,  0));
  s += textureOffset(map, uvz, ivec2( 1,  0));
  s += textureOffset(map, uvz, ivec2(-1,  1));
  s += textureOffset(map, uvz, ivec2( 0,  1));
  s += textureOffset(map, uvz, ivec2( 1,  1));
  return s / 9.0;
}

// Visibility in one cascade, or -1 when the fragment falls outside it. \`edge\`
// comes back as 0 at the cascade centre and 1 at its border, which is what
// drives both the cross-fade and the outer fade-to-lit.
float shadowCascade(
  sampler2DShadow map, mat4 lightViewProj, vec3 world, vec3 g,
  float sinTheta, float texel, float bias, out float edge
) {
  // Normal offset: lift the lookup off the surface along the FACE normal by
  // half a texel, plus up to one more as the face turns edge-on to the sun.
  // The depth pass's slope-scaled polygon offset already covers the PCF
  // footprint on a flat receiver, so this only has to clear the map's own
  // surface. It used to be one to four texels along the smooth shading
  // normal: on rolling ground that dragged the lookup around with the vertex
  // normals, so shadow edges bent to follow the bumps and lit blotches opened
  // inside the shade — and on the far cascade, whose texels run to half a
  // unit and more, it pushed the shadow clean off the foot of every cliff.
  vec3 p = world + g * (texel * (0.5 + sinTheta));
  vec4 lp = lightViewProj * vec4(p, 1.0);
  vec3 uvz = lp.xyz / lp.w * 0.5 + 0.5;
  vec2 e = abs(uvz.xy - 0.5) * 2.0;
  edge = max(e.x, e.y);
  if (edge > 1.0 || uvz.z > 1.0) return -1.0;
  return shadowPcf(map, vec3(uvz.xy, uvz.z - bias));
}

// Multiplier to apply to the FINAL lit colour: 1.0 lit, (1 - strength) fully
// shadowed. \`n\` must be normalized and \`ndl\` is dot(n, sunDir) *unclamped* —
// back-facing fragments get no sun to begin with, so they return early and
// never sample a map.
//
// This deliberately multiplies the finished colour instead of subtracting the
// sun term before xim's clamp(amb + sun + moon, 0, 1). Outdoor zones author
// ambient ~0.56 with a full-white sun, so lit terrain saturates at 1.0 and a
// subtracted sun term mostly vanishes into the clamp — a 60% shadow showed up
// as a ~16% dip. The smoothstep ramp keeps the physical part: a surface almost
// edge-on to the sun had little to lose, so it barely darkens.
float sunShadow(vec3 world, vec3 n, float ndl) {
  // Face normal from the position derivatives: constant across a triangle,
  // unlike the interpolated shading normal, so the lookup offset does not
  // wobble with the vertex normals. Taken before any branch — derivatives
  // are only defined in uniform control flow. FFXI winds faces either way,
  // so it is flipped onto the shading normal's side.
  vec3 g = cross(dFdx(world), dFdy(world));
  if (uShadowParams.x < 0.5 || ndl <= 0.0) return 1.0;
  float g2 = dot(g, g);
  g = g2 > 1e-20 ? g * inversesqrt(g2) : n;
  if (dot(g, n) < 0.0) g = -g;
  float gdl = clamp(dot(g, uSunDir), 0.0, 1.0);
  float sinTheta = sqrt(1.0 - gdl * gdl);

  float e0;
  float near = shadowCascade(uShadowMap0, uLightViewProj0, world, g, sinTheta,
                             uShadowParams.z, uShadowParams.w, e0);
  // Weight of the near cascade: full until blendStart, gone at its border.
  float w0 = near < 0.0 ? 0.0 : 1.0 - smoothstep(uShadowParams1.z, 1.0, e0);

  float lit;
  if (w0 >= 0.999) {
    lit = near;                    // deep inside the sharp cascade, one lookup
  } else {
    float far = 1.0;
    if (uShadowParams1.w > 0.5) {
      float e1;
      float v = shadowCascade(uShadowMap1, uLightViewProj1, world, g, sinTheta,
                              uShadowParams1.x, uShadowParams1.y, e1);
      // Past the last cascade there is no information, so fade to lit rather
      // than ending the shadows on a hard ring.
      if (v >= 0.0) far = mix(1.0, v, 1.0 - smoothstep(0.88, 1.0, e1));
    }
    lit = near < 0.0 ? far : mix(far, near, w0);
  }
  // The ramp is narrow on purpose. Any surface the sun barely reaches is
  // shaded by ambient alone, and ambient is what the multiply darkens — so a
  // wide ramp made every bump in a shadow that tilted away from the sun glow
  // against the ground around it. With a low sun (level ground at ndl ~0.4)
  // the old 0.35 ramp caught nearly every undulation.
  return 1.0 - uShadowParams.y * (1.0 - lit) * smoothstep(0.0, 0.12, ndl);
}
`;

// uAlphaMode: 0 = entity (two-pass cutout/blend), 1 = zone opaque (ignore tex alpha),
//             2 = zone cutout (_-prefix foliage), 3 = zone blend (water/fog 0x8000)
// uTerrainLit: 1 = xim terrain lighting (ambient + sun + moon), 0 = entity key-light
const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vUV;
in vec4 vColor;
in vec3 vNormal;
in vec3 vWorld;

uniform sampler2D uTexture;
uniform vec3 uLightDir;
uniform int uAlphaPass;   // 0 = opaque pass (solids), 1 = transparent pass (blended)
uniform float uShowAlpha; // 1 = blend/cutout alpha, 0 = force fully opaque
uniform int uAlphaMode;   // see comment above
uniform float uTerrainLit; // 1 = zone terrain (xim), 0 = entity
uniform vec3 uAmbient;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform vec3 uMoonColor;
uniform float uSunLit;     // 1 = swap the camera key light for the shadow sun
uniform float uLightGain;  // viewer brightness (1 = 100%, up to ~2)
${FOG_UNIFORMS}
${SHADOW_UNIFORMS}
${PLIGHT_UNIFORMS}

out vec4 outColor;
${SHADOW_SAMPLE}
${PLIGHT_APPLY}

void main() {
  vec4 tex = texture(uTexture, vUV);

  // FFXI alpha: 4 * vertexColorAlpha * textureAlpha. Neutral vColor.a is
  // 0x80 (0.5), so this is 2*texAlpha when diffuse alpha is untouched. (xim)
  float rawAlpha = clamp(4.0 * vColor.a * tex.a, 0.0, 1.0);

  float alpha;
  if (uShowAlpha < 0.5) {
    alpha = 1.0;
  } else if (uAlphaMode == 1) {
    // Zone opaque: retail ignores texture alpha on non-blend submeshes.
    alpha = 1.0;
  } else if (uAlphaMode == 2) {
    // Zone cutout foliage (mesh name starts with '_'): hard alpha-test.
    alpha = rawAlpha;
    if (alpha < 0.375) discard;
  } else if (uAlphaMode == 3) {
    // Zone soft-edge / water blend (xim): vertex alpha fades tile edges.
    alpha = rawAlpha;
    if (alpha < 0.02) discard;
  } else {
    // Entity default: two-pass solid/translucent split.
    alpha = rawAlpha;
    if (alpha < 0.06) discard;
    if (uAlphaPass == 0 && alpha < 0.5) discard;
    if (uAlphaPass == 1 && alpha >= 0.5) discard;
  }

  vec3 litRgb;
  float gain = max(uLightGain, 0.0);
  if (uTerrainLit > 0.5) {
    // XimShader terrain path: lit = vColor*ambient + Σ vColor*N·L*lightColor
    // then modulate2x with texture. No camera key-light.
    vec3 n = vNormal;
    float nl = length(n);
    n = nl > 1e-4 ? n / nl : vec3(0.0, 1.0, 0.0);
    float ndl = dot(n, uSunDir);
    vec3 amb = vColor.rgb * uAmbient;
    vec3 df0 = vColor.rgb * clamp(ndl, 0.0, 1.0) * uSunColor;
    vec3 df1 = vColor.rgb * clamp(dot(n, uMoonDir), 0.0, 1.0) * uMoonColor;
    litRgb = clamp(amb + df0 + df1, 0.0, 1.0) * sunShadow(vWorld, n, ndl);
    litRgb = clamp(litRgb + pointLighting(vWorld, n, vColor.rgb), 0.0, 1.0) * gain;
  } else if (uSunLit > 0.5) {
    // Shadows on: one directional key from the sun's angle. The camera light
    // below can't be used here — its shading would disagree with where the
    // cast shadow lands, and the result reads as a decal rather than a shadow.
    float nl = length(vNormal);
    vec3 n = nl > 1e-4 ? vNormal / nl : uSunDir;
    float ndl = dot(n, uSunDir);
    // Same 0.5..1.15 range as the camera key below, so toggling shadows changes
    // where the light comes from without changing how bright the model reads.
    float lit = (0.5 + 0.65 * clamp(ndl, 0.0, 1.0)) * gain;
    litRgb = vColor.rgb * lit * sunShadow(vWorld, n, ndl);
  } else {
    // Entity: camera-relative key light (legacy).
    float nl = length(vNormal);
    float intensity = nl < 1e-3 ? 1.0
      : 0.55 + 0.6 * max(0.0, dot(vNormal / nl, -uLightDir));
    litRgb = vColor.rgb * intensity * gain;
  }

  // modulate2x: 2 * lit * tex (0x80 diffuse neutral)
  outColor = vec4(tex.rgb * litRgb * 2.0, alpha);
${FOG_APPLY}
}
`;

// --- Zone terrain (port of xim XimShader: no skinning, wind position blend) ---
// Geometry arrives pre-baked in display space, so the VS only applies the wind
// blend (position0 + windFactor * position1) and the view-projection.
const ZONE_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location=0) in vec3 aP0;
layout(location=1) in vec3 aP1;      // wind blend delta (0 when the submesh has none)
layout(location=2) in vec3 aN;
layout(location=3) in vec2 aUV;
layout(location=4) in vec4 aColor;

uniform mat4 uViewProj;
uniform float uWind;                 // positionBlendWeight (xim WindFactor)
uniform vec3 uCenter;                // sky meshes follow the camera; 0 for world geometry
uniform vec2 uUVOffset;              // cloud / effect UV drift

out vec2 vUV;
out vec4 vColor;
out vec3 vNormal;
out vec3 vWorld;

void main() {
  vec3 world = aP0 + uWind * aP1 + uCenter;
  vUV = aUV + uUVOffset;
  vColor = aColor;
  vNormal = aN;
  vWorld = world;
  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

// XimShader.fragShader:
//   lit    = clamp(vColor*ambient + Σ vColor*max(0, N·L)*lightColor, 0, 1), a = vColor.a
//   pixel  = vec4(2*lit.rgb*tex.rgb, 4*lit.a*tex.a)
//   discard when pixel.a < discardThreshold, then fog (fog preserves alpha)
const ZONE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vUV;
in vec4 vColor;
in vec3 vNormal;
in vec3 vWorld;

uniform sampler2D uTexture;
uniform float uDiscard;    // 0.375 for '_' meshes, else 0
uniform float uShowAlpha;  // 0 = force opaque (viewer toggle)
uniform vec3 uAmbient;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform vec3 uMoonColor;
uniform float uLightGain;
${FOG_UNIFORMS}
${SHADOW_UNIFORMS}
${PLIGHT_UNIFORMS}

out vec4 outColor;
${SHADOW_SAMPLE}
${PLIGHT_APPLY}

void main() {
  vec4 tex = texture(uTexture, vUV);

  vec3 n = vNormal;
  float nl = length(n);
  n = nl > 1e-4 ? n / nl : vec3(0.0, 1.0, 0.0);
  float ndl = dot(n, uSunDir);
  vec3 amb = vColor.rgb * uAmbient;
  vec3 df0 = vColor.rgb * clamp(ndl, 0.0, 1.0) * uSunColor;
  vec3 df1 = vColor.rgb * clamp(dot(n, uMoonDir), 0.0, 1.0) * uMoonColor;
  // Sun shadow only darkens the sun/moon/ambient share; lamps still light
  // a shadowed patch, which is what makes them worth placing.
  vec3 lit = clamp(amb + df0 + df1, 0.0, 1.0) * sunShadow(vWorld, n, ndl);
  lit = clamp(lit + pointLighting(vWorld, n, vColor.rgb), 0.0, 1.0) * max(uLightGain, 0.0);

  float alpha = 4.0 * vColor.a * tex.a;
  if (alpha < uDiscard) discard;
  outColor = vec4(2.0 * lit * tex.rgb, uShowAlpha > 0.5 ? clamp(alpha, 0.0, 1.0) : 1.0);
${FOG_APPLY}
}
`;

// --- Floor plane (tiled ground texture + fog) ------------------------------

const FLOOR_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;   // world X/Z on the Y=0 plane
uniform mat4 uViewProj;
uniform float uTile;               // texture repeats per world unit
uniform float uY;                  // floor height (model feet)
out vec2 vUV;
out vec3 vWorld;
void main() {
  vWorld = vec3(aPos.x, uY, aPos.y);
  vUV = aPos * uTile;
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}
`;

const FLOOR_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUV;
in vec3 vWorld;
uniform sampler2D uTexture;
uniform vec3 uSunDir;
uniform vec2 uFadeRadius;   // (opaque within x, gone beyond y) in world units
${FOG_UNIFORMS}
${SHADOW_UNIFORMS}
out vec4 outColor;
${SHADOW_SAMPLE}
void main() {
  // Fade to nothing on a circle around the origin so the plane blends into
  // whatever is behind it instead of ending on a hard horizon line. Radial,
  // not square, or the corners would reach further than the sides.
  float r = length(vWorld.xz);
  float alpha = 1.0 - smoothstep(uFadeRadius.x, max(uFadeRadius.y, uFadeRadius.x + 0.001), r);
  // Skip the fully-faded ring entirely — a transparent fragment still writes
  // depth, which would punch a hole in anything drawn behind it later.
  if (alpha <= 0.002) discard;

  // The floor is unlit, so the shadow is the only lighting it has. Its normal
  // is constant: entity models are raw Y-DOWN DAT space, so "up" is −Y.
  const vec3 n = vec3(0.0, -1.0, 0.0);
  vec3 rgb = texture(uTexture, vUV).rgb * sunShadow(vWorld, n, dot(n, uSunDir));
  outColor = vec4(rgb, alpha);
${FOG_APPLY}
}
`;

// --- Debug overlays: collision (per-vert colour) + navmesh (solid green) ----

const OVERLAY_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
uniform mat4 uViewProj;
out vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

const OVERLAY_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 vColor;
uniform float uOpacity;
out vec4 outColor;
void main() {
  outColor = vec4(vColor, uOpacity);
}
`;

// Camera-facing sound markers (zone positional SFX). Drawn as soft discs so
// they stay readable at any distance; colour encodes in-range vs out-of-range.
const MARKER_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
uniform mat4 uViewProj;
uniform float uPointSize;
out vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPos, 1.0);
  gl_PointSize = uPointSize;
}
`;

const MARKER_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  // Ring + soft centre so markers read as "speaker" blobs.
  float ring = smoothstep(0.55, 0.45, r) * smoothstep(1.0, 0.75, r);
  float core = smoothstep(0.45, 0.0, r);
  float a = max(ring, core * 0.85);
  outColor = vec4(vColor, a);
}
`;

// --- Sky dome (xim SkyBoxMesh): vertex-coloured gradient dome, camera-centred,
// unlit, drawn behind everything. uCenter follows the eye so it wraps the free
// camera (xim leaves it at the world origin; zones are authored around it). ----

const SKY_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;      // dome-local position (display space)
layout(location=1) in vec4 aColor;
uniform mat4 uViewProj;
uniform vec3 uCenter;
out vec4 vColor;
void main() {
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPos + uCenter, 1.0);
}
`;

const SKY_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vec4(vColor.rgb, 1.0); }
`;

// --- Shadow depth pass -----------------------------------------------------
// Two vertex shaders, one per geometry layout, each a stripped copy of the
// matching main-pass VS so a caster lands in exactly the position it is drawn
// at. Keep them in step with ZONE_VERTEX_SHADER / VERTEX_SHADER above.

const SHADOW_ZONE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aP0;
layout(location=1) in vec3 aP1;
layout(location=3) in vec2 aUV;
layout(location=4) in vec4 aColor;
uniform mat4 uLightViewProj;
uniform float uWind;
out vec2 vUV;
out float vAlpha;
void main() {
  vUV = aUV;
  vAlpha = aColor.a;
  gl_Position = uLightViewProj * vec4(aP0 + uWind * aP1, 1.0);
}
`;

const SHADOW_ENTITY_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aP0;
layout(location=1) in vec3 aP1;
layout(location=4) in vec2 aWeights;
layout(location=5) in vec2 aJoints;
layout(location=6) in vec2 aUV;
layout(location=7) in vec4 aColor;

uniform mat4 uLightViewProj;
uniform mat4 uModel;      // identity for the main entity; placement for zone actors
uniform vec4 uRot[${MAX_JOINTS}];
uniform vec4 uTrans[${MAX_JOINTS}];
uniform vec4 uScale[${MAX_JOINTS}];

out vec2 vUV;
out float vAlpha;

vec3 qrot(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

void main() {
  int j0 = int(aJoints.x);
  int j1 = int(aJoints.y);
  vec3 world = qrot(uRot[j0], uScale[j0].xyz * aP0) + aWeights.x * uTrans[j0].xyz
             + qrot(uRot[j1], uScale[j1].xyz * aP1) + aWeights.y * uTrans[j1].xyz;
  vUV = aUV;
  vAlpha = aColor.a;
  gl_Position = uLightViewProj * (uModel * vec4(world, 1.0));
}
`;

// Depth-only. uCutout > 0 alpha-tests the caster with the same 4*vα*texα rule
// the colour passes use, so foliage cards and hair drop their holes into the
// map instead of casting solid rectangles.
const SHADOW_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUV;
in float vAlpha;
uniform sampler2D uTexture;
uniform float uCutout;
void main() {
  if (uCutout > 0.0 && 4.0 * vAlpha * texture(uTexture, vUV).a < uCutout) discard;
}
`;

/** Edge index list for wireframe drawElements(LINES). */
function buildWireIndices(vertCount, isStrip) {
  if (vertCount < 3) return null;
  const edges = [];
  const push = (a, b) => { edges.push(a, b); };
  if (!isStrip) {
    for (let i = 0; i + 2 < vertCount; i += 3) {
      push(i, i + 1); push(i + 1, i + 2); push(i + 2, i);
    }
  } else {
    for (let i = 0; i + 2 < vertCount; i++) {
      push(i, i + 1); push(i + 1, i + 2); push(i + 2, i);
    }
  }
  return edges.length ? new Uint32Array(edges) : null;
}

/**
 * Canonical form for source-path matching: backslashes, lowercase. Both the
 * filter sets and the per-batch keys go through here, so they cannot drift.
 */
function normSourcePath(p) {
  return String(p ?? '').replace(/\//g, '\\').toLowerCase();
}

/** The trailing `rom2\dir\file.dat`, so an absolute path also matches a ROM-relative one. */
function romTail(normalised) {
  const m = normalised.match(/rom\d*[\\/][\w.\\/-]+\.dat$/i);
  return m ? m[0] : null;
}

/**
 * Path list -> lookup set holding both the full path and its ROM tail.
 * Null for an empty list, which every caller reads as "no filter".
 */
function sourceKeySet(paths) {
  if (!paths || (typeof paths.size === 'number' ? paths.size === 0 : !paths.length)) return null;
  const set = new Set();
  for (const p of paths) {
    const n = normSourcePath(p);
    set.add(n);
    const tail = romTail(n);
    if (tail) set.add(tail);
  }
  return set;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;

    this.s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc');

    this.program = buildProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.uniforms = {
      viewProj: gl.getUniformLocation(this.program, 'uViewProj'),
      model: gl.getUniformLocation(this.program, 'uModel'),
      rot: gl.getUniformLocation(this.program, 'uRot'),
      trans: gl.getUniformLocation(this.program, 'uTrans'),
      scale: gl.getUniformLocation(this.program, 'uScale'),
      texture: gl.getUniformLocation(this.program, 'uTexture'),
      lightDir: gl.getUniformLocation(this.program, 'uLightDir'),
      cameraPos: gl.getUniformLocation(this.program, 'uCameraPos'),
      fogColor: gl.getUniformLocation(this.program, 'uFogColor'),
      fogRange: gl.getUniformLocation(this.program, 'uFogRange'),
      alphaPass: gl.getUniformLocation(this.program, 'uAlphaPass'),
      showAlpha: gl.getUniformLocation(this.program, 'uShowAlpha'),
      alphaMode: gl.getUniformLocation(this.program, 'uAlphaMode'),
      terrainLit: gl.getUniformLocation(this.program, 'uTerrainLit'),
      ambient: gl.getUniformLocation(this.program, 'uAmbient'),
      sunDir: gl.getUniformLocation(this.program, 'uSunDir'),
      sunColor: gl.getUniformLocation(this.program, 'uSunColor'),
      moonDir: gl.getUniformLocation(this.program, 'uMoonDir'),
      moonColor: gl.getUniformLocation(this.program, 'uMoonColor'),
      sunLit: gl.getUniformLocation(this.program, 'uSunLit'),
      lightGain: gl.getUniformLocation(this.program, 'uLightGain'),
      shadowMap0: gl.getUniformLocation(this.program, 'uShadowMap0'),
      shadowMap1: gl.getUniformLocation(this.program, 'uShadowMap1'),
      lightViewProj0: gl.getUniformLocation(this.program, 'uLightViewProj0'),
      lightViewProj1: gl.getUniformLocation(this.program, 'uLightViewProj1'),
      shadowParams: gl.getUniformLocation(this.program, 'uShadowParams'),
      shadowParams1: gl.getUniformLocation(this.program, 'uShadowParams1'),
      pointCount: gl.getUniformLocation(this.program, 'uPointCount'),
      pointPos: gl.getUniformLocation(this.program, 'uPointPos'),
      pointColor: gl.getUniformLocation(this.program, 'uPointColor'),
      pointRadius: gl.getUniformLocation(this.program, 'uPointRadius'),
      pointDir: gl.getUniformLocation(this.program, 'uPointDir'),
      pointCone: gl.getUniformLocation(this.program, 'uPointCone'),
      extraAmbient: gl.getUniformLocation(this.program, 'uExtraAmbient'),
    };
    // Default midday outdoor terrain lighting (overwritten per-zone from 0x2F).
    this.terrainLighting = {
      ambient: [0.45, 0.45, 0.45],
      sunDir: [0.35, 0.9, 0.25],
      sunColor: [0.55, 0.55, 0.5],
      moonDir: [-0.35, -0.9, -0.25],
      moonColor: [0.08, 0.08, 0.12],
      fogColor: [0.5, 0.55, 0.6],
      fogNear: 80,
      fogFar: 400,
      fogOn: false,
      clearColor: null,
      indoors: false,
    };
    // View > Unlit forces full unlit; lightBrightness (0..1) blends default → unlit.
    this.unlit = false;
    this.lightBrightness = 0;
    // Light gizmo brightness (1 = 100%, 2 = 200%). Scales lit RGB after shading.
    this.lightGain = 1;
    this.polygonMode = gl.getExtension('WEBGL_polygon_mode');

    // Zone terrain program (xim ximProgram equivalent).
    this.zoneProgram = buildProgram(gl, ZONE_VERTEX_SHADER, ZONE_FRAGMENT_SHADER);
    this.zoneUniforms = {
      viewProj: gl.getUniformLocation(this.zoneProgram, 'uViewProj'),
      wind: gl.getUniformLocation(this.zoneProgram, 'uWind'),
      center: gl.getUniformLocation(this.zoneProgram, 'uCenter'),
      texture: gl.getUniformLocation(this.zoneProgram, 'uTexture'),
      discard: gl.getUniformLocation(this.zoneProgram, 'uDiscard'),
      showAlpha: gl.getUniformLocation(this.zoneProgram, 'uShowAlpha'),
      ambient: gl.getUniformLocation(this.zoneProgram, 'uAmbient'),
      sunDir: gl.getUniformLocation(this.zoneProgram, 'uSunDir'),
      sunColor: gl.getUniformLocation(this.zoneProgram, 'uSunColor'),
      moonDir: gl.getUniformLocation(this.zoneProgram, 'uMoonDir'),
      moonColor: gl.getUniformLocation(this.zoneProgram, 'uMoonColor'),
      lightGain: gl.getUniformLocation(this.zoneProgram, 'uLightGain'),
      cameraPos: gl.getUniformLocation(this.zoneProgram, 'uCameraPos'),
      fogColor: gl.getUniformLocation(this.zoneProgram, 'uFogColor'),
      fogRange: gl.getUniformLocation(this.zoneProgram, 'uFogRange'),
      uvOffset: gl.getUniformLocation(this.zoneProgram, 'uUVOffset'),
      shadowMap0: gl.getUniformLocation(this.zoneProgram, 'uShadowMap0'),
      shadowMap1: gl.getUniformLocation(this.zoneProgram, 'uShadowMap1'),
      lightViewProj0: gl.getUniformLocation(this.zoneProgram, 'uLightViewProj0'),
      lightViewProj1: gl.getUniformLocation(this.zoneProgram, 'uLightViewProj1'),
      shadowParams: gl.getUniformLocation(this.zoneProgram, 'uShadowParams'),
      shadowParams1: gl.getUniformLocation(this.zoneProgram, 'uShadowParams1'),
      pointCount: gl.getUniformLocation(this.zoneProgram, 'uPointCount'),
      pointPos: gl.getUniformLocation(this.zoneProgram, 'uPointPos'),
      pointColor: gl.getUniformLocation(this.zoneProgram, 'uPointColor'),
      pointRadius: gl.getUniformLocation(this.zoneProgram, 'uPointRadius'),
      pointDir: gl.getUniformLocation(this.zoneProgram, 'uPointDir'),
      pointCone: gl.getUniformLocation(this.zoneProgram, 'uPointCone'),
      extraAmbient: gl.getUniformLocation(this.zoneProgram, 'uExtraAmbient'),
    };
    // Shadow depth pass (View > Toggle Shadows). Off by default — it is a
    // viewer embellishment, not something retail FFXI ever drew.
    this.shadowZoneProgram = buildProgram(gl, SHADOW_ZONE_VS, SHADOW_FRAGMENT_SHADER);
    this.shadowZoneUniforms = {
      lightViewProj: gl.getUniformLocation(this.shadowZoneProgram, 'uLightViewProj'),
      wind: gl.getUniformLocation(this.shadowZoneProgram, 'uWind'),
      texture: gl.getUniformLocation(this.shadowZoneProgram, 'uTexture'),
      cutout: gl.getUniformLocation(this.shadowZoneProgram, 'uCutout'),
    };
    this.shadowEntityProgram = buildProgram(gl, SHADOW_ENTITY_VS, SHADOW_FRAGMENT_SHADER);
    this.shadowEntityUniforms = {
      lightViewProj: gl.getUniformLocation(this.shadowEntityProgram, 'uLightViewProj'),
      model: gl.getUniformLocation(this.shadowEntityProgram, 'uModel'),
      rot: gl.getUniformLocation(this.shadowEntityProgram, 'uRot'),
      trans: gl.getUniformLocation(this.shadowEntityProgram, 'uTrans'),
      scale: gl.getUniformLocation(this.shadowEntityProgram, 'uScale'),
      texture: gl.getUniformLocation(this.shadowEntityProgram, 'uTexture'),
      cutout: gl.getUniformLocation(this.shadowEntityProgram, 'uCutout'),
    };
    this.showShadows = false;
    this.shadowMapSize = 2048;
    this.shadowStrength = 0.6;     // how dark a fully shadowed sun term goes
    // Zone shadow draw distance: the cascade's half-extent in world units, i.e.
    // how far from the camera terrain still receives. Graphics Settings owns it.
    // Entity/creation views ignore it and fit the model's own bounds instead.
    this.shadowRange = 90;
    // Near cascade half-extent as a fraction of the draw distance, with a floor
    // so a small distance doesn't shrink it to nothing. A quarter keeps the
    // sharp cascade over everything within arm's reach of the camera while
    // still leaving the far one a sane job.
    this.shadowNearSplit = 0.25;
    this.shadowNearMin = 12;
    this.shadowTargets = [];       // [{ fbo, tex, size }] — built on first use
    this.shadowActive = false;     // valid maps were rendered for this frame
    // [{ lvp, texel, bias, ax, cx, ay, cy, r }] — near first. Zones get two,
    // model views one (the fit is already tighter than any split would be).
    this.shadowCascades = [];
    this.shadowSunDir = ENTITY_SUN_DAT;   // light dir in the space being drawn
    // Optional user override from the light gizmo (display-space, Y-up, toward
    // the light). null = use zone env sun / default entity key. Zones keep the
    // vector as-is; entity models map it into DAT space (DISPLAY_ROT).
    this.customSunDir = null;

    this.zoneBatches = [];
    this.zoneSpinnerBatches = [];   // live-spin companions (mill on w_mill)
    this.zoneSpinnerAngle = 0;
    this.zoneDisableCull = false;   // debug: ignore the per-submesh cull flag
    // Coplanar water/overlay submeshes: retail-style LEQUAL lets equal-depth blend
    // fragments pass. Off = strict LESS (old behaviour) for A/B comparison.
    this.zoneBlendLequal = true;
    // xim WindFactor: a 0→1→0 triangle wave, 2 seconds per leg.
    this.windFactor = 0;
    this.windDir = 1;

    // Floor plane program + a unit quad spanning [-1,1] (scaled in the shader).
    this.floorProgram = buildProgram(gl, FLOOR_VERTEX_SHADER, FLOOR_FRAGMENT_SHADER);
    this.floorUniforms = {
      viewProj: gl.getUniformLocation(this.floorProgram, 'uViewProj'),
      texture: gl.getUniformLocation(this.floorProgram, 'uTexture'),
      tile: gl.getUniformLocation(this.floorProgram, 'uTile'),
      y: gl.getUniformLocation(this.floorProgram, 'uY'),
      cameraPos: gl.getUniformLocation(this.floorProgram, 'uCameraPos'),
      fogColor: gl.getUniformLocation(this.floorProgram, 'uFogColor'),
      fogRange: gl.getUniformLocation(this.floorProgram, 'uFogRange'),
      sunDir: gl.getUniformLocation(this.floorProgram, 'uSunDir'),
      fadeRadius: gl.getUniformLocation(this.floorProgram, 'uFadeRadius'),
      shadowMap0: gl.getUniformLocation(this.floorProgram, 'uShadowMap0'),
      shadowMap1: gl.getUniformLocation(this.floorProgram, 'uShadowMap1'),
      lightViewProj0: gl.getUniformLocation(this.floorProgram, 'uLightViewProj0'),
      lightViewProj1: gl.getUniformLocation(this.floorProgram, 'uLightViewProj1'),
      shadowParams: gl.getUniformLocation(this.floorProgram, 'uShadowParams'),
      shadowParams1: gl.getUniformLocation(this.floorProgram, 'uShadowParams1'),
    };
    const half = 60;
    this.floorVao = gl.createVertexArray();
    this.floorVbo = gl.createBuffer();
    gl.bindVertexArray(this.floorVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.floorVbo);
    // Filled by _uploadFloorQuad — half-extent tracks Floor Radius.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(12), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.floor = null;      // { texture } when a floor is loaded
    // Scene > Flat Floor: a plain untextured ground plane, drawn through the
    // same shader with a 1x1 solid texture so it keeps the fade ring, the fog
    // and — the point of it — the actor's shadow. Independent of `floor`, so
    // ticking it does not discard a loaded ground texture.
    this.flatFloor = { on: false, color: [0.5, 0.5, 0.55] };
    this.flatFloorTex = null;
    // The ground plane is at Y = 0 and never moves. Placing it at the
    // model's feet meant it jumped whenever the pose changed — frame-0 sole
    // height varies by up to 0.14 between clips on one model — which read
    // as the camera dropping through the floor. A floor is scenery.
    this.floorY = 0;
    // `floorTile` is what the shader reads: the per-texture default times the
    // user's Scene > Floor Repeat multiplier. Kept apart so picking a different
    // floor re-derives the default without discarding their setting.
    this.floorTileBase = 0.5;
    this.floorTileScale = 1;
    this.floorTile = 0.5;
    // Scene > Floor Radius / Fade Radius. `outer` is fully transparent beyond;
    // `inner` is fully opaque within. Fade band width = outer − inner.
    // Defaults match the old fixed half=60 plane (outer 42, fade 30 → inner 12).
    this.floorRadius = 42;
    this.floorFadeRadius = 30;
    this.floorHalf = half;
    this.floorFade = { inner: 12, outer: 42 };
    this._syncFloorExtent();
    // `_fogBase` is the authored fog (zone environment or manual); `fog` is what
    // the shaders read after the user's toggle and distance scale are applied.
    this._fogBase = { enabled: false, color: [0x30 / 255, 0x34 / 255, 0x38 / 255], near: 6, far: 40 };
    this.fogOverride = { enabled: true, scale: 1 };
    this.fog = { ...this._fogBase };

    // Collision / navmesh debug overlays (zone only).
    this.overlayProgram = buildProgram(gl, OVERLAY_VERTEX_SHADER, OVERLAY_FRAGMENT_SHADER);
    this.overlayUniforms = {
      viewProj: gl.getUniformLocation(this.overlayProgram, 'uViewProj'),
      opacity: gl.getUniformLocation(this.overlayProgram, 'uOpacity'),
    };
    this.markerProgram = buildProgram(gl, MARKER_VERTEX_SHADER, MARKER_FRAGMENT_SHADER);
    this.markerUniforms = {
      viewProj: gl.getUniformLocation(this.markerProgram, 'uViewProj'),
      pointSize: gl.getUniformLocation(this.markerProgram, 'uPointSize'),
    };
    this.markerVao = gl.createVertexArray();
    this.markerVbo = gl.createBuffer();
    gl.bindVertexArray(this.markerVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.markerVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
    this.markerCount = 0;
    // Sky dome program (xim SkyBoxMesh). Built per-zone from the 0x2F skybox.
    this.skyProgram = buildProgram(gl, SKY_VERTEX_SHADER, SKY_FRAGMENT_SHADER);
    this.skyUniforms = {
      viewProj: gl.getUniformLocation(this.skyProgram, 'uViewProj'),
      center: gl.getUniformLocation(this.skyProgram, 'uCenter'),
    };
    this.skyDome = null;   // { vao, vbo, count } | null
    this.skyWeather = null; // current weather id — which cloud layer to show

    this.collisionOverlay = null; // { vao, vbo, count }
    this.navmeshOverlay = null;
    this.zonePickOverlay = null; // live-selection hover/selected AABB wireframes
    this.actorHoverId = null;    // Actors live selection: actor under the cursor
    this.zoneGizmo = null;       // { pos, size, activeAxis } selected-object XYZ grabber
    this.gizmoMesh = null;       // solid unit gizmo (triangles)
    this.zoneMoveProxy = [];     // temporary zone batches while dragging a placement
    this.showCollision = false;
    this.showNavmesh = false;
    this.showSoundMarkers = false;  // zone positional SFX (waterfalls, surf)
    this.showSkybox = false;
    /** Draw 0x2E meshes with no 0x1C placement (at origin). Off by default. */
    this.showUnplaced = false;
    /** Scale DAT-authored particle draw/cull distances. 1 = game default. */
    this.effectDistanceScale = 1;
    this.collisionOpacity = 0.45;
    this.navmeshOpacity = 0.40;

    this.whiteTexture = makeWhiteTexture(gl);
    this.camera = new OrbitCamera();

    this.model = null;
    // Zone actors (Objects › Actors): NPCs / characters placed on the terrain,
    // each with its own batches, textures, pose and clip. See addActor().
    this.actors = [];
    // { actorId, mode: 'move'|'rotate'|'scale', hoverAxis, activeAxis } — the
    // transform grabber on the selected actor (Actors panel live selection).
    this.actorGizmo = null;
    this.pose = null;
    this.batches = [];
    this.textures = new Map();
    /** Texture names owned by the current model, so an effect overlaid on
     *  the actor cannot replace the actor's own art (see
     *  {@link Renderer#attachEffectSystem}). */
    this.modelTextureNames = new Set();
    // PC gear isolation: null = show all; Set of lowercased source paths = only those.
    this.meshSourceFilter = null;
    // Always-hidden sources (the stowed ranged weapon); null = nothing hidden.
    this.hiddenSources = null;
    // Fired when the playing clip wraps, so a paired effect can restart with it.
    this.onAnimLoop = null;
    // Character playback transport: false parks on the last frame instead of
    // wrapping, and reports it through onAnimEnd.
    this.animLoop = true;
    this.onAnimEnd = null;

    // Origin axis gizmo (View > Toggle Axes; on by default in the Effects view).
    this.showAxes = false;
    // World grid on the ground plane (View > Toggle Grid) — the floor, as lines.
    this.showGrid = false;
    this.gridLines = null;   // { vao, vbo, count, kind } — rebuilt when range kind changes
    // Camera Sequencer route preview — set by the panel, null when it is closed.
    this.cameraPath = null;  // { data, count, dirty }
    this.pathLines = null;   // { vao, vbo } — lazily built, reused

    // Standalone spell/ability effect playback (no model, particles at origin).
    this.effectMode = false;
    this.effectPaused = false;
    this.effectSpeed = 1;
    // Spell TargetActor attach at skinned AABB centre when a character is on stage.
    this.attachFxToActor = true;

    this.rotArray = new Float32Array(MAX_JOINTS * 4);
    this.transArray = new Float32Array(MAX_JOINTS * 4);
    this.scaleArray = new Float32Array(MAX_JOINTS * 4);

    this.currentAnimation = null;
    this.animFrame = 0;
    this.playing = false;
    this.playbackSpeed = 1;    // 1 = 30fps game speed; scaled by the panel slider
    this.showTextures = true;
    this.showWireframe = false;
    this.showSkeleton = false;
    this.highlightJoint = -1;       // Skeleton panel selection — orange in viewport
    this.skeletonLines = null;      // lazily built, reused for the renderer's life
    this.showAlpha = true;
    this.poseDirty = true;

    // Horizontal screen-space shift in CSS px (positive = scene moves right).
    // Used to keep the model centered in the area not covered by the tree panel.
    this.screenOffsetX = 0;

    // Graphics > Render Resolution: rows in the drawing buffer, or 0 to follow
    // the window at native DPR. See resize().
    this.renderHeight = 0;

    this.clearColor = [0x30 / 255, 0x34 / 255, 0x38 / 255];
    this.userClearColor = this.clearColor.slice();

    // Full-screen background image (Scene > Background Image). Drawn after
    // clear, depth off, so models/floors sit on top. Cover-fit in the shader.
    this.bgProgram = buildProgram(gl, BG_IMAGE_VS, BG_IMAGE_FS);
    this.bgUniforms = {
      texture: gl.getUniformLocation(this.bgProgram, 'uTexture'),
      coverScale: gl.getUniformLocation(this.bgProgram, 'uCoverScale'),
    };
    this.bgVao = gl.createVertexArray();
    this.bgVbo = gl.createBuffer();
    gl.bindVertexArray(this.bgVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgVbo);
    // pos.xy NDC, uv
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      // x, y, u, v  — full-screen quad, UV 0..1
      -1, -1, 0, 1,
       1, -1, 1, 1,
      -1,  1, 0, 0,
      -1,  1, 0, 0,
       1, -1, 1, 1,
       1,  1, 1, 0,
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);
    this.bgImage = null; // { texture, width, height, url }
  }

  /** Accepts '#rrggbb'. */
  setClearColor(hex) {
    const rgb = hexToRgb(hex);
    if (rgb) {
      this.userClearColor = rgb;
      this.clearColor = rgb;
    }
  }

  /**
   * Full-viewport background image (cover). Pass a URL string or null to clear.
   * Async — loads then uploads; safe to call repeatedly.
   */
  setBackgroundImage(url) {
    const gl = this.gl;
    if (!url) {
      if (this.bgImage?.texture) gl.deleteTexture(this.bgImage.texture);
      this.bgImage = null;
      this._bgLoadToken = (this._bgLoadToken || 0) + 1;
      return;
    }
    if (this.bgImage?.url === url && this.bgImage?.texture) return;
    const token = (this._bgLoadToken = (this._bgLoadToken || 0) + 1);
    const img = new Image();
    // Same-origin public asset; still helps some embeds.
    img.decoding = 'async';
    img.onload = () => {
      if (token !== this._bgLoadToken) return;
      try {
        if (this.bgImage?.texture) gl.deleteTexture(this.bgImage.texture);
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.bindTexture(gl.TEXTURE_2D, null);
        this.bgImage = {
          texture,
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
          url,
        };
      } catch (e) {
        console.warn('[renderer] background upload failed', url, e);
      }
    };
    img.onerror = () => {
      if (token !== this._bgLoadToken) return;
      console.warn('[renderer] background image failed to load', url);
    };
    img.src = url;
  }

  /** Sets the floor's tiled ground texture (a parsed floor TextureImage), or null. */
  setFloorTexture(image) {
    const gl = this.gl;
    if (this.floor) { gl.deleteTexture(this.floor.texture); this.floor = null; }
    if (!image) return;
    const texture = this.createTexture(image);
    if (texture) {
      // Tile roughly every ~2 world units regardless of the source resolution.
      this.floorTileBase = 1 / 2;
      this.floorTile = this.floorTileBase * this.floorTileScale;
      this.floor = { texture };
      this.snapFloorToFeet();
    }
  }

  /**
   * Scene > Flat Floor: `on` toggles the plain ground plane, `color` is
   * '#rrggbb' (or an [r,g,b] 0..1 triple). Either may be omitted.
   */
  setFlatFloor({ on, color } = {}) {
    const gl = this.gl;
    if (on !== undefined) this.flatFloor.on = !!on;
    if (color) {
      const rgb = Array.isArray(color) ? color : hexToRgb(color);
      if (rgb) this.flatFloor.color = rgb;
    }
    if (!this.flatFloor.on) return;
    if (!this.flatFloorTex) {
      this.flatFloorTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.flatFloorTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    }
    const [r, g, b] = this.flatFloor.color;
    const px = new Uint8Array([
      Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), 255,
    ]);
    gl.bindTexture(gl.TEXTURE_2D, this.flatFloorTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindTexture(gl.TEXTURE_2D, null);
    // Nothing to place: the plane is fixed at Y = 0.
  }

  /**
   * User multiplier on the floor's texture repeat (Scene > Floor Repeat).
   * Higher repeats more often, i.e. smaller tiles. Survives a floor change.
   */
  setFloorTileScale(scale) {
    const s = Math.min(4, Math.max(0.25, Number(scale) || 1));
    this.floorTileScale = s;
    this.floorTile = this.floorTileBase * s;
  }

  /**
   * Scene > Floor Radius — world-unit radius of the ground disc (fully gone
   * beyond this). Rebuilds the backing quad when the extent grows/shrinks.
   */
  setFloorRadius(radius) {
    const r = Math.min(200, Math.max(2, Number(radius) || 42));
    this.floorRadius = r;
    this._syncFloorExtent();
  }

  /**
   * Scene > Floor Fade Radius — soft edge width in world units. Opaque inside
   * (outer − fade), transparent at outer. Clamped so it cannot exceed radius.
   */
  setFloorFadeRadius(fade) {
    const f = Math.min(200, Math.max(0, Number(fade) || 0));
    this.floorFadeRadius = f;
    this._syncFloorExtent();
  }

  /** Derive fade inner/outer + upload a quad large enough to cover the disc. */
  _syncFloorExtent() {
    const outer = this.floorRadius;
    const fade = Math.min(this.floorFadeRadius, outer);
    const inner = Math.max(0, outer - fade);
    this.floorFade = { inner, outer };
    // Square half-extent ≥ outer so the circular fade never hits the quad edge.
    const half = Math.max(outer, 2);
    if (half !== this.floorHalf) {
      this.floorHalf = half;
      this._uploadFloorQuad(half);
    }
  }

  _uploadFloorQuad(half) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.floorVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -half, -half, half, -half, half, half, -half, -half, half, half, -half, half,
    ]), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /**
   * Scene fog, { enabled, color:'#rrggbb', near, far } — any subset.
   *
   * The values given here are the *source* fog: for a zone that's whatever the
   * 0x2F environment authored (re-pushed every frame during a weather fade), for
   * an entity it's the manual viewer fog. The user's toggle and distance scale
   * are stored separately and re-applied on top, so an incoming environment
   * update can't stomp them.
   */
  setFog(opts = {}) {
    const base = this._fogBase;
    if (opts.enabled !== undefined) base.enabled = opts.enabled;
    if (opts.color) {
      if (Array.isArray(opts.color)) base.color = opts.color;
      else { const rgb = hexToRgb(opts.color); if (rgb) base.color = rgb; }
    }
    if (opts.near !== undefined) base.near = opts.near;
    if (opts.far !== undefined) base.far = opts.far;
    this._applyFog();
  }

  /** User override: { enabled, scale } — scale multiplies the authored distance. */
  setFogOverride({ enabled, scale } = {}) {
    if (enabled !== undefined) this.fogOverride.enabled = enabled;
    if (scale !== undefined) this.fogOverride.scale = scale;
    this._applyFog();
  }

  _applyFog() {
    const base = this._fogBase;
    const scale = this.fogOverride.scale ?? 1;
    this.fog.enabled = base.enabled && this.fogOverride.enabled !== false;
    this.fog.color = base.color;
    this.fog.near = base.near * scale;
    this.fog.far = base.far * scale;
  }

  /** Apply xim-style terrain lighting (from zone 0x2F environment). */
  setTerrainLighting(lit) {
    if (!lit) return;
    this.terrainLighting = { ...this.terrainLighting, ...lit };
    // Always sync fog from the environment (disable when the DAT has none).
    this.setFog({
      enabled: !!lit.fogOn,
      color: lit.fogColor,
      near: lit.fogNear ?? 0,
      far: lit.fogFar ?? 0,
    });
    // Indoor clear colour from the DAT; outdoors restore the user/settings colour.
    if (lit.clearColor) this.clearColor = lit.clearColor;
    else if (this.userClearColor) this.clearColor = this.userClearColor;
  }

  /**
   * Zone lighting uniforms. Blends terrain env lighting toward unlit
   * (ambient white, no sun/moon) by lightBrightness 0..1. View > Unlit = 1.
   */
  /**
   * Display-space sun (Y-up, toward light). null clears the gizmo override and
   * restores zone env / default entity key.
   */
  setCustomSunDir(dir) {
    if (!dir) {
      this.customSunDir = null;
      return;
    }
    const n = Math.hypot(dir[0], dir[1], dir[2]);
    if (!(n > 1e-6)) {
      this.customSunDir = null;
      return;
    }
    this.customSunDir = [dir[0] / n, dir[1] / n, dir[2] / n];
  }

  /** Light gizmo brightness. 1 = 100%, 2 = 200%. */
  setLightGain(gain) {
    const g = Number(gain);
    this.lightGain = Math.min(2, Math.max(0.25, Number.isFinite(g) ? g : 1));
  }

  /** Display → entity DAT sun (same map as ENTITY_SUN_DISPLAY → ENTITY_SUN_DAT). */
  _displaySunToDat(d) {
    return [-d[0], -d[1], d[2]];
  }

  _zoneLightUniforms() {
    const L = this.terrainLighting;
    const sunDir = this.customSunDir || L.sunDir;
    const t = this.unlit ? 1 : Math.min(1, Math.max(0, this.lightBrightness || 0));
    if (t <= 0) return { ...L, sunDir };
    const lerp3 = (a, b) => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ];
    return {
      ambient: lerp3(L.ambient, [1, 1, 1]),
      sunDir,
      sunColor: lerp3(L.sunColor || [0, 0, 0], [0, 0, 0]),
      moonDir: L.moonDir,
      moonColor: lerp3(L.moonColor || [0, 0, 0], [0, 0, 0]),
    };
  }

  // -------------------------------------------------------------------------

  /**
   * PC gear isolation. `paths` null/empty = show every mesh; otherwise only
   * batches whose sourcePath matches one of the given DAT paths (abs or ROM/…).
   */
  setMeshSourceFilter(paths) {
    this.meshSourceFilter = sourceKeySet(paths);
  }

  /**
   * Sources hidden regardless of isolation. Separate from `meshSourceFilter`,
   * which is an allow-list for gear isolation — this is a deny-list, and the
   * ranged weapon uses it: the game keeps a bow scaled to 0 until it is in use.
   */
  setHiddenSources(paths) {
    this.hiddenSources = sourceKeySet(paths);
  }

  _sourceIn(set, batch) {
    if (!set) return false;
    // Normalise once per batch, not once per batch per draw pass. This ran for
    // every batch in every pass (solid, alpha, each shadow cascade) whenever a
    // filter was set — tens of thousands of regex matches a frame on a zone,
    // all returning the same answer.
    //
    // Cached lazily rather than stamped at build time on purpose: batches are
    // pushed from several places (model, zone, spinner proxy) and the proxy
    // arrays get swapped into `zoneBatches`, so a missed construction site
    // would silently mis-filter. sourcePath never changes once a batch exists.
    if (batch._srcKey === undefined) {
      batch._srcKey = normSourcePath(batch.sourcePath);
      batch._srcRomKey = romTail(batch._srcKey);
    }
    if (set.has(batch._srcKey)) return true;
    return batch._srcRomKey !== null && set.has(batch._srcRomKey);
  }

  _batchSourceVisible(batch) {
    if (this._sourceIn(this.hiddenSources, batch)) return false;
    if (!this.meshSourceFilter) return true;
    return this._sourceIn(this.meshSourceFilter, batch);
  }

  /** keepCamera: leave the orbit untouched (gear swap on the same actor). */
  setModel(model, keepCamera = false) {
    const gl = this.gl;
    this.effectMode = false;   // any real model/zone load leaves effect mode
    // Always drop isolation — caller re-applies after PC gear swaps.
    this.meshSourceFilter = null;
    // New geometry (including a gear swap) invalidates the cached rest bounds.
    this._restBounds = undefined;
    for (const b of this.batches) {
      gl.deleteBuffer(b.vbo);
      if (b.wireEbo) gl.deleteBuffer(b.wireEbo);
      if (b.vao) gl.deleteVertexArray(b.vao);
    }
    for (const b of this.zoneBatches) {
      gl.deleteBuffer(b.vbo);
      if (b.vao) gl.deleteVertexArray(b.vao);
    }
    for (const b of this.zoneSpinnerBatches) {
      gl.deleteBuffer(b.vbo);
      if (b.vao) gl.deleteVertexArray(b.vao);
    }
    this.zoneSpinnerBatches = [];
    this.zoneSpinnerAngle = 0;
    this.particleDrawer?.disposeMeshes();
    this.particleSystem = null;
    this.particleEnvironment = null;
    for (const t of this.textures.values()) gl.deleteTexture(t);
    this.batches = [];
    this.zoneBatches = [];
    this.textures.clear();
    this.modelTextureNames.clear();
    this._freeOverlay(this.collisionOverlay);
    this.collisionOverlay = null;
    // Navmesh is loaded async and keyed to the zone — clear on every model swap.
    this._freeOverlay(this.navmeshOverlay);
    this.navmeshOverlay = null;
    this._freeOverlay(this.zonePickOverlay);
    this.zonePickOverlay = null;
    this.zoneGizmo = null;
    this.setZoneMoveProxy(null);
    this.currentAnimation = null;
    this.animFrame = 0;
    this.model = model;
    this.pose = null;
    this.poseDirty = true;
    this.creationDriver = null;   // CPU animator for high-poly creation models
    this.creationCamera = null;   // authored camera track (see creation.js)
    this.clearActors();

    if (!model || !model.isRenderable) return;

    this.camera.setRangeFor(model.kind === 'zone' ? 'zone' : 'entity');

    if (model.skeleton.joints.length > MAX_JOINTS)
      console.warn(`skeleton has ${model.skeleton.joints.length} joints (max ${MAX_JOINTS})`);

    this.pose = new SkeletonPose(model.skeleton, model.jointOverrides ?? null);

    for (const tex of model.textures.values()) {
      const t = this.createTexture(tex);
      if (t) this.textures.set(tex.name, t);
    }
    // Names the *geometry* draws from — not every texture in the model's DATs.
    // An NPC animation pack is merged into the model for its clip but is mostly
    // particle art, and guarding all of `model.textures` would have made the
    // effect's own sheets unreachable (see attachEffectSystem).
    for (const group of model.meshGroups ?? []) {
      for (const piece of group.pieces ?? []) {
        if (piece.textureName) this.modelTextureNames.add(piece.textureName);
      }
    }
    for (const draw of model.zoneDraws ?? []) {
      if (draw.textureName) this.modelTextureNames.add(draw.textureName);
    }

    // Zones: ordered per-submesh draws, no skinning (see zoneModel.js).
    if (model.kind === 'zone') {
      for (const draw of model.zoneDraws ?? []) {
        const batch = this.buildZoneBatch(draw);
        if (batch) this.zoneBatches.push(batch);
      }
      this._rebuildZoneSpinners();
    }

    // Equipment occlusion (xim): a piece is dropped when another equipped mesh
    // declares an occludeType that hides this piece's display type — a helmet
    // hides hair, a sleeve hides the wrist, etc. Prevents the base skin/hair
    // clipping through worn gear.
    const occl = new Set(model.meshGroups.map((g) => g.occludeType ?? 0));
    for (const group of model.meshGroups) {
      for (const piece of group.pieces) {
        if (occludesDisplayType(piece.props?.displayType ?? 0, occl)) continue;
        const batch = this.buildBatch(group, piece);
        if (batch) this.batches.push(batch);
      }
    }
    // FFXI layers garment/skin geometry coincident and relies on authored draw
    // order (inner skin first, outer gear later) — the fixed-function pipeline
    // resolved ties deterministically. Under float depth the tie is per-pixel
    // luck, so skin patches win through the garment (belly/knee/wrist jaggies).
    // A tiny growing polygon offset makes each later batch win near-ties;
    // ~1 depth-ulp per batch, far below visible parallax.
    if (model.kind !== 'zone') {
      this.batches.forEach((b, i) => { b.depthNudge = -i; });
    }

    // Zone collision overlay (terrain-coloured); visibility via showCollision.
    if (model.kind === 'zone' && model.collision?.positions?.length) {
      this.collisionOverlay = this._buildOverlay(
        model.collision.positions,
        model.collision.colors,
      );
    }

    if (keepCamera) this.snapFloorToFeet();
    else this.fitCamera();
  }

  /**
   * Show a standalone spell/ability effect: no model, just its particles played
   * at the world origin. Textures come from the effect DAT and shared
   * ROM/0/0.DAT; `system` is a ParticleSystem already armed via playEffectRoutine.
   */
  setEffectScene(system, textures, keepCamera = false) {
    this.setModel(null);   // clears batches, textures and any prior particle system
    for (const tex of textures.values()) {
      const t = this.createTexture(tex);
      if (t) this.textures.set(tex.name, t);
    }
    this.effectMode = true;
    this.effectPaused = false;
    this.effectSpeed = 1;
    this.setParticleSystem(system, null);   // installs the camera adapter
    // Switching between effects leaves the camera fully alone (keepCamera). The
    // FIRST effect only normalizes what must be right (Y-up, entity ranges,
    // origin pivot) while keeping the user's zoom and angle — lining up a shot
    // on the empty stage survives picking an effect. F = full reframe.
    if (!keepCamera) this.frameEffect(true);
  }

  /**
   * Play a spell/ability on the current entity without wiping the mesh.
   * Zone pattern: model stays, then setParticleSystem. Entity draw path must
   * call _drawParticles (see draw()).
   */
  attachEffectSystem(system, textures) {
    this.particleDrawer?.disposeMeshes();
    const gl = this.gl;
    for (const tex of textures.values()) {
      // Never overwrite art the geometry draws with. `this.textures` is a
      // single registry shared by mesh draws and particles, and the old code
      // deleted the incumbent GL texture on a name clash. An NPC's effect
      // routines live in the model DAT itself, so the effect-side parse
      // returns that NPC's *body* textures under the same names — every one of
      // them got dropped and re-decoded by the particle path, repainting the
      // model.
      if (this.modelTextureNames.has(tex.name)) continue;
      const t = this.createTexture(tex);
      if (!t) continue;
      const prev = this.textures.get(tex.name);
      if (prev) gl.deleteTexture(prev);
      this.textures.set(tex.name, t);
    }
    this.effectMode = false;
    this.effectPaused = false;
    if (this.effectSpeed == null) this.effectSpeed = 1;
    this.setParticleSystem(system, null);
  }

  /**
   * Frame the world origin for standalone effect playback (no model bounds).
   * Measured particle extents for typical spells sit within DAT-space
   * X,Z ∈ [-3,3], Y ∈ [-4,1.5] around the target actor origin; the drawer maps
   * DAT → display as (−x,−y,z), so that vertical range lands at display Y ≈
   * [-1.5,4] (the effect rises *above* the origin on screen). Frame that box
   * with a little margin — larger AoE/summon effects can be zoomed out.
   */
  /**
   * @param {boolean} keepView keep the user's distance/yaw/pitch and only
   *   normalize what MUST be right for effects (Y-up camera, entity ranges,
   *   pivot on the origin). Used by the first effect load, so lining up a shot
   *   on the empty stage isn't thrown away the moment an effect is picked.
   *   Plain frameEffect() — F / Reset Camera — is the full known-good framing.
   */
  frameEffect(keepView = false) {
    const cam = this.camera;
    const prev = { distance: cam.distance, yaw: cam.yaw, pitch: cam.pitch };
    cam.setRangeFor('entity');
    // Particles are drawn in the Y-up display space (DISPLAY_ROT), exactly like
    // zone geometry — NOT the Y-down space entity models are drawn in.
    // setRangeFor('entity') gives the right near/far and zoom scale for a small
    // effect, but it also sets the FFXI Y-down camera (up = [0,-1,0]), which
    // renders the whole effect vertically mirrored: rising particles fall and
    // their trail hangs above them instead of below. Force the zone/editor Y-up
    // camera so the effect is drawn in the space its geometry was built for.
    cam.yUp = true;
    cam.fit([-4, -2.5, -4], [4, 5.5, 4]);
    // fit() targets the box centre (0, 1.5, 0), which put the orbit pivot above
    // the axes crossing — rotation felt anchored to a point that wasn't the
    // origin. Keep fit's distance/pitch (framed for effects that rise a few
    // units) but pivot exactly on 0,0,0, which is where every standalone
    // effect actually lives. (Cursor-zoom then deliberately walks the pivot
    // toward what you zoom at; F/reset comes back here.)
    cam.target = [0, 0, 0];
    if (keepView) {
      cam.yaw = prev.yaw;
      cam.pitch = prev.pitch;
      // Clamp into the entity range — a distance inherited from a zone's fly
      // camera can be thousands of units out.
      cam.distance = Math.min(Math.max(prev.distance, cam.minDistance), cam.maxDistance);
    }
  }

  /** Load/replace navmesh overlay (display-space positions). Pass null to clear. */
  setNavmesh(nav) {
    this._freeOverlay(this.navmeshOverlay);
    this.navmeshOverlay = null;
    if (!nav?.positions?.length) return;
    // Solid Unreal-style green if no per-vert colours supplied.
    const n = nav.positions.length / 3;
    const colors = nav.colors || (() => {
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        c[i * 3] = 0.05; c[i * 3 + 1] = 0.85; c[i * 3 + 2] = 0.25;
      }
      return c;
    })();
    this.navmeshOverlay = this._buildOverlay(nav.positions, colors);
  }

  /**
   * Build the procedural sky dome (xim SkyBoxMesh) from a skyDomeFromEnv config:
   * { radius, spokes, slices:[{elevation, color:[r,g,b]}], horizon:[r,g,b] }.
   * Upper hemisphere in display space (+Y up); horizon ring at elevation 0.
   * Pass null to clear.
   */
  setSkyDome(config) {
    const gl = this.gl;
    if (this.skyDome) {
      gl.deleteVertexArray(this.skyDome.vao);
      gl.deleteBuffer(this.skyDome.vbo);
      this.skyDome = null;
    }
    if (!config || !(config.radius > 0) || !config.spokes || (config.slices?.length ?? 0) < 2) return;

    const { radius, spokes, slices } = config;
    const data = [];
    const vert = (theta, slice) => {
      const a = 0.5 * Math.PI * slice.elevation;   // 0 = horizon, π/2 = zenith
      const y = radius * Math.sin(a);
      const r = radius * Math.cos(a);
      data.push(r * Math.cos(theta), y, r * Math.sin(theta), slice.color[0], slice.color[1], slice.color[2], 1);
    };
    for (let i = 0; i < slices.length - 1; i++) {
      const lo = slices[i], hi = slices[i + 1];
      for (let j = 0; j < spokes; j++) {
        const t0 = (2 * Math.PI * j) / spokes;
        const t1 = (2 * Math.PI * (j + 1)) / spokes;
        vert(t0, lo); vert(t1, lo); vert(t1, hi);
        vert(t0, lo); vert(t1, hi); vert(t0, hi);
      }
    }
    const arr = new Float32Array(data);
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
    gl.bindVertexArray(null);
    this.skyDome = { vao, vbo, count: arr.length / 7, horizon: config.horizon || null };
  }

  _freeOverlay(o) {
    if (!o) return;
    const gl = this.gl;
    if (o.vbo) gl.deleteBuffer(o.vbo);
    if (o.vao) gl.deleteVertexArray(o.vao);
  }

  /** Interleaved pos(3)+color(3) overlay mesh. */
  _buildOverlay(positions, colors) {
    const gl = this.gl;
    const n = positions.length / 3;
    if (n < 3) return null;
    const data = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const o = i * 6, p = i * 3;
      data[o] = positions[p]; data[o + 1] = positions[p + 1]; data[o + 2] = positions[p + 2];
      data[o + 3] = colors[p]; data[o + 4] = colors[p + 1]; data[o + 5] = colors[p + 2];
    }
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
    return { vao, vbo, count: n };
  }

  /**
   * Bone lines for the current pose — one segment per joint back to its parent.
   * pose.trans[i] is already the joint's world origin, in the same display space
   * the overlay shader draws in, so the segments need no transform of their own.
   *
   * Rebuilt every frame into one reused buffer: the pose moves, and a skeleton
   * is a couple of hundred vertices. Depth test off, so the rig reads as a whole
   * rather than burying its far side.
   *
   * Uses the joint's real parent, not pose.parentOverrides — those re-parent a
   * gripped weapon and would draw a bone that isn't anatomically there.
   */
  /**
   * Origin gizmo: the three world axes through (0,0,0) — X red, Y green, Z blue,
   * with the negative half dimmed so the sign is readable. Mainly for the
   * Effects view, where particles play at the origin and there is no other
   * geometry to judge position or scale against.
   *
   * Built once as unit-length lines and scaled to a fixed WORLD size, so it
   * behaves like an object in the scene — zooming in makes it bigger on screen,
   * zooming out shrinks it (a constant-screen-size gizmo felt wrong to use as a
   * scale reference). Entity/effect scenes get a few units; zones get a larger
   * one so it's findable at terrain scale.
   */
  _drawAxes(viewProj) {
    const gl = this.gl;

    if (!this.axesLines) {
      // 3 axes × 2 halves × 2 verts, each (x,y,z, r,g,b).
      const DIM = 0.28;
      const axis = (i, r, g, b) => {
        const p = [0, 0, 0]; p[i] = 1;
        const n = [0, 0, 0]; n[i] = -1;
        return [
          0, 0, 0, r, g, b, p[0], p[1], p[2], r, g, b,
          0, 0, 0, r * DIM, g * DIM, b * DIM, n[0], n[1], n[2], r * DIM, g * DIM, b * DIM,
        ];
      };
      const data = new Float32Array([
        ...axis(0, 1.0, 0.28, 0.30),   // X
        ...axis(1, 0.35, 0.95, 0.40),  // Y
        ...axis(2, 0.35, 0.55, 1.0),   // Z
      ]);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      gl.bindVertexArray(null);
      this.axesLines = { vao, vbo, count: data.length / 6 };
    }

    const s = this.camera.rangeKind === 'zone' ? 50 : 2;
    const scale = new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]);
    const mvp = mat4Multiply(viewProj, scale);

    gl.useProgram(this.overlayProgram);
    gl.uniformMatrix4fv(this.overlayUniforms.viewProj, false, mvp);
    gl.uniform1f(this.overlayUniforms.opacity, 1);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);   // a reference gizmo is no use once it's buried
    gl.depthMask(false);
    gl.bindVertexArray(this.axesLines.vao);
    gl.drawArrays(gl.LINES, 0, this.axesLines.count);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  }

  /**
   * World grid — the floor, as lines. XZ plane at the same height the textured
   * floor / axes sit (feet for entities, world 0 for zones/effects). Kept on
   * the true plane so the X/Z axes and the i=0 grid lines meet at one point
   * when zoomed in (a Y bias used to look like a gap at the origin). Z-fight
   * with a coplanar floor is handled via polygon offset, not a world offset.
   * Fixed world spacing (1 unit; 10 in zones). Every 5th line is brighter.
   */
  _drawGrid(viewProj) {
    const gl = this.gl;
    const kind = this.camera.rangeKind === 'zone' ? 'zone' : 'entity';

    if (!this.gridLines || this.gridLines.kind !== kind) {
      if (this.gridLines) {
        gl.deleteBuffer(this.gridLines.vbo);
        gl.deleteVertexArray(this.gridLines.vao);
      }
      const half = kind === 'zone' ? 500 : 10;
      const step = kind === 'zone' ? 10 : 1;
      const MINOR = 0.21, MAJOR = 0.38;
      const verts = [];
      for (let i = -half; i <= half; i += step) {
        const c = (i % (step * 5) === 0) ? MAJOR : MINOR;
        verts.push(i, 0, -half, c, c, c, i, 0, half, c, c, c);
        verts.push(-half, 0, i, c, c, c, half, 0, i, c, c, c);
      }
      const data = new Float32Array(verts);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      gl.bindVertexArray(null);
      this.gridLines = { vao, vbo, count: data.length / 6, kind };
    }

    // Same plane as the axes gizmo. Only lift off that plane when a coplanar
    // textured floor is actually drawn — otherwise axes/grid diverge at the
    // origin when zoomed (the old always-on 0.02 bias).
    const baseY = (this.effectMode || this.model?.kind === 'zone') ? 0 : (this.floorY ?? 0);
    // Zones bring their own ground: the Scene floor is not drawn under them.
    const floorOn = !!this.floor && this.model?.kind !== 'zone';
    // DAT space for entities (drawn via datVP) and display space for zones —
    // the lift follows which one this grid is in, not the camera.
    const datSpaceGrid = !this.effectMode && this.model?.kind !== 'zone';
    const y = baseY + (floorOn ? (datSpaceGrid ? -0.015 : 0.015) : 0);
    const move = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, y, 0, 1]);
    const mvp = mat4Multiply(viewProj, move);

    gl.useProgram(this.overlayProgram);
    gl.uniformMatrix4fv(this.overlayUniforms.viewProj, false, mvp);
    gl.uniform1f(this.overlayUniforms.opacity, 1);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);   // world object: hidden behind terrain/models
    gl.depthMask(false);
    gl.bindVertexArray(this.gridLines.vao);
    gl.drawArrays(gl.LINES, 0, this.gridLines.count);
    gl.bindVertexArray(null);
    gl.depthMask(true);
  }

  /**
   * Camera Sequencer route: the splined flythrough as a polyline, with a cross
   * and a short look-direction stub at every keyframe. Built here rather than
   * per frame — the panel calls this only when the sequence changes.
   *
   * `route` is { points: [[x,y,z]…], keys: [{ eye, forward }…] }, or null to
   * clear it.
   */
  setCameraPath(route) {
    if (!route || !(route.points?.length || route.keys?.length)) {
      this.cameraPath = null;
      return;
    }
    // Sized in world units like the axes gizmo, so the markers read as scene
    // scale rather than screen furniture.
    const arm = this.camera.rangeKind === 'zone' ? 2.5 : 0.18;
    const stub = arm * 4;
    const LINE = [1.0, 0.70, 0.26], KEY = [1, 1, 1], AIM = [0.35, 0.68, 1.0];
    const v = [];
    const push = (p, c) => v.push(p[0], p[1], p[2], c[0], c[1], c[2]);

    const pts = route.points ?? [];
    for (let i = 1; i < pts.length; i++) { push(pts[i - 1], LINE); push(pts[i], LINE); }
    for (const k of route.keys ?? []) {
      const e = k.eye;
      for (let ax = 0; ax < 3; ax++) {
        const a = e.slice(), b = e.slice();
        a[ax] -= arm; b[ax] += arm;
        push(a, KEY); push(b, KEY);
      }
      const f = k.forward;
      if (f) push(e, AIM), push([e[0] + f[0] * stub, e[1] + f[1] * stub, e[2] + f[2] * stub], AIM);
    }
    this.cameraPath = { data: new Float32Array(v), count: v.length / 6, dirty: true };
  }

  _drawCameraPath(viewProj) {
    const gl = this.gl;
    const path = this.cameraPath;
    if (!path?.count) return;

    if (!this.pathLines) {
      const vbo = gl.createBuffer();
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      gl.bindVertexArray(null);
      this.pathLines = { vao, vbo };
    }
    if (path.dirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pathLines.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, path.data, gl.DYNAMIC_DRAW);
      path.dirty = false;
    }

    gl.useProgram(this.overlayProgram);
    gl.uniformMatrix4fv(this.overlayUniforms.viewProj, false, viewProj);
    gl.uniform1f(this.overlayUniforms.opacity, 1);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);   // an authoring route is no use once terrain buries it
    gl.depthMask(false);
    gl.bindVertexArray(this.pathLines.vao);
    gl.drawArrays(gl.LINES, 0, path.count);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  }

  _drawSkeleton(viewProj) {
    const gl = this.gl;
    // Creation models don't pose the GPU skeleton (they are CPU-skinned against
    // their own combined body+head rig), so draw that rig instead — otherwise
    // the toggle shows a single dummy joint and tells you nothing about whether
    // the bones are animating.
    const creation = this.model?.kind === 'creation' ? this.creationDriver : null;
    if (creation?.worlds?.length) { this._drawCreationSkeleton(viewProj, creation); return; }
    const joints = this.pose?.skeleton?.joints;
    if (!joints?.length) return;

    if (!this.skeletonLines) {
      const vbo = gl.createBuffer();
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      gl.bindVertexArray(null);
      this.skeletonLines = { vao, vbo, data: new Float32Array(0) };
    }
    const lines = this.skeletonLines;

    // Root end dim, child end bright: the taper shows which way each bone runs.
    // Selected joint (Skeleton panel): parent→child edges + axis cross in orange.
    const hi = this.highlightJoint | 0;
    const needFloats = joints.length * 12 + 36; // +3 lines for highlight cross
    if (lines.data.length < needFloats) lines.data = new Float32Array(needFloats);
    const d = lines.data;
    const trans = this.pose.trans;
    let v = 0;
    for (let i = 0; i < joints.length; i++) {
      const parent = joints[i].parent;
      if (parent < 0 || !trans[parent] || !trans[i]) continue;
      const a = trans[parent], b = trans[i];
      const sel = i === hi || parent === hi;
      const r0 = sel ? 1.0 : 0.20, g0 = sel ? 0.45 : 0.55, b0 = sel ? 0.05 : 0.75;
      const r1 = sel ? 1.0 : 0.65, g1 = sel ? 0.55 : 0.95, b1 = sel ? 0.08 : 1.0;
      d[v] = a[0]; d[v + 1] = a[1]; d[v + 2] = a[2];
      d[v + 3] = r0; d[v + 4] = g0; d[v + 5] = b0;
      d[v + 6] = b[0]; d[v + 7] = b[1]; d[v + 8] = b[2];
      d[v + 9] = r1; d[v + 10] = g1; d[v + 11] = b1;
      v += 12;
    }
    if (hi >= 0 && hi < joints.length && trans[hi]) {
      const p = trans[hi];
      const s = 0.08;
      const oR = 1.0, oG = 0.5, oB = 0.05;
      d[v] = p[0] - s; d[v + 1] = p[1]; d[v + 2] = p[2];
      d[v + 3] = oR; d[v + 4] = oG; d[v + 5] = oB;
      d[v + 6] = p[0] + s; d[v + 7] = p[1]; d[v + 8] = p[2];
      d[v + 9] = oR; d[v + 10] = oG; d[v + 11] = oB;
      v += 12;
      d[v] = p[0]; d[v + 1] = p[1] - s; d[v + 2] = p[2];
      d[v + 3] = oR; d[v + 4] = oG; d[v + 5] = oB;
      d[v + 6] = p[0]; d[v + 7] = p[1] + s; d[v + 8] = p[2];
      d[v + 9] = oR; d[v + 10] = oG; d[v + 11] = oB;
      v += 12;
      d[v] = p[0]; d[v + 1] = p[1]; d[v + 2] = p[2] - s;
      d[v + 3] = oR; d[v + 4] = oG; d[v + 5] = oB;
      d[v + 6] = p[0]; d[v + 7] = p[1]; d[v + 8] = p[2] + s;
      d[v + 9] = oR; d[v + 10] = oG; d[v + 11] = oB;
      v += 12;
    }
    const count = v / 6;
    if (!count) return;

    gl.bindBuffer(gl.ARRAY_BUFFER, lines.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, v), gl.DYNAMIC_DRAW);
    gl.useProgram(this.overlayProgram);
    gl.uniformMatrix4fv(this.overlayUniforms.viewProj, false, viewProj);
    gl.uniform1f(this.overlayUniforms.opacity, 1);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.bindVertexArray(lines.vao);
    gl.drawArrays(gl.LINES, 0, count);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  }

  /**
   * The combined body+head rig of a creation model, drawn from the animator's
   * live world matrices. Body bones are blue, head bones amber, and any bone
   * whose own rotation never changes across the clip is drawn red — so "is
   * every bone animating?" is answerable by looking.
   */
  _drawCreationSkeleton(viewProj, driver) {
    const gl = this.gl;
    const bones = this.model.creation.bones;
    if (!this.skeletonLines) {
      const vbo = gl.createBuffer();
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      gl.bindVertexArray(null);
      this.skeletonLines = { vao, vbo, data: new Float32Array(0) };
    }
    const lines = this.skeletonLines;
    if (lines.data.length < bones.length * 12) lines.data = new Float32Array(bones.length * 12);
    const still = driver.staticBones;
    const d = lines.data;
    let v = 0;
    for (let i = 0; i < bones.length; i++) {
      const p = bones[i].parent;
      if (p < 0) continue;
      const a = driver.worlds[p];
      const b = driver.worlds[i];
      if (!a || !b) continue;
      // red = this bone's own rotation is constant for the whole clip
      const dead = still ? still[i] : 0;
      const head = bones[i].fileIndex === 1;
      const r = dead ? 1.0 : (head ? 0.95 : 0.20);
      const g = dead ? 0.15 : (head ? 0.70 : 0.55);
      const bl = dead ? 0.15 : (head ? 0.20 : 0.75);
      d[v] = a[9]; d[v + 1] = a[10]; d[v + 2] = a[11];
      d[v + 3] = r * 0.4; d[v + 4] = g * 0.4; d[v + 5] = bl * 0.4;
      d[v + 6] = b[9]; d[v + 7] = b[10]; d[v + 8] = b[11];
      d[v + 9] = r; d[v + 10] = g; d[v + 11] = bl;
      v += 12;
    }
    const count = v / 6;
    if (!count) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, lines.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, v), gl.DYNAMIC_DRAW);
    gl.useProgram(this.overlayProgram);
    gl.uniformMatrix4fv(this.overlayUniforms.viewProj, false, viewProj);
    gl.uniform1f(this.overlayUniforms.opacity, 1);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.bindVertexArray(lines.vao);
    gl.drawArrays(gl.LINES, 0, count);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  }

  /** opts.frame — resume at this frame (gear swap); otherwise start at 0. */
  setAnimation(clip, opts = {}) {
    const changed = clip !== this.currentAnimation;
    this.currentAnimation = clip;
    const len = clip?.lengthInFrames ?? 0;
    const frame = (opts.frame != null && len > 0) ? opts.frame % len : 0;
    this.animFrame = frame;
    if (this.pose) this.pose.evaluate(clip, frame);
    this.poseDirty = true;
    // Ground the floor on the pose that is actually shown. The load-time snap
    // runs in bind pose, whose straight legs hang lower than any animated one
    // — measured 0.07 below the idle soles on Iroha, which reads as the model
    // hovering. Clips start grounded, so frame 0 of the new clip is the
    // contact pose; a leap mid-clip then genuinely leaves the plane.
  }

  /** Scrub to a game-frame, clamped to the clip. Leaves play state alone, so
   *  dragging works whether or not the clip is running. */
  seekTo(frame) {
    if (!this.currentAnimation || !this.pose) return;
    const len = this.currentAnimation.lengthInFrames ?? 0;
    this.animFrame = Math.min(Math.max(frame, 0), len);
    this.pose.evaluate(this.currentAnimation, this.animFrame);
    this.poseDirty = true;
  }

  fitCamera() {
    if (!this.pose || !this.model) return;
    const bounds = this.restBounds() ?? this.computeBounds();
    if (!bounds) return;
    // Zones: zoneBounds are already display-space (−x,−y,z). Entities: mesh
    // bounds are DAT Y-down → map through ENTITY_ROT to match the draw pass.
    let min;
    let max;
    if (this.model.kind === 'zone') {
      min = bounds.min;
      max = bounds.max;
    } else {
      const a = toEntityPt(bounds.min);
      const b = toEntityPt(bounds.max);
      min = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
      max = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
      // Entities frame around the ORIGIN, not the mesh box centre: the look-at
      // lands on the axis gizmo (the orbit pivot, see getOrbitPivot) at screen
      // centre, and only the distance comes from the bounds — far enough that
      // the whole box fits, measured from the origin to its farthest corner
      // so a model that stands entirely above its feet is not cut off.
      let reach = 0;
      for (const x of [min[0], max[0]]) {
        for (const y of [min[1], max[1]]) {
          for (const z of [min[2], max[2]]) reach = Math.max(reach, Math.hypot(x, y, z));
        }
      }
      reach = Math.max(reach, 0.5);
      this.camera.fit([-reach, -reach, -reach], [reach, reach, reach], { distance: reach * 2.4 });
      this.snapFloorToFeet();
      return;
    }
    const canvas = this.canvas;
    const aspect = canvas?.clientWidth > 0 && canvas?.clientHeight > 0
      ? canvas.clientWidth / canvas.clientHeight
      : undefined;
    this.camera.fit(min, max, aspect ? { aspect } : undefined);
    // Model extents for the shadow cascade — the full model, weapons included,
    // so a raised blade still casts. The floor is not involved — it is fixed
    // at Y = 0.
    this.snapFloorToFeet();
  }

  /**
   * Display-space world position of one skeleton joint in the current pose.
   * Null when there is no pose or the index is past the end of the skeleton.
   *
   * `pose.trans[j]` is the joint's world translation in DAT space, the same
   * space `computeBounds` works in — so the display conversion is the one
   * `getOrbitPivot` uses, NOT the particle-space one `getActorAttachPosition`
   * applies (that negates X and Z; this negates Y and Z).
   */
  getJointPosition(index) {
    const tr = this.pose?.trans?.[index | 0];
    if (!tr) return null;
    return toEntityPt(tr);
  }

  /**
   * Display-space point an entity or effect orbits around: ALWAYS the world
   * origin, where the axis gizmo sits. Zones return null — free tumble about
   * the look-at stays as-is there.
   *
   * This used to be the rest-bounds centre, and that is the pivot that kept
   * "wandering" between NPC loads: a wyrm with its wings spread and tail out
   * has a mesh box whose centre is nowhere near its body, a gear swap or a
   * borrowed pack re-derives it from a different box, and the box itself
   * depends on which pose computeBounds last saw. The DAT origin is the one
   * fixed point every model shares (its feet/root), so a drag turns the model
   * about the axes on screen and the same spot every time.
   */
  getOrbitPivot() {
    if (this.effectMode) return [0, 0, 0];
    if (!this.model || this.model.kind === 'zone') return null;
    return [0, 0, 0];
  }

  /**
   * Particle-space origin for an actor-attached generator.
   *
   * The 0x05 header's attach values index the skeleton's **joint-reference
   * table**, not the joint array — `references[n]` gives a joint index plus a
   * position offset, and the result is that offset carried through the joint's
   * current world transform (xim SkeletonInstance.getStandardJointPosition:
   * `getJoint(ref).currentTransform.transform(ref.positionOffset)`).
   *
   * This used to approximate: attach values were read as opaque slot IDs and
   * mapped to a height fraction up the actor with XZ from the root. That is why
   * a weapon skill's wind-up sat at the waist — Eagle Eye Shot's source gens
   * ask for reference 11, which on Hume Male resolves to joint 80, the bow arm
   * (0.022 from the left hand; the height guess was 0.89 away).
   *
   * References 49-51 are not single points: they stand for the ring of eight
   * (13..20) around the actor, and the game picks the one nearest the incoming
   * source (xim getStandardJointExtended). With a single actor on stage there is
   * no incoming direction, so the front of the ring is used.
   *
   * DAT point D → particle P so DISPLAY_ROT(P) matches ENTITY_ROT(D) on screen:
   * P = (−Dx, Dy, −Dz). null → world origin (toggle off / no entity).
   */
  getActorAttachPosition(jointRef = 0, attach = null) {
    if (!this.attachFxToActor) return null;
    if (this.effectMode || !this.model || this.model.kind === 'zone' || !this.pose) {
      return null;
    }
    const refs = this.model.skeleton?.references ?? [];
    let idx = jointRef | 0;
    if (idx >= 49 && idx <= 51) idx = RING_REF_START;
    const ref = refs[idx];
    if (!ref) return null;

    const j = ref.index | 0;
    const tr = this.pose.trans?.[j];
    if (!tr) return null;
    const off = ref.offset ?? [0, 0, 0];
    const sc = this.pose.scale?.[j] ?? [1, 1, 1];
    const q = this.pose.rot?.[j];
    const local = [off[0] * sc[0], off[1] * sc[1], off[2] * sc[2]];
    const rot = q ? qRotate(q, local) : local;
    return new Vec3(-(tr[0] + rot[0]), tr[1] + rot[1], -(tr[2] + rot[2]));
  }

  /**
   * Particle-space position AND orientation of a joint reference, for a
   * generator that rides the hand every frame (AttachType.SourceActorWeapon —
   * the logging hatchet, the fishing rod: a 0x1F mesh the routine spawns into
   * the actor's grip). Same reference resolution as getActorAttachPosition;
   * the rotation is the joint's world quaternion taken into particle space,
   * which is DAT space mirrored on X and Z (M = diag(−1, 1, −1)). The mesh
   * itself is authored in the joint's own DAT-space frame, so the map is
   * R' = M·R — one change of space on the way out, not a conjugation. With
   * M·R·M the hatchet came out turned 180° in the hand, head where the butt
   * should be.
   */
  getActorAttachTransform(jointRef = 0, attach = null) {
    const position = this.getActorAttachPosition(jointRef, attach);
    if (!position) return null;
    const refs = this.model.skeleton?.references ?? [];
    let idx = jointRef | 0;
    if (idx >= 49 && idx <= 51) idx = RING_REF_START;
    const q = this.pose.rot?.[refs[idx]?.index | 0];
    const rotation = new Mat4();
    if (q) {
      rotation.setRotationFromQuaternionInPlace(q[0], q[1], q[2], q[3]);
      const m = new Mat4().scaleInPlace(new Vec3(-1, 1, -1));
      m.multiply(rotation, rotation);
    }
    return { position, rotation };
  }

  /** Reset the camera to frame whatever is on screen — a model/zone or a
   *  standalone effect (which has no model bounds to fit). */
  resetCamera() {
    if (this.effectMode) this.frameEffect();
    else this.fitCamera();
  }

  /**
   * Wheel zoom anchored at the cursor. Converts client coords to the NDC the
   * scene is actually drawn at — including the Explorer screen-offset shift the
   * projection carries (see render()), which moves the picture right; the ray
   * must be cast where the pixels are, not where unshifted NDC says.
   */
  zoomAt(clientX, clientY, wheelDelta) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) { this.camera.zoom(wheelDelta); return; }
    const dx = this.screenOffsetX ? (2 * this.screenOffsetX) / rect.width : 0;
    const ndcX = (((clientX - rect.left) / rect.width) * 2 - 1) - dx;
    const ndcY = -((((clientY - rect.top) / rect.height) * 2) - 1);
    this.camera.zoomAt(wheelDelta, ndcX, ndcY, rect.width / rect.height);
  }

  /**
   * Axis-aligned bounds of the skinned mesh in the current pose, plus a ground
   * ("feet") Y. FFXI is Y-down: larger Y = lower. Floor snaps to the lowest
   * mesh contact, not bone0 (root is often at the pelvis/origin and would bury
   * the legs — and a center-XZ heuristic missed wide stances / only-shoes bugs).
   *
   * Dangling weapon tips can sit slightly below the soles; we clamp how far
   * past the near-foot cluster the plane may drop so bosses don't hover.
   */
  /**
   * Bounds in the model's REST pose, computed once per model.
   *
   * `computeBounds` skins every vertex through the *current* pose, so it moves
   * with the animation — measured on Hume Male running Eagle Eye Shot the box
   * width swings from 0.38 to 0.72 across the clip. Framing off that meant
   * every press of F landed somewhere new. Framing and the orbit pivot use this
   * instead; the floor plane still tracks the live pose, because feet do move.
   */
  restBounds() {
    if (this._restBounds !== undefined) return this._restBounds;
    if (!this.pose || !this.model) return null;
    if (this.model.kind === 'zone') {
      this._restBounds = this.computeBounds();
      return this._restBounds;
    }
    const clip = this.currentAnimation;
    const frame = this.animFrame;
    this.pose.evaluate(null, 0);
    // Body only: equipped weapons (tagged at load) are left out so the frame
    // and orbit pivot sit on the character, not on a box a polearm doubles.
    this._restBounds = this.computeBounds({ bodyOnly: true });
    this.pose.evaluate(clip ?? null, clip ? frame : 0);
    this.poseDirty = true;
    return this._restBounds;
  }

  /**
   * @param {{bodyOnly?: boolean}} [opts] bodyOnly skips mesh groups tagged
   *   `isWeapon` (falls back to everything when nothing else is there, e.g. a
   *   weapon DAT viewed on its own).
   */
  computeBounds(opts = {}) {
    if (!this.pose || !this.model) return null;
    // Zones precompute bounds from sane placements — scanning millions of
    // baked verts is slow and a single wild coord used to blast the camera
    // to Z ≈ −1e7 (Ceizak Battlegrounds / ROM9/0/8.DAT).
    if (this.model.kind === 'zone' && this.model.zoneBounds) {
      const b = this.model.zoneBounds;
      return { min: b.min.slice(), max: b.max.slice(), footY: b.footY ?? b.min[1] };
    }
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const ys = [];
    const groups = this.model.meshGroups;
    const skipWeapons = !!opts.bodyOnly && groups.some((g) => !g.isWeapon);
    for (const group of groups) {
      if (skipWeapons && group.isWeapon) continue;
      const pools = [group.vertices];
      if (group.flippedVertices) pools.push(group.flippedVertices);
      for (const pool of pools) {
        for (const v of pool) {
          const p = this.pose.skinPosition(v);
          ys.push(p[1]);
          for (let i = 0; i < 3; i++) {
            if (p[i] < min[i]) min[i] = p[i];
            if (p[i] > max[i]) max[i] = p[i];
          }
        }
      }
    }
    if (!isFinite(min[0]) || ys.length === 0) return null;

    ys.sort((a, b) => a - b);
    const yMin = ys[0];
    const yMax = ys[ys.length - 1];
    const height = Math.max(yMax - yMin, 1e-4);
    // Near-sole cluster (top 5% of Y). Median of that cluster ≈ real foot contact.
    const soleStart = Math.floor(ys.length * 0.95);
    const soles = ys.slice(soleStart);
    const soleMid = soles[Math.floor(soles.length * 0.5)];
    // Allow the plane a little below the sole mid for heel/toe, but not more than
    // ~3% of body height (stops a long sword tip from dragging the floor down).
    const maxDrop = height * 0.03;
    const footY = Math.min(yMax, soleMid + maxDrop);

    return { min, max, footY };
  }

  /** Place the ground plane under the actor's feet (Y-down floor line). */
  /**
   * Model extents for the shadow cascade and the orbit/fit maths. Named for
   * what it used to do: the ground plane is fixed at Y = 0 now and this no
   * longer touches it.
   */
  snapFloorToFeet(bounds) {
    const b = bounds ?? this.computeBounds();
    if (!b) return;
    this.modelMaxY = b.footY;
    this.modelMin = b.min;
    this.modelMax = b.max;
  }

  // -------------------------------------------------------------------------

  /**
   * One zone draw → one VAO. Interleaved p0(3f) p1(3f) n(3f) uv(2f) color(4u8),
   * stride 12 floats + 4 bytes = 52 B. Draw state (blend/cull/zBias/discard) is
   * carried on the batch and applied per draw, in list order.
   */
  buildZoneBatch(draw) {
    const gl = this.gl;
    const n = draw.count;
    if (!n || n < 3) return null;

    const stride = 13;                 // floats (last slot holds the packed color)
    const data = new Float32Array(n * stride);
    const dataU8 = new Uint8Array(data.buffer);
    // Bounding sphere, accumulated here so the shadow pass can cull against its
    // cascade without a second pass over the vertices. Wind-blended positions
    // are included so a swaying submesh can't slip outside its own bounds.
    let lo0 = Infinity, lo1 = Infinity, lo2 = Infinity;
    let hi0 = -Infinity, hi1 = -Infinity, hi2 = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = i * stride, i3 = i * 3, i2 = i * 2, i4 = i * 4;
      data[o] = draw.positions[i3]; data[o + 1] = draw.positions[i3 + 1]; data[o + 2] = draw.positions[i3 + 2];
      data[o + 3] = draw.blendOffsets[i3]; data[o + 4] = draw.blendOffsets[i3 + 1]; data[o + 5] = draw.blendOffsets[i3 + 2];
      for (let k = 0; k < 3; k++) {
        const p = data[o + k], q = p + data[o + 3 + k];
        const mn = p < q ? p : q, mx = p < q ? q : p;
        if (k === 0) { if (mn < lo0) lo0 = mn; if (mx > hi0) hi0 = mx; }
        else if (k === 1) { if (mn < lo1) lo1 = mn; if (mx > hi1) hi1 = mx; }
        else { if (mn < lo2) lo2 = mn; if (mx > hi2) hi2 = mx; }
      }
      data[o + 6] = draw.normals[i3]; data[o + 7] = draw.normals[i3 + 1]; data[o + 8] = draw.normals[i3 + 2];
      data[o + 9] = draw.uvs[i2]; data[o + 10] = draw.uvs[i2 + 1];
      const b = o * 4 + 12 * 4;
      dataU8[b] = draw.colors[i4];
      dataU8[b + 1] = draw.colors[i4 + 1];
      dataU8[b + 2] = draw.colors[i4 + 2];
      dataU8[b + 3] = draw.colors[i4 + 3];
    }

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const bytes = stride * 4;
    const attr = (loc, size, offsetFloats) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, bytes, offsetFloats * 4);
    };
    attr(0, 3, 0); attr(1, 3, 3); attr(2, 3, 6); attr(3, 2, 9);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 4, gl.UNSIGNED_BYTE, true, bytes, 12 * 4);
    gl.bindVertexArray(null);

    return {
      vao,
      vbo,
      count: n,
      texture: draw.textureName ? this.textures.get(draw.textureName) ?? null : null,
      layer: draw.layer || 'world',
      blend: !!draw.blend,
      noCull: !!draw.noCull,
      discard: draw.discard || 0,
      wind: !!draw.wind,
      zBias: draw.zBias || 0,
      weather: draw.weather ?? null,     // sky cloud layer this belongs to (or null)
      celestial: !!draw.celestial,       // sun/moon/star — always shown
      positioned: !!draw.positioned,     // sun/moon disc — needs sky placement (skipped for now)
      uvScroll: draw.uvScroll || null,   // cloud UV drift from 0x05 generators
      center: [(lo0 + hi0) / 2, (lo1 + hi1) / 2, (lo2 + hi2) / 2],
      radius: Math.hypot(hi0 - lo0, hi1 - lo1, hi2 - lo2) / 2,
    };
  }

  buildBatch(group, piece, texMap = null) {
    const gl = this.gl;
    const pool = piece.mirrored ? group.flippedVertices : group.vertices;
    if (!pool || piece.corners.length < 3) return null;

    const stride = 19;   // floats per vertex (color packed as 4 u8 in the last slot)
    const data = new Float32Array(piece.corners.length * stride);
    const dataU8 = new Uint8Array(data.buffer);

    for (let i = 0; i < piece.corners.length; i++) {
      const c = piece.corners[i];
      const v = pool[Math.min(c.vi, pool.length - 1)];
      const o = i * stride;
      data[o] = v.p0[0]; data[o + 1] = v.p0[1]; data[o + 2] = v.p0[2];
      data[o + 3] = v.p1[0]; data[o + 4] = v.p1[1]; data[o + 5] = v.p1[2];
      data[o + 6] = v.n0[0]; data[o + 7] = v.n0[1]; data[o + 8] = v.n0[2];
      data[o + 9] = v.n1[0]; data[o + 10] = v.n1[1]; data[o + 11] = v.n1[2];
      const single = v.joint1 < 0;
      data[o + 12] = single ? 1 : v.w0;
      data[o + 13] = single ? 0 : v.w1;
      data[o + 14] = Math.min(v.joint0, MAX_JOINTS - 1);
      data[o + 15] = single ? 0 : Math.min(v.joint1, MAX_JOINTS - 1);
      data[o + 16] = c.u;
      data[o + 17] = c.v;
      // color: BGRA u32 -> RGBA bytes (normalized in shader)
      const b = i * stride * 4 + 18 * 4;
      dataU8[b] = (c.color >>> 16) & 0xff;
      dataU8[b + 1] = (c.color >>> 8) & 0xff;
      dataU8[b + 2] = c.color & 0xff;
      dataU8[b + 3] = (c.color >>> 24) & 0xff;
    }

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    // Creation pieces are re-skinned on the CPU and re-uploaded per animation
    // frame (see creation.js CreationAnimator), so their buffers stay dynamic.
    gl.bufferData(gl.ARRAY_BUFFER, data, piece.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const bytes = stride * 4;
    const attr = (loc, size, offsetFloats) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, bytes, offsetFloats * 4);
    };
    attr(0, 3, 0); attr(1, 3, 3); attr(2, 3, 6); attr(3, 3, 9);
    attr(4, 2, 12); attr(5, 2, 14); attr(6, 2, 16);
    gl.enableVertexAttribArray(7);
    gl.vertexAttribPointer(7, 4, gl.UNSIGNED_BYTE, true, bytes, 18 * 4);

    // Wireframe edge list (fallback when WEBGL_polygon_mode is missing).
    const isStrip = piece.topology === 'strip';
    const wireIdx = buildWireIndices(piece.corners.length, isStrip);
    let wireEbo = null;
    if (wireIdx) {
      wireEbo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wireEbo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, wireIdx, gl.STATIC_DRAW);
    }
    gl.bindVertexArray(null);

    // Entity pieces have no alphaMode → 0 (two-pass). Zone pieces set opaque/cutout/blend.
    const alphaMode = piece.alphaMode === 'opaque' ? 1
      : piece.alphaMode === 'cutout' ? 2
        : piece.alphaMode === 'blend' ? 3
          : 0;

    const batch = {
      vao,
      vbo,
      wireEbo,
      wireCount: wireIdx ? wireIdx.length : 0,
      mode: isStrip ? gl.TRIANGLE_STRIP : gl.TRIANGLES,
      count: piece.corners.length,
      texture: piece.textureName ? (texMap ?? this.textures).get(piece.textureName) ?? null : null,
      alphaMode,
      layer: piece.layer || 'world', // 'world' | 'env' (sky/water)
      sourcePath: group.sourcePath || null,
    };
    if (piece.dynamic) {
      // The animator needs the CPU-side copy and the corner -> pool-vertex map
      // to rewrite positions/normals in place.
      batch.data = data;
      batch.corners = Uint32Array.from(piece.corners, (c) => c.vi);
      batch.creationGroup = piece.creationGroup;
    }
    return batch;
  }

  createTexture(image) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    if (image.format === 'rgba32') {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, image.width, image.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, image.data);
    } else if (this.s3tc) {
      const fmt = image.format === 'dxt1'
        ? this.s3tc.COMPRESSED_RGBA_S3TC_DXT1_EXT
        : this.s3tc.COMPRESSED_RGBA_S3TC_DXT3_EXT;
      gl.compressedTexImage2D(gl.TEXTURE_2D, 0, fmt, image.width, image.height, 0, image.data);
    } else {
      const rgba = image.format === 'dxt1'
        ? decodeDxt(image.data, image.width, image.height, 1)
        : decodeDxt(image.data, image.width, image.height, 3);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, image.width, image.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    }
    return tex;
  }

  // -------------------------------------------------------------------------

  /**
   * Size the drawing buffer. `renderHeight` 0 (Graphics > Window Size) matches
   * the element at native DPR; anything else renders at that many rows and lets
   * the browser scale the result to the window — supersampling above the window
   * height, upscaling below it.
   *
   * The width always follows the element's aspect rather than the picked
   * resolution's, because #canvas is fixed inset:0 under the panels: a buffer
   * with its own aspect would either stretch the picture or letterbox it out
   * from under the UI. Everything that maps pointers to the scene already works
   * off getBoundingClientRect (CSS px), so it is unaffected either way.
   *
   * Hard-capped: a runaway size (e.g. 33M×33M from a bad aspect or corrupt
   * state) OOMs the tab and collapses the UI. Prefer the window CSS box always.
   */
  resize() {
    // Size from the VIEWPORT, never from the canvas's own layout box.
    //
    // #canvas is `position: fixed; inset: 0`, so the viewport IS its intended
    // size — and reading it here is what makes this loop-proof. Deriving the
    // buffer from clientWidth is self-referential: a canvas with no effective
    // CSS size lays out at its *attribute* size, so buffer → layout → buffer
    // feeds back and grows every frame until it pins at maxDim. By then the
    // element overflows the window and you see one corner of a huge render,
    // which reads as the view zooming in. Reading window.innerWidth cannot
    // feed back, so the loop is impossible no matter what broke the CSS.
    const cw = Math.max(window.innerWidth || this.canvas.clientWidth || 0, 1);
    const ch = Math.max(window.innerHeight || this.canvas.clientHeight || 0, 1);
    // If the element is laying out far larger than the window, the #canvas rule
    // is not in effect. The size is recoverable here; the cause is not, so say
    // it once with the numbers rather than silently papering over it.
    if (!this._sizeWarned) {
      const lw = this.canvas.clientWidth || 0;
      const lh = this.canvas.clientHeight || 0;
      if (lw > cw * 1.5 || lh > ch * 1.5) {
        this._sizeWarned = true;
        console.warn(
          `[renderer] #canvas lays out at ${lw}x${lh} but the window is ${cw}x${ch} — `
          + 'the "#canvas { position: fixed; inset: 0 }" rule is not applying. '
          + 'Sizing from the window instead; expect the element to overflow until that is fixed.',
        );
      }
    }
    // Prefer a real GL cap when available; stay well under typical browser limits.
    let maxDim = 8192;
    try {
      const glMax = this.gl?.getParameter?.(this.gl.MAX_RENDERBUFFER_SIZE);
      if (glMax > 0) maxDim = Math.min(8192, glMax);
    } catch { /* context lost */ }

    let w, h;
    const rh = Number(this.renderHeight);
    if (Number.isFinite(rh) && rh > 0 && rh <= 4320) {
      h = Math.round(rh);
      w = Math.round(h * (cw / ch));
    } else {
      const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 0.5), 3);
      w = Math.round(cw * dpr);
      h = Math.round(ch * dpr);
    }
    w = Math.min(Math.max(w, 1), maxDim);
    h = Math.min(Math.max(h, 1), maxDim);
    // Keep aspect if we had to clamp one side.
    if (w === maxDim || h === maxDim) {
      const aspect = cw / ch;
      if (w / h > aspect) w = Math.max(1, Math.round(h * aspect));
      else h = Math.max(1, Math.round(w / aspect));
    }

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  render(dtSeconds) {
    const gl = this.gl;
    this.resize();

    if (this.playing && this.currentAnimation && this.pose) {
      // 30 game-frames/sec, scaled — unless the clip declares its own rate
      // (high-poly creation motions run at ~30 or ~61 depending on encoding).
      this.animFrame += dtSeconds * (this.currentAnimation.fps ?? 30) * this.playbackSpeed;
      const len = this.currentAnimation.lengthInFrames;
      // Guard the same way setAnimation and seekTo do. A clip can legitimately
      // arrive with length 0 (mergeAnimationParts over all-zero-length parts),
      // and `animFrame %= 0` is NaN — which then feeds evaluate() every frame
      // from here on, so the model freezes or vanishes with nothing logged.
      if (!(len > 0)) {
        this.animFrame = 0;
      } else if (this.animFrame > len) {
        if (this.animLoop === false) {
          // Park on the last frame rather than wrapping, and hand the caller
          // the transport change so its Play/Pause button agrees with reality.
          this.animFrame = len;
          this.playing = false;
          this.onAnimEnd?.();
        } else {
          this.animFrame %= len;
          // Loop point: whoever is pairing an effect with this clip re-fires it
          // here, so the two stay locked instead of drifting on separate clocks.
          this.onAnimLoop?.();
        }
      }
      this.pose.evaluate(this.currentAnimation, this.animFrame);
      this.poseDirty = true;
    }
    // Creation models animate on the CPU: pick up the playhead every frame
    // (advance above, or a seek while paused) — apply() no-ops on a repeat.
    if (this.creationDriver && this.model?.kind === 'creation') {
      this.creationDriver.apply(this.animFrame);
      // The authored camera track, when enabled: the creation screen's motion
      // is mostly camera work, so this is what makes the sequence read right.
      if (this.creationCamera) {
        const shot = this.creationCamera.at(this.creationDriver.rangeStart + this.animFrame);
        const cam = this.camera;
        cam.mode = 'fly';
        cam.pos = shot.eye;
        cam.yaw = Math.atan2(shot.forward[0], shot.forward[2]);
        const horiz = Math.hypot(shot.forward[0], shot.forward[2]) || 1e-6;
        cam.pitch = cam.yUp ? Math.atan2(shot.forward[1], horiz) : Math.atan2(-shot.forward[1], horiz);
        cam.fovDegrees = this.creationCamera.fovDegrees;
      }
    }

    // xim WindFactor.update: step 1/60 per game frame (30fps) → 2s per leg.
    this.windFactor += dtSeconds * 0.5 * this.windDir;
    if (this.windFactor >= 1) { this.windFactor = 1; this.windDir = -1; }
    else if (this.windFactor <= 0) { this.windFactor = 0; this.windDir = 1; }

    if (this.model?.kind === 'zone' && this.model.zoneSpinners?.length) {
      this.zoneSpinnerAngle += dtSeconds;
      this._rebuildZoneSpinners();
    }

    this._updateEnvironment(dtSeconds);
    this._advanceActors(dtSeconds);

    const aspect = this.canvas.width / this.canvas.height;
    // The Explorer panel overlays the left of the canvas, so the scene is nudged
    // right in NDC to stay centred in the visible area. The shift is folded into
    // the projection rather than the combined view-projection so that *every*
    // pass shares it — a pass that rebuilds its own projection (the particle
    // drawer needs proj and view separately) would otherwise draw its geometry
    // offset from the world. Because the offset is in NDC, the resulting
    // mismatch grows with depth, which reads on screen as parallax.
    let proj = this.camera.projectionMatrix(aspect);
    if (this.screenOffsetX) {
      // screenOffsetX is CSS px, so divide by the displayed width, not the
      // drawing buffer's — the two part company once Graphics > Render
      // Resolution pins the buffer to a fixed height. Same form as zoomAt().
      // Window rather than clientWidth, matching resize(): identical while the
      // canvas is pinned to the viewport, and still right if it ever is not.
      const dx = (2 * this.screenOffsetX)
        / Math.max(window.innerWidth || this.canvas.clientWidth || 1, 1);
      const shift = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, dx, 0, 0, 1]);
      proj = mat4Multiply(shift, proj);
    }
    this.projMatrix = proj;
    const viewProj = mat4Multiply(proj, this.camera.viewMatrix());
    const eye = this.camera.eye;
    // Entity geometry (mesh, floor, skeleton, helpers) is raw DAT space, so it
    // renders through DISPLAY_ROT while the camera stays Y-up like everywhere
    // else. `datEye` is the camera in DAT space, for the fog distance those
    // shaders measure against their raw vWorld.
    const datVP = mat4Multiply(viewProj, ENTITY_ROT_M);
    const datEye = toEntityPt(eye);
    const fogFar = this.fog.enabled ? this.fog.far : -1;

    // Cast shadows: fill the depth map from the sun before anything reads it.
    // Owns its own framebuffer and viewport, so it runs before the backbuffer
    // is set up below.
    this._renderShadowMap(eye);

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    // When the sky dome is shown, clear to its horizon colour so the background
    // below the horizon ring (and beyond the dome radius) matches seamlessly.
    const skyOn = this.model?.kind === 'zone' && this.showSkybox && this.skyDome;
    const cc = skyOn && this.skyDome.horizon ? this.skyDome.horizon : this.clearColor;
    gl.clearColor(cc[0], cc[1], cc[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Optional background image — CSS background-size: cover. Aspect ratio is
    // kept and the viewport is always filled, so the overflowing axis is
    // cropped rather than bordered; `contain` here left the clear colour
    // showing as bars down the side of the canvas.
    // Zones fill the frame themselves (terrain + sky dome), so the Scene
    // background image and floor stay parked until an entity is back.
    const zoneUp = this.model?.kind === 'zone';
    if (this.bgImage?.texture && !zoneUp) {
      const img = this.bgImage;
      const canvasAspect = this.canvas.width / Math.max(this.canvas.height, 1);
      const imgAspect = (img.width || 1) / Math.max(img.height || 1, 1);
      // Fraction of the texture that stays visible on each axis. Both are <= 1,
      // so the sampler never reads outside [0,1] and CLAMP_TO_EDGE can't smear
      // an edge pixel across the gap — which is what inverting these does.
      let sx = 1;
      let sy = 1;
      if (canvasAspect > imgAspect) sy = imgAspect / canvasAspect;  // crop top/bottom
      else sx = canvasAspect / imgAspect;                           // crop left/right
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.useProgram(this.bgProgram);
      gl.uniform1i(this.bgUniforms.texture, 0);
      gl.uniform2f(this.bgUniforms.coverScale, sx, sy);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, img.texture);
      gl.bindVertexArray(this.bgVao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.depthMask(true);
    }

    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    // Floor first (writes depth so the model occludes correctly). Flat Floor
    // wins over a loaded ground texture while it is on, and stands in for one
    // when none is loaded.
    const flatOn = this.flatFloor.on && !!this.flatFloorTex;
    if ((this.floor || flatOn) && !zoneUp) {
      gl.useProgram(this.floorProgram);
      gl.uniformMatrix4fv(this.floorUniforms.viewProj, false, datVP);
      gl.uniform1f(this.floorUniforms.tile, this.floorTile);
      gl.uniform1f(this.floorUniforms.y, this.floorY);
      gl.uniform1i(this.floorUniforms.texture, 0);
      gl.uniform3fv(this.floorUniforms.cameraPos, datEye);
      gl.uniform3fv(this.floorUniforms.fogColor, this.fog.color);
      gl.uniform2f(this.floorUniforms.fogRange, this.fog.near, fogFar);
      gl.uniform3fv(this.floorUniforms.sunDir, this.shadowSunDir);
      gl.uniform2f(this.floorUniforms.fadeRadius, this.floorFade.inner, this.floorFade.outer);
      this._bindShadowUniforms(this.floorUniforms);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, flatOn ? this.flatFloorTex : this.floor.texture);
      // The fade ring needs blending against the background drawn above it.
      // Depth writes stay on so the model still occludes correctly where the
      // floor is solid; the faded ring discards rather than writing depth.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(this.floorVao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }

    // Zones take the dedicated ordered path (xim ZoneDrawer.drawZoneObjects).
    if (this.model?.kind === 'zone') {
      // Sky is the 0x2F gradient dome plus particles (clouds, sun, moon, stars),
      // exactly as xim does it — there is no separate textured sky-shell pass.
      if (this.showSkybox) this._drawSky(viewProj, eye);
      this._drawZone(viewProj, eye, fogFar);
      this._drawZoneSpinners(viewProj, eye, fogFar);
      this._drawActors(viewProj, eye, fogFar);
      this._drawZoneMoveProxy(viewProj, eye, fogFar);
      this._drawParticles();
      this._drawOverlay(viewProj, this.showCollision ? this.collisionOverlay : null, this.collisionOpacity);
      this._drawOverlay(viewProj, this.showNavmesh ? this.navmeshOverlay : null, this.navmeshOpacity);
      if (!this.camera?.sequenceLock) {
        this._drawZonePickOverlay(viewProj);
        this._drawActorHover(viewProj);
        this._drawActorGizmo(viewProj);
      }
      if (this.showSoundMarkers) this._drawSoundMarkers(viewProj);
      if (this.showGrid) this._drawGrid(viewProj);
      if (this.showAxes) this._drawAxes(viewProj);
      if (this.cameraPath) this._drawCameraPath(viewProj);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);   // surfaces may leave REVERSE_SUBTRACT set
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(0, 0);
      gl.bindVertexArray(null);
      return;
    }

    // Standalone spell/ability effect: just its particles at the world origin,
    // no model geometry behind them. Drawn before the model early-outs below,
    // which would otherwise skip it (there is no pose).
    if (this.effectMode && this.particleSystem) {
      if (this.showGrid) this._drawGrid(viewProj);   // before particles: they blend over it
      this._drawParticles();
      if (this.showAxes) this._drawAxes(viewProj);
      if (this.cameraPath) this._drawCameraPath(viewProj);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.disable(gl.CULL_FACE);
      gl.bindVertexArray(null);
      return;
    }

    // Helpers: display-space (viewProj) on the empty/effect stage and zones.
    // Entity mesh is drawn through datVP (ENTITY_ROT); keep skeleton helpers in
    // the same space as the skinned mesh when a pose exists.
    const helpersVP = (this.pose && this.model && this.model.kind !== 'zone')
      ? datVP
      : viewProj;
    const drawHelpers = () => {
      if (this.showGrid) this._drawGrid(helpersVP);
      if (this.showAxes) this._drawAxes(helpersVP);
      if (this.cameraPath) this._drawCameraPath(helpersVP);
    };
    if (!this.pose) { drawHelpers(); return; }
    // "Just the bones": the rig replaces the mesh rather than overlaying it.
    if (this.showSkeleton) {
      this._drawSkeleton(datVP);
      this._drawParticles();
      drawHelpers();
      return;
    }
    if (this.batches.length === 0) {
      this._drawParticles();
      drawHelpers();
      return;
    }

    gl.useProgram(this.program);
    this._syncPose();
    gl.uniform4fv(this.uniforms.rot, this.rotArray);
    gl.uniform4fv(this.uniforms.trans, this.transArray);
    gl.uniform4fv(this.uniforms.scale, this.scaleArray);
    gl.uniformMatrix4fv(this.uniforms.viewProj, false, datVP);
    gl.uniformMatrix4fv(this.uniforms.model, false, IDENTITY_M);
    gl.uniform3fv(this.uniforms.lightDir, this.camera.forward);
    gl.uniform1i(this.uniforms.texture, 0);
    gl.uniform3fv(this.uniforms.cameraPos, datEye);
    gl.uniform3fv(this.uniforms.fogColor, this.fog.color);
    gl.uniform2f(this.uniforms.fogRange, this.fog.near, fogFar);

    gl.activeTexture(gl.TEXTURE0);
    const alphaOn = !!this.showAlpha;
    gl.uniform1f(this.uniforms.showAlpha, alphaOn ? 1 : 0);
    // Zones use xim terrain lighting (ambient + sun + moon from 0x2F env).
    const isZone = this.model?.kind === 'zone';
    gl.uniform1f(this.uniforms.terrainLit, isZone ? 1 : 0);
    if (isZone) {
      const L = this._zoneLightUniforms();
      gl.uniform3fv(this.uniforms.ambient, L.ambient);
      gl.uniform3fv(this.uniforms.sunDir, L.sunDir);
      gl.uniform3fv(this.uniforms.sunColor, L.sunColor);
      gl.uniform3fv(this.uniforms.moonDir, L.moonDir);
      gl.uniform3fv(this.uniforms.moonColor, L.moonColor);
    } else {
      gl.uniform3fv(this.uniforms.ambient, [1, 1, 1]);
      // Shadows on: the entity key light becomes the shadow sun so the shading
      // and the cast shadow agree (uSunLit branch in the fragment shader).
      gl.uniform3fv(this.uniforms.sunDir, this.shadowSunDir);
      gl.uniform3fv(this.uniforms.sunColor, [0, 0, 0]);
      gl.uniform3fv(this.uniforms.moonDir, [0, -1, 0]);
      gl.uniform3fv(this.uniforms.moonColor, [0, 0, 0]);
    }
    gl.uniform1f(this.uniforms.sunLit, !isZone && this.shadowActive ? 1 : 0);
    gl.uniform1f(this.uniforms.lightGain, this.lightGain ?? 1);
    gl.uniform1i(this.uniforms.pointCount, 0);
    gl.uniform3f(this.uniforms.extraAmbient, 0, 0, 0);
    this._bindShadowUniforms(this.uniforms);

    const usePolyMode = this.showWireframe && this.polygonMode;
    if (usePolyMode) {
      this.polygonMode.polygonModeWEBGL(gl.FRONT_AND_BACK, this.polygonMode.LINE_WEBGL);
    }

    // pred filters batches; alphaMode is set per draw (zone opaque/cutout/blend).
    // depthNudge: later batches pull ~1 depth-ulp/batch toward the viewer so
    // outer garment layers deterministically win ties against the skin under
    // them (see setModel).
    const showEnv = !!this.showSkybox;
    gl.enable(gl.POLYGON_OFFSET_FILL);
    const drawBatches = (asWire, pred) => {
      for (const batch of this.batches) {
        if ((batch.layer === 'sky' || batch.layer === 'water') && !showEnv) continue;
        if (!this._batchSourceVisible(batch)) continue;
        if (pred && !pred(batch)) continue;
        gl.uniform1i(this.uniforms.alphaMode, batch.alphaMode ?? 0);
        gl.polygonOffset(0, batch.depthNudge ?? 0);
        gl.bindTexture(gl.TEXTURE_2D, this.showTextures && batch.texture ? batch.texture : this.whiteTexture);
        gl.bindVertexArray(batch.vao);
        if (asWire && batch.wireEbo) {
          gl.drawElements(gl.LINES, batch.wireCount, gl.UNSIGNED_INT, 0);
        } else {
          gl.drawArrays(batch.mode, 0, batch.count);
        }
      }
    };

    const wireFallback = this.showWireframe && !usePolyMode;
    const modeOf = (b) => b.alphaMode ?? 0;

    // Solid depth-write pass: entity batches + zone opaque/cutout (not blend).
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.uniform1i(this.uniforms.alphaPass, 0);
    drawBatches(wireFallback, (b) => modeOf(b) !== 3);

    // Translucent pass: entity membrane/glass (mode 0) + zone soft-edge/water
    // blend (mode 3). Depth-test ON, depth-write OFF so soft terrain edges
    // composite over the opaque base instead of z-fighting into hard rectangles.
    if (alphaOn && !wireFallback) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.uniform1i(this.uniforms.alphaPass, 1);
      drawBatches(false, (b) => {
        const m = modeOf(b);
        return m === 0 || m === 3;
      });
    }

    if (usePolyMode) {
      this.polygonMode.polygonModeWEBGL(gl.FRONT_AND_BACK, this.polygonMode.FILL_WEBGL);
    }

    // Spell/ability on this actor (attachEffectSystem) — same composite order as zones.
    this._drawParticles();

    // Skeleton panel bone pick: draw rig overlay (orange highlight) without
    // forcing "skeleton only" mode.
    if (this.highlightJoint >= 0) this._drawSkeleton(datVP);

    // Debug overlays on top (collision terrain colours, UE-green navmesh).
    this._drawOverlay(viewProj, this.showCollision ? this.collisionOverlay : null, this.collisionOpacity);
    this._drawOverlay(viewProj, this.showNavmesh ? this.navmeshOverlay : null, this.navmeshOpacity);
    if (this.showGrid) this._drawGrid(viewProj);
    if (this.showAxes) this._drawAxes(viewProj);
    if (this.cameraPath) this._drawCameraPath(viewProj);

    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(0, 0);
    gl.bindVertexArray(null);
  }

  // --- Cast shadows --------------------------------------------------------

  // --- Zone actors ----------------------------------------------------------

  /**
   * Add an actor standing at `pos` (display space; y = ground). It shows as
   * a placeholder figure until setActorModel() gives it a mesh.
   */
  addActor(id, pos, rot = null) {
    this.removeActor(id);
    const actor = {
      id,
      pos: [pos[0], pos[1], pos[2]],
      rot: rot ? Float32Array.from(rot) : new Float32Array(MAT3_IDENTITY),
      scale: 1,
      light: null,
      model: null,
      pose: null,
      batches: [],
      textures: new Map(),
      rotArray: new Float32Array(MAX_JOINTS * 4),
      transArray: new Float32Array(MAX_JOINTS * 4),
      scaleArray: new Float32Array(MAX_JOINTS * 4),
      poseDirty: true,
      currentAnimation: null,
      animFrame: 0,
      playing: true,
      loop: true,
      speed: 1,
      visible: true,
      placeholder: null,
      color: [0.42, 0.72, 1.0],
      modelMatrix: new Float32Array(16),
      fx: null,   // { system } — the NPC's own effect routine, see setActorEffect
    };
    this._syncActorTransform(actor);
    this.actors.push(actor);
    return actor;
  }

  getActor(id) {
    return this.actors.find((a) => a.id === id) || null;
  }

  removeActor(id) {
    const i = this.actors.findIndex((a) => a.id === id);
    if (i < 0) return;
    this._freeActorGeometry(this.actors[i]);
    this.actors.splice(i, 1);
  }

  clearActors() {
    for (const a of this.actors) this._freeActorGeometry(a);
    this.actors = [];
    this.actorGizmo = null;
  }

  _freeActorGeometry(actor) {
    const gl = this.gl;
    for (const b of actor.batches) {
      gl.deleteBuffer(b.vbo);
      if (b.wireEbo) gl.deleteBuffer(b.wireEbo);
      if (b.vao) gl.deleteVertexArray(b.vao);
    }
    actor.batches = [];
    for (const t of actor.textures.values()) gl.deleteTexture(t);
    actor.textures.clear();
    this._freeOverlay(actor.placeholder);
    actor.placeholder = null;
    actor.fx?.system?.clearEffect();
    actor.fx = null;
  }

  _syncActorTransform(actor) {
    actorModelMatrix(actor.pos, actor.rot, actor.modelMatrix, actor.scale ?? 1);
    if (actor.light) {
      // Light marker: a small sphere in the light's colour, hovering over the spot.
      this._freeOverlay(actor.placeholder);
      const fig = lightMarkerFigure([actor.pos[0], actor.pos[1] + 0.6, actor.pos[2]], actor.light.color || [1, 1, 1]);
      if (actor.light.type === 'spot') {
        // A stub along the spot axis (actor -Y) so the aim is readable.
        const R = actor.rot || MAT3_IDENTITY;
        const c = [actor.pos[0], actor.pos[1] + 0.6, actor.pos[2]];
        const ax = [-R[3], -R[4], -R[5]];
        const stub = spotStubFigure(c, ax, actor.light.color || [1, 1, 1]);
        fig.positions.push(...stub.positions);
        fig.colors.push(...stub.colors);
      }
      actor.placeholder = this._buildOverlay(fig.positions, fig.colors);
      return;
    }
    if (!actor.model) {
      this._freeOverlay(actor.placeholder);
      const fig = placeholderFigure(actor.pos, actor.rot, actor.color, actor.scale ?? 1);
      actor.placeholder = this._buildOverlay(fig.positions, fig.colors);
    }
  }

  /** pos: [x,y,z] | null, rot: column-major 3x3 (9 numbers) | null, scale: number | null. */
  setActorTransform(id, pos, rot, scale) {
    const actor = this.getActor(id);
    if (!actor) return;
    if (pos) actor.pos = [pos[0], pos[1], pos[2]];
    if (rot && rot.length === 9) actor.rot = Float32Array.from(rot);
    if (scale != null && scale > 0) actor.scale = scale;
    this._syncActorTransform(actor);
  }

  /** Placeholder figure colour ([r,g,b] 0–1); moot once a mesh is set. */
  setActorColor(id, rgb) {
    const actor = this.getActor(id);
    if (!actor || !rgb) return;
    actor.color = [rgb[0], rgb[1], rgb[2]];
    this._syncActorTransform(actor);
  }

  /**
   * Display-space point a camera should aim at to frame this actor: `joint`
   * (2 = the pelvis, the Camera Sequencer's LOCK_JOINT) through the placement
   * matrix for a posed model, else a body-height point above the feet.
   */
  getActorAimPoint(id, joint = 2) {
    const actor = this.getActor(id);
    if (!actor) return null;
    const pose = actor.pose;
    const n = pose?.skeleton?.joints?.length ?? 0;
    if (actor.model && pose && n > joint) {
      if (actor.poseDirty) {
        pose.pack(actor.rotArray, actor.transArray, actor.scaleArray);
        actor.poseDirty = false;
      }
      const m = actor.modelMatrix;
      const x = actor.transArray[joint * 4];
      const y = actor.transArray[joint * 4 + 1];
      const z = actor.transArray[joint * 4 + 2];
      return [
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
      ];
    }
    const s = actor.scale ?? 1;
    return [actor.pos[0], actor.pos[1] + 1.0 * s, actor.pos[2]];
  }

  /** Rotate an actor about a WORLD axis (the rotate-gizmo rings). */
  rotateActorWorld(id, axis, angle) {
    const actor = this.getActor(id);
    if (!actor || !angle) return;
    actor.rot = mat3Mul(mat3AxisRotation(axis, angle), actor.rot);
    this._syncActorTransform(actor);
  }

  /**
   * Display-space box around an actor for viewport picking: the posed joint
   * origins (DAT space) through its placement matrix, padded for limbs; a
   * body-sized box for a placeholder.
   */
  actorBoundsDisplay(actor) {
    const m = actor.modelMatrix;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const add = (x, y, z) => {
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      if (wx < min[0]) min[0] = wx; if (wx > max[0]) max[0] = wx;
      if (wy < min[1]) min[1] = wy; if (wy > max[1]) max[1] = wy;
      if (wz < min[2]) min[2] = wz; if (wz > max[2]) max[2] = wz;
    };
    const pose = actor.pose;
    const n = pose?.skeleton?.joints?.length ?? 0;
    if (actor.model && pose && n) {
      if (actor.poseDirty) {
        pose.pack(actor.rotArray, actor.transArray, actor.scaleArray);
        actor.poseDirty = false;
      }
      for (let i = 0; i < n; i++) add(actor.transArray[i * 4], actor.transArray[i * 4 + 1], actor.transArray[i * 4 + 2]);
      const pad = 0.35 * (actor.scale ?? 1);
      for (let k = 0; k < 3; k++) { min[k] -= pad; max[k] += pad; }
      // Joints alone under-report height for a standing figure (no head top).
      max[1] = Math.max(max[1], actor.pos[1] + 0.9 * (actor.scale ?? 1));
      return { min, max };
    }
    if (actor.light) {
      return {
        min: [actor.pos[0] - 0.5, actor.pos[1], actor.pos[2] - 0.5],
        max: [actor.pos[0] + 0.5, actor.pos[1] + 1.2, actor.pos[2] + 0.5],
      };
    }
    const hw = 0.45 * (actor.scale ?? 1);
    const h = 2.0 * (actor.scale ?? 1);
    return {
      min: [actor.pos[0] - hw, actor.pos[1], actor.pos[2] - hw],
      max: [actor.pos[0] + hw, actor.pos[1] + h, actor.pos[2] + hw],
    };
  }

  /**
   * Give an actor a light source ({ type, color: [r,g,b], intensity, radius })
   * or null. A light actor draws a marker instead of a mesh / placeholder.
   */
  setActorLight(id, light) {
    const actor = this.getActor(id);
    if (!actor) return;
    actor.light = light ? { ...light } : null;
    this._syncActorTransform(actor);
  }

  /** Upload this frame's light-source actors to a program's uniform table. */
  _uploadPointLights(u) {
    const gl = this.gl;
    if (!u || u.pointCount == null) return;
    const pos = this._plightPos || (this._plightPos = new Float32Array(MAX_PLIGHTS * 3));
    const col = this._plightCol || (this._plightCol = new Float32Array(MAX_PLIGHTS * 3));
    const rad = this._plightRad || (this._plightRad = new Float32Array(MAX_PLIGHTS));
    const dir = this._plightDir || (this._plightDir = new Float32Array(MAX_PLIGHTS * 3));
    const cone = this._plightCone || (this._plightCone = new Float32Array(MAX_PLIGHTS));
    let n = 0;
    const amb = [0, 0, 0];
    for (const a of this.actors) {
      const L = a.light;
      if (!L || !a.visible) continue;
      const k = Math.max(0, L.intensity ?? 1);
      const c = L.color || [1, 1, 1];
      if (L.type === 'ambient') {
        amb[0] += c[0] * k * 0.5; amb[1] += c[1] * k * 0.5; amb[2] += c[2] * k * 0.5;
        continue;
      }
      if (n >= MAX_PLIGHTS) continue;
      // Lamp sits a little above its marker so it lights the ground it stands on.
      pos[n * 3] = a.pos[0]; pos[n * 3 + 1] = a.pos[1] + 0.6; pos[n * 3 + 2] = a.pos[2];
      col[n * 3] = c[0] * k; col[n * 3 + 1] = c[1] * k; col[n * 3 + 2] = c[2] * k;
      rad[n] = Math.max(0.5, L.radius ?? 20);
      if (L.type === 'spot') {
        // Spot axis: the actor's local -Y (straight down until rotated).
        const R = a.rot || MAT3_IDENTITY;
        const dx = -R[3], dy = -R[4], dz = -R[5];
        const len = Math.hypot(dx, dy, dz) || 1;
        dir[n * 3] = dx / len; dir[n * 3 + 1] = dy / len; dir[n * 3 + 2] = dz / len;
        const half = Math.min(85, Math.max(2, L.cone ?? 35));
        cone[n] = Math.cos((half * Math.PI) / 180);
      } else {
        dir[n * 3] = 0; dir[n * 3 + 1] = -1; dir[n * 3 + 2] = 0;
        cone[n] = 0;
      }
      n++;
    }
    gl.uniform1i(u.pointCount, n);
    if (n) {
      gl.uniform3fv(u.pointPos, pos);
      gl.uniform3fv(u.pointColor, col);
      gl.uniform1fv(u.pointRadius, rad);
      gl.uniform3fv(u.pointDir, dir);
      gl.uniform1fv(u.pointCone, cone);
    }
    gl.uniform3f(u.extraAmbient, amb[0], amb[1], amb[2]);
  }

  /** Radius rings on the ground under point-light actors. */
  _drawLightMarkers(viewProj) {
    const lights = this.actors.filter((a) => a.light && a.visible && a.light.type !== 'ambient');
    if (!lights.length) return;
    this._ensureGizmoMesh();
    if (!this.gizmoParts.ring) {
      // Rings are built lazily by setActorGizmo; borrow that path once.
      const keep = this.actorGizmo;
      const any = this.actors[0];
      if (any) { this.setActorGizmo(any.id, 'move'); this.actorGizmo = keep; }
    }
    if (!this.gizmoParts.ring) return;
    const gl = this.gl;
    gl.useProgram(this.overlayProgram);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(this.overlayUniforms.opacity, 0.3);
    gl.bindVertexArray(this.gizmoParts.ring.vao);
    for (const a of lights) {
      const r = Math.max(0.5, a.light.radius ?? 20);
      const ring = new Float32Array([r, 0, 0, 0, 0, r, 0, 0, 0, 0, r, 0, a.pos[0], a.pos[1] + 0.05, a.pos[2], 1]);
      gl.uniformMatrix4fv(this.overlayUniforms.viewProj, false, mat4Multiply(viewProj, ring));
      gl.drawArrays(gl.TRIANGLES, 0, this.gizmoParts.ring.count);
    }
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.bindVertexArray(null);
  }

  /** Show the transform grabber on an actor (mode: move | rotate | scale), or clear it. */
  setActorGizmo(actorId, mode = 'move') {
    if (actorId == null || !this.getActor(actorId)) { this.actorGizmo = null; return; }
    const prev = this.actorGizmo;
    this.actorGizmo = {
      actorId, mode,
      hoverAxis: prev?.actorId === actorId ? prev.hoverAxis : null,
      activeAxis: null,
    };
    this._ensureGizmoMesh();
    if (!this.gizmoParts.ring) {
      const gl = this.gl;
      const upload = (data) => {
        const vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
        gl.bindVertexArray(null);
        return { vao, vbo, count: data.length / 6 };
      };
      this.gizmoParts.ring = upload(buildRingMesh([0.95, 0.82, 0.25]));
      this.gizmoParts.ringHot = upload(buildRingMesh([1.0, 0.95, 0.55], 0.88, 1.02));
      this.gizmoParts.ringX = upload(buildRingMesh([0.90, 0.20, 0.22]));
      this.gizmoParts.ringXHot = upload(buildRingMesh([1.0, 0.55, 0.45], 0.88, 1.02));
      this.gizmoParts.ringY = upload(buildRingMesh([0.24, 0.80, 0.30]));
      this.gizmoParts.ringYHot = upload(buildRingMesh([0.55, 1.0, 0.50], 0.88, 1.02));
      this.gizmoParts.ringZ = upload(buildRingMesh([0.24, 0.44, 0.95]));
      this.gizmoParts.ringZHot = upload(buildRingMesh([0.50, 0.70, 1.0], 0.88, 1.02));
    }
  }

  /** Gizmo with its live position and world size, for hit-testing. */
  getActorGizmo() {
    const gz = this.actorGizmo;
    if (!gz) return null;
    const actor = this.getActor(gz.actorId);
    if (!actor) { this.actorGizmo = null; return null; }
    const base = { pos: [actor.pos[0], actor.pos[1], actor.pos[2]] };
    return { ...gz, pos: base.pos, size: gizmoSize(this, base), actor };
  }

  setActorGizmoHover(axis) {
    if (this.actorGizmo) this.actorGizmo.hoverAxis = axis || null;
  }

  setActorGizmoActive(axis) {
    if (this.actorGizmo) this.actorGizmo.activeAxis = axis || null;
  }

  _drawActorGizmo(viewProj) {
    const gz = this.getActorGizmo();
    if (!gz || !this.gizmoParts) return;
    const gl = this.gl;
    const s = gz.size;
    const hot = gz.activeAxis || gz.hoverAxis || null;
    const drawPart = (part, scaleMul = 1, R = MAT3_IDENTITY) => {
      if (!part) return;
      const sc = s * scaleMul;
      const model = new Float32Array([
        R[0] * sc, R[1] * sc, R[2] * sc, 0,
        R[3] * sc, R[4] * sc, R[5] * sc, 0,
        R[6] * sc, R[7] * sc, R[8] * sc, 0,
        gz.pos[0], gz.pos[1], gz.pos[2], 1,
      ]);
      gl.uniformMatrix4fv(this.overlayUniforms.viewProj, false, mat4Multiply(viewProj, model));
      gl.bindVertexArray(part.vao);
      gl.drawArrays(gl.TRIANGLES, 0, part.count);
    };
    gl.useProgram(this.overlayProgram);
    gl.uniform1f(this.overlayUniforms.opacity, 1);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    drawPart(this.gizmoParts.center, 1);
    if (gz.mode === 'rotate') {
      // Ring mesh lies in XZ (normal +Y); tip it to face each world axis.
      const RX = mat3AxisRotation('z', Math.PI / 2);   // normal → X
      const RZ = mat3AxisRotation('x', Math.PI / 2);   // normal → Z
      const rings = [['rx', 'ringX', RX], ['ry', 'ringY', MAT3_IDENTITY], ['rz', 'ringZ', RZ]];
      for (const [id, part, R] of rings) {
        if (hot === id) continue;
        drawPart(this.gizmoParts[part], 1, R);
      }
      const hotRing = rings.find(([id]) => id === hot);
      if (hotRing) drawPart(this.gizmoParts[`${hotRing[1]}Hot`], 1.04, hotRing[2]);
    } else if (gz.mode === 'scale') {
      drawPart(this.gizmoParts[hot === 'u' ? 'yHot' : 'y'], hot === 'u' ? 1.18 : 1);
    } else {
      for (const id of ['x', 'y', 'z']) {
        const isHot = hot === id;
        drawPart(this.gizmoParts[isHot ? `${id}Hot` : id], isHot ? 1.18 : 1);
      }
    }
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  }

  setActorVisible(id, visible) {
    const actor = this.getActor(id);
    if (actor) actor.visible = !!visible;
  }

  /** Actors live selection: the actor under the cursor gets a wire box. */
  setActorHover(id) {
    this.actorHoverId = id ?? null;
  }

  /**
   * Wire box round the hovered actor. Rebuilt every frame from the live pose
   * bounds (an idle sways, a breath swings the head), which is 24 vertices —
   * cheaper than tracking dirtiness.
   */
  _drawActorHover(viewProj) {
    if (this.actorHoverId == null) return;
    const actor = this.getActor(this.actorHoverId);
    if (!actor || !actor.visible) return;
    const b = this.actorBoundsDisplay(actor);
    if (!b?.min || !b?.max) return;
    const [x0, y0, z0] = b.min;
    const [x1, y1, z1] = b.max;
    const c = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ];
    const edges = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    const rgb = [0.35, 0.85, 1.0];   // same cyan as the zone live-selection hover
    const verts = [];
    for (const [a, bi] of edges) {
      verts.push(...c[a], ...rgb, ...c[bi], ...rgb);
    }
    const gl = this.gl;
    const data = new Float32Array(verts);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.useProgram(this.overlayProgram);
    gl.uniformMatrix4fv(this.overlayUniforms.viewProj, false, viewProj);
    gl.uniform1f(this.overlayUniforms.opacity, 1);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);   // always readable, even through terrain
    gl.depthMask(false);
    gl.drawArrays(gl.LINES, 0, verts.length / 6);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.deleteVertexArray(vao);
    gl.deleteBuffer(vbo);
  }

  /**
   * Give an actor a parsed entity model (same shape setModel takes), or null
   * to go back to the placeholder. Textures and batches are owned by the actor.
   */
  setActorModel(id, model) {
    const actor = this.getActor(id);
    if (!actor) return;
    this._freeActorGeometry(actor);
    actor.model = model && model.isRenderable ? model : null;
    actor.pose = null;
    actor.currentAnimation = null;
    actor.animFrame = 0;
    if (!actor.model) {
      this._syncActorTransform(actor);
      return;
    }
    actor.pose = new SkeletonPose(actor.model.skeleton, actor.model.jointOverrides ?? null);
    for (const tex of actor.model.textures.values()) {
      const t = this.createTexture(tex);
      if (t) actor.textures.set(tex.name, t);
    }
    const occl = new Set(actor.model.meshGroups.map((g) => g.occludeType ?? 0));
    for (const group of actor.model.meshGroups) {
      for (const piece of group.pieces) {
        if (occludesDisplayType(piece.props?.displayType ?? 0, occl)) continue;
        const batch = this.buildBatch(group, piece, actor.textures);
        if (batch) actor.batches.push(batch);
      }
    }
    actor.batches.forEach((b, i) => { b.depthNudge = -i; });
    actor.poseDirty = true;
    this._syncActorTransform(actor);
  }

  setActorAnimation(id, clip, opts = {}) {
    const actor = this.getActor(id);
    if (!actor) return;
    actor.currentAnimation = clip;
    if (opts.loop != null) actor.loop = !!opts.loop;
    if (opts.speed != null) actor.speed = opts.speed;
    const len = clip?.lengthInFrames ?? 0;
    actor.animFrame = (opts.frame != null && len > 0) ? opts.frame % len : 0;
    if (actor.pose) actor.pose.evaluate(clip, actor.animFrame);
    actor.poseDirty = true;
  }

  setActorPlaying(id, playing) {
    const actor = this.getActor(id);
    if (actor) actor.playing = !!playing;
  }

  /** Scrub an actor's clip to a game-frame (clamped). Leaves play state alone. */
  seekActor(id, frame) {
    const actor = this.getActor(id);
    if (!actor || !actor.currentAnimation || !actor.pose) return;
    const len = actor.currentAnimation.lengthInFrames ?? 0;
    actor.animFrame = Math.min(Math.max(+frame || 0, 0), len);
    actor.pose.evaluate(actor.currentAnimation, actor.animFrame);
    actor.poseDirty = true;
  }

  /**
   * Play an NPC's own effect routine on a zone actor: `system` is a
   * ParticleSystem armed via playEffectRoutine (or null to stop), `textures`
   * the effect DAT's images. Each actor owns its system, ticked in
   * _advanceActors and drawn after the zone's weather pass, with its
   * actor-attached generators anchored to THIS actor's joints and placement
   * rather than the main entity (there is none in a zone).
   */
  setActorEffect(id, system, textures = null, replay = null) {
    const actor = this.getActor(id);
    if (!actor) return;
    if (actor.fx?.system && actor.fx.system !== system) actor.fx.system.clearEffect();
    if (!system) { actor.fx = null; return; }
    for (const tex of textures?.values() ?? []) {
      // The registry is shared with the zone and every other actor: keep the
      // incumbent on a name clash (the shared ROM/0/0 sheets are identical).
      if (this.textures.has(tex.name)) continue;
      const t = this.createTexture(tex);
      if (t) this.textures.set(tex.name, t);
    }
    system.camera = this._particleCameraAdapter();
    system.effectDistanceScale = this.effectDistanceScale ?? 1;
    system.floorQuery = () => null;
    system.getActorAttachPosition = (jointRef, attach) => this._actorAttachPosition(actor, jointRef, attach);
    system.getActorAttachTransform = (jointRef, attach) => this._actorAttachTransform(actor, jointRef, attach);
    // Unattached generators (most of a routine's ground rings, bursts and
    // flashes) sit at the actor's feet and turn with it — see
    // ParticleGenerator.updateAssociatedPosition. Particle space is display
    // space through toDat = diag(-1,-1,1), its own inverse, so a display yaw R
    // becomes toDat * R * toDat there.
    system.getEffectOrigin = () => new Vec3(-actor.pos[0], -actor.pos[1], actor.pos[2]);
    system.getEffectFacing = () => {
      const R = actor.rot;
      if (!R) return null;
      const m = new Mat4(new Float32Array([
        R[0], R[1], R[2], 0,
        R[3], R[4], R[5], 0,
        R[6], R[7], R[8], 0,
        0, 0, 0, 1,
      ]));
      const d = new Mat4().scaleInPlace(new Vec3(-1, -1, 1));
      d.multiply(m, m);
      m.multiply(d, m);
      return m;
    };
    // `replay` re-fires the routine at the clip's loop point (see _advanceActors).
    actor.fx = { system, replay };
  }

  /** A joint reference as a point in the actor's own DAT frame (current pose). */
  _actorRefLocal(actor, idx) {
    const ref = actor.model?.skeleton?.references?.[idx];
    if (!ref || !actor.pose) return null;
    const j = ref.index | 0;
    const tr = actor.pose.trans?.[j];
    if (!tr) return null;
    const off = ref.offset ?? [0, 0, 0];
    const sc = actor.pose.scale?.[j] ?? [1, 1, 1];
    const q = actor.pose.rot?.[j];
    const local = [off[0] * sc[0], off[1] * sc[1], off[2] * sc[2]];
    const rot = q ? qRotate(q, local) : local;
    return [tr[0] + rot[0], tr[1] + rot[1], tr[2] + rot[2]];
  }

  /**
   * Zone-actor twin of getActorAttachPosition: the joint in the actor's raw DAT
   * frame, through its model matrix (ENTITY_ROT · scale · yaw · place) into
   * display space, then into particle space (toDat = diag(-1,-1,1)).
   *
   * Target-side references resolve on a VIRTUAL target standing in front of
   * the actor, not on the actor itself. A monster's TP move is authored for
   * two actors — the shot leaves the source's mouth (reference 24 on a wyvern)
   * and the hit lands on the target's body references — and with one actor on
   * stage those target points sat on the caster's own chest, so a breath
   * attack looked like it fired at its own feet. The stand-in is the front
   * slot of the skeleton's attack ring (reference 13, where an attacker stands
   * in game), so it is model-sized: a few units ahead of a wyvern, one step
   * ahead of a goblin. Target references keep their own height and lateral
   * offset; only the ground point moves.
   */
  _actorAttachPosition(actor, jointRef = 0, attach = null) {
    if (!actor.model || !actor.pose) return null;
    let idx = jointRef | 0;
    if (idx >= 49 && idx <= 51) idx = RING_REF_START;
    const d = this._actorRefLocal(actor, idx);
    if (!d) return null;
    const isTarget = attach === AttachType.TargetActor
      || attach === AttachType.TargetActorSourceFacing
      || attach === AttachType.TargetToSourceBasis;
    if (isTarget) {
      const front = this._actorRefLocal(actor, RING_REF_START);
      const root = this._actorRefLocal(actor, 0) ?? [0, 0, 0];
      if (front) { d[0] += front[0] - root[0]; d[2] += front[2] - root[2]; }
    }
    const m = actor.modelMatrix;
    const wx = m[0] * d[0] + m[4] * d[1] + m[8] * d[2] + m[12];
    const wy = m[1] * d[0] + m[5] * d[1] + m[9] * d[2] + m[13];
    const wz = m[2] * d[0] + m[6] * d[1] + m[10] * d[2] + m[14];
    return new Vec3(-wx, -wy, wz);
  }

  /** Joint frame for a weapon-attached generator: R' = toDat * M3(actor) * Rq. */
  _actorAttachTransform(actor, jointRef = 0, attach = null) {
    const position = this._actorAttachPosition(actor, jointRef, attach);
    if (!position) return null;
    const refs = actor.model.skeleton?.references ?? [];
    let idx = jointRef | 0;
    if (idx >= 49 && idx <= 51) idx = RING_REF_START;
    const q = actor.pose.rot?.[refs[idx]?.index | 0];
    const rotation = new Mat4();
    if (q) {
      rotation.setRotationFromQuaternionInPlace(q[0], q[1], q[2], q[3]);
      const m = actor.modelMatrix;
      const k = actor.scale > 0 ? actor.scale : 1;
      const basis = new Mat4(new Float32Array([
        m[0] / k, m[1] / k, m[2] / k, 0,
        m[4] / k, m[5] / k, m[6] / k, 0,
        m[8] / k, m[9] / k, m[10] / k, 0,
        0, 0, 0, 1,
      ]));
      const toDat = new Mat4().scaleInPlace(new Vec3(-1, -1, 1));
      toDat.multiply(basis, basis);
      basis.multiply(rotation, rotation);
    }
    return { position, rotation };
  }

  _advanceActors(dtSeconds) {
    for (const actor of this.actors) {
      if (!actor.playing || !actor.currentAnimation || !actor.pose) continue;
      const clip = actor.currentAnimation;
      actor.animFrame += dtSeconds * (clip.fps ?? 30) * (actor.speed ?? 1);
      const len = clip.lengthInFrames;
      if (!(len > 0)) actor.animFrame = 0;
      else if (actor.animFrame > len) {
        if (actor.loop === false) { actor.animFrame = len; actor.playing = false; }
        else {
          actor.animFrame %= len;
          actor.fx?.replay?.();   // keep the motion's VFX in phase with the clip
        }
      }
      actor.pose.evaluate(clip, actor.animFrame);
      actor.poseDirty = true;
    }
    // Per-actor effect routines run on the effect engine's 60/s clock (same
    // clamp as _updateEnvironment). Hidden, or paused mid-clip (scrubbing),
    // the effect freezes with the actor; a clip that ran out lets its
    // trailing particles finish.
    const fxFrames = Math.min(8, Math.max(0, (dtSeconds || 1 / 60) * 60));
    for (const actor of this.actors) {
      if (!actor.fx?.system || !actor.visible) continue;
      const len = actor.currentAnimation?.lengthInFrames ?? 0;
      const pausedMidClip = !actor.playing && actor.currentAnimation && actor.animFrame < len - 1e-3;
      if (!pausedMidClip) actor.fx.system.update(fxFrames);
    }
  }

  /**
   * Draw every actor inside the zone pass: same skinning program as the main
   * entity, but placed by uModel and lit/fogged/shadowed like the terrain
   * around it (display space, zone light set, zone cascades).
   */
  _drawActors(viewProj, eye, fogFar) {
    if (!this.actors.length) return;
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    // Placeholders first (overlay program handles its own state). A playing
    // camera sequence hides every helper: lamps become just their light.
    const helpersOn = !this.camera?.sequenceLock;
    for (const actor of this.actors) {
      if (!helpersOn) break;
      if (!actor.visible || actor.model || !actor.placeholder) continue;
      gl.depthMask(true);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      this._drawOverlay(viewProj, actor.placeholder, 0.85);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(0, 0);
    }

    if (helpersOn) this._drawLightMarkers(viewProj);

    const skinned = this.actors.filter((a) => a.visible && a.model && a.pose && a.batches.length);
    if (!skinned.length) return;

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniforms.viewProj, false, viewProj);
    gl.uniform3fv(this.uniforms.lightDir, this.camera.forward);
    gl.uniform1i(this.uniforms.texture, 0);
    gl.uniform3fv(this.uniforms.cameraPos, eye);
    gl.uniform3fv(this.uniforms.fogColor, this.fog.color);
    gl.uniform2f(this.uniforms.fogRange, this.fog.near, fogFar);
    const alphaOn = !!this.showAlpha;
    gl.uniform1f(this.uniforms.showAlpha, alphaOn ? 1 : 0);
    gl.uniform1f(this.uniforms.terrainLit, 1);
    const L = this._zoneLightUniforms();
    gl.uniform3fv(this.uniforms.ambient, L.ambient);
    gl.uniform3fv(this.uniforms.sunDir, L.sunDir);
    gl.uniform3fv(this.uniforms.sunColor, L.sunColor);
    gl.uniform3fv(this.uniforms.moonDir, L.moonDir);
    gl.uniform3fv(this.uniforms.moonColor, L.moonColor);
    gl.uniform1f(this.uniforms.sunLit, 0);
    gl.uniform1f(this.uniforms.lightGain, this.lightGain ?? 1);
    this._bindShadowUniforms(this.uniforms);
    this._uploadPointLights(this.uniforms);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.CULL_FACE);

    const drawActorBatches = (actor, pred) => {
      for (const batch of actor.batches) {
        if (pred && !pred(batch)) continue;
        gl.uniform1i(this.uniforms.alphaMode, batch.alphaMode ?? 0);
        gl.polygonOffset(0, batch.depthNudge ?? 0);
        gl.bindTexture(gl.TEXTURE_2D, this.showTextures && batch.texture ? batch.texture : this.whiteTexture);
        gl.bindVertexArray(batch.vao);
        gl.drawArrays(batch.mode, 0, batch.count);
      }
    };

    for (const actor of skinned) {
      if (actor.poseDirty) {
        actor.pose.pack(actor.rotArray, actor.transArray, actor.scaleArray);
        actor.poseDirty = false;
      }
      gl.uniform4fv(this.uniforms.rot, actor.rotArray);
      gl.uniform4fv(this.uniforms.trans, actor.transArray);
      gl.uniform4fv(this.uniforms.scale, actor.scaleArray);
      gl.uniformMatrix4fv(this.uniforms.model, false, actor.modelMatrix);

      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.uniform1i(this.uniforms.alphaPass, 0);
      drawActorBatches(actor, (b) => (b.alphaMode ?? 0) !== 3);
      if (alphaOn) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        gl.uniform1i(this.uniforms.alphaPass, 1);
        drawActorBatches(actor, (b) => { const m = b.alphaMode ?? 0; return m === 0 || m === 3; });
      }
    }

    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(0, 0);
    gl.bindVertexArray(null);
  }

  /** Depth-only render targets, one per cascade; rebuilt when the size changes. */
  _ensureShadowTargets(count) {
    const size = this.shadowMapSize;
    if (this.shadowTargets.length >= count && this.shadowTargets[0]?.size === size) {
      return this.shadowTargets;
    }
    const gl = this.gl;
    for (const t of this.shadowTargets) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
    this.shadowTargets = [];
    for (let i = 0; i < count; i++) this.shadowTargets.push(this._makeShadowTarget(size));
    return this.shadowTargets;
  }

  _makeShadowTarget(size) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, size, size);
    // LINEAR + COMPARE_REF_TO_TEXTURE is hardware 2x2 PCF; the shader adds 3x3
    // taps on top of it.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { fbo, tex, size };
  }

  /**
   * Fit the shadow cascades and build their view-projections.
   *
   * All cascades share one light basis and one depth range; each gets its own
   * half-extent and its own centre, placed down the view by a fraction of that
   * extent. That keeps the near one nested inside the far one — so the shader
   * can still cross-fade on a single "how close to this cascade's border"
   * number — while putting it over the ground you are actually looking at.
   *
   * The basis is anchored at the world origin so it never moves; only the ortho
   * window slides, which lets each cascade snap to its own whole texels.
   * Without that snap the map re-rasterizes on a different sub-texel grid every
   * frame and shadow edges crawl as the camera moves.
   *
   * Returns false when there is nothing sensible to fit (no bounds, no sun).
   */
  _updateShadowCascades(eye) {
    const isZone = this.model?.kind === 'zone';
    // Custom gizmo (display-space) wins. Else zones follow live 0x2F sun; entity
    // views use the fixed DAT-space key.
    let raw;
    if (this.customSunDir) {
      raw = isZone ? this.customSunDir : this._displaySunToDat(this.customSunDir);
    } else {
      raw = isZone ? this.terrainLighting.sunDir : ENTITY_SUN_DAT;
    }
    const ln = raw ? Math.hypot(raw[0], raw[1], raw[2]) : 0;
    if (!(ln > 1e-4)) return false;
    const L = [raw[0] / ln, raw[1] / ln, raw[2] / ln];
    this.shadowSunDir = L;

    let bmin = null, bmax = null;
    if (isZone) {
      const b = this.model.zoneBounds;
      if (b) { bmin = b.min; bmax = b.max; }
    } else {
      if (!this.modelMin) this.snapFloorToFeet();
      bmin = this.modelMin; bmax = this.modelMax;
      if (!bmin) return false;
    }

    // Light camera sits at the origin looking down −L (L points *at* the sun),
    // so light-space z of a point is dot(L, p) and "in front" is negative z.
    // Built before the fit because the model branch measures its box in light
    // space rather than guessing a radius from the bounds.
    const up = Math.abs(L[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
    const view = mat4LookAt([0, 0, 0], [-L[0], -L[1], -L[2]], up);
    const lx = (p) => view[0] * p[0] + view[4] * p[1] + view[8] * p[2];
    const ly = (p) => view[1] * p[0] + view[5] * p[1] + view[9] * p[2];
    const lz = (p) => view[2] * p[0] + view[6] * p[1] + view[10] * p[2];
    const cornersOf = (lo, hi) => {
      const out = [];
      for (let i = 0; i < 8; i++) {
        out.push([(i & 1) ? hi[0] : lo[0], (i & 2) ? hi[1] : lo[1], (i & 4) ? hi[2] : lo[2]]);
      }
      return out;
    };

    // radii[0] is the sharp near cascade, the last entry is the draw distance.
    // centreFor() must take the radius: each cascade sits where its *own* box
    // is useful. Sharing one centre sized for the far cascade parks the near
    // one ~0.55 x far-radius down the view, so the whole foreground — the only
    // place its resolution would have shown — falls out of it and back onto the
    // coarse map. That is the bug that made the split look like it did nothing.
    let centreFor, radii;
    // Model views measure their own fit, so the depth range can use the same
    // points rather than the raw bounds (a long shadow reaches well past them).
    let fitPoints = null;
    if (isZone) {
      // The user's draw distance, used verbatim. The cascades cover a disc
      // around the camera, so a bird's-eye view shadows only what is near it
      // until the distance is raised — that is what the Graphics slider is for.
      const groundY = bmin ? bmin[1] : 0;
      const R = Math.max(this.shadowRange, 1);
      const near = Math.min(Math.max(R * this.shadowNearSplit, this.shadowNearMin), R);
      radii = near < R * 0.95 ? [near, R] : [R];
      // Horizontal forward, NOT renormalized: its length is cos(pitch), so a
      // level view pushes the box a full 0.55 radii down the line of sight and
      // a top-down view leaves it under the camera, where the ground is.
      const f = this.camera.forward;
      centreFor = (Ri) => [
        eye[0] + f[0] * Ri * 0.55,
        Math.max(groundY, eye[1] - Ri),
        eye[2] + f[2] * Ri * 0.55,
      ];
    } else {
      // One map is plenty for a model — but it has to cover where the shadow
      // LANDS, not just the model. Sizing it to the bounds meant a low sun cast
      // a shadow many times the model's size straight out of the box, and past
      // the edge there is no depth information at all, so it ended on a hard
      // diagonal line (the ortho window's border, seen on the floor).
      //
      // So fit the model's corners PLUS those corners dropped down the light
      // onto the floor plane: exactly the region that needs coverage. It only
      // grows when the sun is low enough to need it, and even a long shadow
      // costs little here — at 2048 a box ten times the model's size still
      // resolves finer than the model's own silhouette.
      const modelR = Math.hypot(bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]) / 2;
      const corners = cornersOf(bmin, bmax);
      fitPoints = corners.slice();
      // Entity space is Y-DOWN: the floor is at +Y and a sun above has L[1] < 0,
      // so t (the distance along −L to the floor plane) comes out positive.
      // Capped, or a sun on the horizon stretches the box towards infinity and
      // takes all the resolution with it.
      const maxCast = Math.max(modelR * 24, 1);
      if (Math.abs(L[1]) > 1e-3) {
        for (const p of corners) {
          const t = (p[1] - this.floorY) / L[1];
          if (!(t > 0)) continue;                       // corner is below the floor
          const d = Math.min(t, maxCast);
          fitPoints.push([p[0] - d * L[0], p[1] - d * L[1], p[2] - d * L[2]]);
        }
      }
      let xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity;
      let zlo = Infinity, zhi = -Infinity;
      for (const p of fitPoints) {
        const x = lx(p), y = ly(p), z = lz(p);
        if (x < xlo) xlo = x; if (x > xhi) xhi = x;
        if (y < ylo) ylo = y; if (y > yhi) yhi = y;
        if (z < zlo) zlo = z; if (z > zhi) zhi = z;
      }
      // Rebuild the world point holding that light-space centre. The lookAt has
      // no translation (eye is the origin) and its basis is orthonormal, so the
      // inverse is just the transpose: p = x*row0 + y*row1 + z*row2.
      const mid = [(xlo + xhi) / 2, (ylo + yhi) / 2, (zlo + zhi) / 2];
      const c = [
        view[0] * mid[0] + view[1] * mid[1] + view[2] * mid[2],
        view[4] * mid[0] + view[5] * mid[1] + view[6] * mid[2],
        view[8] * mid[0] + view[9] * mid[1] + view[10] * mid[2],
      ];
      centreFor = () => c;
      // Square window over the wider axis, with headroom for the PCF taps and
      // the 0.85→1 border ramp so neither eats into the shadow itself.
      const r = Math.max((xhi - xlo) / 2, (yhi - ylo) / 2);
      radii = [Math.max(r * 1.15, 0.5)];
    }
    const outerCentre = centreFor(radii[radii.length - 1]);

    // Depth range spans the whole scene along the light axis: casters well
    // outside the ortho window are clipped by x/y anyway, but anything *above*
    // the window (a cliff, a roof) has to stay inside near/far to cast at all.
    // Shared by every cascade so their depths are directly comparable.
    // Model views hand over the same points they were fitted to: a receiver
    // whose depth falls outside near/far is rejected by `uvz.z > 1.0` just as
    // surely as one outside the window, so the far end of a long shadow has to
    // be in here too.
    let zmin = Infinity, zmax = -Infinity;
    const depthPts = fitPoints ?? (bmin ? cornersOf(bmin, bmax) : null);
    if (depthPts) {
      for (const p of depthPts) {
        const z = lz(p);
        if (z < zmin) zmin = z;
        if (z > zmax) zmax = z;
      }
    }
    const cz = lz(outerCentre);
    const outer = radii[radii.length - 1];
    if (!isFinite(zmin)) { zmin = cz - outer * 4; zmax = cz + outer * 4; }
    // Never let the window run past the widest cascade.
    zmin = Math.min(zmin, cz - outer);
    zmax = Math.max(zmax, cz + outer);
    const depth = (zmax - zmin) + 2;
    const near = -(zmax + 1);
    const far = -(zmin - 1);

    // The x/y axes are shared, so cache them once for the cull tests below.
    const ax = [view[0], view[4], view[8]];
    const ay = [view[1], view[5], view[9]];

    this.shadowCascades = radii.map((R) => {
      const centre = centreFor(R);
      const texel = (2 * R) / this.shadowMapSize;
      const cx = Math.round(lx(centre) / texel) * texel;
      const cy = Math.round(ly(centre) / texel) * texel;
      return {
        lvp: mat4Multiply(mat4Ortho(cx - R, cx + R, cy - R, cy + R, near, far), view),
        texel,
        // Constant bias in normalized depth: half a texel along the light. The
        // depth pass's polygon offset and the receiver's normal offset do the
        // real work; this only covers quantization. It used to carry an
        // R * 0.002 floor too, which at any real draw distance was several
        // times the texel and detached every shadow from its caster.
        bias: (texel * 0.5) / depth,
        // Caster culling: the light-space x/y axes and this window's centre.
        // A zone is ~10k submeshes and a cascade covers a fraction of it, so
        // testing each bounding sphere against these two slabs is the
        // difference between a shadow pass that doubles frame time and one
        // that barely shows.
        ax, ay, cx, cy, r: R,
        // World-space centre of the cascade disc (camera-relative for zones).
        worldCentre: centre,
      };
    });
    return true;
  }

  /** Fill each cascade's depth map from the sun. No-op when shadows are off. */
  _renderShadowMap(eye) {
    const gl = this.gl;
    this.shadowActive = false;
    if (!this.showShadows || this.unlit) return;
    const isZone = this.model?.kind === 'zone';
    const casters = isZone ? this.zoneBatches : this.batches;
    if (!casters.length || this.showSkeleton || this.effectMode) return;
    if (!this._updateShadowCascades(eye)) return;

    const cascades = this.shadowCascades;
    const targets = this._ensureShadowTargets(cascades.length);
    // Last frame's receivers left these textures bound to units 1 and 2.
    // Rendering into one while it is still sampleable is a feedback loop, and
    // WebGL answers by silently dropping every draw in the pass — the map stays
    // cleared and the whole scene reads as lit. Unbind before attaching them.
    for (let i = 0; i < SHADOW_UNITS.length; i++) {
      gl.activeTexture(SHADOW_UNITS[i]);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.activeTexture(gl.TEXTURE0);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    // FFXI geometry mixes windings freely (and plenty of it is single-sided),
    // so culling either face here would punch holes in the map. Slope-scaled
    // polygon offset takes the place of the usual front-face cull.
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(2, 4);

    const alphaOn = !!this.showAlpha;
    if (!isZone) this._syncPose();

    for (let i = 0; i < cascades.length; i++) {
      const cascade = cascades[i];
      const target = targets[i];
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.size, target.size);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.activeTexture(gl.TEXTURE0);

      if (isZone) {
        const u = this.shadowZoneUniforms;
        gl.useProgram(this.shadowZoneProgram);
        gl.uniformMatrix4fv(u.lightViewProj, false, cascade.lvp);
        gl.uniform1i(u.texture, 0);
        let curWind = null, curCutout = null, curTex = null;
        const zoneCasters = this.zoneSpinnerBatches.length
          ? this.zoneBatches.concat(this.zoneSpinnerBatches)
          : this.zoneBatches;
        for (const batch of zoneCasters) {
          // Water and soft-edge overlays are blended surfaces — casting from
          // them would drop a hard slab of shade over everything beneath the sea.
          if (batch.blend || batch.layer === 'sky' || batch.layer === 'unplaced' || batch.celestial) continue;
          // Bounding sphere vs this cascade's two light-space slabs. The depth
          // axis is deliberately not tested: a caster far up the light
          // direction is exactly the one that still needs to reach the ground.
          const c = batch.center;
          if (c) {
            // Sky/env shells enclose the whole cascade disc — their silhouette
            // paints a huge camera-following arch that grows with shadow range.
            // If the cascade centre sits well inside the batch sphere, skip.
            const wc = cascade.worldCentre;
            if (wc && batch.radius > cascade.r) {
              const dx = c[0] - wc[0], dy = c[1] - wc[1], dz = c[2] - wc[2];
              const dist = Math.hypot(dx, dy, dz);
              if (dist + cascade.r * 1.05 < batch.radius) continue;
            }
            const reach = cascade.r + batch.radius;
            const px = cascade.ax[0] * c[0] + cascade.ax[1] * c[1] + cascade.ax[2] * c[2];
            if (Math.abs(px - cascade.cx) > reach) continue;
            const py = cascade.ay[0] * c[0] + cascade.ay[1] * c[1] + cascade.ay[2] * c[2];
            if (Math.abs(py - cascade.cy) > reach) continue;
          }
          const wind = batch.wind ? this.windFactor : 0;
          if (wind !== curWind) { gl.uniform1f(u.wind, wind); curWind = wind; }
          const cutout = alphaOn ? batch.discard : 0;
          if (cutout !== curCutout) { gl.uniform1f(u.cutout, cutout); curCutout = cutout; }
          const tex = batch.texture || this.whiteTexture;
          if (tex !== curTex) { gl.bindTexture(gl.TEXTURE_2D, tex); curTex = tex; }
          gl.bindVertexArray(batch.vao);
          gl.drawArrays(gl.TRIANGLES, 0, batch.count);
        }
        // Zone particle props (mil* windmills, mi* roof vanes, water, …).
        if (this.particleSystem && this.showEffects !== false) {
          try {
            if (!this.particleDrawer) this.particleDrawer = new ParticleDrawer(gl);
            this.particleDrawer.setTextures(this.textures);
            this.particleDrawer.castShadows({
              system: this.particleSystem,
              lightViewProj: cascade.lvp,
              alphaOn,
            });
          } catch (e) {
            console.warn('particle shadow cast failed', e);
          }
        }
        // Placed actors cast like the main entity would, placed by uModel.
        const casterActors = this.actors.filter((a) => a.visible && a.model && a.pose && a.batches.length);
        if (casterActors.length) {
          const u = this.shadowEntityUniforms;
          gl.useProgram(this.shadowEntityProgram);
          gl.uniformMatrix4fv(u.lightViewProj, false, cascade.lvp);
          gl.uniform1i(u.texture, 0);
          gl.uniform1f(u.cutout, alphaOn ? 0.5 : 0);
          for (const actor of casterActors) {
            if (actor.poseDirty) {
              actor.pose.pack(actor.rotArray, actor.transArray, actor.scaleArray);
              actor.poseDirty = false;
            }
            gl.uniform4fv(u.rot, actor.rotArray);
            gl.uniform4fv(u.trans, actor.transArray);
            gl.uniform4fv(u.scale, actor.scaleArray);
            gl.uniformMatrix4fv(u.model, false, actor.modelMatrix);
            for (const batch of actor.batches) {
              if ((batch.alphaMode ?? 0) === 3) continue;
              gl.bindTexture(gl.TEXTURE_2D, batch.texture || this.whiteTexture);
              gl.bindVertexArray(batch.vao);
              gl.drawArrays(batch.mode, 0, batch.count);
            }
          }
        }
      } else {
        const u = this.shadowEntityUniforms;
        gl.useProgram(this.shadowEntityProgram);
        gl.uniform4fv(u.rot, this.rotArray);
        gl.uniform4fv(u.trans, this.transArray);
        gl.uniform4fv(u.scale, this.scaleArray);
        gl.uniformMatrix4fv(u.lightViewProj, false, cascade.lvp);
        gl.uniformMatrix4fv(u.model, false, IDENTITY_M);
        gl.uniform1i(u.texture, 0);
        // Same 0.5 split the opaque colour pass uses: only the solid half of
        // the model casts, so hair cards and glass don't shadow as filled quads.
        gl.uniform1f(u.cutout, alphaOn ? 0.5 : 0);
        for (const batch of this.batches) {
          if (batch.layer === 'sky' || batch.layer === 'water') continue;
          if ((batch.alphaMode ?? 0) === 3) continue;   // zone-style blend submesh
          if (!this._batchSourceVisible(batch)) continue;
          gl.bindTexture(gl.TEXTURE_2D, batch.texture || this.whiteTexture);
          gl.bindVertexArray(batch.vao);
          gl.drawArrays(batch.mode, 0, batch.count);
        }
      }
    }

    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(0, 0);
    this.shadowActive = true;
  }

  /** Pack the pose into the joint uniform arrays once per frame. */
  _syncPose() {
    if (this.pose && this.poseDirty) {
      this.pose.pack(this.rotArray, this.transArray, this.scaleArray);
      this.poseDirty = false;
    }
  }

  /**
   * Cascade maps + light matrices for a receiver program. Texture units 1 and 2
   * across the board (unit 0 is always the diffuse texture), and unit 0 is left
   * selected.
   */
  _bindShadowUniforms(u) {
    const gl = this.gl;
    if (!u.shadowParams) return;
    const cascades = this.shadowActive ? this.shadowCascades : [];
    const near = cascades[0];
    const far = cascades[1];

    if (near) {
      gl.uniform4f(u.shadowParams, 1, this.shadowStrength, near.texel, near.bias);
      gl.uniformMatrix4fv(u.lightViewProj0, false, near.lvp);
    } else {
      gl.uniform4f(u.shadowParams, 0, 0, 0, 0);
    }
    if (far) {
      // Cross-fade over the near cascade's outer 18% — wide enough that the
      // resolution change is a gradient rather than a ring, narrow enough that
      // most fragments still take the single-lookup path.
      gl.uniform4f(u.shadowParams1, far.texel, far.bias, 0.82, 1);
      gl.uniformMatrix4fv(u.lightViewProj1, false, far.lvp);
    } else {
      // Model views: one cascade, so the shader skips the far lookup entirely.
      gl.uniform4f(u.shadowParams1, 0, 0, 0.85, 0);
    }

    // A sampler2DShadow must still have a depth-comparable texture bound even
    // when the shader branches around it — validation doesn't care that the
    // sample is unreachable. Hence the 1x1 stand-in for unused cascades.
    const dummy = (near && far) ? null : this._shadowDummy();
    for (let i = 0; i < SHADOW_UNITS.length; i++) {
      gl.uniform1i(i === 0 ? u.shadowMap0 : u.shadowMap1, i + 1);
      gl.activeTexture(SHADOW_UNITS[i]);
      gl.bindTexture(gl.TEXTURE_2D, cascades[i] ? this.shadowTargets[i].tex : dummy);
    }
    gl.activeTexture(gl.TEXTURE0);
  }

  /** 1x1 depth texture with compare mode on — bound whenever shadows are off. */
  _shadowDummy() {
    if (this.shadowDummyTex) return this.shadowDummyTex;
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, 1, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    this.shadowDummyTex = tex;
    return tex;
  }

  /**
   * Zone terrain, drawn in authored DAT order with per-submesh state — the
   * faithful shape of xim's GLDrawer.drawXim loop:
   *
    *   blend submesh : BLEND(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, FUNC_ADD), depthMask off,
    *                   POLYGON_OFFSET_FILL polygonOffset(-zBias, 1)   [zBias = 5],
    *                   depthFunc LEQUAL when zoneBlendLequal (default) else LESS
    *   opaque submesh: BLEND off, depthMask on, no polygon offset, depthFunc LESS
    *   culling       : on (frontFace CW, cull BACK) unless the 0x2000 flag is set
    *   discard       : 0.375 for '_' meshes, else none
    *
    * No global opaque/translucent split and no reordering: FFXI authored the DAT
    * order so overlay/decal submeshes composite over the surfaces drawn before
    * them. Sorting or bucketing here is exactly what breaks that layering.
    */
  _rebuildZoneSpinners() {
    const gl = this.gl;
    for (const b of this.zoneSpinnerBatches) {
      gl.deleteBuffer(b.vbo);
      if (b.vao) gl.deleteVertexArray(b.vao);
    }
    this.zoneSpinnerBatches = [];
    const spinners = this.model?.zoneSpinners;
    if (!spinners?.length) return;
    for (const sp of spinners) {
      const angle = this.zoneSpinnerAngle * (sp.spinY || 0);
      for (const draw of bakeSpinnerDraws(sp, angle)) {
        const batch = this.buildZoneBatch(draw);
        if (batch) this.zoneSpinnerBatches.push(batch);
      }
    }
  }

  _drawZoneSpinners(viewProj, eye, fogFar) {
    if (!this.zoneSpinnerBatches.length) return;
    const saved = this.zoneBatches;
    this.zoneBatches = this.zoneSpinnerBatches;
    this._drawZone(viewProj, eye, fogFar);
    this.zoneBatches = saved;
  }

  _drawZone(viewProj, eye, fogFar) {
    const gl = this.gl;
    if (this.zoneBatches.length === 0) return;

    const usePolyMode = this.showWireframe && this.polygonMode;
    if (usePolyMode) {
      this.polygonMode.polygonModeWEBGL(gl.FRONT_AND_BACK, this.polygonMode.LINE_WEBGL);
    }

    gl.useProgram(this.zoneProgram);
    gl.uniformMatrix4fv(this.zoneUniforms.viewProj, false, viewProj);
    gl.uniform1i(this.zoneUniforms.texture, 0);
    this._uploadPointLights(this.zoneUniforms);
    gl.uniform3fv(this.zoneUniforms.cameraPos, eye);
    gl.uniform3fv(this.zoneUniforms.fogColor, this.fog.color);
    gl.uniform2f(this.zoneUniforms.fogRange, this.fog.near, fogFar);

    const L = this._zoneLightUniforms();
    gl.uniform3fv(this.zoneUniforms.ambient, L.ambient);
    gl.uniform3fv(this.zoneUniforms.sunDir, L.sunDir);
    gl.uniform3fv(this.zoneUniforms.sunColor, L.sunColor);
    gl.uniform3fv(this.zoneUniforms.moonDir, L.moonDir);
    gl.uniform3fv(this.zoneUniforms.moonColor, L.moonColor);
    gl.uniform1f(this.zoneUniforms.lightGain, this.lightGain ?? 1);
    this._bindShadowUniforms(this.zoneUniforms);

    const alphaOn = !!this.showAlpha;
    gl.uniform1f(this.zoneUniforms.showAlpha, alphaOn ? 1 : 0);
    gl.uniform3f(this.zoneUniforms.center, 0, 0, 0);   // world geometry is not camera-centred
    gl.uniform2f(this.zoneUniforms.uvOffset, 0, 0);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.frontFace(gl.CW);
    gl.cullFace(gl.BACK);
    gl.activeTexture(gl.TEXTURE0);

    // Track state so identical consecutive draws don't re-issue GL calls.
    let curBlend = null, curCull = null, curBias = null, curDiscard = null, curWind = null, curTex = null;
    let curDepthFunc = gl.LESS;

    for (const batch of this.zoneBatches) {
      // Unplaced orphans (layer 'unplaced') sit at the origin — optional debug.
      if (batch.layer === 'unplaced' && !this.showUnplaced) continue;
      // Sky/water shells and 0x05 effects are not in this list (particle system).

      // Alpha toggled off in the viewer: draw blend submeshes as solids.
      const blend = alphaOn && batch.blend;
      if (blend !== curBlend) {
        if (blend) {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.blendEquation(gl.FUNC_ADD);
          gl.depthMask(false);
        } else {
          gl.disable(gl.BLEND);
          gl.depthMask(true);
        }
        curBlend = blend;
      }

      // Blend overlays are often coplanar with the opaque base. LEQUAL keeps
      // equal-depth fragments; LESS rejects them (looks like "broken blending").
      const depthFunc = (blend && this.zoneBlendLequal) ? gl.LEQUAL : gl.LESS;
      if (depthFunc !== curDepthFunc) {
        gl.depthFunc(depthFunc);
        curDepthFunc = depthFunc;
      }

      const cull = !batch.noCull && !this.zoneDisableCull;
      if (cull !== curCull) {
        if (cull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
        curCull = cull;
      }

      const bias = batch.zBias;
      if (bias !== curBias) {
        if (bias) {
          gl.enable(gl.POLYGON_OFFSET_FILL);
          gl.polygonOffset(-bias, 1);
        } else {
          gl.disable(gl.POLYGON_OFFSET_FILL);
        }
        curBias = bias;
      }

      const discard = alphaOn ? batch.discard : 0;
      if (discard !== curDiscard) {
        gl.uniform1f(this.zoneUniforms.discard, discard);
        curDiscard = discard;
      }

      const wind = batch.wind ? this.windFactor : 0;
      if (wind !== curWind) {
        gl.uniform1f(this.zoneUniforms.wind, wind);
        curWind = wind;
      }

      const tex = (this.showTextures && batch.texture) ? batch.texture : this.whiteTexture;
      if (tex !== curTex) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        curTex = tex;
      }

      gl.bindVertexArray(batch.vao);
      gl.drawArrays(gl.TRIANGLES, 0, batch.count);
    }

    if (curDepthFunc !== gl.LESS) gl.depthFunc(gl.LESS);

    if (usePolyMode) {
      this.polygonMode.polygonModeWEBGL(gl.FRONT_AND_BACK, this.polygonMode.FILL_WEBGL);
    }
  }

  // --- Live particle system (xim ParticleDrawer) ---------------------------

  /**
   * Attach the zone's particle system. The renderer owns the per-frame step so
   * the simulation advances on the same clock as the rest of the scene, and the
   * camera adapter lives here because only the renderer knows the view matrix.
   *
   * Particle maths runs in raw DAT space while the scene is drawn in display
   * space (−x, −y, z); that mapping is a 180° rotation about Z and is its own
   * inverse, so the adapter uses it in both directions.
   */
  setParticleSystem(system, environment = null) {
    this.particleSystem = system;
    this.particleEnvironment = environment;
    if (!system) return;
    system.effectDistanceScale = this.effectDistanceScale ?? 1;

    const self = this;
    system.getActorAttachPosition = (jointRef, attach) => self.getActorAttachPosition(jointRef, attach);
    system.getActorAttachTransform = (jointRef, attach) => self.getActorAttachTransform(jointRef, attach);
    // GroundProjection (0x42) / decal: entity floor plane in particle DAT Y.
    // Zones keep null until real terrain queries exist; bare effect stage = y0.
    system.floorQuery = (pos) => {
      if (self.model?.kind === 'zone') return null;
      if (self.model && self.pose && self.floorY != null) return self.floorY;
      return 0;
    };
    system.camera = this._particleCameraAdapter();
  }

  /** The particle engine's view of the live camera (see setParticleSystem). */
  _particleCameraAdapter() {
    const toDat = (v) => new Vec3(-v.x, -v.y, v.z);
    const self = this;
    return {
      getPosition() {
        const e = self.camera.eye;
        return toDat(new Vec3(e[0], e[1], e[2]));
      },
      getViewVector() {
        const f = self.camera.forward;
        return toDat(new Vec3(f[0], f[1], f[2])).normalizeInPlace();
      },
      /**
       * xim reads the camera basis straight off the view matrix rows
       * (lookAtLeft / lookAtUp / lookAtForward). Note "forward" there is the
       * look-at *direction* vector, which points from the target back toward the
       * eye — deriving these from the true forward vector instead flips X and Z
       * and throws camera-attached effects to the wrong side of the viewer.
       */
      getBasis() {
        const m = self.camera.viewMatrix();
        return {
          left: toDat(new Vec3(m[0], m[4], m[8])),
          up: toDat(new Vec3(m[1], m[5], m[9])),
          forward: toDat(new Vec3(m[2], m[6], m[10])),
        };
      },
      getFoV: () => self.camera.fov ?? (Math.PI / 4),
      toCameraSpace(v) {
        const e = self.camera.eye;
        return toDat(new Vec3(e[0], e[1], e[2])).sub(v).scaleInPlace(-1);
      },
    };
  }

  /**
   * Advance the game clock, the weather cross-fade and the particle simulation.
   * Runs before any drawing so terrain, sky and particles all read the same
   * environment for this frame — otherwise fog lags the sky by one frame during
   * a weather change and the transition visibly tears.
   */
  _updateEnvironment(dtSeconds) {
    const system = this.particleSystem;
    if (!system) return;

    // The FFXI effect engine ticks at 60 frames per second (see particle/math.js
    // FPS); clamp so a stalled tab doesn't fast-forward every effect on the next
    // frame (8 frames ≈ 133 ms, same real-time tolerance as before).
    let elapsedFrames = Math.min(8, Math.max(0, (dtSeconds || 1 / 60) * 60));

    // Effect playback (empty stage or on-actor): Stop freezes the sim; Speed
    // scales particles and the routine schedule. Armed via playEffectRoutine.
    if (this.effectMode || this.particleSystem?._effect) {
      if (this.effectPaused) return;
      elapsedFrames *= this.effectSpeed ?? 1;
    }

    const env = this.particleEnvironment;
    if (env) {
      env.update(elapsedFrames, { advanceClock: this.advanceGameClock === true });

      // xim SkyBoxMesh.isExpired: the dome is rebuilt when the clock has moved
      // more than a game-minute, and continuously while weather cross-fades.
      // Without the time check the sky and its lighting stay frozen at whatever
      // hour the zone loaded at.
      const tod = env.clock.currentTimeOfDayInSeconds();
      const stale = this._skyBuiltAt == null || tod < this._skyBuiltAt || tod > this._skyBuiltAt + 60;
      if (env.weatherTransition || stale) {
        this.setTerrainLighting(env.getTerrainLighting());
        this.setSkyDome(env.getSkyDome());
        this._skyBuiltAt = tod;
      }
    }

    system.update(elapsedFrames);
    this.weatherAudio?.update();
  }

  _drawParticles() {
    // Not gated on showSkybox: water, spray and fountains are world effects, and
    // hiding the sky shouldn't drain the sea. View > Toggle Effects hides them.
    if (this.showEffects === false) return;
    const system = this.particleSystem;
    const actorFx = this.actors.filter((a) => a.visible && a.fx?.system);
    if (!system && !actorFx.length) return;
    if (!this.particleDrawer) this.particleDrawer = new ParticleDrawer(this.gl);
    this.particleDrawer.setTextures(this.textures);

    const drawSystem = (sys) => this.particleDrawer.draw({
      system: sys,
      view: this.camera.viewMatrix(),
      // Must be the same projection the zone pass used, Explorer offset and all.
      proj: this.projMatrix,
      // Same light gain the zone pass applies, so a generator-drawn zone mesh
      // (Xarcabard's cave mouths re-draw x_cave_* over the placement) matches
      // the static geometry it sits on.
      lighting: { ...this._zoneLightUniforms(), gain: this.lightGain ?? 1 },
      fog: this.fog,
      showTextures: this.showTextures,
      canvasWidth: this.gl.drawingBufferWidth,
      canvasHeight: this.gl.drawingBufferHeight,
    });
    let stats = null;
    if (system) {
      drawSystem(system);
      stats = this.particleDrawer.lastStats;
    }
    // Zone actors' own routines, composited after the weather pass. Their
    // screen flashes are skipped: a flash is a full-screen event, not a prop.
    for (const a of actorFx) {
      drawSystem(a.fx.system);
      if (stats) {
        stats.drawn += this.particleDrawer.lastStats.drawn;
        stats.particles += this.particleDrawer.lastStats.particles;
      }
    }
    if (stats) this.particleDrawer.lastStats = stats;
    if (system) this.particleDrawer.drawScreenFlashes(system.getScreenFlashes());
  }

  getParticleStats() {
    return {
      ...(this.particleDrawer?.lastStats ?? { drawn: 0, particles: 0 }),
      live: this.particleSystem?.effectManager.countParticles() ?? 0,
    };
  }

  /**
   * Sky dome (xim: drawn first, depth-write off). We also disable the depth
   * test and centre the dome on the camera, so it always fills the background
   * and wraps the free-fly camera regardless of zone extent. Everything drawn
   * after paints over it.
   */
  _drawSky(viewProj, eye) {
    if (!this.skyDome) return;
    const gl = this.gl;
    gl.useProgram(this.skyProgram);
    gl.uniformMatrix4fv(this.skyUniforms.viewProj, false, viewProj);
    gl.uniform3fv(this.skyUniforms.center, eye);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.skyDome.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.skyDome.count);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  }

  /**
   * Live Selection overlays: AABB wireframes + optional XYZ grabber at a point.
   * @param {{
   *   hover?: {min:number[], max:number[]}|null,
   *   selected?: {min:number[], max:number[]}|null,
   *   gizmo?: { pos:number[], size?: number }|null,
   * }|null} boxes
   */
  setZonePickHighlight(boxes) {
    const gl = this.gl;
    this._freeOverlay(this.zonePickOverlay);
    this.zonePickOverlay = null;
    this.zoneGizmo = null;
    if (!boxes) return;
    const verts = [];
    const pushBox = (b, rgb) => {
      if (!b?.min || !b?.max) return;
      const [x0, y0, z0] = b.min;
      const [x1, y1, z1] = b.max;
      if (![x0, y0, z0, x1, y1, z1].every(Number.isFinite)) return;
      const c = [
        [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
        [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
      ];
      const edges = [
        [0, 1], [1, 2], [2, 3], [3, 0],
        [4, 5], [5, 6], [6, 7], [7, 4],
        [0, 4], [1, 5], [2, 6], [3, 7],
      ];
      const [r, g, bcol] = rgb;
      for (const [a, bi] of edges) {
        const pa = c[a]; const pb = c[bi];
        verts.push(pa[0], pa[1], pa[2], r, g, bcol, pb[0], pb[1], pb[2], r, g, bcol);
      }
    };
    // Selected first so hover drawn after can sit on top when they overlap.
    pushBox(boxes.selected, [1.0, 0.78, 0.25]);
    pushBox(boxes.hover, [0.35, 0.85, 1.0]);
    if (verts.length) {
      const data = new Float32Array(verts);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      gl.bindVertexArray(null);
      this.zonePickOverlay = { vao, vbo, count: data.length / 6, mode: 'lines' };
    }

    const gz = boxes.gizmo;
    if (gz?.pos && gz.pos.length >= 3 && gz.pos.every(Number.isFinite)) {
      this.zoneGizmo = {
        pos: [gz.pos[0], gz.pos[1], gz.pos[2]],
        size: Number.isFinite(gz.size) && gz.size > 0 ? gz.size : null,
        // 'x'|'y'|'z' — hover or active drag axis for highlight
        hoverAxis: gz.hoverAxis || gz.activeAxis || null,
        activeAxis: gz.activeAxis || null,
      };
      this._ensureGizmoMesh();
    }
  }

  /** Per-axis solid grabber meshes (base + hot), built once. */
  _ensureGizmoMesh() {
    if (this.gizmoParts) return;
    const gl = this.gl;
    const meshes = buildSolidGizmoMeshes();
    const upload = (data) => {
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      gl.bindVertexArray(null);
      return { vao, vbo, count: data.length / 6 };
    };
    this.gizmoParts = {
      x: upload(meshes.x),
      y: upload(meshes.y),
      z: upload(meshes.z),
      center: upload(meshes.center),
      xHot: upload(meshes.xHot),
      yHot: upload(meshes.yHot),
      zHot: upload(meshes.zHot),
    };
  }

  /** Current world size of the active gizmo (for hit-testing). */
  getZoneGizmo() {
    if (!this.zoneGizmo) return null;
    return {
      ...this.zoneGizmo,
      size: gizmoSize(this, this.zoneGizmo),
    };
  }

  /** Update hover axis without rebuilding AABB overlays. */
  setGizmoHoverAxis(axis) {
    if (!this.zoneGizmo) return;
    const next = axis || null;
    if (this.zoneGizmo.hoverAxis === next) return;
    this.zoneGizmo.hoverAxis = next;
  }

  /**
   * Replace zone GPU batches from model.zoneDraws (after a placement rebuild).
   * Keeps textures / collision / particle system intact.
   */
  reloadZoneBatches(model) {
    const gl = this.gl;
    for (const b of this.zoneBatches) {
      gl.deleteBuffer(b.vbo);
      if (b.vao) gl.deleteVertexArray(b.vao);
    }
    this.zoneBatches = [];
    if (model?.kind !== 'zone') return;
    for (const draw of model.zoneDraws ?? []) {
      const batch = this.buildZoneBatch(draw);
      if (batch) this.zoneBatches.push(batch);
    }
    this._rebuildZoneSpinners();
  }

  /** Temporary geometry for the placement being dragged. */
  setZoneMoveProxy(draws) {
    const gl = this.gl;
    for (const b of this.zoneMoveProxy) {
      gl.deleteBuffer(b.vbo);
      if (b.vao) gl.deleteVertexArray(b.vao);
    }
    this.zoneMoveProxy = [];
    if (!draws?.length) return;
    for (const draw of draws) {
      const batch = this.buildZoneBatch(draw);
      if (batch) this.zoneMoveProxy.push(batch);
    }
  }

  _drawZoneMoveProxy(viewProj, eye, fogFar) {
    if (!this.zoneMoveProxy.length) return;
    // Reuse zone draw path by temporarily swapping batches.
    const saved = this.zoneBatches;
    this.zoneBatches = this.zoneMoveProxy;
    this._drawZone(viewProj, eye, fogFar);
    this.zoneBatches = saved;
  }

  _drawZonePickOverlay(viewProj) {
    const gl = this.gl;
    const o = this.zonePickOverlay;
    if (o) {
      gl.useProgram(this.overlayProgram);
      gl.uniformMatrix4fv(this.overlayUniforms.viewProj, false, viewProj);
      gl.uniform1f(this.overlayUniforms.opacity, 1);
      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-1, -1);
      gl.bindVertexArray(o.vao);
      gl.drawArrays(gl.LINES, 0, o.count);
      gl.bindVertexArray(null);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(0, 0);
      gl.depthMask(true);
    }

    const gz = this.zoneGizmo;
    if (!gz || !this.gizmoParts) return;
    const s = gizmoSize(this, gz);
    const hot = gz.activeAxis || gz.hoverAxis || null;
    const drawPart = (part, scaleMul = 1) => {
      if (!part) return;
      const sc = s * scaleMul;
      const model = new Float32Array([
        sc, 0, 0, 0,
        0, sc, 0, 0,
        0, 0, sc, 0,
        gz.pos[0], gz.pos[1], gz.pos[2], 1,
      ]);
      const mvp = mat4Multiply(viewProj, model);
      gl.uniformMatrix4fv(this.overlayUniforms.viewProj, false, mvp);
      gl.bindVertexArray(part.vao);
      gl.drawArrays(gl.TRIANGLES, 0, part.count);
    };

    gl.useProgram(this.overlayProgram);
    gl.uniform1f(this.overlayUniforms.opacity, 1);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);

    // Center ball first, then axes (hot axis last + slightly larger).
    drawPart(this.gizmoParts.center, 1);
    for (const id of ['x', 'y', 'z']) {
      const isHot = hot === id;
      drawPart(this.gizmoParts[isHot ? `${id}Hot` : id], isHot ? 1.18 : 1);
    }

    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  }

  _drawOverlay(viewProj, overlay, opacity) {
    if (!overlay) return;
    const gl = this.gl;
    gl.useProgram(this.overlayProgram);
    gl.uniformMatrix4fv(this.overlayUniforms.viewProj, false, viewProj);
    gl.uniform1f(this.overlayUniforms.opacity, opacity);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -1); // sit just above the terrain
    gl.bindVertexArray(overlay.vao);
    gl.drawArrays(gl.TRIANGLES, 0, overlay.count);
    gl.bindVertexArray(null);
  }

  /**
   * Positional zone SFX markers (waterfalls, shoreline beds). DAT space →
   * display (−x,−y,z); in-range sources are cyan, out-of-range dim purple.
   */
  _drawSoundMarkers(viewProj) {
    const system = this.particleSystem;
    if (!system?.listSoundMarkers) return;
    const markers = system.listSoundMarkers();
    const gl = this.gl;
    const n = markers.length;
    this.markerCount = n;
    if (!n) return;

    const data = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const m = markers[i];
      const o = i * 6;
      data[o] = -m.x; data[o + 1] = -m.y; data[o + 2] = m.z;
      if (m.active) { data[o + 3] = 0.25; data[o + 4] = 0.95; data[o + 5] = 0.95; }
      else { data[o + 3] = 0.55; data[o + 4] = 0.35; data[o + 5] = 0.85; }
    }

    gl.bindVertexArray(this.markerVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.markerVbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);

    gl.useProgram(this.markerProgram);
    gl.uniformMatrix4fv(this.markerUniforms.viewProj, false, viewProj);
    gl.uniform1f(this.markerUniforms.pointSize, 18);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    // Keep markers visible through light geometry so you can find buried emitters.
    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.POINTS, 0, n);
    gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  }

  /**
   * Release every GL object this renderer owns, then drop the context.
   *
   * Nothing called this before, so each teardown leaked its buffers, VAOs,
   * textures and FBOs. The shipped app mounts once and exits, but React
   * StrictMode double-mounts in dev and HMR remounts on every edit, so a long
   * dev session accumulated a full set per cycle until the driver started
   * refusing allocations.
   *
   * Safe to call twice: every field is nulled and the guard returns early.
   */
  dispose() {
    this.clearActors();
    if (this._disposed) return;
    this._disposed = true;
    const gl = this.gl;

    // Geometry: the batch arrays, including the two that get swapped into
    // zoneBatches during a drag (setZoneMoveProxy frees its own).
    const freeBatches = (arr) => {
      for (const b of arr || []) {
        if (b.vbo) gl.deleteBuffer(b.vbo);
        if (b.wireEbo) gl.deleteBuffer(b.wireEbo);
        if (b.vao) gl.deleteVertexArray(b.vao);
      }
    };
    this.setZoneMoveProxy(null);
    freeBatches(this.batches);
    freeBatches(this.zoneBatches);
    freeBatches(this.zoneSpinnerBatches);
    this.batches = [];
    this.zoneBatches = [];
    this.zoneSpinnerBatches = [];

    // Lazily-built overlay meshes — all { vao, vbo }.
    for (const key of [
      'axesLines', 'gridLines', 'pathLines', 'skeletonLines',
      'collisionOverlay', 'navmeshOverlay', 'zonePickOverlay', 'skyDome',
    ]) {
      this._freeOverlay(this[key]);
      this[key] = null;
    }
    for (const part of Object.values(this.gizmoParts || {})) this._freeOverlay(part);
    this.gizmoParts = null;

    // Fixed meshes built in the constructor.
    for (const [vao, vbo] of [
      ['floorVao', 'floorVbo'], ['markerVao', 'markerVbo'], ['bgVao', 'bgVbo'],
    ]) {
      if (this[vao]) gl.deleteVertexArray(this[vao]);
      if (this[vbo]) gl.deleteBuffer(this[vbo]);
      this[vao] = null;
      this[vbo] = null;
    }

    // Textures: the model cache plus the standalone ones.
    for (const t of this.textures.values()) gl.deleteTexture(t);
    this.textures.clear();
    this.modelTextureNames.clear();
    for (const key of ['whiteTexture', 'flatFloorTex', 'shadowDummyTex']) {
      if (this[key]) gl.deleteTexture(this[key]);
      this[key] = null;
    }
    if (this.bgImage?.texture) gl.deleteTexture(this.bgImage.texture);
    this.bgImage = null;
    if (this.floor?.texture) gl.deleteTexture(this.floor.texture);
    this.floor = null;

    // Shadow cascade render targets.
    for (const t of this.shadowTargets || []) {
      if (t.tex) gl.deleteTexture(t.tex);
      if (t.fbo) gl.deleteFramebuffer(t.fbo);
    }
    this.shadowTargets = [];

    this.particleDrawer?.dispose();
    this.particleDrawer = null;
    this.particleSystem = null;

    for (const key of [
      'program', 'zoneProgram', 'shadowZoneProgram', 'shadowEntityProgram',
      'floorProgram', 'overlayProgram', 'markerProgram', 'skyProgram', 'bgProgram',
    ]) {
      if (this[key]) gl.deleteProgram(this[key]);
      this[key] = null;
    }

    this.model = null;
    this.pose = null;
    this.currentAnimation = null;

    // Deliberately NOT calling WEBGL_lose_context.loseContext(): the canvas
    // element outlives the renderer (same canvasRef across a remount), and a
    // lost context stays lost for that canvas — the next Renderer() then fails
    // in buildProgram with a null shader. Releasing the objects above is the
    // cleanup; the context belongs to the canvas, not to us.
  }
}

/**
 * Whether a piece with this render displayType is hidden by the set of
 * occludeTypes declared across all equipped meshes (xim ActorModel.isOccluded).
 * displayType: 1/2/3 = hair, 4 = face, 5 = wrist, 6 = pants, 7 = shins.
 * (0x11/0x21/0x31 are body/legs/feet self-markers and hide nothing.)
 */
function occludesDisplayType(displayType, occl) {
  switch (displayType) {
    case 1: return occl.has(0x02) || occl.has(0x03) || occl.has(0x04) || occl.has(0x05) || occl.has(0x06);
    case 2:
    case 3: return occl.has(0x04) || occl.has(0x05) || occl.has(0x06);
    case 4: return occl.has(0x05);
    case 5: return occl.has(0x12);
    case 6: return occl.has(0x32);
    case 7: return occl.has(0x22);
    default: return false;
  }
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16 & 0xff) / 255, (v >> 8 & 0xff) / 255, (v & 0xff) / 255];
}

// ---------------------------------------------------------------------------

function buildProgram(gl, vsSource, fsSource) {
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vsSource));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program));
  return program;
}

function makeWhiteTexture(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return tex;
}

/** CPU fallback DXT1/DXT3 decode (standard block layout). */
function decodeDxt(data, width, height, variant) {
  const out = new Uint8Array(width * height * 4);
  const blocksX = Math.max(width >> 2, 1);
  const blocksY = Math.max(height >> 2, 1);
  const blockBytes = variant === 1 ? 8 : 16;

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const off = (by * blocksX + bx) * blockBytes;
      const colorOff = variant === 1 ? off : off + 8;

      const c0 = data[colorOff] | (data[colorOff + 1] << 8);
      const c1 = data[colorOff + 2] | (data[colorOff + 3] << 8);
      const indices = data[colorOff + 4] | (data[colorOff + 5] << 8) | (data[colorOff + 6] << 16) | (data[colorOff + 7] << 24);

      const r0 = ((c0 >> 11) & 31) * 255 / 31, g0 = ((c0 >> 5) & 63) * 255 / 63, b0 = (c0 & 31) * 255 / 31;
      const r1 = ((c1 >> 11) & 31) * 255 / 31, g1 = ((c1 >> 5) & 63) * 255 / 63, b1 = (c1 & 31) * 255 / 31;

      const palette = [[r0, g0, b0, 255], [r1, g1, b1, 255]];
      if (variant === 1 && c0 <= c1) {
        palette.push([(r0 + r1) / 2, (g0 + g1) / 2, (b0 + b1) / 2, 255], [0, 0, 0, 0]);
      } else {
        palette.push(
          [(2 * r0 + r1) / 3, (2 * g0 + g1) / 3, (2 * b0 + b1) / 3, 255],
          [(r0 + 2 * r1) / 3, (g0 + 2 * g1) / 3, (b0 + 2 * b1) / 3, 255],
        );
      }

      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px, y = by * 4 + py;
          if (x >= width || y >= height) continue;
          const pi = py * 4 + px;
          const c = palette[(indices >>> (pi * 2)) & 3];
          const o = (y * width + x) * 4;
          out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
          out[o + 3] = variant === 3
            ? (((readAlpha4(data, off, pi)) * 17))
            : c[3];
        }
      }
    }
  }
  return out;
}

function readAlpha4(data, blockOff, pixelIndex) {
  const byte = data[blockOff + (pixelIndex >> 1)];
  return pixelIndex & 1 ? (byte >> 4) & 0xf : byte & 0xf;
}

/**
 * Decodes a parsed texture ({ format, data, width, height }) to RGBA bytes for
 * 2D canvas display (texture viewer). FFXI stores opaque as 0x80, not 0xFF —
 * the GL shader doubles alpha at draw time; bake that same ×2 here so opaque
 * texels aren't ~50% see-through on the checkerboard (xi DEFAULT_ALPHA_SCALE).
 */
export function decodeTextureRGBA(tex) {
  const raw = tex.format === 'rgba32'
    ? tex.data
    : decodeDxt(tex.data, tex.width, tex.height, tex.format === 'dxt1' ? 1 : 3);
  return scaleAlpha2x(raw);
}

/** Multiply every alpha byte by 2, clamped to 255 (FFXI half-scale → display). */
function scaleAlpha2x(rgba) {
  const out = rgba instanceof Uint8Array ? new Uint8Array(rgba) : new Uint8Array(rgba);
  for (let i = 3; i < out.length; i += 4) out[i] = Math.min(255, out[i] * 2);
  return out;
}
