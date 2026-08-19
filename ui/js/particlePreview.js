// Lightweight WebGL2 host for Data Struct ParticleGenerator previews.
// Own canvas + ParticleSystem + ParticleDrawer — does not touch the main view.

import { OrbitCamera, mat4Multiply } from './camera.js';
import { ParticleDrawer } from './particleDrawer.js';
import { Vec3 } from './particle/math.js';
import { SEC } from './dat/tree.js';
import { AttachType } from './particle/types.js';
import { GeneratorBasePositionUpdater } from './particle/ops/generator.js';

const DEFAULT_LIGHT = {
  ambient: [0.55, 0.55, 0.6],
  sunDir: [0.35, 0.85, 0.3],
  sunColor: [0.9, 0.85, 0.7],
  moonDir: [-0.2, 0.4, -0.5],
  moonColor: [0.08, 0.1, 0.18],
};

const DEFAULT_BG = [0.06, 0.08, 0.11];

const GRID_VS = `#version 300 es
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
const GRID_FS = `#version 300 es
precision highp float;
in vec3 vColor;
uniform float uOpacity;
out vec4 outColor;
void main() {
  outColor = vec4(vColor, uOpacity);
}
`;

function compileProgram(gl, vsSrc, fsSrc) {
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(log || 'shader compile failed');
    }
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(log || 'program link failed');
  }
  return prog;
}

/** Parse #rrggbb / #rgb / css-ish hex into [r,g,b] 0..1. */
export function parseBgHex(hex, fallback = DEFAULT_BG) {
  const s = String(hex ?? '').trim();
  const m6 = /^#?([0-9a-f]{6})$/i.exec(s);
  if (m6) {
    const n = parseInt(m6[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const m3 = /^#?([0-9a-f]{3})$/i.exec(s);
  if (m3) {
    const [r, g, b] = m3[1].split('').map((c) => parseInt(c + c, 16) / 255);
    return [r, g, b];
  }
  return fallback.slice();
}

export function bgToHex([r, g, b]) {
  const u = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255)
    .toString(16).padStart(2, '0');
  return `#${u(r)}${u(g)}${u(b)}`;
}

/**
 * Zone generators store world-space basePosition (torch/fire/water location).
 * For a freestanding modal we pull everything to the origin and kill distance
 * culls so the orbit camera can see them.
 */
export function recenterGeneratorDef(def) {
  if (!def) return;
  const zero = (v) => { if (v && typeof v.set === 'function') v.set(0, 0, 0); };
  zero(def.particleConfiguration?.basePosition);
  for (const init of def.initializers ?? []) {
    zero(init.config?.basePosition);
    zero(init.basePosition);
  }
  // Drop world-space basePosition keyframes (they re-apply zone coords every tick)
  // and loosen distance culls so the orbit camera always sees the emitter.
  def.generatorUpdaters = (def.generatorUpdaters ?? []).filter((u) => {
    if (u instanceof GeneratorBasePositionUpdater) return false;
    if (typeof u.maxEmitDistance === 'number') u.maxEmitDistance = 1e9;
    return true;
  });
  // Actor/zone attach types need a live actor; treat as free-standing at origin.
  if (def.attachType !== AttachType.Sun && def.attachType !== AttachType.Moon) {
    def.attachType = AttachType.None;
  }
}

function findEffect(system, genId) {
  const id = String(genId ?? '').replace(/\0/g, '').trim();
  if (!id || !system) return null;
  const find = (root) => root?.getChild(id, SEC.EFFECT)
    ?? root?.getChildRecursive(id, SEC.EFFECT)
    ?? null;
  // Search full tree root too — areaRoot is only the first top-level dir.
  return find(system.areaRoot)
    ?? find(system.zoneRoot)
    ?? find(system.globalRoot)
    ?? null;
}

function ensureParticleConfig(def) {
  if (!def) return false;
  if (def.particleConfiguration) return true;
  // Some parses leave config only on the StandardParticleSetup initializer.
  for (const init of def.initializers ?? []) {
    if (init?.config?.linkedDataType != null || init?.config?.basePosition) {
      def.particleConfiguration = init.config;
      return true;
    }
  }
  return false;
}

/**
 * Arm a single generator on a private ParticleSystem for modal playback.
 * Registers directly (not via effect routine) so it keeps emitting continuously
 * and survives host remounts as long as App keeps the system reference.
 */
