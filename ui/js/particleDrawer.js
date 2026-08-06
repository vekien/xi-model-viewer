// GPU pass for the particle system — port of xim ParticleDrawer + the
// drawXimParticle half of GLDrawer, using XimParticleShader.
//
// Zone geometry is baked into display space (−x, −y, z) by zoneModel.js, but the
// particle simulation runs in raw DAT space because every offset, velocity and
// spawn shell in the format is authored there. (−x, −y, z) happens to be a plain
// 180° rotation about Z, so a single pre-multiply moves a particle's model
// matrix into display space with normals still correct.

import { Mat4, Vec3 } from './particle/math.js';
import { BlendFunc, LinkedDataType } from './particle/types.js';
import { resolveTexture } from './zone.js';

const VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
layout(location=3) in vec4 aColor;

uniform mat4 uProjMatrix;
uniform mat4 uModelMatrix;      // display-space model matrix (for world lighting)
uniform mat4 uModelViewMatrix;

uniform float uComputeLighting;
uniform vec4  uAmbientColor;
uniform vec3  uLight0Dir;
uniform vec4  uLight0Color;
uniform vec3  uLight1Dir;
uniform vec4  uLight1Color;

out vec2 vUV;
out vec4 vColor;
out vec4 vCameraSpacePos;

vec4 diffuseCalc(vec3 n, vec4 vertexColor, vec3 dir, vec4 color) {
  return vertexColor * clamp(dot(n, dir), 0.0, 1.0) * color;
}

void main() {
  vUV = aUV;
  vec4 cameraSpacePosition = uModelViewMatrix * vec4(aPos, 1.0);
  vCameraSpacePos = cameraSpacePosition;

  if (uComputeLighting > 0.0) {
    mat3 invTransModel = transpose(inverse(mat3(uModelMatrix)));
    vec3 worldNormal = normalize(invTransModel * aNormal);
    vec4 ambient = aColor * uAmbientColor;
    vec4 d0 = diffuseCalc(worldNormal, aColor, uLight0Dir, uLight0Color);
    vec4 d1 = diffuseCalc(worldNormal, aColor, uLight1Dir, uLight1Color);
    vColor = clamp(vec4((ambient + d0 + d1).rgb, aColor.a), 0.0, 1.0);
  } else {
    vColor = aColor;
  }

  gl_Position = uProjMatrix * cameraSpacePosition;
}
`;

// Two fixed-function stages, exactly as XimParticleShader:
//   stage0 = 2 * (vertexColor * texel)
//   stage1 = (2 * stage0.rgb * tf.rgb, 4 * stage0.a * tf.a)
// The doubled multipliers are why FFXI vertex colours sit around 0x80 for
// "neutral"; dropping them washes every effect out.
const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vUV;
in vec4 vColor;
in vec4 vCameraSpacePos;

uniform sampler2D uTexture;
uniform vec2  uTexTranslate;
uniform vec4  uTextureFactor;
uniform float uIgnoreTextureAlpha;
uniform float uDiscardThreshold;

uniform float uComputeFog;
uniform vec2  uFogRange;      // (near, far)
uniform vec4  uFogColor;

out vec4 outColor;

void main() {
  vec4 texel = texture(uTexture, uTexTranslate + vUV);
  if (uIgnoreTextureAlpha > 0.0) texel.a = 0.5;

  vec4 stage0 = 2.0 * (vColor * texel);
  vec4 stage1 = vec4(2.0 * stage0.rgb * uTextureFactor.rgb, 4.0 * stage0.a * uTextureFactor.a);

  if (stage1.a < uDiscardThreshold) discard;

  if (uComputeFog > 0.0) {
    float d = length(vCameraSpacePos.xyz);
    float f = clamp((uFogRange.y - d) / (uFogRange.y - uFogRange.x), 0.0, 1.0);
    outColor = vec4(stage1.rgb * f + uFogColor.rgb * (1.0 - f), stage1.a);
  } else {
    outColor = stage1;
  }
}
`;

