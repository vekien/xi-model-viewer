// Zone environment (0x2F) — port of xim EnvironmentSection / EnvironmentManager.
//
// Each weather directory under `weat` holds several 0x2F keyframes, one per
// time-of-day (the section id is HHMM, hour = parseInt(id)/100). xim sorts them
// by hour and interpolates the floor/ceil pair around the current time — the
// skybox (dome gradient), lighting, fog, clear colour and draw distance all
// blend. We do the same, defaulting to noon.
//
// Terrain shading (XimShader):
//   lit = clamp(vColor*ambient + Σ vColor*max(0,dot(N,L))*lightColor)
//   out.rgb = 2 * lit * tex.rgb ; out.a = 4 * vColor.a * tex.a

import { parseSections } from './zone.js';
import { Vec3, Color, secondsToFrames } from './particle/math.js';
import { FadeParameters, WeatherAssociation } from './particle/effects.js';

const WEATHER_IDS = new Set([
  'fine', 'suny', 'clod', 'mist', 'dryw', 'heat', 'rain', 'squl',
  'dust', 'sand', 'wind', 'stom', 'snow', 'bliz', 'thdr', 'bolt',
  'aura', 'ligt', 'fogd', 'dark',
]);

const BIAS = [1.4, 1.36, 1.45];
const TH = 0xcc;

const readRgba = (bytes, p) => [bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]];

function readLightConfig(bytes, dv, p) {
  return {
    sun: readRgba(bytes, p),
    moon: readRgba(bytes, p + 4),
    ambient: readRgba(bytes, p + 8),
    fog: readRgba(bytes, p + 12),
    fogEnd: dv.getFloat32(p + 16, true),
    fogStart: dv.getFloat32(p + 20, true),
    diffuseMult: dv.getFloat32(p + 24, true),
  };
}

// Full 0x2F layout (xim EnvironmentSection.read).
function parseEnvironment(bytes, dv, section, hour) {
  const ds = section.dataStart;
  const slices = [];
  for (let i = 0; i < 8; i++) {
    slices.push({ color: readRgba(bytes, ds + 0x6c + i * 4), elevation: dv.getFloat32(ds + 0x8c + i * 4, true) });
  }
  return {
    hour,
    indoors: dv.getUint32(ds, true) === 1,
    model: readLightConfig(bytes, dv, ds + 0x0c),
    terrain: readLightConfig(bytes, dv, ds + 0x2c),
    clearColor: readRgba(bytes, ds + 0x4c),
    drawDistance: dv.getFloat32(ds + 0x58, true),
    spokes: dv.getUint16(ds + 0x5e, true),
    radius: dv.getFloat32(ds + 0x68, true),
    slices,
  };
}

/** weatherId → time-of-day keyframes (sorted by hour), for the main `weat` tree. */
export function parseEnvironments(datBuffer) {
  return parseEnvironmentsByRoot(datBuffer).get('weat') ?? new Map();
}

/**
 * All environment trees in the DAT, keyed by the directory that holds them.
 *
 * A zone has `weat` (the main environment) plus optional `ev01`, `ev02`, …
 * sub-environments that individual objects link to for their own lighting and
 * fog — a cave mouth, a lit interior. xim resolves a generator's environmentId
 * against these, falling back to `weat` when the id isn't defined.
 */
export function parseEnvironmentsByRoot(datBuffer) {
  const bytes = new Uint8Array(datBuffer instanceof ArrayBuffer ? datBuffer : datBuffer.buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sections = parseSections(dv);
  const stack = [];
  const out = new Map();

  for (const s of sections) {
    if (s.typeCode === 0x01) { stack.push(s.id); continue; }
    if (s.typeCode === 0x00) { stack.pop(); continue; }
    if (s.typeCode !== 0x2f) continue;

    // The environment root is the directory directly above the weather folder.
    const weatherIdx = stack.findLastIndex((id) => WEATHER_IDS.has(id));
    if (weatherIdx < 1) continue;
    const weather = stack[weatherIdx];
    const envRoot = stack[weatherIdx - 1];

    const hour = Number.isNaN(parseInt(s.id, 10)) ? 12 : Math.floor(parseInt(s.id, 10) / 100);
    if (!out.has(envRoot)) out.set(envRoot, new Map());
    const byWeather = out.get(envRoot);
    if (!byWeather.has(weather)) byWeather.set(weather, []);
    byWeather.get(weather).push(parseEnvironment(bytes, dv, s, hour));
  }

  for (const byWeather of out.values()) {
    for (const list of byWeather.values()) list.sort((a, b) => a.hour - b.hour);
  }
  return out;
}

export function listWeathers(environments) {
  return environments ? [...environments.keys()] : [];
}

/** Preferred default weather present in the DAT. */
export function defaultWeather(environments) {
  if (!environments || environments.size === 0) return null;
  for (const id of ['fine', 'suny', 'clod', 'default']) if (environments.has(id)) return id;
  return environments.keys().next().value;
}

const lerp = (a, b, t) => a + (b - a) * t;
const lerpRgba = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)];
const lerpLight = (a, b, t) => ({
  sun: lerpRgba(a.sun, b.sun, t), moon: lerpRgba(a.moon, b.moon, t),
  ambient: lerpRgba(a.ambient, b.ambient, t), fog: lerpRgba(a.fog, b.fog, t),
  fogEnd: lerp(a.fogEnd, b.fogEnd, t), fogStart: lerp(a.fogStart, b.fogStart, t),
  diffuseMult: lerp(a.diffuseMult, b.diffuseMult, t),
});

