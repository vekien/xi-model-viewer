// EffectManager + fade parameters — port of xim EffectManager.kt.
//
// Effects are grouped by "association": everything a zone owns under one
// ZoneAssociation, everything a weather type owns under its WeatherAssociation.
// That grouping is what makes a weather change work — switching weather applies
// a fade-out to the old association and a fade-in to the new one, so the two
// sets of particles cross-dissolve instead of popping.

import { secondsToFrames } from './math.js';

export const ZoneAssociation = (areaId = 'main') => ({ kind: 'zone', key: `zone:${areaId}`, areaId });
export const WeatherAssociation = (weatherId) => ({ kind: 'weather', key: `weather:${weatherId}`, weatherId });

/** A linear opacity ramp over `duration` frames (xim FadeParameters). */
export class FadeParameters {
  constructor(opacityStart, opacityEnd, duration, removeOnComplete) {
    this.opacityStart = opacityStart;
    this.opacityEnd = opacityEnd;
    this.duration = duration;
    this.removeOnComplete = removeOnComplete;
    this.counter = 0;
  }

  static get noFade() { return new FadeParameters(1, 1, 0, false); }

  static defaultFadeIn() { return FadeParameters.fadeIn(secondsToFrames(3.33)); }
  static defaultFadeOut() { return FadeParameters.fadeOut(secondsToFrames(3.33)); }

  static fadeIn(durationFrames) { return new FadeParameters(0, 1, durationFrames, false); }
  static fadeOut(durationFrames, removeOnComplete = true) {
    return new FadeParameters(1, 0, durationFrames, removeOnComplete);
  }

  update(elapsedFrames) {
    const wasComplete = this.isComplete();
    this.counter += elapsedFrames;
    return !wasComplete && this.isComplete();
  }

  shouldRemove() { return this.removeOnComplete && this.isComplete(); }
  isComplete() { return this.counter >= this.duration; }

  getOpacity() {
    if (this.duration === 0) return this.opacityEnd;
    const t = this.counter / this.duration;
    const v = this.opacityStart + (this.opacityEnd - this.opacityStart) * t;
    return Math.min(1, Math.max(0, v));
  }
}

/** One association's live generators plus its shared fade. */
class EffectRoutines {
  constructor() {
    this.generators = [];
    this.fadeParameters = FadeParameters.noFade;
  }

  update(elapsedFrames) {
    for (const gen of this.generators) gen.update(elapsedFrames);
    this.generators = this.generators.filter((g) => !g.isExpired());

    this.fadeParameters.update(elapsedFrames);
    if (this.fadeParameters.shouldRemove()) {
      for (const g of this.generators) g.stopEmitting();
      this.generators = [];
    }
  }

  shouldRemove() { return this.generators.length === 0 && this.fadeParameters.isComplete(); }
}

export class EffectManager {
  constructor() { this.routines = new Map(); }

  update(elapsedFrames) {
    for (const routines of [...this.routines.values()]) routines.update(elapsedFrames);
    for (const [key, routines] of [...this.routines]) {
      if (routines.shouldRemove()) this.routines.delete(key);
    }
  }

  /** Register a top-level generator under an association. */
  register(association, generator) {
    const routines = this.#get(association);
    routines.generators.push(generator);
    return generator;
  }

  applyFadeParameter(association, fadeParameters) {
    this.#get(association).fadeParameters = fadeParameters;
  }

  clearEffects(association) {
    const routines = this.routines.get(association.key);
    if (!routines) return;
    for (const g of routines.generators) g.stopEmitting();
    this.routines.delete(association.key);
  }

  clearAll() {
    for (const routines of this.routines.values()) {
      for (const g of routines.generators) g.stopEmitting();
    }
    this.routines.clear();
  }

  hasAssociation(association) { return this.routines.has(association.key); }

  /**
   * Every live particle, each paired with its association's current fade
   * opacity. xim multiplies that into the particle's alpha at draw time, which
   * is how a departing weather's rain thins out rather than vanishing.
   */
  getAllParticles() {
    const out = [];
    for (const routines of this.routines.values()) {
      const opacity = routines.fadeParameters.getOpacity();
      for (const gen of routines.generators) {
        for (const p of gen.getActiveParticles()) {
          out.push({ particle: p, opacity });
          for (const child of p.getChildrenRecursively()) out.push({ particle: child, opacity });
        }
      }
    }
    return out;
  }

  countParticles() {
    let n = 0;
    for (const routines of this.routines.values()) {
      for (const gen of routines.generators) {
        for (const p of gen.getActiveParticles()) n += 1 + p.getChildrenRecursively().length;
      }
    }
    return n;
  }

  #get(association) {
    let routines = this.routines.get(association.key);
    if (!routines) { routines = new EffectRoutines(); this.routines.set(association.key, routines); }
    return routines;
  }
}