// Lens flare. FFXI doesn't draw the flare in the world — it draws the sprite
// sheet in screen space, strung along the vector from the sun/moon's screen
// position through the centre of the view, with each sprite's position given by
// the per-sprite offset stored in the sheet. That's why the streaks sweep across
// the screen as you turn: they're a 2D construction, not geometry.
// xim sizes flare sprites at screenSize/32 pixels per sprite unit. In NDC that
// works out to local/16 on both axes regardless of resolution, and the particle's
// own scale is deliberately not involved. uDepth carries the source's NDC depth
// so the occlusion probe tests where the sun actually is.
const FLARE_SPRITE_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;      // sprite-local quad corner
layout(location=2) in vec2 aUV;
layout(location=3) in vec4 aColor;
uniform vec2 uCenter;                 // NDC position for this sprite
uniform vec2 uScale;                  // NDC units per sprite unit (y flipped)
uniform float uDepth;                 // NDC z
out vec2 vUV;
out vec4 vColor;
void main() {
  vUV = aUV;
  vColor = aColor;
  gl_Position = vec4(uCenter + aPos.xy * uScale, uDepth, 1.0);
}
`;

const FLARE_SPRITE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUV;
in vec4 vColor;
uniform sampler2D uTexture;
uniform vec4 uTextureFactor;
out vec4 outColor;
void main() {
  vec4 texel = texture(uTexture, vUV);
  vec4 stage0 = 2.0 * (vColor * texel);
  outColor = vec4(2.0 * stage0.rgb * uTextureFactor.rgb, 4.0 * stage0.a * uTextureFactor.a);
}
`;

// xim ScreenFlasher: lightning adds a full-screen wash whose strength comes from
// how close and how central the bolt is (ScreenFlashApplier).
const FLASH_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FLASH_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main() { outColor = uColor; }
`;

function buildProgram(gl, vsSrc, fsSrc) {
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(`particle shader: ${gl.getShaderInfoLog(s)}`);
    }
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`particle program: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

/** (−x, −y, z): a 180° rotation about Z, so it is orthonormal with det +1. */
const DISPLAY_ROT = new Mat4();
DISPLAY_ROT.m[0] = -1; DISPLAY_ROT.m[5] = -1; DISPLAY_ROT.m[10] = 1;

/**
 * xim draws flare sprites at screenSize/32 pixels per sprite unit. Converting to
 * NDC: pixels / (screenSize / 2) = unit * 2 / 32, i.e. 1/16 — resolution
 * independent, and notably not scaled by the particle's own scale.
 */
const FLARE_NDC_PER_UNIT = 1 / 16;

/** Near-plane escape factor for screen-anchored (camera-space) particles. */
const OVERLAY_SCALE = 50;

/**
 * xim Matrix4f.lookAtNegZ upper 3×3 is diag(−1, 1, −1) — a 180° turn about Y,
 * det +1. It is expressed in xim's camera space, which is Y-down like the rest
 * of that engine; ours is Y-up.
 *
 * The XYZ billboard *replaces* the model-view 3×3 outright, so unlike the
 * mesh/None path it never sees the DISPLAY_ROT that maps DAT space into our
 * display space. It therefore has to carry that mapping itself:
 *
 *     DISPLAY_ROT · lookAtNegZ = diag(−1,−1,1) · diag(−1,1,−1) = diag(1, −1, −1)
 *
 * det stays +1, so this is still a pure rotation (180° about X). That matters:
 * negating Y alone gives diag(−1,−1,−1), det −1, which is a *reflection* — it
 * puts the text the right way up but back-to-front, so the sprite reads as
 * "Level Up!!" and "!!pU leveL" superimposed. Check the determinant, not just
 * which way is up.
 *
 * Sanity check against the real lvu1 quad (image-left at local −X, image-top at
 * local −Y): local (−8,−2) → camera (−8,+2) = screen left/top. Correct.
 */
const LOOK_AT_NEG_Z = new Mat4();
LOOK_AT_NEG_Z.m[0] = 1; LOOK_AT_NEG_Z.m[5] = -1; LOOK_AT_NEG_Z.m[10] = -1;