/**
 * Resolve one environment for a weather + time (minutes 0..1439), interpolating
 * the floor/ceil TOD keyframes exactly as xim's computeInterpolatedEnvResource.
 */
export function resolveEnvironment(environments, weather, timeMinutes = 12 * 60) {
  if (!environments || environments.size === 0) return null;
  const frames = environments.get(weather) ?? environments.get(defaultWeather(environments));
  if (!frames || frames.length === 0) return null;
  if (frames.length === 1) return frames[0];

  const hour = Math.floor(timeMinutes / 60);
  const floor = [...frames].reverse().find((f) => f.hour <= hour) ?? frames[frames.length - 1];
  const ceil = frames.find((f) => f.hour > hour) ?? frames[0];
  if (floor.hour === ceil.hour) return floor;

  const t0 = floor.hour * 60;
  const t1 = (ceil.hour === 0 ? 24 : ceil.hour) * 60;
  const t = (timeMinutes - t0) / (t1 - t0);

  return {
    hour,
    indoors: floor.indoors,
    model: lerpLight(floor.model, ceil.model, t),
    terrain: lerpLight(floor.terrain, ceil.terrain, t),
    clearColor: lerpRgba(floor.clearColor, ceil.clearColor, t),
    drawDistance: lerp(floor.drawDistance, ceil.drawDistance, t),
    spokes: Math.round(lerp(floor.spokes, ceil.spokes, t)),
    radius: lerp(floor.radius, ceil.radius, t),
    slices: floor.slices.map((s, i) => ({
      color: lerpRgba(s.color, ceil.slices[i].color, t),
      elevation: lerp(s.elevation, ceil.slices[i].elevation, t),
    })),
  };
}

/** xim EnvironmentLighting.ambientToColor — /510 + bias, clamp 0.5 (+ viewer boost). */
export function ambientToColor(c) {
  const bias = (c[0] < TH && c[1] < TH && c[2] < TH) ? BIAS : [1, 1, 1];
  const boost = 1.35;
  return [
    Math.min(0.65, bias[0] * c[0] / 510 * boost),
    Math.min(0.65, bias[1] * c[1] / 510 * boost),
    Math.min(0.65, bias[2] * c[2] / 510 * boost),
  ];
}

/** xim EnvironmentLighting.diffuseToColor (+ slight viewer boost). */
export function diffuseToColor(c, inten) {
  const d = [c[0] / 255 * inten, c[1] / 255 * inten, c[2] / 255 * inten];
  const thf = TH / 255;
  const bias = (d[0] < thf && d[1] < thf && d[2] < thf) ? BIAS : [1, 1, 1];
  const boost = 1.15;
  return [
    Math.min(1, d[0] * bias[0] * boost),
    Math.min(1, d[1] * bias[1] * boost),
    Math.min(1, d[2] * bias[2] * boost),
  ];
}

/**
 * Sun direction in **display** space (−x,−y,z). xim: normalize(sin a, cos a, 0)
 * with a = timeOfDaySeconds · (0.5π / 6h); display flips X and Y.
 */
export function sunDirDisplay(timeMinutes = 12 * 60) {
  const ang = (timeMinutes * 60) * (0.5 * Math.PI / 21600);
  const x = Math.sin(ang), y = Math.cos(ang);
  const len = Math.hypot(x, y) || 1;
  return [-x / len, -y / len, 0];
}

