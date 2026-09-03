// Lightweight WebGL2 host for Data Struct ZoneMesh (0x2E) previews.
// Unlit modulate2× (vertex color × texture × 2), own canvas, no main-view touch.

import { OrbitCamera, mat4Multiply } from './camera.js';
import { parseBgHex } from './particlePreview.js';
import { resolveTexture } from './zone.js';

const DEFAULT_BG = [0.06, 0.08, 0.11];
const NEUTRAL = new Uint8Array([0x80, 0x80, 0x80, 0x80]);

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

const MESH_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in vec4 aColor;
uniform mat4 uViewProj;
out vec2 vUV;
out vec4 vColor;
void main() {
  vUV = aUV;
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;
const MESH_FS = `#version 300 es
precision highp float;
in vec2 vUV;
in vec4 vColor;
uniform sampler2D uTexture;
uniform float uDiscard;
out vec4 outColor;
void main() {
  vec4 tex = texture(uTexture, vUV);
  float alpha = 4.0 * vColor.a * tex.a;
  if (alpha < uDiscard) discard;
  outColor = vec4(2.0 * vColor.rgb * tex.rgb, 1.0);
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

function toDisplay(x, y, z) {
  return [-x, -y, z];
}

export class ZoneMeshPreviewHost {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      premultipliedAlpha: false,
      powerPreference: 'low-power',
    });
    if (!gl) throw new Error('WebGL2 unavailable for mesh preview');
    this.gl = gl;
    this.gridProgram = compileProgram(gl, GRID_VS, GRID_FS);
    this.gridUniforms = {
      viewProj: gl.getUniformLocation(this.gridProgram, 'uViewProj'),
      opacity: gl.getUniformLocation(this.gridProgram, 'uOpacity'),
    };
    this.meshProgram = compileProgram(gl, MESH_VS, MESH_FS);
    this.meshUniforms = {
      viewProj: gl.getUniformLocation(this.meshProgram, 'uViewProj'),
      texture: gl.getUniformLocation(this.meshProgram, 'uTexture'),
      discard: gl.getUniformLocation(this.meshProgram, 'uDiscard'),
    };
    this.gridLines = null;
    this.batches = [];
    this.glTextures = new Map();
    this.whiteTex = null;
    this.camera = new OrbitCamera();
    this.camera.yUp = true;
    this.camera.setRangeFor?.('entity');
    this.camera.target = [0, 0.5, 0];
    this.camera.distance = 8;
    this.camera.yaw = 0.7;
    this.camera.pitch = 0.4;
    this.camera.minDistance = 0.2;
    this.camera.maxDistance = 400;
    this.showGrid = true;
    this.bgColor = DEFAULT_BG.slice();
    this.triCount = 0;
    this.subCount = 0;
    this._raf = 0;
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

  _ensureWhite() {
    if (this.whiteTex) return this.whiteTex;
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, NEUTRAL);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.whiteTex = tex;
    return tex;
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
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, image.width, image.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, image.data);
    } catch {
      gl.deleteTexture(tex);
      return null;
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  setScene(mesh, textures) {
    this._freeBatches();
    this._freeTextures();
    const prims = mesh?.prims ?? [];
    const meshName = mesh?.meshName || '';
    const discard = (meshName || '').startsWith('_') ? 0.375 : 0;
    const gl = this.gl;
    const glMap = new Map();
    for (const [key, tex] of textures ?? []) {
      let glTex = tex.name ? glMap.get(tex.name) : null;
      if (!glTex) {
        glTex = this._createTexture(tex);
        if (glTex && tex.name) glMap.set(tex.name, glTex);
      }
      if (glTex) glMap.set(key, glTex);
    }
    this.glTextures = glMap;

    let lo0 = Infinity, lo1 = Infinity, lo2 = Infinity;
    let hi0 = -Infinity, hi1 = -Infinity, hi2 = -Infinity;
    let triCount = 0;
    const batches = [];
    for (const prim of prims) {
      const n = (prim.positions?.length || 0) / 3;
      if (n < 3) continue;
      const stride = 9;
      const data = new Float32Array(n * stride);
      for (let i = 0; i < n; i++) {
        const i3 = i * 3, i2 = i * 2, i4 = i * 4;
        const [dx, dy, dz] = toDisplay(
          prim.positions[i3], prim.positions[i3 + 1], prim.positions[i3 + 2],
        );
        const o = i * stride;
        data[o] = dx; data[o + 1] = dy; data[o + 2] = dz;
        data[o + 3] = prim.uvs[i2]; data[o + 4] = prim.uvs[i2 + 1];
        data[o + 5] = prim.colors[i4];
        data[o + 6] = prim.colors[i4 + 1];
        data[o + 7] = prim.colors[i4 + 2];
        data[o + 8] = prim.colors[i4 + 3];
        if (dx < lo0) lo0 = dx; if (dy < lo1) lo1 = dy; if (dz < lo2) lo2 = dz;
        if (dx > hi0) hi0 = dx; if (dy > hi1) hi1 = dy; if (dz > hi2) hi2 = dz;
      }
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      const bytes = stride * 4;
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, bytes, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, bytes, 12);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, bytes, 20);
      gl.bindVertexArray(null);
      const texKey = resolveTexture(prim.textureName, textures) || prim.textureName || '';
      const glTex = (texKey && glMap.get(texKey)) || this._ensureWhite();
      batches.push({
        vao, vbo, count: n, texture: glTex,
        blend: !!prim.blend, noCull: !!prim.noCull, discard,
      });
      triCount += n / 3;
    }
    batches.sort((a, b) => (a.blend === b.blend ? 0 : a.blend ? 1 : -1));
    this.batches = batches;
    this.triCount = triCount | 0;
    this.subCount = prims.length;

    if (Number.isFinite(lo0)) {
      const cx = (lo0 + hi0) / 2, cy = (lo1 + hi1) / 2, cz = (lo2 + hi2) / 2;
      const span = Math.max(hi0 - lo0, hi1 - lo1, hi2 - lo2, 0.5);
      this.camera.target = [cx, cy, cz];
      this.camera.distance = Math.max(1.2, span * 1.8);
      this.camera.minDistance = Math.max(0.15, span * 0.04);
      this.camera.maxDistance = Math.max(40, span * 24);
    }
  }

  setShowGrid(v) { this.showGrid = !!v; }
  setBgColor(hexOrRgb) {
    if (Array.isArray(hexOrRgb)) {
      this.bgColor = [Number(hexOrRgb[0]) || 0, Number(hexOrRgb[1]) || 0, Number(hexOrRgb[2]) || 0];
    } else {
      this.bgColor = parseBgHex(hexOrRgb, this.bgColor);
    }
  }

  start() {
    if (this._raf || this._disposed) return;
    const tick = () => {
      if (this._disposed) return;
      this._raf = requestAnimationFrame(tick);
      this._frame();
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
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

  _frame() {
    const gl = this.gl;
    const aspect = this._resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const [br, bg, bb] = this.bgColor;
    gl.clearColor(br, bg, bb, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    const view = this.camera.viewMatrix();
    const proj = this.camera.projectionMatrix(aspect);
    this._drawGrid(view, proj);
    const viewProj = mat4Multiply(proj, view);
    gl.useProgram(this.meshProgram);
    gl.uniformMatrix4fv(this.meshUniforms.viewProj, false, viewProj);
    gl.uniform1i(this.meshUniforms.texture, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.frontFace(gl.CW);
    gl.cullFace(gl.BACK);
    for (const b of this.batches) {
      if (b.noCull) gl.disable(gl.CULL_FACE);
      else gl.enable(gl.CULL_FACE);
      if (b.blend) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
      } else {
        gl.disable(gl.BLEND);
        gl.depthMask(true);
      }
      gl.uniform1f(this.meshUniforms.discard, b.discard || 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, b.texture);
      gl.bindVertexArray(b.vao);
      gl.drawArrays(gl.TRIANGLES, 0, b.count);
    }
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
  }

  _freeBatches() {
    const gl = this.gl;
    for (const b of this.batches) {
      gl.deleteBuffer(b.vbo);
      gl.deleteVertexArray(b.vao);
    }
    this.batches = [];
  }

  _freeTextures() {
    const gl = this.gl;
    for (const t of this.glTextures.values()) gl.deleteTexture(t);
    this.glTextures.clear();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.stop();
    this._onDrag?.();
    this._onDrag = null;
    this._freeBatches();
    this._freeTextures();
    if (this.whiteTex) this.gl.deleteTexture(this.whiteTex);
    this.whiteTex = null;
    if (this.gridLines) {
      this.gl.deleteBuffer(this.gridLines.vbo);
      this.gl.deleteVertexArray(this.gridLines.vao);
      this.gridLines = null;
    }
    if (this.gridProgram) this.gl.deleteProgram(this.gridProgram);
    if (this.meshProgram) this.gl.deleteProgram(this.meshProgram);
    const ext = this.gl.getExtension('WEBGL_lose_context');
    ext?.loseContext?.();
  }
}