export class ParticleDrawer {
  constructor(gl) {
    this.gl = gl;
    this.program = buildProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.u = {
      proj: gl.getUniformLocation(this.program, 'uProjMatrix'),
      model: gl.getUniformLocation(this.program, 'uModelMatrix'),
      modelView: gl.getUniformLocation(this.program, 'uModelViewMatrix'),
      computeLighting: gl.getUniformLocation(this.program, 'uComputeLighting'),
      ambient: gl.getUniformLocation(this.program, 'uAmbientColor'),
      light0Dir: gl.getUniformLocation(this.program, 'uLight0Dir'),
      light0Color: gl.getUniformLocation(this.program, 'uLight0Color'),
      light1Dir: gl.getUniformLocation(this.program, 'uLight1Dir'),
      light1Color: gl.getUniformLocation(this.program, 'uLight1Color'),
      texture: gl.getUniformLocation(this.program, 'uTexture'),
      texTranslate: gl.getUniformLocation(this.program, 'uTexTranslate'),
      textureFactor: gl.getUniformLocation(this.program, 'uTextureFactor'),
      ignoreTextureAlpha: gl.getUniformLocation(this.program, 'uIgnoreTextureAlpha'),
      discardThreshold: gl.getUniformLocation(this.program, 'uDiscardThreshold'),
      computeFog: gl.getUniformLocation(this.program, 'uComputeFog'),
      fogRange: gl.getUniformLocation(this.program, 'uFogRange'),
      fogColor: gl.getUniformLocation(this.program, 'uFogColor'),
    };

    this.meshCache = new Map();     // mesh descriptor -> { vao, vbo, count, texName }
    this.textures = new Map();      // texture name -> GLTexture
    this.lastStats = { drawn: 0, particles: 0 };

    // xim binds a single-colour 0x80 texture for any mesh without one. 0x80 is
    // the *neutral* value in this pipeline — stage0 doubles the texel, so grey
    // maps to 1.0. Binding white instead makes every untextured particle twice
    // as bright in both colour and alpha, which is what turned the sun's
    // untextured additive dome into a screen-wide white-out.
    this.defaultTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.defaultTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0x80, 0x80, 0x80, 0x80]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.flareProgram = buildProgram(gl, FLARE_SPRITE_VERTEX_SHADER, FLARE_SPRITE_FRAGMENT_SHADER);
    this.flareU = {
      center: gl.getUniformLocation(this.flareProgram, 'uCenter'),
      scale: gl.getUniformLocation(this.flareProgram, 'uScale'),
      depth: gl.getUniformLocation(this.flareProgram, 'uDepth'),
      texture: gl.getUniformLocation(this.flareProgram, 'uTexture'),
      textureFactor: gl.getUniformLocation(this.flareProgram, 'uTextureFactor'),
    };
    // One occlusion query per flare source. WebGL2 only offers ANY_SAMPLES_PASSED
    // so visibility is binary rather than a coverage fraction — xim notes the
    // same limitation. Results are read a frame late, which is invisible in motion.
    this.flareQueries = new Map();

