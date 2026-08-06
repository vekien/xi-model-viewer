// Generator-level updaters (opcode section 1) and expiration handlers (section 4).
// Ports of xim ParticleGeneratorUpdaters.kt and ParticleExpirationHandlers.kt.
//
// Section-1 opcodes animate the *emitter* rather than individual particles —
// emission rate, spawn-shell radius, base position — so a single generator can
// ramp a downpour up and down or sweep spray along a shoreline.

import { Vec3, PI_f } from '../math.js';
import { DatLink, AttachType } from '../types.js';

class GeneratorUpdater {
  read() {}
  apply() {}
}

/**
 * Base for the section-1 opcodes that read a keyframe curve. Progress is
 * measured against the generator's own lifetime rather than a particle's.
 */
class GeneratorKeyFrameUpdater extends GeneratorUpdater {
  read(r) {
    r.next32();
    this.keyFrameLink = new DatLink(r.nextDatId());
    r.next32();          // 0 or 1
    this.spare = r.nextFloat();
  }

  getGeneratorProgressValue(gen, initialValue = null) {
    return this.#progress(gen, gen.maxEmitTime, initialValue);
  }

  getGeneratorPlusParticleProgressValue(gen, initialValue = null) {
    const maxLifeTime = gen.maxEmitTime + (gen.def.particleConfiguration?.maxLifeSpan ?? 0);
    return this.#progress(gen, maxLifeTime, initialValue);
  }

  #progress(gen, maxLifeTime, initialValue) {
    const curve = this.keyFrameLink.getOrPut((id) => gen.runtime.resolveKeyFrame(id, gen));
    if (!curve) return null;
    const progress = Math.min(1, gen.getTotalLifeTime() / maxLifeTime);
    return curve.getCurrentValue(progress, initialValue);
  }
}

/** 0x11 — whether the emitter tracks its attachment's position/facing. */
export class AssociationUpdater extends GeneratorUpdater {
  read(r) {
    const config = r.next32();
    this.followAttachedPosition = (config & 0x1) !== 0;
    this.followAttachedFacing = (config & 0x2) !== 0;
    // The remaining bits act like a rubber-banding rate; xim doesn't model them.
    this.followAttachedFactor = config >>> 2;
  }

  apply(elapsed, gen) {
    if (this.followAttachedPosition) gen.updateAssociatedPosition(elapsed);
    if (this.followAttachedFacing) gen.updateAssociatedFacing(elapsed);
  }
}

/** 0x0A — stop emitting when the viewer is too far away. */
export class GeneratorCullUpdater extends GeneratorUpdater {
  read(r) {
    this.maxEmitDistance = r.nextFloat();
    r.nextFloat();      // unknown, -1 .. 600
    r.next32();         // 0 or 1
  }

  apply(elapsed, gen) {
    if (!Number.isFinite(gen.def.framesPerEmission) || this.maxEmitDistance === 0) return;
    const emitterPosition = gen.def.particleConfiguration?.basePosition ?? Vec3.ZERO;
    const viewer = gen.runtime.getCullReferencePosition();
    gen.emitCulled = Vec3.distance(viewer, emitterPosition) > this.maxEmitDistance;
  }
}

export class GeneratorRotationUpdater extends GeneratorKeyFrameUpdater {
  constructor(axis) { super(); this.axis = axis; }
  apply(elapsed, gen) {
    const rotation = this.getGeneratorPlusParticleProgressValue(gen);
    if (rotation == null) return;
    gen.rotation.setAxis(this.axis, PI_f * rotation);
  }
}

export class GeneratorBasePositionUpdater extends GeneratorKeyFrameUpdater {
  constructor(axis) { super(); this.axis = axis; }
  apply(elapsed, gen) {
    const value = this.getGeneratorPlusParticleProgressValue(gen);
    if (value == null) return;
    const setup = gen.def.initializers.find((i) => i.constructor.name === 'StandardParticleSetup');
    if (setup) setup.config.basePosition.setAxis(this.axis, value);
  }
}

export class GeneratorVelocityUpdater extends GeneratorKeyFrameUpdater {
  constructor(axis) { super(); this.axis = axis; }
  apply(elapsed, gen) {
    const velocity = this.getGeneratorProgressValue(gen);
    if (velocity == null) return;
    const setup = gen.def.initializers.find((i) => i.constructor.name === 'TranslationVelocitySetup');
    if (setup) setup.velocity.setAxis(this.axis, velocity);
  }
}