/** Build GPU terrain lighting uniforms from a resolved environment (or null). */
export function terrainLightingFromEnv(env, timeMinutes = 12 * 60) {
  if (!env) {
    // No 0x2F block (some interiors) — neutral key light so geometry stays readable.
    return {
      ambient: [0.55, 0.55, 0.55], sunDir: sunDirDisplay(timeMinutes), sunColor: [0.45, 0.45, 0.4],
      moonDir: [0, -1, 0], moonColor: [0.08, 0.08, 0.1],
      fogColor: [0.5, 0.55, 0.6], fogNear: 80, fogFar: 400, fogOn: false,
      clearColor: null, indoors: false,
    };
  }

  const m = env.terrain || env.model;
  const amb = ambientToColor(m.ambient);
  const sun = diffuseToColor(m.sun, m.diffuseMult || 1);
  const moon = diffuseToColor(m.moon, m.diffuseMult || 1);
  const sd = sunDirDisplay(timeMinutes);

  let sunDir = sd, sunColor = sun, moonDir = [-sd[0], -sd[1], -sd[2]], moonColor = moon;
  let ambient = amb;

  if (env.indoors) {
    // Indoor directional light: moon RGBA packs a signed direction in FFXI space.
    // Convert to display (−x,−y,z) — same as normals. Do NOT pre-negate: that
    // flipped the light against floor normals (N·L ≈ 0 → pure black caves).
    const s2b = (v) => (v > 127 ? v - 256 : v) / 128;
    let ix = s2b(m.moon[0]), iy = s2b(m.moon[1]), iz = s2b(m.moon[2]);
    const len = Math.hypot(ix, iy, iz) || 1;
    ix /= len; iy /= len; iz /= len;
    sunDir = [-ix, -iy, iz];
    sunColor = sun;
    moonDir = [0, -1, 0];
    moonColor = [0, 0, 0];
    // Terrain ambient is authored very dark (fill only); model ambient is the
    // readable indoor level. Prefer the brighter of the two so caves aren't murk.
    const modelAmb = ambientToColor((env.model || m).ambient);
    ambient = [
      Math.max(amb[0], modelAmb[0], 0.22),
      Math.max(amb[1], modelAmb[1], 0.22),
      Math.max(amb[2], modelAmb[2], 0.22),
    ];
  }

  const clear = env.indoors && env.clearColor
    ? [env.clearColor[0] / 255, env.clearColor[1] / 255, env.clearColor[2] / 255]
    : null;

  // xim LightConfig.getFogParams → FogParams(near = fogStart, far = fogEnd).
  // `noOpFog` is far = -1, so a non-positive far means "this environment has no
  // fog" and the shader disables it. Everything else fogs exactly as retail:
  // Qufim's `thdr` authors far = 203 with a dark grey, which is what turns the
  // sea/sky boundary into haze instead of a hard line.
  const fogNear = m.fogStart || 0;
  const fogFar = m.fogEnd || 0;

  return {
    ambient, sunDir, sunColor, moonDir, moonColor,
    fogColor: [m.fog[0] / 255, m.fog[1] / 255, m.fog[2] / 255],
    fogNear, fogFar, fogOn: fogFar > fogNear,
    clearColor: clear, indoors: !!env.indoors,
  };
}

/**
 * Sky-dome config for the renderer from a resolved environment. Slices are the
 * gradient rings (elevation 0 = horizon, 1 = zenith); the background/clear
 * colour is the horizon slice outdoors, or the explicit clearColor indoors
 * (xim getBackgroundColor).
 *
 * Colours are /255 only — the dome shader is unlit and writes vColor as-is.
 * Applying the terrain modulate-2× here crushed mid-greys (overcast horizons
 * ~175) to pure white, so clouds never fully covered the sky.
 */
export function skyDomeFromEnv(env) {
  if (!env || env.indoors || !(env.radius > 0) || !env.spokes) return null;
  const norm = (c) => [c[0] / 255, c[1] / 255, c[2] / 255];
  return {
    radius: env.radius,
    spokes: env.spokes,
    slices: env.slices.map((s) => ({ elevation: s.elevation, color: norm(s.color) })),
    horizon: norm(env.slices[0].color),
  };
}

// ── EnvironmentManager (xim EnvironmentManager.kt) ─────────────────────────

/** Elemental day cycle; the particle 0x4E day tints index into this order. */
export const DAYS_OF_WEEK = ['Fire', 'Earth', 'Water', 'Wind', 'Ice', 'Lightning', 'Light', 'Dark'];
export const MOON_PHASES = 12;

const SECONDS_IN_DAY = 24 * 60 * 60;
/** One in-game minute is 2.4 real seconds, and the particle clock runs at 30fps. */
const FRAMES_PER_GAME_MINUTE = 2.4 * secondsToFrames(1);