    this.flashProgram = buildProgram(gl, FLASH_VERTEX_SHADER, FLASH_FRAGMENT_SHADER);
    this.flashColor = gl.getUniformLocation(this.flashProgram, 'uColor');
    this.flashVao = gl.createVertexArray();
    gl.bindVertexArray(this.flashVao);
    this.flashVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flashVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  /** Additive full-screen wash for lightning (xim ScreenFlasher). */
  drawScreenFlashes(flashes) {
    if (!flashes?.length) return;
    const gl = this.gl;

    // Several bolts can flash at once; xim accumulates them into one wash.
    let r = 0, g = 0, b = 0, a = 0;
    for (const c of flashes) {
      const alpha = c.a();
      r += c.r() * alpha; g += c.g() * alpha; b += c.b() * alpha;
      a = Math.max(a, alpha);
    }
    if (a <= 0.001) return;

    gl.useProgram(this.flashProgram);
    gl.uniform4f(this.flashColor, Math.min(1, r), Math.min(1, g), Math.min(1, b), Math.min(1, a));
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.bindVertexArray(this.flashVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }

  setTextures(map) {
    this.textures = map;
    // Texture names are resolved per mesh and cached; a new zone invalidates them.
    for (const entry of this.meshCache.values()) entry.texResolved = undefined;
  }

  disposeMeshes() {
    const gl = this.gl;
    for (const entry of this.meshCache.values()) {
      gl.deleteBuffer(entry.vbo);
      gl.deleteVertexArray(entry.vao);
    }
    this.meshCache.clear();
  }

  dispose() {
    this.disposeMeshes();
    this.gl.deleteTexture(this.defaultTexture);
    for (const state of this.flareQueries.values()) {
      if (state.query) this.gl.deleteQuery(state.query);
    }
    this.flareQueries.clear();
    this.gl.deleteProgram(this.flareProgram);
    this.gl.deleteProgram(this.flashProgram);
    this.gl.deleteProgram(this.program);
  }

  #upload(mesh) {
    let entry = this.meshCache.get(mesh);
    if (entry) return entry;

    const gl = this.gl;
    const n = mesh.count;
    // Interleave into one buffer: pos(3f) normal(3f) uv(2f) colour(4ub).
    const stride = 3 * 4 + 3 * 4 + 2 * 4 + 4;
    const buf = new ArrayBuffer(n * stride);
    const f = new Float32Array(buf);
    const b = new Uint8Array(buf);
    for (let i = 0; i < n; i++) {
      const fo = (i * stride) / 4;
      f[fo] = mesh.positions[i * 3];
      f[fo + 1] = mesh.positions[i * 3 + 1];
      f[fo + 2] = mesh.positions[i * 3 + 2];
      f[fo + 3] = mesh.normals ? mesh.normals[i * 3] : 0;
      f[fo + 4] = mesh.normals ? mesh.normals[i * 3 + 1] : 1;
      f[fo + 5] = mesh.normals ? mesh.normals[i * 3 + 2] : 0;
      f[fo + 6] = mesh.uvs[i * 2];
      f[fo + 7] = mesh.uvs[i * 2 + 1];
      const bo = i * stride + 32;
      b[bo] = mesh.colors[i * 4];
      b[bo + 1] = mesh.colors[i * 4 + 1];
      b[bo + 2] = mesh.colors[i * 4 + 2];
      b[bo + 3] = mesh.colors[i * 4 + 3];
    }

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, buf, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, stride, 32);
    gl.bindVertexArray(null);

