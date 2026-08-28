// ParticleSystem — the host that xim spreads across MainTool, SceneManager,
// ParticleMeshResolver and GlobalDirectory.
//
// It owns the zone's DAT tree, the shared ROM/0/0.DAT effects tree, the
// EffectManager, and the resolution rules that turn a DatId inside a generator
// into an actual mesh / curve / sound. Everything the ops call through
// `particle.runtime` lands here.

import { Vec3, Mat4 } from './math.js';
import { SEC, datKey } from '../dat/tree.js';
import { LinkedDataType } from './types.js';
import { EffectManager, ZoneAssociation, WeatherAssociation } from './effects.js';
import { ParticleGenerator } from './runtime.js';

// ── mesh providers (xim ParticleLinkedDataProviders) ───────────────────────

class StaticMeshProvider {
  constructor(meshes, isParticleMesh, meshName = '') {
    this.meshes = meshes;
    this.isParticleMesh = isParticleMesh;
    this.meshName = meshName || '';
  }
  hasMeshes() { return this.meshes.length > 0; }
  getMeshes() { return this.meshes; }
}

class SpriteSheetMeshProvider {
  constructor(spriteSheet) { this.spriteSheet = spriteSheet; this.isParticleMesh = true; }
  hasMeshes() { return this.spriteSheet.meshes.length > 0; }
  getMeshes(particle) {
    const i = Math.min(this.spriteSheet.meshes.length - 1, Math.max(0, particle.spriteSheetIndex));
    return [this.spriteSheet.meshes[i]];
  }
}

class NoMeshProvider {
  hasMeshes() { return false; }
  getMeshes() { return []; }
}

const NO_MESH = new NoMeshProvider();

/**
 * Procedural ring (linkedDataType 0x24). RingMeshSetup fills particle.ringMeshParams
 * after StandardParticleSetup resolves the provider — getMeshes reads them live.
 */
class RingMeshProvider {
  hasMeshes(particle) {
    const p = particle?.ringMeshParams;
    return !!(p && p.numLayers >= 2 && p.verticesPerLayer >= 3);
  }
  getMeshes(particle) {
    if (!this.hasMeshes(particle)) return [];
    return [buildRingMesh(particle.ringMeshParams)];
  }
}

const RING_MESH = new RingMeshProvider();

/**
 * Distortion (0x22) geometry: unit billboard quad. The drawer refracts the
 * scene grab through it using hazeOffset — no solid fill.
 */
class DistortionMeshProvider {
  constructor() {
    // XY plane, faces +Z in local space; XYZ/Camera billboard orients it.
    const n = 6;
    this._mesh = {
      count: n,
      positions: new Float32Array([
        -1, -1, 0,  1, -1, 0,  1, 1, 0,
        -1, -1, 0,  1, 1, 0,  -1, 1, 0,
      ]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      // Neutral 0x80 — stage doubling maps to 1.0; alpha full so haze strength
      // comes from the particle colour / keyframes.
      colors: new Uint8Array(n * 4).fill(0x80),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]),
      textureName: null,
      distortion: true,
    };
  }
  hasMeshes() { return true; }
  getMeshes() { return [this._mesh]; }
}

const DISTORTION_MESH = new DistortionMeshProvider();

/** Build a multi-layer ring strip from RingMeshSetup params. */
function buildRingMesh(params) {
  const layers = Math.max(2, params.numLayers | 0);
  const segs = Math.max(3, Math.min(64, params.verticesPerLayer | 0));
  const radii = params.layerRadius || [];
  const colors = params.layerColor || [];
  // Two tris per segment per layer gap.
  const rings = layers - 1;
  const numVerts = rings * segs * 6;
  const positions = new Float32Array(numVerts * 3);
  const normals = new Float32Array(numVerts * 3);
  const cols = new Uint8Array(numVerts * 4);
  const uvs = new Float32Array(numVerts * 2);
  let vi = 0;
  for (let L = 0; L < rings; L++) {
    const r0 = radii[L] ?? (0.5 + L * 0.5);
    const r1 = radii[L + 1] ?? (r0 + 0.5);
    const c0 = colors[L] || [255, 255, 255, 180];
    const c1 = colors[L + 1] || c0;
    for (let s = 0; s < segs; s++) {
      const a0 = (s / segs) * Math.PI * 2;
      const a1 = ((s + 1) / segs) * Math.PI * 2;
      const cos0 = Math.cos(a0), sin0 = Math.sin(a0);
      const cos1 = Math.cos(a1), sin1 = Math.sin(a1);
      // ring lies in XZ (Y up in DAT space for many shockwaves is vertical axis)
      const pts = [
        [r0 * cos0, 0, r0 * sin0, c0, s / segs, L / rings],
        [r1 * cos0, 0, r1 * sin0, c1, s / segs, (L + 1) / rings],
        [r1 * cos1, 0, r1 * sin1, c1, (s + 1) / segs, (L + 1) / rings],
        [r0 * cos0, 0, r0 * sin0, c0, s / segs, L / rings],
        [r1 * cos1, 0, r1 * sin1, c1, (s + 1) / segs, (L + 1) / rings],
        [r0 * cos1, 0, r0 * sin1, c0, (s + 1) / segs, L / rings],
      ];
      for (const [x, y, z, col, u, v] of pts) {
        positions[vi * 3] = x;
        positions[vi * 3 + 1] = y;
        positions[vi * 3 + 2] = z;
        normals[vi * 3] = 0;
        normals[vi * 3 + 1] = 1;
        normals[vi * 3 + 2] = 0;
        cols[vi * 4] = col[0] ?? 255;
        cols[vi * 4 + 1] = col[1] ?? 255;
        cols[vi * 4 + 2] = col[2] ?? 255;
        cols[vi * 4 + 3] = col[3] ?? 180;
        uvs[vi * 2] = u;
        uvs[vi * 2 + 1] = v;
        vi++;
      }
    }
  }
  return {
    count: numVerts,
    positions,
    normals,
    colors: cols,
    uvs,
    textureName: null,
  };
}