export function armGeneratorPreview(system, genId) {
  const id = String(genId ?? '').replace(/\0/g, '').trim();
  if (!system || !id) throw new Error('missing generator id');

  const effect = findEffect(system, id);
  if (!effect) throw new Error(`Generator “${id}” not found in DAT tree`);
  if (effect.def?.parseError) {
    throw new Error(`Generator parse failed: ${effect.def.parseError}`);
  }
  if (!ensureParticleConfig(effect.def)) {
    throw new Error(`Generator “${id}” has no particle setup`);
  }
  recenterGeneratorDef(effect.def);

  // Children spawned on expiration/links also land at origin.
  if (!system._previewCreateWrapped) {
    const origCreate = system.createGenerator.bind(system);
    system.createGenerator = (effectResource, association, maxEmitTime = Infinity, parent = null) => {
      if (effectResource?.def) {
        ensureParticleConfig(effectResource.def);
        recenterGeneratorDef(effectResource.def);
      }
      const gen = origCreate(effectResource, association, maxEmitTime, parent);
      gen.genAssociatedPosition?.set?.(0, 0, 0);
      gen.emitCulled = false;
      return gen;
    };
    system._previewCreateWrapped = true;
  }

  // Tear down any prior preview association, then register a continuous emitter.
  const assoc = { kind: 'effect', key: `fx-preview:${id}` };
  if (system._effectAssociation) {
    system.effectManager.clearEffects(system._effectAssociation);
  }
  system.effectManager.clearEffects(assoc);
  system._effect = null;
  system._effectAssociation = assoc;
  system._previewGenId = id;

  const gen = system.createGenerator(effect, assoc, Infinity);
  if (gen.invalid) {
    throw new Error(
      gen.def?.parseError
        ? `Generator invalid: ${gen.def.parseError}`
        : `Generator “${id}” is invalid (no mesh setup?)`,
    );
  }
  gen.genAssociatedPosition.set(0, 0, 0);
  gen.emitCulled = false;
  system.effectManager.register(assoc, gen);

  // Force an immediate emit so the first frame isn't empty.
  try { gen.emit(1); } catch (e) { console.warn('[fx-preview] initial emit', e); }
  try { system.update(2); } catch (e) { console.warn('[fx-preview] seed update', e); }

  return {
    effect,
    gen,
    live: system.effectManager.countParticles(),
    warnings: system.getWarnings?.() ?? [],
  };
}

/**
 * @param {HTMLCanvasElement} canvas
 */