export class RelativeVelocityUpdater extends GeneratorKeyFrameUpdater {
  apply(elapsed, gen) {
    const velocity = this.getGeneratorProgressValue(gen);
    if (velocity == null) return;
    const setup = gen.def.initializers.find((i) => i.constructor.name === 'RelativeVelocitySetup');
    if (setup) setup.velocity = velocity;
  }
}

/** 0x06-0x09 — animate the spawn shell. Only 0x1F shells are affected (xim-verified). */
export class SphericalPositionUpdater extends GeneratorKeyFrameUpdater {
  constructor(updater) { super(); this.updater = updater; }
  apply(elapsed, gen) {
    const value = this.getGeneratorProgressValue(gen);
    if (value == null) return;
    const setup = gen.def.initializers.find((i) => i.constructor.name === 'SphericalPositionVarianceFull');
    if (setup) this.updater(setup.positionVariance, value);
  }
}

/** 0x04 — ramps the emission rate; `frequency` is emissions per 60 frames. */
export class EmissionFrequencyUpdater extends GeneratorKeyFrameUpdater {
  apply(elapsed, gen) {
    const initialValue = 60 / gen.def.framesPerEmission;
    const frequency = this.getGeneratorProgressValue(gen, initialValue);
    if (frequency == null || frequency <= 0) return;
    gen.framesPerEmission = 60 / frequency;
  }
}

/** Mirrors xim ParticleGeneratorParser.sec1Handler. */
export function makeGeneratorUpdater(opCode) {
  switch (opCode) {
    case 0x04: return new EmissionFrequencyUpdater();
    case 0x05: return new RelativeVelocityUpdater();
    case 0x06: return new SphericalPositionUpdater((p, v) => { p.baseRadius = v; });
    case 0x07: return new SphericalPositionUpdater((p, v) => { p.radiusVariance = v; });
    case 0x08: return new SphericalPositionUpdater((p, v) => { p.rotationZAxis = v * PI_f; });
    case 0x09: return new SphericalPositionUpdater((p, v) => { p.rotationYAxis = v * PI_f; });
    case 0x0a: return new GeneratorCullUpdater();
    case 0x0b: return new GeneratorBasePositionUpdater(0);
    case 0x0c: return new GeneratorBasePositionUpdater(1);
    case 0x0d: return new GeneratorBasePositionUpdater(2);
    case 0x0e: return new GeneratorRotationUpdater(0);
    case 0x0f: return new GeneratorRotationUpdater(1);
    case 0x10: return new GeneratorRotationUpdater(2);
    case 0x11: return new AssociationUpdater();
    case 0x12: return new GeneratorVelocityUpdater(0);
    case 0x13: return new GeneratorVelocityUpdater(1);
    case 0x14: return new GeneratorVelocityUpdater(2);
    default: return null;
  }
}

// ── section 4: expiration handlers ─────────────────────────────────────────

/** 0x05 — loop forever by resetting age instead of dying. */
export class RepeatExpirationHandler {
  read() {}
  onExpire(particle) { particle.resetAge(); }
}

/** 0x01 — spawn a burst of children at death (splash on impact). */
export class EmitChildHandler {
  read(r) { r.next32(); this.generatorLink = new DatLink(r.nextDatId()); }

  onExpire(particle) {
    const effect = this.generatorLink.getOrPut((id) => particle.runtime.resolveEffect(id, particle.creator));
    if (!effect) {
      particle.runtime.warn(`[${particle.datId}] expiration child not found: ${this.generatorLink.id}`);
      return;
    }
    const generator = particle.runtime.createGenerator(effect, particle.association, Infinity, particle);
    const emitted = generator.emit(0, (child) => { child.useParentAssociatedPositionOnly = true; });
    for (const c of emitted) particle.children.push(c);
  }
}

export function makeExpirationHandler(opCode) {
  switch (opCode) {
    case 0x01: return new EmitChildHandler();
    case 0x05: return new RepeatExpirationHandler();
    default: return null;
  }
}

export { AttachType };