/**
 * Slash-joined directory ids from the DAT root down to `dir` ("f_qu/weat/thdr"),
 * matching the path the zone loader records for each 0x2E section. The tree root
 * carries an empty id and is skipped.
 */
function dirPath(dir) {
  const parts = [];
  for (let d = dir; d; d = d.parent) if (d.id) parts.push(d.id);
  return parts.reverse().join('/');
}

/**
 * Emission budget for a directly-registered effect. xim wraps each one in a
 * single-step routine with `duration = 0`, which becomes the generator's
 * maxEmitTime, and that zero is load-bearing: a generator with autoRun clear
 * stops as soon as it has emitted once, while an autoRun generator ignores
 * maxEmitTime entirely and keeps its own cadence.
 *
 * Registering with Infinity instead let the non-autoRun ones run forever.
 * Qufim's thunder spawner `thd2` (11 frames per emission, autoRun clear) is
 * meant to fire a single bolt on entry; unbounded it fired every 0.37s and each
 * one spawned a child lightning generator.
 */
const SINGLETON_EMIT_TIME = 0;

/**
 * Backstop for the standalone-effect loop: how long past an effect's computed
 * end to keep waiting before re-arming anyway. Only reached when something never
 * finishes on its own (a self-resetting particle, or a sound that never reports
 * completion), so it is deliberately generous — 5s at the 60/s effect clock.
 */
const LOOP_TAIL_FRAMES = 300;

/** Stand-in until the renderer supplies the real view. */
const NULL_CAMERA = {
  getPosition: () => new Vec3(),
  getViewVector: () => new Vec3(0, 0, 1),
  getBasis: () => ({ left: new Vec3(1, 0, 0), up: new Vec3(0, 1, 0), forward: new Vec3(0, 0, 1) }),
  getFoV: () => Math.PI / 4,
  toCameraSpace: (v) => v.clone(),
};

/**
 * A particle-attached sound. xim plays it through AudioManager with a distance
 * falloff and an optional path so shoreline waves follow the coast.
 */
class AudioEmitter {
  constructor(system, soundPointer) { this.system = system; this.soundPointer = soundPointer; }

  update(particle) {
    if (!this.soundPointer) return;
    const pos = this.#position(particle);
    const volume = this.#volume(pos, particle);
    // null = no range authored → full volume; 0 = out of range.
    const atten = volume == null ? 1 : volume;
    const shouldCull = atten <= 0;

    particle.emittedAudio = particle.emittedAudio.filter((a) => !a.isComplete());

    if (shouldCull) {
      for (const a of particle.emittedAudio) a.stop();
      particle.emittedAudio = [];
      return;
    }

    if (particle.emittedAudio.length === 0) {
      const handle = this.system.playSoundEffect(this.soundPointer, particle.association, {
        looping: particle.audioConfiguration.looping,
        positionFn: () => this.#position(particle),
        volumeFn: (p) => this.#volume(p, particle) ?? 1,
      });
      if (handle) particle.emittedAudio.push(handle);
    }

    // Keep attenuation in lockstep with the camera — without this a waterfall
    // started at full volume stays loud as you walk away.
    for (const a of particle.emittedAudio) a.setAttenuation?.(atten);
  }

  /** World-space position used for markers / debug (path-snapped when authored). */
  markerPosition(particle) { return this.#position(particle); }

  #position(particle) {
    const path = particle.audioConfiguration.pathLink?.getIfPresent();
    if (path) {
      const nearest = path.nearestPoint(this.system.camera.getPosition());
      if (nearest) return nearest.point;
    }
    return particle.getWorldSpacePosition();
  }

  #volume(position, particle) {
    if (!position) return 0;
    const cfg = particle.audioConfiguration;
    if (cfg.farDistance <= 0) return null;
    const distance = Vec3.distance(position, this.system.camera.getPosition());
    const fall = distance <= cfg.nearDistance ? 1
      : distance >= cfg.farDistance ? 0
        : (cfg.farDistance - distance) / (cfg.farDistance - cfg.nearDistance);
    return cfg.volumeMultiplier * fall;
  }
}