export class ParticlePreviewHost {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      premultipliedAlpha: false,
      powerPreference: 'low-power',
    });
    if (!gl) throw new Error('WebGL2 unavailable for particle preview');
    this.gl = gl;
    this.s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc');
    this.drawer = new ParticleDrawer(gl);
    this.gridProgram = compileProgram(gl, GRID_VS, GRID_FS);
    this.gridUniforms = {
      viewProj: gl.getUniformLocation(this.gridProgram, 'uViewProj'),
      opacity: gl.getUniformLocation(this.gridProgram, 'uOpacity'),
    };
    this.gridLines = null;
    this.camera = new OrbitCamera();
    this.camera.yUp = true;
    this.camera.setRangeFor?.('entity');
    // Frame a unit-scale emitter at the origin (zone gens are recentered here).
    this.camera.target = [0, 0.5, 0];
    this.camera.distance = 4.5;
    this.camera.yaw = 0.7;
    this.camera.pitch = 0.4;
    this.camera.minDistance = 0.4;
    this.camera.maxDistance = 80;
    this.system = null;
    this.genId = '';
    this.glTextures = new Map();
    this.playing = true;
    this.speed = 1;
    this.showGrid = true;
    this.bgColor = DEFAULT_BG.slice();
    this._raf = 0;
    this._last = 0;
    this._disposed = false;
    this._onDrag = null;
    this._bindPointer();
  }

  _bindPointer() {
    const el = this.canvas;
    let drag = null;
    const onDown = (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY };
      el.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag = { x: e.clientX, y: e.clientY };
      this.camera.yaw -= dx * 0.008;
      this.camera.pitch = Math.max(-1.4, Math.min(1.4, this.camera.pitch + dy * 0.008));
    };
    const onUp = () => { drag = null; };
    const onWheel = (e) => {
      e.preventDefault();
      const f = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      this.camera.distance = Math.min(
        this.camera.maxDistance,
        Math.max(this.camera.minDistance, this.camera.distance * f),
      );
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    this._onDrag = () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('wheel', onWheel);
    };
  }

  /**
   * @param {import('./particle/system.js').ParticleSystem} system
   * @param {Map<string, object>} textureData  parsed DAT textures (CPU)
   * @param {string} genId
   */
  setScene(system, textureData, genId = '') {
    this._freeTextures();
    this.system = system;
    this.genId = genId || system?._previewGenId || '';
    this._installCameraAdapter(system);
    const glMap = new Map();
    for (const tex of textureData?.values?.() ?? []) {
      const glTex = this._createTexture(tex);
      if (glTex) glMap.set(tex.name, glTex);
    }
    this.glTextures = glMap;
    this.drawer.setTextures(glMap);

    // Re-arm if nothing is live (React Strict Mode remount, or first open).
    if (system && this.genId) {
      const live = system.effectManager?.countParticles?.() ?? 0;
      if (live === 0) {
        try { armGeneratorPreview(system, this.genId); } catch (e) {
          console.warn('[fx-preview] re-arm failed', e);
        }
      } else {
        try { system.update(2); } catch (e) { console.warn('[fx-preview] seed update', e); }
      }
    }
  }

  getLiveCount() {
    return this.system?.effectManager?.countParticles?.()
      ?? this.system?.getAllParticles?.()?.length
      ?? 0;
  }

  getDrawStats() {
    return this.drawer?.lastStats ?? { drawn: 0, particles: 0 };
  }

  getStatus() {
    const gens = [];
    const routines = this.system?.effectManager?.routines;
    if (routines) {
      for (const r of routines.values()) {
        for (const g of r.generators ?? []) {
          gens.push({
            id: g.datId,
            invalid: !!g.invalid,
            culled: !!g.emitCulled,
            emitted: g.totalParticlesEmitted ?? 0,
            active: g.activeParticles?.length ?? 0,
            autoRun: !!g.def?.autoRun,
          });
        }
      }
    }
    return { live: this.getLiveCount(), drawn: this.getDrawStats().drawn, gens };
  }

  _installCameraAdapter(system) {
    if (!system) return;
    const toDat = (v) => new Vec3(-v.x, -v.y, v.z);
    const self = this;
    system.camera = {
      getPosition() {
        const e = self.camera.eye;
        return toDat(new Vec3(e[0], e[1], e[2]));
      },
      getViewVector() {
        const f = self.camera.forward;
        return toDat(new Vec3(f[0], f[1], f[2])).normalizeInPlace();
      },
      getBasis() {
        const m = self.camera.viewMatrix();
        return {
          left: toDat(new Vec3(m[0], m[4], m[8])),
          up: toDat(new Vec3(m[1], m[5], m[9])),
          forward: toDat(new Vec3(m[2], m[6], m[10])),
        };
      },
      getFoV: () => (self.camera.fovDegrees * Math.PI) / 180,
      toCameraSpace(v) {
        const e = self.camera.eye;
        return toDat(new Vec3(e[0], e[1], e[2])).sub(v).scaleInPlace(-1);
      },
    };
  }

  _createTexture(image) {
    if (!image?.data || !(image.width > 0) || !(image.height > 0)) return null;
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    try {
      if (image.format === 'rgba32') {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, image.width, image.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, image.data);
      } else if (this.s3tc) {
        const fmt = image.format === 'dxt1'
          ? this.s3tc.COMPRESSED_RGBA_S3TC_DXT1_EXT
          : this.s3tc.COMPRESSED_RGBA_S3TC_DXT3_EXT;
        gl.compressedTexImage2D(gl.TEXTURE_2D, 0, fmt, image.width, image.height, 0, image.data);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
          new Uint8Array([0x80, 0x80, 0x80, 0x80]));
      }
    } catch {
      gl.deleteTexture(tex);
      return null;
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  _freeTextures() {
    const gl = this.gl;
    for (const t of this.glTextures.values()) gl.deleteTexture(t);
    this.glTextures.clear();
  }

  start() {
    if (this._raf || this._disposed) return;
    this._last = performance.now();
    const tick = (now) => {
      if (this._disposed) return;
      this._raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, Math.max(0, (now - this._last) / 1000));
      this._last = now;
      this._frame(dt);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  setPlaying(v) { this.playing = !!v; }
  setSpeed(v) { this.speed = Math.min(2, Math.max(0.1, v || 1)); }
  setShowGrid(v) { this.showGrid = !!v; }
  setBgColor(hexOrRgb) {
    if (Array.isArray(hexOrRgb)) {
      this.bgColor = [
        Number(hexOrRgb[0]) || 0,
        Number(hexOrRgb[1]) || 0,
        Number(hexOrRgb[2]) || 0,
      ];
    } else {
      this.bgColor = parseBgHex(hexOrRgb, this.bgColor);
    }
  }

  restart() {
    if (this.system && this.genId) {
      try { armGeneratorPreview(this.system, this.genId); } catch (e) {
        console.warn('[fx-preview] restart failed', e);
      }
    }
    this.playing = true;
  }

  _resize() {
    const el = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(el.clientWidth * dpr));
    const h = Math.max(1, Math.round(el.clientHeight * dpr));
    if (el.width !== w || el.height !== h) {
      el.width = w;
      el.height = h;
    }
    return w / h;
  }

  _ensureGrid() {
    if (this.gridLines) return;
    const gl = this.gl;
    const half = 10;
    const step = 1;
    const MINOR = 0.22;
    const MAJOR = 0.4;
    const verts = [];
    for (let i = -half; i <= half; i += step) {
      const c = (i % (step * 5) === 0) ? MAJOR : MINOR;
      verts.push(i, 0, -half, c, c, c, i, 0, half, c, c, c);
      verts.push(-half, 0, i, c, c, c, half, 0, i, c, c, c);
    }
    // Axis accents (X red-ish, Z blue-ish) through the origin.
    verts.push(-half, 0.001, 0, 0.55, 0.22, 0.22, half, 0.001, 0, 0.55, 0.22, 0.22);
    verts.push(0, 0.001, -half, 0.22, 0.28, 0.55, 0, 0.001, half, 0.22, 0.28, 0.55);

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
    this.gridLines = { vao, vbo, count: data.length / 6 };
  }

  _drawGrid(view, proj) {
    if (!this.showGrid) return;
    this._ensureGrid();
    const gl = this.gl;
    const viewProj = mat4Multiply(proj, view);
    // Lift a hair so particles on y=0 don't z-fight the lines.
    const move = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.02, 0, 1]);
    const mvp = mat4Multiply(viewProj, move);
    gl.useProgram(this.gridProgram);
    gl.uniformMatrix4fv(this.gridUniforms.viewProj, false, mvp);
    gl.uniform1f(this.gridUniforms.opacity, 1);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.bindVertexArray(this.gridLines.vao);
    gl.drawArrays(gl.LINES, 0, this.gridLines.count);
    gl.bindVertexArray(null);
    gl.depthMask(true);
  }

  _frame(dtSeconds) {
    const gl = this.gl;
    const aspect = this._resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const [br, bg, bb] = this.bgColor;
    gl.clearColor(br, bg, bb, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);

    const system = this.system;
    if (this.playing && system) {
      let frames = Math.min(8, Math.max(0, dtSeconds * 60));
      frames *= this.speed;
      // Keep at least a fractional tick so slow frames still advance emitters.
      if (frames < 0.05) frames = 0.05;
      try { system.update(frames); } catch (e) { console.warn('[fx-preview] update', e); }
    }

    const view = this.camera.viewMatrix();
    const proj = this.camera.projectionMatrix(aspect);
    this._drawGrid(view, proj);
    if (system) {
      this.drawer.draw({
        system,
        view,
        proj,
        lighting: DEFAULT_LIGHT,
        fog: null,
        showTextures: true,
      });
      this.drawer.drawScreenFlashes?.(system.getScreenFlashes?.() ?? []);
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.stop();
    this._onDrag?.();
    this._onDrag = null;
    // Do NOT clearEffect here — React Strict Mode remounts the host and must
    // keep the App-owned ParticleSystem armed. App.closeFxPreview clears it.
    this.system = null;
    this._freeTextures();
    if (this.gridLines) {
      this.gl.deleteBuffer(this.gridLines.vbo);
      this.gl.deleteVertexArray(this.gridLines.vao);
      this.gridLines = null;
    }
    if (this.gridProgram) this.gl.deleteProgram(this.gridProgram);
    const ext = this.gl.getExtension('WEBGL_lose_context');
    ext?.loseContext?.();
  }
}