/** xim AdjustableClock. */
class GameClock {
  constructor() { this.currentMinute = 0; this.frameCounter = 0; }

  currentHour() { return Math.floor(this.currentMinute / 60); }
  currentMinuteOfHour() { return this.currentMinute % 60; }

  currentTimeOfDayInSeconds() {
    const seconds = Math.round(Math.floor((this.frameCounter / FRAMES_PER_GAME_MINUTE) * 60));
    return this.currentMinute * 60 + seconds;
  }

  getFullDayInterpolation() { return this.currentTimeOfDayInSeconds() / SECONDS_IN_DAY; }

  setTotalMinutes(total) {
    this.currentMinute = ((total % 1440) + 1440) % 1440;
    this.frameCounter = 0;
  }

  /** @returns true when the day rolled over, so the elemental day advances. */
  advanceFrames(elapsedFrames) {
    let dayRolled = false;
    this.frameCounter += elapsedFrames;
    while (this.frameCounter > FRAMES_PER_GAME_MINUTE) {
      this.currentMinute += 1;
      this.frameCounter -= FRAMES_PER_GAME_MINUTE;
      if (this.currentMinute >= 60 * 24) { this.currentMinute = 0; dayRolled = true; }
    }
    return dayRolled;
  }
}

/** Snapshot of the outgoing weather, held while it cross-fades into the new one. */
class WeatherTransition {
  constructor(snapshot, fadeParameters) {
    this.snapshot = snapshot;              // env root id -> resolved environment
    this.fadeParameters = fadeParameters;
  }
  /** 0 at the start of the fade, 1 once the new weather has fully taken over. */
  getDelta() { return 1 - this.fadeParameters.getOpacity(); }
  isComplete() { return this.fadeParameters.isComplete(); }
}

const lerpEnv = (e0, e1, t) => ({
  hour: e1.hour,
  indoors: e0.indoors,
  model: lerpLight(e0.model, e1.model, t),
  terrain: lerpLight(e0.terrain, e1.terrain, t),
  clearColor: lerpRgba(e0.clearColor, e1.clearColor, t),
  drawDistance: lerp(e0.drawDistance, e1.drawDistance, t),
  spokes: Math.round(lerp(e0.spokes, e1.spokes, t)),
  radius: lerp(e0.radius, e1.radius, t),
  slices: e0.slices.map((s, i) => ({
    color: lerpRgba(s.color, e1.slices[i].color, t),
    elevation: lerp(s.elevation, e1.slices[i].elevation, t),
  })),
});

/**
 * Owns the clock, the current weather, and the cross-fade between weathers.
 *
 * Switching weather in FFXI is not a swap: the outgoing environment is captured
 * and lerped toward the incoming one over ~3.3 seconds while the two weathers'
 * particle sets fade past each other. Sky colour, fog, draw distance and
 * lighting all travel together, which is what makes a storm roll in rather than
 * blink on.
 */
export class EnvironmentManager {
  constructor(environmentsByRoot, { particleSystem = null } = {}) {
    this.byRoot = environmentsByRoot ?? new Map();
    this.weat = this.byRoot.get('weat') ?? new Map();
    this.particleSystem = particleSystem;

    this.clock = new GameClock();
    this.dayOfWeek = 3;    // Windsday — xim's default
    this.moonPhase = 6;    // Full moon
    this.currentWeather = defaultWeather(this.weat);
    this.weatherTransition = null;

    this._cache = new Map();
  }

  get weathers() { return [...this.weat.keys()]; }
  getWeather() { return this.currentWeather; }
  getDayOfWeek() { return this.dayOfWeek; }
  getMoonPhase() { return this.moonPhase; }
  getFullDayInterpolation() { return this.clock.getFullDayInterpolation(); }
  getTimeMinutes() { return this.clock.currentHour() * 60 + this.clock.currentMinuteOfHour(); }

  setTimeMinutes(total) { this.clock.setTotalMinutes(total); this._cache.clear(); }
  setDayOfWeek(index) { this.dayOfWeek = ((index % 8) + 8) % 8; }
  setMoonPhase(index) { this.moonPhase = ((index % MOON_PHASES) + MOON_PHASES) % MOON_PHASES; }

  /** Advance time and any running transition. Call once per frame. */
  update(elapsedFrames, { advanceClock = true } = {}) {
    if (advanceClock && this.clock.advanceFrames(elapsedFrames)) {
      this.dayOfWeek = (this.dayOfWeek + 1) % 8;
    }
    if (this.weatherTransition) {
      this.weatherTransition.fadeParameters.update(elapsedFrames);
      if (this.weatherTransition.isComplete()) this.weatherTransition = null;
    }
    this._cache.clear();
  }