// ── the system ─────────────────────────────────────────────────────────────

export class ParticleSystem {
  /**
   * @param {Object} opts
   * @param {Object} opts.zoneRoot     DatDir for the zone DAT
   * @param {Object} [opts.globalRoot] DatDir for ROM/0/0.DAT (shared effects)
   * @param {Map}    [opts.zoneMeshIdToName] 0x2E DatId -> mesh name
   * @param {Map}    [opts.zoneMeshes]       mesh name -> prim[]
   * @param {Array}  [opts.zoneMeshSections] every 0x2E section: { path, id, name, prims }
   * @param {Object} opts.camera       adapter, see CameraAdapter below
   * @param {Object} opts.environment  EnvironmentManager
   */
  constructor({ zoneRoot, globalRoot = null, zoneMeshIdToName = new Map(), zoneMeshes = new Map(), zoneMeshSections = [], camera, environment, onWarn = null }) {
    this.zoneRoot = zoneRoot;
    // xim's rootDirectory is the DAT's first pushed directory (f_qu, …), not a
    // synthetic wrapper — link resolution walks up to exactly that.
    this.areaRoot = zoneRoot?.getSubDirectories()[0] ?? zoneRoot;
    this.globalRoot = globalRoot;
    // DatIds are four raw bytes and short ones are space-padded ("ka1 "), while
    // a generator's link is read trimmed ("ka1"). Normalise both sides or every
    // three-character mesh silently fails to resolve — which is what hid East
    // Ronfaure's rivers while Qufim's four-character `quf1`/`umw1` worked.
    this.zoneMeshIdToName = new Map();
    for (const [id, name] of zoneMeshIdToName) this.zoneMeshIdToName.set(datKey(id), name);
    this.zoneMeshes = zoneMeshes;
    // Same id in several directories is normal (every weather declares `clod`,
    // `suns`, `moon`), so index by id and pick by directory scope at lookup.
    this.zoneMeshSections = new Map();   // datKey(id) -> section[]
    for (const s of zoneMeshSections) {
      const key = datKey(s.id);
      const list = this.zoneMeshSections.get(key);
      if (list) list.push(s); else this.zoneMeshSections.set(key, [s]);
    }
    // Never null: sun/moon-attached generators read the camera in their
    // constructor, so a missing adapter would throw during registration and take
    // the whole weather set down with it.
    this.camera = camera ?? NULL_CAMERA;
    this.environment = environment;
    this.effectManager = new EffectManager();

    this._warnings = new Map();
    this._onWarn = onWarn;
    this._meshCache = new Map();
    this._screenFlashes = [];
    this._cameraShake = 0;

    this.audioBackend = null;    // set by the host to enable weather/particle audio
    this.floorQuery = null;      // set by the host for decal / ground projection

    // Standalone spell/ability effect playback (see playEffectRoutine).
    this._effect = null;
    this._effectAssociation = null;

    // Objects panel → Visual Effects: catalog + per-key hide set.
    this._effectCatalog = [];
    this._hiddenEffectKeys = new Set();
  }

  warn(msg) {
    const n = (this._warnings.get(msg) ?? 0) + 1;
    this._warnings.set(msg, n);
    if (n === 1) this._onWarn?.(msg);
  }

  getWarnings() { return [...this._warnings].map(([msg, count]) => ({ msg, count })); }

  // ── registration (xim Area.registerEffects) ──────────────────────────────