    entry = { vao, vbo, count: n, texName: mesh.textureName, texResolved: undefined };
    this.meshCache.set(mesh, entry);
    return entry;
  }

  #texture(entry) {
    if (entry.texResolved === undefined) {
      const key = entry.texName ? resolveTexture(entry.texName, this.textures) : null;
      entry.texResolved = key ? this.textures.get(key) : null;
    }
    return entry.texResolved ?? this.defaultTexture;
  }

  #setBlend(blendFunc, isDistortion) {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    switch (blendFunc) {
      case BlendFunc.One_Zero:
        gl.blendFunc(gl.ONE, gl.ZERO); gl.blendEquation(gl.FUNC_ADD); break;
      case BlendFunc.Src_InvSrc_Add:
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.blendEquation(gl.FUNC_ADD); break;
      case BlendFunc.Src_One_RevSub:
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE); gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT); break;
      case BlendFunc.Zero_InvSrc_Add:
        gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA); gl.blendEquation(gl.FUNC_ADD); break;
      case BlendFunc.Src_One_Add:
      default:
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE); gl.blendEquation(gl.FUNC_ADD); break;
    }
    if (isDistortion) gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  /**
   * @param {Object}  opts
   * @param {Object}  opts.system     ParticleSystem
   * @param {Float32Array} opts.view  display-space view matrix
   * @param {Float32Array} opts.proj  projection matrix
   * @param {Object}  opts.lighting   { ambient, sunDir, sunColor, moonDir, moonColor }
   * @param {Object}  opts.fog        { enabled, near, far, color }
   */
  draw({ system, view, proj, lighting, fog, showTextures = true }) {
    const gl = this.gl;
    const contexts = system.getAllParticles();
    this.lastStats = { drawn: 0, particles: contexts.length };
    if (!contexts.length) return;

    const viewMat = new Mat4(new Float32Array(view));

    // Static view for screen-anchored particles (localPositionInCameraSpace):
    // the camera's translation with NO rotation, looking fixed display −Z. xim
    // renders these through a StaticCamera at the viewer's position (radiance
    // FFXIEffectFacade:2195) so rank emblems and heat-haze panels hold their
    // place on screen instead of swinging with the orbit. eye = −Rᵀ·t off the
    // live view.
    const vm = viewMat.m;
    const ex = -(vm[0] * vm[12] + vm[1] * vm[13] + vm[2] * vm[14]);
    const ey = -(vm[4] * vm[12] + vm[5] * vm[13] + vm[6] * vm[14]);
    const ez = -(vm[8] * vm[12] + vm[9] * vm[13] + vm[10] * vm[14]);
    // Rotation diag(−1,1,−1) — xim's lookAtNegZ used RAW, not composed with
    // DISPLAY_ROT the way the billboard constant is: the DISPLAY-composed form
    // diag(1,−1,−1) x-mirrored the sprite LAYOUT ("RANK 3" read "3 KNAR" —
    // glyphs looked fine because XYZ billboarding replaces the rotation block,
    // so only the translations mirrored). Empirically pinned on that text:
    // screen-x = +DAT-x, DAT +Z in front, det +1. An identity rotation is also
    // wrong — it puts the +Z offsets behind the camera (w < 0, nothing drawn).
    const staticView = new Mat4();
    staticView.m[0] = -1; staticView.m[5] = 1; staticView.m[10] = -1;
    staticView.m[12] = ex; staticView.m[13] = -ey; staticView.m[14] = ez;

    const commands = [];
    const flares = [];

    for (const { particle, opacity } of contexts) {
      if (particle.isExpired() || particle.drawDistanceCulled) continue;
      if (!particle.hasMeshes()) continue;
      // Point lights and audio-only particles have no geometry to draw.
      if (particle.config.linkedDataType === LinkedDataType.PointLight) continue;

      // Lens flares are not world geometry — collected here, drawn in screen
      // space by #drawLensFlares once the depth buffer is complete.
      if (particle.isLensFlare()) { flares.push({ particle, opacity }); continue; }

      // Same story: these are only drawn when their occlusion query passes.
      if (particle.occlusionSettings) continue;

      const meshes = particle.getMeshes();
      if (!meshes.length) continue;

      const model = new Mat4();
      particle.getWorldSpaceTransform().multiply(particle.getParticleSpaceOrientationTransform(), model);
      DISPLAY_ROT.multiply(model, model);

      const cameraSpace = particle.config.localPositionInCameraSpace;
      const activeView = cameraSpace ? staticView : viewMat;
      const modelView = new Mat4();
      activeView.multiply(model, modelView);

      this.#applyBillboard(particle, activeView, modelView);

      // Screen overlays are authored millimetres from the eye — Bastok Rank's
      // sprites sit 0.02 units out, inside the 0.05 near plane, so they clipped
      // to nothing. Uniformly scaling the finished camera-space transform is
      // invisible under perspective (x/z, y/z unchanged) but moves them past
      // the near plane. Done AFTER the billboard, which replaces the rotation
      // block and would otherwise shed the scale — position ×50 with geometry
      // at ×1 renders as sub-pixel dots.
      if (cameraSpace) {
        const m = modelView.m;
        for (let i = 0; i < 15; i++) if ((i & 3) !== 3) m[i] *= OVERLAY_SCALE;
      }

      const textureFactor = particle.getColor().withMultipliedAlpha(opacity).clamp();
      const distance = Math.hypot(modelView.m[12], modelView.m[13], modelView.m[14]);

      commands.push({
        particle, meshes, model, modelView, textureFactor, distance,
        priority: this.#priority(particle, distance),
        subParticles: particle.subParticles,
      });
    }

    if (!commands.length) return;
    // Painter's order: furthest (and explicitly low-priority, like the sea) first.
    commands.sort((a, b) => b.priority - a.priority);

    gl.useProgram(this.program);
    gl.uniform1i(this.u.texture, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);

    const projMat = new Float32Array(proj);
    const baseProj14 = projMat[14];

    for (const cmd of commands) {
      const p = cmd.particle;
      const config = p.config;

      this.#setBlend(p.blendFunc, p.isDistortion());
      gl.depthMask(!!config.depthMask);

      // Projection-matrix depth nudge (tiny epsilon). Opcode 0x30's param0 is
      // dual-use in the DAT: fire/sparks store real epsilons (~-0.2…0.2) while
      // sea/foam store painter-sort weights in the hundreds/thousands (Valkurm
      // uma1 = 8290). Feeding those weights into proj[14] yanks the plane behind
      // the far plane — water vanishes. Large values stay in #priority only.
      let depthNudge = 0;
      if (config.lowPriorityDraw) depthNudge = -0.1;
      else if (config.drawPriorityOffset) depthNudge = -0.01;
      else {
        const b = p.projectionBias.param0;
        if (Number.isFinite(b) && Math.abs(b) <= 1) depthNudge = b;
      }
      const d = cmd.distance <= 30 ? cmd.distance : 30 + Math.sqrt(cmd.distance - 30);
      projMat[14] = baseProj14 + (depthNudge * 0.03) * Math.pow(0.5, d / 5);
      gl.uniformMatrix4fv(this.u.proj, false, projMat);

      gl.uniformMatrix4fv(this.u.model, false, cmd.model.m);
      gl.uniform4fv(this.u.textureFactor, cmd.textureFactor.rgba);
      gl.uniform1f(this.u.ignoreTextureAlpha, config.ignoreTextureAlpha ? 1 : 0);
      gl.uniform1f(this.u.discardThreshold, 0);
      gl.uniform2f(this.u.texTranslate, p.texCoordTranslate.x, p.texCoordTranslate.y);

      const lit = config.lightingEnabled && lighting;
      gl.uniform1f(this.u.computeLighting, lit ? 1 : 0);
      if (lit) {
        gl.uniform4f(this.u.ambient, lighting.ambient[0], lighting.ambient[1], lighting.ambient[2], 1);
        gl.uniform3fv(this.u.light0Dir, lighting.sunDir);
        gl.uniform4f(this.u.light0Color, lighting.sunColor[0], lighting.sunColor[1], lighting.sunColor[2], 1);
        gl.uniform3fv(this.u.light1Dir, lighting.moonDir);
        gl.uniform4f(this.u.light1Color, lighting.moonColor[0], lighting.moonColor[1], lighting.moonColor[2], 1);
      }

      // Additive particles fog toward black, otherwise the fog colour would be
      // *added* to the scene and haze would glow (xim computeLightingParams).
      const fogOn = p.isFogEnabled() && fog?.enabled;
      gl.uniform1f(this.u.computeFog, fogOn ? 1 : 0);
      if (fogOn) {
        gl.uniform2f(this.u.fogRange, fog.near, fog.far);
        const black = p.blendFunc === BlendFunc.Src_One_Add;
        const c = black ? [0, 0, 0] : fog.color;
        gl.uniform4f(this.u.fogColor, c[0], c[1], c[2], 1);
      }

      // Batched generators carry their extra copies as sub-particle offsets;
      // xim adds them in camera space, which is a world-space translation.
      const offsets = cmd.subParticles?.length
        ? cmd.subParticles.map((s) => s.position)
        : [null];

      for (const offset of offsets) {
        const mv = offset ? this.#offsetModelView(cmd.modelView, viewMat, offset) : cmd.modelView;
        gl.uniformMatrix4fv(this.u.modelView, false, mv.m);

        for (const mesh of cmd.meshes) {
          const entry = this.#upload(mesh);
          gl.bindTexture(gl.TEXTURE_2D, showTextures ? this.#texture(entry) : this.defaultTexture);
          gl.bindVertexArray(entry.vao);
          gl.drawArrays(gl.TRIANGLES, 0, entry.count);
          this.lastStats.drawn++;
        }
      }
    }

    projMat[14] = baseProj14;
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);

    this.#drawLensFlares(flares, viewMat, proj);
  }

  /**
   * Screen-space lens flare, gated on whether the source is actually visible.
   *
   * The source (sun or moon) is projected to NDC; an occlusion query drawn at
   * its depth tells us whether terrain is in the way. If it's clear, the sheet's
   * sprites are laid out along the line from the source through the screen
   * centre — offset 0 sits on the source, 0.5 at the centre, 1 diametrically
   * opposite — which is what makes the streaks swing as the camera turns.
   */
  #drawLensFlares(flares, viewMat, proj) {
    const gl = this.gl;
    // Flare sources come and go with the weather; drop query state for any that
    // are no longer being drawn so the map doesn't pin dead particles.
    for (const [particle, state] of this.flareQueries) {
      if (state.seen) { state.seen = false; continue; }
      if (state.query) gl.deleteQuery(state.query);
      this.flareQueries.delete(particle);
    }
    if (!flares.length) return;
    const projMat = new Mat4(new Float32Array(proj));

    gl.useProgram(this.flareProgram);
    gl.uniform1i(this.flareU.texture, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);   // flares are always additive
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);

    for (const { particle, opacity } of flares) {
      const sheet = particle.meshProvider?.spriteSheet;
      if (!sheet?.meshes?.length) continue;

      // Project the source into NDC.
      const world = particle.getWorldSpacePosition();
      const display = DISPLAY_ROT.transform(world, 1);
      const cam = viewMat.transform(display, 1);
      if (cam.z >= 0) continue;                       // behind the viewer
      const m = projMat.m;
      const clipW = m[3] * cam.x + m[7] * cam.y + m[11] * cam.z + m[15];
      if (clipW <= 0) continue;
      const ndcX = (m[0] * cam.x + m[4] * cam.y + m[8] * cam.z + m[12]) / clipW;
      const ndcY = (m[1] * cam.x + m[5] * cam.y + m[9] * cam.z + m[13]) / clipW;
      const ndcZ = (m[2] * cam.x + m[6] * cam.y + m[10] * cam.z + m[14]) / clipW;
      if (Math.abs(ndcX) > 1.6 || Math.abs(ndcY) > 1.6) continue;   // well off-screen

      if (!this.#flareVisible(particle, ndcX, ndcY, ndcZ)) continue;

      const tint = particle.getColor().withMultipliedAlpha(opacity).clamp();
      gl.uniform4fv(this.flareU.textureFactor, tint.rgba);
      // Screen-space quads sit in front of everything; depth is only meaningful
      // for the occlusion probe.
      gl.uniform1f(this.flareU.depth, 0);
      gl.uniform2f(this.flareU.scale, FLARE_NDC_PER_UNIT, -FLARE_NDC_PER_UNIT);

      // xim zips meshes with offsets, so a sheet that carries no offsets draws
      // nothing — that's how a non-flare sheet is filtered out.
      const offsets = sheet.offsets ?? [];
      const count = Math.min(sheet.meshes.length, offsets.length);
      for (let i = 0; i < count; i++) {
        const entry = this.#upload(sheet.meshes[i]);
        const o = offsets[i];
        // offset 0 sits on the source, 0.5 at the screen centre, 1 opposite.
        gl.uniform2f(this.flareU.center, ndcX * (1 - 2 * o), ndcY * (1 - 2 * o));
        gl.bindTexture(gl.TEXTURE_2D, this.#texture(entry));
        gl.bindVertexArray(entry.vao);
        gl.drawArrays(gl.TRIANGLES, 0, entry.count);
        this.lastStats.drawn++;
      }
    }

    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  /**
   * Binary visibility for a flare source. A one-pixel depth-tested probe is
   * drawn with the colour mask off inside an occlusion query; the result is read
   * on a later frame, so the flare pops in a frame or two after the source
   * clears an obstruction. WebGL2 has no coverage-count query, so partial
   * occlusion can't fade the flare the way retail does.
   */
  #flareVisible(particle, ndcX, ndcY, ndcZ) {
    const gl = this.gl;
    // Keyed on the particle, not its dat id — a zone can hold several flares off
    // the same sheet (120.DAT has two lf03s), and they occlude independently.
    let state = this.flareQueries.get(particle);
    // xim's consumeQuery returns null until a query has come back, and a null
    // result draws nothing, so a flare stays dark for its first frame or two.
    if (!state) { state = { query: null, visible: false }; this.flareQueries.set(particle, state); }
    state.seen = true;

    if (state.query) {
      if (gl.getQueryParameter(state.query, gl.QUERY_RESULT_AVAILABLE)) {
        state.visible = gl.getQueryParameter(state.query, gl.QUERY_RESULT) > 0;
        gl.deleteQuery(state.query);
        state.query = null;
      }
    }

    if (!state.query) {
      // Small depth-tested probe at the source's real position, colour masked
      // off so it only answers "is anything in front of the sun here?".
      const query = gl.createQuery();
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);
      gl.colorMask(false, false, false, false);
      gl.uniform2f(this.flareU.center, ndcX, ndcY);
      gl.uniform2f(this.flareU.scale, 0.004, -0.004);
      gl.uniform1f(this.flareU.depth, Math.min(0.999999, ndcZ));
      gl.uniform4f(this.flareU.textureFactor, 1, 1, 1, 1);
      const probe = this.#upload(particle.meshProvider.spriteSheet.meshes[0]);
      gl.bindTexture(gl.TEXTURE_2D, this.defaultTexture);
      gl.bindVertexArray(probe.vao);
      gl.beginQuery(gl.ANY_SAMPLES_PASSED, query);
      gl.drawArrays(gl.TRIANGLES, 0, probe.count);
      gl.endQuery(gl.ANY_SAMPLES_PASSED);
      gl.colorMask(true, true, true, true);
      gl.disable(gl.DEPTH_TEST);
      state.query = query;
    }

    return state.visible;
  }

  #offsetModelView(modelView, viewMat, offset) {
    const out = new Mat4().copyFrom(modelView);
    // The offset is authored in DAT space; rotate it into display space first.
    const d = DISPLAY_ROT.transform(offset, 0);
    const camOffset = viewMat.transform(d, 0);
    out.m[12] += camOffset.x;
    out.m[13] += camOffset.y;
    out.m[14] += camOffset.z;
    return out;
  }

  /**
   * xim applies billboarding to the model-view's upper 3×3 rather than the model
   * matrix, so the particle keeps its own rotation while facing the camera.
   */
  #applyBillboard(particle, viewMat, modelView) {
    const type = particle.config.billBoardType;
    const particleTransform = particle.getParticleSpaceOrientationTransform();

    if (type === 'XYZ') {
      const out = new Mat4();
      LOOK_AT_NEG_Z.multiply(particleTransform, out);
      modelView.copyUpperLeft(out);
    } else if (type === 'XZ') {
      // Keep the view's up axis, take everything else from the particle. The up
      // column is negated for the same reason LOOK_AT_NEG_Z is built from
      // DISPLAY_ROT · lookAtNegZ: this path also replaces the model-view
      // rotation, so it must carry the DAT→display Y flip itself, or the sprite
      // is drawn upside down.
      //
      // Z is negated too, purely to keep the basis right-handed (det +1). With
      // only Y flipped the matrix is a reflection; that is invisible on a flat
      // sprite quad, whose vertices all sit at z = 0, but it mirrors any
      // XZ-billboarded *3D* particle mesh.
      const transform = new Mat4();
      transform.m[4] = -viewMat.m[4];
      transform.m[5] = -viewMat.m[5];
      transform.m[6] = -viewMat.m[6];
      transform.m[10] = -1;
      const billboard = new Mat4();
      transform.multiply(particleTransform, billboard);
      modelView.copyUpperLeft(billboard);
    }
    // Camera / Movement / MovementHorizontal already baked their orientation
    // into the world transform; None needs nothing.
  }

  #priority(particle, distance) {
    const config = particle.config;
    // Inverse-source blending gets a nudge so it resolves consistently against
    // equal-depth additive particles (xim: the sunrise in Mount Zhayolm).
    const tieBreaker = particle.blendFunc === BlendFunc.Src_InvSrc_Add ? -0.01 : 0;
    const projectionBias = config.localPositionInCameraSpace
      ? -particle.projectionBias.param0 : particle.projectionBias.param0;
    const offset = config.lowPriorityDraw ? 10000
      : config.drawPriorityOffset ? -10 : 0;
    return tieBreaker + distance + projectionBias + offset;
  }
}