  /**
   * Register the starting weather's effects. Kept separate from switchWeather so
   * the initial load doesn't fade in from nothing.
   */
  activateInitialWeather() {
    if (!this.currentWeather || !this.particleSystem) return;
    this.particleSystem.registerWeatherEffects(this.currentWeather);
  }

  /** xim EnvironmentManager.switchWeather. */
  switchWeather(newWeather, interpolationSeconds = 3.33) {
    if (!newWeather || newWeather === this.currentWeather) return;
    if (!this.weat.has(newWeather)) return;

    const durationFrames = secondsToFrames(interpolationSeconds);
    const snapshot = new Map();
    for (const key of this.byRoot.keys()) snapshot.set(key, this._resolve(key, this.currentWeather));

    const fadeOut = FadeParameters.fadeOut(durationFrames);
    const system = this.particleSystem;
    if (system) system.effectManager.applyFadeParameter(WeatherAssociation(this.currentWeather), fadeOut);
    this.weatherTransition = new WeatherTransition(snapshot, fadeOut);

    this.currentWeather = newWeather;

    if (system) {
      // The outgoing association is torn down by its own fade, so a weather we
      // come back to has to be registered again.
      system.registerWeatherEffects(newWeather);
      system.effectManager.applyFadeParameter(WeatherAssociation(newWeather), FadeParameters.fadeIn(durationFrames));
    }

    this._cache.clear();
  }

  _resolve(envKey, weather) {
    const byWeather = this.byRoot.get(envKey) ?? this.weat;
    let frames = byWeather.get(weather);
    // xim falls back to an arbitrary weather when a sub-environment doesn't
    // define the active one (Apollyon's [ev01] has no Dark, for instance).
    if (!frames) frames = byWeather.values().next().value;
    if (!frames?.length) return null;
    return resolveEnvironment(new Map([[weather, frames]]), weather, this.getTimeMinutes());
  }

  /**
   * The environment for a link id, blended across an active weather transition.
   * A null `environmentId` means the main `weat` tree.
   */
  getEnvironment(environmentId = null) {
    const key = environmentId && this.byRoot.has(environmentId) ? environmentId : 'weat';
    const cached = this._cache.get(key);
    if (cached !== undefined) return cached;

    let env = this._resolve(key, this.currentWeather);
    const transition = this.weatherTransition;
    if (transition && env) {
      const previous = transition.snapshot.get(key);
      if (previous) env = lerpEnv(previous, env, transition.getDelta());
    }

    this._cache.set(key, env);
    return env;
  }

  /** Terrain lighting uniforms for the renderer, fog included. */
  getTerrainLighting(environmentId = null) {
    return terrainLightingFromEnv(this.getEnvironment(environmentId), this.getTimeMinutes());
  }

  getSkyDome(environmentId = null) {
    return skyDomeFromEnv(this.getEnvironment(environmentId));
  }

  /**
   * Model lighting in the shape the particle ops expect: Color-valued lights, so
   * the DaylightBasedColor operators can pick the strongest one.
   */
  getModelLighting(environmentId = null) {
    const env = this.getEnvironment(environmentId);
    if (!env) return null;
    const m = env.model || env.terrain;
    const sun = diffuseToColor(m.sun, m.diffuseMult || 1);
    const moon = diffuseToColor(m.moon, m.diffuseMult || 1);
    const dir = sunDirDisplay(this.getTimeMinutes());
    return {
      ambientColor: new Color(...ambientToColor(m.ambient), 1),
      lights: [
        { direction: new Vec3(dir[0], dir[1], dir[2]), color: new Color(sun[0], sun[1], sun[2], 1) },
        { direction: new Vec3(-dir[0], -dir[1], -dir[2]), color: new Color(moon[0], moon[1], moon[2], 1) },
      ],
    };
  }

  /** Sun and moon ride a circle that completes a quarter turn every 6 hours. */
  getSunPosition() {
    const angle = this.clock.currentTimeOfDayInSeconds() * ((0.5 * Math.PI) / (6 * 60 * 60));
    return new Vec3(Math.sin(angle), Math.cos(angle), 0).normalizeInPlace().scaleInPlace(900);
  }

  getMoonPosition() {
    const angle = Math.PI + this.clock.currentTimeOfDayInSeconds() * ((0.5 * Math.PI) / (6 * 60 * 60));
    return new Vec3(Math.sin(angle), Math.cos(angle), 0).normalizeInPlace().scaleInPlace(900);
  }
}