  /** Weather folder id an effect sits under, or null for zone-owned VFX. */
  #weatherIdOf(effect) {
    for (let d = effect?.localDir; d; d = d.parent) {
      if (d.parent?.id === 'weat') return d.id || null;
    }
    return null;
  }

  /**
   * Same gate as xi-zone-editor: list/run auto-running emitters and continuous
   * singletons (sea planes, fixed glows). One-shot non-autoRun stay out so things
   * like Qufim thunder spawners don't loop forever.
   */
  #isListableEffect(def) {
    if (!def || def.parseError) return false;
    return !!(def.autoRun || def.continuousSingleton);
  }

  /**
   * Register every auto-running / continuous-singleton generator that belongs
   * to the zone itself (not a weather folder). Classic retail keeps these under
   * `data/effe` and `data/mode`; town DATs park them on the area root.
   */
  registerZoneEffects() {
    const association = ZoneAssociation();
    const area = this.areaRoot;
    if (!area) return 0;

    const seen = new Set();
    let n = 0;
    const addFrom = (dir) => {
      if (!dir) return;
      for (const effect of dir.collectByTypeRecursive(SEC.EFFECT)) {
        if (!this.#isListableEffect(effect.def)) continue;
        if (this.#weatherIdOf(effect)) continue;
        // Identity: same resource object, or same id under the same dir.
        const key = effect.def?.datId
          ? `${effect.localDir?.id ?? ''}\0${effect.def.datId}`
          : effect;
        if (seen.has(key)) continue;
        seen.add(key);
        const gen = this.createGenerator(effect, association, SINGLETON_EMIT_TIME);
        this.effectManager.register(association, gen);
        n++;
      }
    };

    // Classic: data/effe + data/mode.
    const data = area.getNullableSubDirectory?.('data') ?? null;
    if (data) {
      addFrom(data.getNullableSubDirectory('effe'));
      addFrom(data.getNullableSubDirectory('mode'));
    }
    // Town / prototype: generators on the area root (and any non-weat subtree).
    addFrom(area);
    this.rebuildEffectCatalog();
    return n;
  }

  /**
   * Register the generators belonging to one weather type (xim
   * EnvironmentManager.updateWeatherEffects). Unlike zone effects these are
   * registered whether or not they auto-run — the weather directory only
   * contains effects that are meant to be live while that weather is active.
   */
  registerWeatherEffects(weatherId) {
    const dir = this.getWeatherDirectory(weatherId);
    if (!dir) {
      this.rebuildEffectCatalog();
      return 0;
    }
    const association = WeatherAssociation(weatherId);
    let n = 0;
    for (const effect of dir.collectByTypeRecursive(SEC.EFFECT)) {
      const gen = this.createGenerator(effect, association, SINGLETON_EMIT_TIME);
      this.effectManager.register(association, gen);
      n++;
    }
    this.rebuildEffectCatalog();
    return n;
  }

  /**
   * Build Objects → Visual Effects rows from the full DAT tree (not only live
   * generators). Matches xi-zone-editor: every autoRun / continuousSingleton
   * 0x05, including weather folders. Hide keys bind to live gens by id+pos.
   */
  rebuildEffectCatalog() {
    const area = this.areaRoot;
    const catalog = [];
    const seen = new Set();
    if (area) {
      for (const effect of area.collectByTypeRecursive(SEC.EFFECT)) {
        if (!this.#isListableEffect(effect.def)) continue;
        const weatherId = this.#weatherIdOf(effect);
        const association = weatherId
          ? WeatherAssociation(weatherId)
          : ZoneAssociation();
        const entry = this.#catalogEntry(effect, association);
        if (!entry || seen.has(entry.key)) continue;
        seen.add(entry.key);
        catalog.push(entry);
      }
    }
    this._effectCatalog = catalog;

    // Stamp listKey + hide flag onto every live top-level generator.
    this.effectManager.forEachGenerator((gen) => {
      const key = this.#matchCatalogKey(gen);
      if (key) {
        gen.listKey = key;
        if (this._hiddenEffectKeys.has(key)) gen.setUserHidden(true);
        else if (gen.userHidden && !this._hiddenEffectKeys.has(key)) gen.setUserHidden(false);
      }
    });
    return catalog.length;
  }

  #catalogEntry(effect, association) {
    const cfg = effect.def?.particleConfiguration;
    const linkRaw = cfg?.linkedDataId?.id ?? cfg?.linkedDataId?.link?.id ?? '';
    const linkId = linkRaw != null ? String(linkRaw).replace(/\0+$/, '').trim() : '';
    const datId = String(effect.def?.datId || effect.id || '').replace(/\0+$/, '').trim();
    const bp = cfg?.basePosition;
    const rawPos = bp
      ? [Number(bp.x) || 0, Number(bp.y) || 0, Number(bp.z) || 0]
      : [0, 0, 0];
    // Display frame (−x, −y, z), same as zone placements.
    const pos = [-rawPos[0], -rawPos[1], rawPos[2]];
    let meshName = '';
    if (linkId) {
      const k = datKey(linkId);
      meshName = this.zoneMeshIdToName.get(k) || '';
      if (!meshName && this.zoneMeshes.has(k)) meshName = k;
      if (!meshName) {
        for (const name of this.zoneMeshes.keys()) {
          const n = String(name).toLowerCase();
          if (n === k || n.startsWith(k)) { meshName = name; break; }
        }
      }
      if (!meshName) meshName = linkId;
    }
    const name = meshName || datId || 'effect';
    const key = `${association.key}\0${datId}\0${rawPos.map((n) => n.toFixed(3)).join(',')}`;
    return {
      key,
      id: datId,
      name,
      kind: association.kind === 'weather' ? 'weather' : 'zone',
      weatherId: association.weatherId || null,
      dir: dirPath(effect.localDir),
      pos,
      rawPos,
      autoRun: !!effect.def?.autoRun,
      continuousSingleton: !!effect.def?.continuousSingleton,
    };
  }

  #matchCatalogKey(gen) {
    if (gen.listKey && this._effectCatalog.some((e) => e.key === gen.listKey)) {
      return gen.listKey;
    }
    const datId = String(gen.datId || gen.def?.datId || '').replace(/\0+$/, '').trim();
    const bp = gen.def?.particleConfiguration?.basePosition;
    const raw = bp
      ? `${(Number(bp.x) || 0).toFixed(3)},${(Number(bp.y) || 0).toFixed(3)},${(Number(bp.z) || 0).toFixed(3)}`
      : '0.000,0.000,0.000';
    const assocKey = gen.association?.key || '';
    const exact = this._effectCatalog.find(
      (e) => e.id === datId && e.key.startsWith(`${assocKey}\0`) && e.key.endsWith(`\0${raw}`),
    );
    if (exact) return exact.key;
    // Fallback: same datId under any association (weather re-bind).
    return this._effectCatalog.find((e) => e.id === datId)?.key ?? null;
  }

  /** Flat catalog for the Objects panel (hidden flags included). */
  listEffects() {
    if (!this._effectCatalog.length) this.rebuildEffectCatalog();
    return this._effectCatalog.map((e) => ({
      ...e,
      hidden: this._hiddenEffectKeys.has(e.key),
    }));
  }

  /**
   * Group catalog by display name for expandable rows (same shape as objectGroups).
   * @returns {{ name: string, kind: string|null, count: number, instances: object[] }[]}
   */
  listEffectGroups() {
    if (!this._effectCatalog.length) this.rebuildEffectCatalog();
    const by = new Map();
    for (const e of this.listEffects()) {
      const gkey = `${e.kind || 'zone'}\0${e.name}`;
      let g = by.get(gkey);
      if (!g) {
        g = {
          name: e.name,
          mesh: e.name,
          kind: e.kind === 'weather' ? 'weather' : null,
          instances: [],
        };
        by.set(gkey, g);
      }
      const label = e.id && e.id !== e.name ? `${e.name} [${e.id}]` : e.name;
      g.instances.push({
        ...e,
        name: label,
        index: g.instances.length,
        userHidden: e.hidden,
      });
    }
    return [...by.values()]
      .map((g) => {
        // Disambiguate multi-instance labels.
        if (g.instances.length > 1) {
          g.instances = g.instances.map((inst, i) => ({
            ...inst,
            name: `${inst.name}.${String(i + 1).padStart(3, '0')}`,
          }));
        }
        return { ...g, count: g.instances.length };
      })
      .sort((a, b) => {
        const aw = a.kind === 'weather' ? 1 : 0;
        const bw = b.kind === 'weather' ? 1 : 0;
        if (aw !== bw) return aw - bw;
        return b.count - a.count || a.name.localeCompare(b.name);
      });
  }

  setEffectHidden(key, hidden) {
    if (!key) return;
    if (hidden) this._hiddenEffectKeys.add(key);
    else this._hiddenEffectKeys.delete(key);
    this.effectManager.forEachGenerator((gen) => {
      const gk = gen.listKey || this.#matchCatalogKey(gen);
      if (gk === key) {
        gen.listKey = key;
        gen.setUserHidden(hidden);
      }
    });
  }

  setEffectsHidden(keys, hidden) {
    for (const key of keys) this.setEffectHidden(key, hidden);
  }

  getWeatherDirectory(weatherId) {
    const weat = this.areaRoot?.getNullableSubDirectory('weat');
    return weat?.getNullableSubDirectory(weatherId) ?? null;
  }

  /** Weather ids this zone actually ships, in DAT order. */
  listWeatherTypes() {
    const weat = this.areaRoot?.getNullableSubDirectory('weat');
    return weat ? weat.getSubDirectories().map((d) => d.id) : [];
  }

  createGenerator(effectResource, association, maxEmitTime = Infinity, parent = null) {
    return new ParticleGenerator(this, effectResource, association, maxEmitTime, parent);
  }

  // ── standalone effect playback (spell / ability DATs) ─────────────────────

  /**
   * Arm a spell/ability routine for playback. Each 0x02 command spawns one
   * generator at a start delay, for an emit duration (0 = a single emission).
   * These generators are all TargetActor-attached and non-auto-running, so with
   * no actor present they emit at the world origin for their window then drain.
   * `loop` re-arms the routine once it and its trailing particles have finished,
   * giving a continuous preview.
   */
  playEffectRoutine(commands, { loop = true, sounds = [] } = {}) {
    this.clearEffect();
    const cmds = commands ?? [];
    const emitSpan = Math.max(1, ...cmds.map((c) => c.delay + Math.max(c.dur, 1)));
    this._effect = {
      commands: cmds,
      sounds,
      playhead: 0,
      fired: new Set(),
      firedSounds: new Set(),
      voices: [],
      loop,
      length: emitSpan,
      // Grows as generators fire, to emit-end + the particles' own lifespan —
      // the frame the effect is actually over. See #advanceEffect.
      expectedEnd: emitSpan,
    };
    this._effectAssociation = { kind: 'effect', key: 'effect:preview' };
  }

  /** Tear down the armed routine and every particle it spawned. */
  clearEffect() {
    if (this._effectAssociation) this.effectManager.clearEffects(this._effectAssociation);
    // Switching effect or schedule must take its sounds with it, or the old
    // one-shots keep playing over whatever is loaded next. stopOneShots also
    // catches particle-attached emitters, which this routine never held handles
    // for; the ambient weather bed is deliberately left alone.
    for (const v of this._effect?.voices ?? []) v.stop();
    this.audioBackend?.stopOneShots?.();
    this._effect = null;
  }

  /** Restart the armed routine from its first frame (Reset). */
  restartEffect() {
    if (!this._effect) return;
    this.effectManager.clearEffects(this._effectAssociation);
    for (const v of this._effect.voices) v.stop();
    this.audioBackend?.stopOneShots?.();
    this._effect.voices.length = 0;
    this._effect.playhead = 0;
    this._effect.fired.clear();
    this._effect.firedSounds.clear();
  }

  #advanceEffect(elapsedFrames) {
    const e = this._effect;
    if (!e) return;
    e.playhead += elapsedFrames;

    for (let i = 0; i < e.commands.length; i++) {
      if (e.fired.has(i)) continue;
      const c = e.commands[i];
      if (e.playhead < c.delay) continue;
      e.fired.add(i);
      const effect = this.areaRoot?.getChild(c.genId, SEC.EFFECT)
        ?? this.areaRoot?.getChildRecursive(c.genId, SEC.EFFECT)
        ?? this.globalRoot?.getChild(c.genId, SEC.EFFECT)
        ?? this.globalRoot?.getChildRecursive(c.genId, SEC.EFFECT);
      if (!effect) { this.warn(`effect generator not found: ${c.genId}`); continue; }
      // A generator stops *emitting* at delay+dur, but the last particle it
      // emitted lives maxLifeSpan frames beyond that. Aero V finishes emitting
      // at frame 205 and is still on screen at 425.
      const life = effect.def?.particleConfiguration?.maxLifeSpan ?? 0;
      e.expectedEnd = Math.max(e.expectedEnd, c.delay + Math.max(c.dur, 1) + life);
      this.effectManager.register(
        this._effectAssociation,
        this.createGenerator(effect, this._effectAssociation, c.dur > 0 ? c.dur : SINGLETON_EMIT_TIME),
      );
    }

    // Routine-level sounds (ops 0x0a/0x0b/0x53/0x60): one-shots on the same
    // timeline as the generators. A ref that isn't really a sound pointer just
    // doesn't resolve, so it costs nothing.
    for (let i = 0; i < e.sounds.length; i++) {
      if (e.firedSounds.has(i)) continue;
      const s = e.sounds[i];
      if (e.playhead < s.delay) continue;
      e.firedSounds.add(i);
      const pointer = this.areaRoot?.getChildRecursive(s.soundId, SEC.SOUND_POINTER)
        ?? this.globalRoot?.getChildRecursive(s.soundId, SEC.SOUND_POINTER);
      if (!pointer) continue;
      const voice = this.playSoundEffect(pointer, this._effectAssociation, { looping: false });
      if (voice) e.voices.push(voice);
    }

    /*
     * Re-arm when the effect is genuinely finished, not on a fixed timer.
     *
     * The old rule waited `emitSpan + 60`, but emitSpan is only how long the
     * generators *emit* — Aero V emits until frame 205 and its particles live to
     * 425, so it was being cut off and restarted 5 seconds early. Sounds suffer
     * the same way: Banishga IV's tail sound is authored at frame 168, exactly
     * its true end, so a loop at 208 fired it over an already-cleared stage.
     *
     * So: everything fired, nothing left alive, and no one-shot still audible.
     * The expectedEnd cap is the backstop for generators that never die (a
     * RepeatExpirationHandler particle resets its own age forever).
     */
    const allFired = e.fired.size >= e.commands.length
      && e.firedSounds.size >= e.sounds.length;
    if (!allFired) return;

    e.voices = e.voices.filter((v) => !v.isComplete());
    const finished = this.effectManager.countParticles() === 0 && e.voices.length === 0;

    if (finished || e.playhead >= e.expectedEnd + LOOP_TAIL_FRAMES) {
      if (!e.loop) { this.clearEffect(); return; }
      this.effectManager.clearEffects(this._effectAssociation);
      // Normally a no-op — `finished` already requires silence — but the
      // LOOP_TAIL_FRAMES backstop can re-arm while a sound is still going, and
      // that must not bleed into the next cycle.
      for (const v of e.voices) v.stop();
      this.audioBackend?.stopOneShots?.();
      e.voices.length = 0;
      e.playhead = 0;
      e.fired.clear();
      e.firedSounds.clear();
    }
  }

  // ── per-frame ────────────────────────────────────────────────────────────

  update(elapsedFrames) {
    this._screenFlashes.length = 0;
    this._cameraShake = 0;
    this.#advanceEffect(elapsedFrames);
    this.effectManager.update(elapsedFrames);
  }

  getAllParticles() { return this.effectManager.getAllParticles(); }
  getScreenFlashes() { return this._screenFlashes; }
  getCameraShake() { return this._cameraShake; }

  addScreenFlash(color) { this._screenFlashes.push(color); }
  applyCameraShake(amount) { this._cameraShake = Math.max(this._cameraShake, Math.abs(amount)); }

  newMat4() { return new Mat4(); }

  // ── resolution (xim ParticleMeshResolver + DatLink search order) ─────────

  resolveMesh(linkedDataType, link, generator) {
    switch (linkedDataType) {
      case LinkedDataType.StaticMesh: return this.#resolveStaticMesh(link, generator);
      case LinkedDataType.SpriteSheet:
      case LinkedDataType.LensFlare: return this.#resolveSpriteSheet(link, generator);
      case LinkedDataType.RingMesh: return RING_MESH;
      case LinkedDataType.Distortion: return DISTORTION_MESH;
      // Weighted meshes, point lights and audio still have no drawable geometry.
      default: return NO_MESH;
    }
  }

  #resolveStaticMesh(link, generator) {
    const dir = generator.localDir;
    const resource = link.getOrPut((id) => (
      dir?.searchLocalAndParents(id, SEC.PARTICLE_MESH)
      ?? this.#zoneMeshById(id, dir)
      ?? dir?.root().getChildRecursive(id, SEC.PARTICLE_MESH)
      ?? this.globalRoot?.getChildRecursive(id, SEC.PARTICLE_MESH)
      ?? null
    ));

    if (!resource) {
      this.warn(`[${generator.datId}] static mesh not found: ${link.id}`);
      return NO_MESH;
    }

    const cached = this._meshCache.get(resource);
    if (cached) return cached;

    const meshName = resource.name || resource.id || link.id || '';
    const provider = resource.kind === 'particleMesh'
      ? new StaticMeshProvider(resource.meshes, true, meshName)
      : new StaticMeshProvider(resource.meshes, false, meshName);
    this._meshCache.set(resource, provider);
    return provider;
  }

  /**
   * Zone meshes (0x2E) are decrypted by the zone loader, not the DAT tree, so
   * they're bridged in by DatId here. This is what lets `t001 -> quf1` find
   * Qufim's ocean plane.
   */
  #zoneMeshById(id, dir = null) {
    const key = datKey(id);
    const sections = this.zoneMeshSections.get(key);
    if (sections?.length) {
      const section = sections.length === 1 ? sections[0] : this.#nearestSection(sections, dir);
      // Memoised so the draw-time mesh cache, which is keyed on the resource
      // object, still hits across frames.
      section._resource ??= {
        kind: 'zoneMesh', id, name: section.name, meshes: section.prims.map(primToMesh),
      };
      return section._resource;
    }
    // Older path: the id -> name -> geometry maps, which keep one entry per id.
    let name = this.zoneMeshIdToName.get(key);
    // Some generators store a 4-char stem of the mesh name as the link id
    // (e.g. "mill" / "fu_i") while the 0x2E name field is the full id
    // ("mill" / "fu_in"). Fall back to a direct name lookup.
    let prims = name ? this.zoneMeshes.get(name) : null;
    if (!prims?.length) {
      prims = this.zoneMeshes.get(key) ?? this.zoneMeshes.get(String(id || '').trim()) ?? null;
      if (prims?.length) name = key;
    }
    if (!prims?.length && key.length >= 3) {
      // Prefix match: generator link "fu_i" → mesh "fu_in". Require the mesh
      // name to start with the link (not the reverse) so short keys don't grab
      // unrelated meshes.
      for (const [meshName, p] of this.zoneMeshes) {
        const n = String(meshName).toLowerCase();
        if (n === key || n.startsWith(key)) {
          name = meshName;
          prims = p;
          break;
        }
      }
    }
    if (!prims?.length) return null;
    return { kind: 'zoneMesh', id, name: name || key, meshes: prims.map(primToMesh) };
  }

  /**
   * Of several sections sharing an id, the one declared closest to the generator
   * asking for it: same directory first, then the nearest ancestor. Thunder's
   * `clod` must find weat/thdr's storm layer, not weat/mist's fog layer.
   */
  #nearestSection(sections, dir) {
    if (!dir) return sections[0];
    const path = dirPath(dir);
    let best = null;
    let bestLen = -1;
    for (const s of sections) {
      // s.path is the generator's directory or one of its ancestors when it is a
      // prefix; the longest such prefix is the innermost scope.
      if (path !== s.path && !path.startsWith(s.path + '/')) continue;
      if (s.path.length > bestLen) { best = s; bestLen = s.path.length; }
    }
    return best ?? sections[0];
  }

  #resolveSpriteSheet(link, generator) {
    const dir = generator.localDir;
    const resource = link.getOrPut((id) => (
      dir?.getChildRecursive(id, SEC.SPRITE_SHEET)
      ?? dir?.root().getChildRecursive(id, SEC.SPRITE_SHEET)
      ?? this.globalRoot?.getChildRecursive(id, SEC.SPRITE_SHEET)
      ?? null
    ));

    if (!resource) {
      this.warn(`[${generator.datId}] sprite sheet not found: ${link.id}`);
      return NO_MESH;
    }

    const cached = this._meshCache.get(resource);
    if (cached) return cached;
    const provider = new SpriteSheetMeshProvider(resource);
    this._meshCache.set(resource, provider);
    return provider;
  }

  /** xim getKeyFrameReference: local child, then anywhere in the DAT. */
  resolveKeyFrame(id, generator) {
    const dir = generator.localDir;
    const found = dir?.getChild(id, SEC.KEYFRAME)
      ?? dir?.findFirstInEntireTree(id, SEC.KEYFRAME)
      ?? this.globalRoot?.getChildRecursive(id, SEC.KEYFRAME)
      ?? null;
    if (!found) this.warn(`[${generator.datId}] keyframe not found: ${id}`);
    return found;
  }

  resolveEffect(id, generator) {
    const dir = generator.localDir;
    return dir?.getChildRecursive(id, SEC.EFFECT)
      ?? dir?.root().getChildRecursive(id, SEC.EFFECT)
      ?? this.globalRoot?.getChildRecursive(id, SEC.EFFECT)
      ?? null;
  }

  resolvePointList(id, generator) {
    const dir = generator.localDir;
    return dir?.getChild(id, SEC.POINT_LIST)
      ?? dir?.findFirstInEntireTree(id, SEC.POINT_LIST)
      ?? this.globalRoot?.getChildRecursive(id, SEC.POINT_LIST)
      ?? null;
  }

  resolvePath(id, generator) {
    return generator.localDir?.searchLocalAndParents(id, SEC.PATH) ?? null;
  }

  resolveSoundPointer(id, generator) {
    return generator.localDir?.searchLocalAndParents(id, SEC.SOUND_POINTER)
      ?? this.globalRoot?.getChildRecursive(id, SEC.SOUND_POINTER)
      ?? null;
  }

  createAudioEmitter(link, generator) {
    const pointer = link.getOrPut((id) => this.resolveSoundPointer(id, generator));
    if (!pointer) this.warn(`[${generator.datId}] particle audio not found: ${link.id}`);
    return new AudioEmitter(this, pointer);
  }

  playSoundEffect(soundPointer, association, opts) {
    return this.audioBackend?.play(soundPointer, association, opts) ?? null;
  }

  /**
   * Live positional sound sources for the marker overlay: every zone/weather
   * audio particle, path-snapped when a shoreline path is authored. Positions
   * are raw DAT space (caller applies display transform).
   */
  listSoundMarkers() {
    const out = [];
    for (const { particle } of this.getAllParticles()) {
      if (!particle.audioEmitter && particle.config?.linkedDataType !== LinkedDataType.Audio) continue;
      const pos = particle.audioEmitter?.markerPosition?.(particle)
        ?? particle.getWorldSpacePosition?.()
        ?? null;
      if (!pos) continue;
      const cfg = particle.audioConfiguration ?? {};
      const cam = this.camera?.getPosition?.();
      let active = true;
      if (cam && cfg.farDistance > 0) {
        const d = Vec3.distance(pos, cam);
        active = d < cfg.farDistance;
      }
      out.push({
        id: particle.datId,
        soundId: particle.audioEmitter?.soundPointer?.soundId ?? null,
        x: pos.x, y: pos.y, z: pos.z,
        far: cfg.farDistance || 0,
        near: cfg.nearDistance || 0,
        active,
      });
    }
    return out;
  }

  // ── environment bridges ──────────────────────────────────────────────────

  getFullDayInterpolation() { return this.environment?.getFullDayInterpolation() ?? 0.5; }
  getDayOfWeek() { return this.environment?.getDayOfWeek() ?? 0; }
  getMoonPhase() { return this.environment?.getMoonPhase() ?? 6; }
  getModelLighting(environmentId) { return this.environment?.getModelLighting(environmentId) ?? null; }
  getSunPosition() { return this.environment?.getSunPosition() ?? new Vec3(0, 900, 0); }
  getMoonPosition() { return this.environment?.getMoonPosition() ?? new Vec3(0, -900, 0); }

  /** Which sub-environment the viewer is standing in; null means "outdoors". */
  getViewerEnvironmentId() { return null; }

  getCullReferencePosition() { return this.camera.getPosition(); }

  getNearestFloorY(position) { return this.floorQuery ? this.floorQuery(position) : null; }
}

/** Convert a zone.js prim into the uniform mesh descriptor the drawer expects. */
function primToMesh(prim) {
  const count = prim.positions.length / 3;
  const colors = new Uint8Array(count * 4);
  for (let i = 0; i < count * 4; i++) {
    colors[i] = Math.max(0, Math.min(255, Math.round(prim.colors[i] * 255)));
  }
  return {
    count,
    positions: prim.positions,
    normals: prim.normals,
    uvs: prim.uvs,
    colors,
    textureName: prim.textureName,
    noCull: prim.noCull,
    _zonePrim: prim,
  };
}

export { ZoneAssociation, WeatherAssociation };
