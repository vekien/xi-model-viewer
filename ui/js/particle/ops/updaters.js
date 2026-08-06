// Particle updaters — opcode section 3. Port of xim ParticleUpdaters.kt.
//
// These run every frame against a live particle. The two workhorses are
// ProgressValueUpdater (samples a keyframe curve at the particle's normalised
// age) and ClockValueUpdater (samples it at the time of day instead) — together
// they animate essentially everything a zone effect does.

import { Vec3, Color, PI_f, rand, fallOff, PI_f as PI } from '../math.js';
import { ParticleTransform, PositionTransform, OscillationParams } from '../types.js';

class Updater {
  read() {}
  apply() {}
}

export class NoOpParticleUpdater extends Updater {}

// ── transform integration ──────────────────────────────────────────────────

export class PositionUpdater extends Updater {
  constructor(offset) { super(); this.allocationOffset = offset; }
  apply(elapsed, particle) {
    const t = particle.getDynamic(this.allocationOffset);
    if (!t) return;
    particle.position.addInPlace(particle.getTotalVelocity(t).scale(elapsed));
  }
  applySub(elapsed, particle, sub) {
    sub.position.addInPlace(sub.relativeVelocity.scale(elapsed));
  }
}

export class ScaleUpdater extends Updater {
  constructor(offset) { super(); this.allocationOffset = offset; }
  apply(elapsed, particle) {
    const t = particle.getDynamic(this.allocationOffset);
    if (!t) return;
    particle.scale.addInPlace(t.velocity.scale(elapsed));
  }
}

export class RotationUpdater extends Updater {
  constructor(offset) { super(); this.allocationOffset = offset; }
  apply(elapsed, particle) {
    const t = particle.getDynamic(this.allocationOffset);
    if (!t) return;
    particle.rotation.addInPlace(t.velocity.scale(elapsed));
  }
}

export class VelocityAccelerator extends Updater {
  constructor(offset) { super(); this.allocationOffset = offset; this.acceleration = new Vec3(); }
  read(r) { this.acceleration.copyFrom(r.nextVector3f()); }
  apply(elapsed, particle) {
    const t = particle.getDynamic(this.allocationOffset);
    if (!t) return;
    t.velocity.addInPlace(this.acceleration.scale(elapsed));
  }
}

export class VelocityRotationUpdater extends Updater {
  constructor(offset) { super(); this.allocationOffset = offset; }
  apply(elapsed, particle) {
    const t = particle.getDynamic(this.allocationOffset);
    if (!t) return;
    // Side effect noted in xim: all velocity collapses onto +x (forward).
    const magnitude = t.velocity.magnitude() + t.relativeVelocity.magnitude();
    t.velocity.set(0, 0, 0);
    t.relativeVelocity.set(0, 0, 0);
    t.velocity.x = magnitude;
    t.velocityRotation.copyFrom(particle.rotation);
  }
}

export class VelocityRotator extends Updater {
  constructor(offset) { super(); this.allocationOffset = offset; this.rotateAmount = new Vec3(); }
  read(r) { this.rotateAmount.copyFrom(r.nextVector3f()); }
  apply(elapsed, particle) {
    const t = particle.getDynamic(this.allocationOffset);
    if (!t) return;
    // Actor-space effects need the axes swizzled (xim: ge31 black-magic cast).
    const rot = particle.isActorAssociated()
      ? new Vec3(-this.rotateAmount.z, this.rotateAmount.y, this.rotateAmount.x)
      : this.rotateAmount;
    t.velocityRotation.addInPlace(rot.scale(0.5 * elapsed));
  }
}

export class VelocityDampener extends Updater {
  constructor(offset) { super(); this.allocationOffset = offset; }
  read(r) { this.dampen = r.nextFloat(); r.nextFloat(); }

  apply(elapsed, particle) {
    const t = particle.getDynamic(this.allocationOffset);
    if (!t) return;
    const f = this.#factor(elapsed, t);
    t.velocity.scaleInPlace(f);
    t.relativeVelocity.scaleInPlace(f);
  }

  applySub(elapsed, particle, sub) {
    const t = particle.getDynamic(this.allocationOffset);
    if (!t) return;
    sub.relativeVelocity.scaleInPlace(Math.pow(this.#factor(elapsed, t), elapsed));
  }

  #factor(elapsed, t) {
    return Math.pow(t.dampeningFactor ?? this.dampen, elapsed);
  }
}

// ── keyframe sampling ──────────────────────────────────────────────────────

/**
 * Samples a curve at the particle's own progress (age / maxAge), optionally
 * looped `numCycles` times, and writes the result somewhere on the particle.
 *
 * `integrate` turns the sampled value into a per-frame delta (used by the
 * accumulating UV-scroll and spin opcodes). `initialValueFn` seeds the first
 * keyframe from whatever the particle already had, so a curve can ramp from the
 * initialised value rather than snapping to the authored one.
 */
export class ProgressValueUpdater extends Updater {
  constructor(offset, { integrate = false, initialValueFn = null, updateFn }) {
    super();
    this.allocationOffset = offset;
    this.integrate = integrate;
    this.initialValueFn = initialValueFn;
    this.updateFn = updateFn;
  }

  apply(elapsed, particle) {
    const ref = particle.getDynamic(this.allocationOffset);
    if (!ref?.link) return;
    const curve = ref.link.getOrPut((id) => particle.runtime.resolveKeyFrame(id, particle.creator));
    if (!curve) return;

    if (this.initialValueFn && ref.initialValueOverride == null) {
      ref.initialValueOverride = this.initialValueFn(particle);
    }

    const progress = mod1(ref.numCycles * particle.getProgress());
    const value = curve.getCurrentValue(progress, ref.initialValueOverride);
    this.updateFn(particle, this.integrate ? value * elapsed : value);
  }
}

/** Samples the curve against the 24-hour clock instead of particle age. */
export class ClockValueUpdater extends Updater {
  constructor(offset, updateFn) { super(); this.allocationOffset = offset; this.updateFn = updateFn; }

  apply(elapsed, particle) {
    const ref = particle.getDynamic(this.allocationOffset);
    if (!ref?.link) return;
    const curve = ref.link.getOrPut((id) => particle.runtime.resolveKeyFrame(id, particle.creator));
    if (!curve) return;
    this.updateFn(particle, curve.getCurrentValue(particle.runtime.getFullDayInterpolation()));
  }
}

export class ClockValueRotationUpdater extends ClockValueUpdater {
  read(r) { r.nextFloat(); r.nextFloat(); r.nextFloat(); r.nextFloat(); }
}

const mod1 = (v) => { const m = v % 1; return m < 0 ? m + 1 : m; };

// ── texture / sprite ───────────────────────────────────────────────────────

/** Constant UV drift — the classic scrolling-water and cloud-drift opcode. */
export class TextureCoordinateUpdater extends Updater {
  constructor(axis) { super(); this.axis = axis; }
  read(r) { this.translateAmount = r.nextFloat(); }
  apply(elapsed, particle) {
    if (this.axis === 0) particle.texCoordTranslate.x += this.translateAmount * elapsed;
    else particle.texCoordTranslate.y += this.translateAmount * elapsed;
  }
}

export class SpriteSheetFrameUpdater extends Updater {
  apply(elapsed, particle) {
    const sheet = particle.meshProvider?.spriteSheet;
    if (!sheet) return;
    const numSprites = sheet.meshes.length + 1;
    const sprite = Math.round(Math.floor(numSprites * particle.getProgress()));
    particle.spriteSheetIndex = sprite >= sheet.meshes.length ? sheet.meshes.length - 1 : sprite;
  }
}

export class MoonPhaseSpriteSheetUpdater extends Updater {
  apply(elapsed, particle) { particle.spriteSheetIndex = particle.runtime.getMoonPhase(); }
}

// ── colour ─────────────────────────────────────────────────────────────────

export class ColorTransformApplier extends Updater {
  constructor(offset) { super(); this.allocationOffset = offset; }
  apply(elapsed, particle) {
    const ct = particle.getDynamic(this.allocationOffset);
    if (!ct) return;
    const transform = new Color(ct.r >> 7, ct.g >> 7, ct.b >> 7, ct.a >> 7);
    particle.color.addInPlace(transform.withMultiplied(0.5 * elapsed));
  }
}

export class ColorTransformModifier extends Updater {
  constructor(offset) { super(); this.allocationOffset = offset; }
  read(r) {
    this.modifier = { r: r.next16Signed(), g: r.next16Signed(), b: r.next16Signed(), a: r.next16Signed() };
  }
  apply(elapsed, particle) {
    const ct = particle.getDynamic(this.allocationOffset);
    if (!ct) return;
    const rate = elapsed / 30;
    ct.r += Math.floor(this.modifier.r * rate);
    ct.g += Math.floor(this.modifier.g * rate);
    ct.b += Math.floor(this.modifier.b * rate);
    ct.a += Math.floor(this.modifier.a * rate);
  }
}

/** 0x4E — eight authored tints, one per elemental day. */
export class DayOfWeekColorUpdater extends Updater {
  read(r) {
    r.next32();
    this.colors = [];
    for (let i = 0; i < 8; i++) this.colors.push(Color.fromBytes(r.nextRGBA()));
  }
  apply(elapsed, particle) { particle.colorDayOfWeek = this.colors[particle.runtime.getDayOfWeek()]; }
}

/** 0x4F — twelve authored tints, one per moon phase. */
export class MoonPhaseColorUpdater extends Updater {
  read(r) {
    r.next32();
    this.colors = [];
    for (let i = 0; i < 12; i++) this.colors.push(Color.fromBytes(r.nextRGBA()));
  }
  apply(elapsed, particle) { particle.colorMoonPhase = this.colors[particle.runtime.getMoonPhase()]; }
}

export class DaylightBasedColorApplier extends Updater {
  constructor(offset) { super(); this.allocationOffset = offset; }
  read(r) { r.next32(); }
  apply(elapsed, particle) {
    const lighting = particle.runtime.getModelLighting(particle.creator.def.environmentId);
    let best = null, bestSum = -Infinity;
    for (const l of lighting?.lights ?? []) {
      const sum = l.color.r() + l.color.g() + l.color.b();
      if (sum > bestSum) { bestSum = sum; best = l.color; }
    }
    if (best) particle.colorMultiplier.modulateRgbInPlace(best, 1);
  }
}

// ── distance-based visibility ──────────────────────────────────────────────

/** 0x2E — fade out with distance, and cull entirely past `far`. */
export class DrawDistanceUpdater extends Updater {
  read(r) { this.near = r.nextFloat(); this.far = r.nextFloat(); r.next32(); }
  apply(elapsed, particle) {
    const distance = Vec3.distance(particle.runtime.camera.getPosition(), particle.getWorldSpacePosition());
    const multiplier = fallOff(distance, this.near, this.far);
    particle.drawDistanceCulled = multiplier === 0;
    particle.colorMultiplier.multiplyAlphaInPlace(multiplier);
  }
}

/** 0x48 — visible only inside a band: fades in near, out far. */
export class DoubleRangeDrawDistanceUpdater extends Updater {
  read(r) {
    this.nearRange = [r.nextFloat(), r.nextFloat()];
    this.farRange = [r.nextFloat(), r.nextFloat()];
    r.nextFloat();
  }
  apply(elapsed, particle) {
    const distance = Vec3.distance(particle.runtime.camera.getPosition(), particle.getWorldSpacePosition())
      + 1.15 * Math.abs(particle.scale.x);
    const multiplier = doubleRangeWeight(distance, this.nearRange, this.farRange);
    particle.drawDistanceCulled = multiplier === 0;
    particle.colorMultiplier.multiplyAlphaInPlace(multiplier);
  }
}

export class DoubleRangeWeightedMeshUpdater extends Updater {
  read(r) {
    this.nearRange = [r.nextFloat(), r.nextFloat()];
    this.farRange = [r.nextFloat(), r.nextFloat()];
    r.nextFloat();
  }
  apply(elapsed, particle) {
    const distance = Vec3.distance(particle.runtime.camera.getPosition(), particle.getWorldSpacePosition());
    const weight = doubleRangeWeight(distance, this.nearRange, this.farRange);
    particle.weightedMeshWeights[0] = weight;
    particle.weightedMeshWeights[1] = 1 - weight;
  }
}

function doubleRangeWeight(distance, nearRange, farRange) {
  if (distance < nearRange[0]) return 0;
  if (distance < nearRange[1]) return 1 - (nearRange[1] - distance) / (nearRange[1] - nearRange[0]);
  if (distance < farRange[0]) return 1;
  if (distance < farRange[1]) return 1 - (distance - farRange[0]) / (farRange[1] - farRange[0]);
  return 0;
}

// ── motion ─────────────────────────────────────────────────────────────────

/** 0x29-0x2B — sinusoidal sway, e.g. drifting snow and swirling leaves. */
export class OscillationApplier extends Updater {
  constructor(offset, axis) { super(); this.allocationOffset = offset; this.axis = axis; }

  read(r) {
    this.oscillationRate = 180 / r.nextFloat();   // 180 determined empirically in xim
    this.baseOffset = r.nextFloat();
    r.nextFloat();
  }

  apply(elapsed, particle) {
    if (!Number.isFinite(this.oscillationRate)) return;
    const t = particle.getDynamic(this.allocationOffset);
    if (!t) return;

    const frequency = PI_f * (particle.age() / this.oscillationRate);
    const baseAmplitude = 0.5 * (Math.sin(this.baseOffset + frequency - PI_f / 2) + Math.cos(this.baseOffset));
    const amplitude = 0.5 * t.acceleration.get(this.axis) * baseAmplitude * this.oscillationRate;
    const delta = amplitude - t.previousAmplitude.get(this.axis);

    particle.position.addInPlace(this.#direction(particle).scale(delta));
    t.previousAmplitude.setAxis(this.axis, amplitude);
  }

  #direction(particle) {
    const t = particle.getDynamicByType(ParticleTransform);
    if (!t || t.relativeVelocity.magnitude() < 1e-7) {
      return new Vec3().setAxis(this.axis, 1);
    }
    const forward = t.relativeVelocity.normalize();
    if (this.axis === 0) return forward;
    if (this.axis === 1) return forward.cross(Vec3.Z).normalizeInPlace();
    return forward.cross(Vec3.Y).normalizeInPlace();
  }
}

/** 0x59 — spin relative to the camera; keeps flat sprites edge-on correctly. */
export class AngularDistanceRotationUpdater extends Updater {
  read(r) {
    this.angularDistanceFactor = r.nextFloat();
    this.constantFactor = r.nextFloat();
    r.next32();
  }
  apply(elapsed, particle) {
    const camera = particle.runtime.camera;
    const cameraPos = camera.getPosition();
    const particlePos = particle.getWorldSpacePosition();
    const distance = Vec3.distance(cameraPos, particlePos);
    const dir = particlePos.sub(cameraPos).normalizeInPlace();
    const angle = 16 * Math.acos(Math.max(-1, Math.min(1, camera.getViewVector().dot(dir))));
    particle.rotation.z = -(this.constantFactor + this.angularDistanceFactor * (angle + distance));
  }
}

export class PointListPositionUpdater extends Updater {
  constructor(offset) { super(); this.allocationOffset = offset; }
  apply(elapsed, particle) {
    const data = particle.getDynamic(this.allocationOffset);
    if (!data) return;
    const list = data.pointListLink.getOrPut((id) => particle.runtime.resolvePointList(id, particle.creator));
    if (!list) return;

    const particleProgress = particle.getProgress();
    const curve = data.keyFrameLink?.getOrPut((id) => particle.runtime.resolveKeyFrame(id, particle.creator));
    const positionProgress = curve ? curve.getCurrentValue(particleProgress) : particleProgress;

    particle.position.copyFrom(splinePosition(list.points, positionProgress));
  }
}

/** Catmull-Rom-ish sampling along the point list (xim Path.getSplinePosition). */
function splinePosition(points, progress) {
  if (points.length === 1) return points[0].clone();
  const t = Math.max(0, Math.min(1, progress)) * (points.length - 1);
  const i = Math.min(points.length - 2, Math.floor(t));
  return Vec3.lerp(points[i], points[i + 1], t - i);
}

// ── child generators ───────────────────────────────────────────────────────

export class ChildGeneratorUpdater extends Updater {
  constructor(offset, billBoardType) { super(); this.allocationOffset = offset; this.billBoardType = billBoardType; }

  apply(elapsed, particle) {
    const ref = particle.getDynamic(this.allocationOffset);
    const generator = ref?.generator;
    if (!generator) return;

    const worldTransform = particle.runtime.newMat4();
    particle.computeWorldSpaceTransform(worldTransform);
    if (this.billBoardType !== 'None') worldTransform.identityUpperLeft();

    // Rotation order is forced to XYZ for children (xim: Fowl Aubade & friends).
    const particleTransform = particle.runtime.newMat4();
    particle.computeParticleSpaceOrientationTransform(particleTransform, this.billBoardType, 'XYZ');

    const transform = particle.runtime.newMat4();
    worldTransform.multiply(particleTransform, transform);

    const updateChild = (child) => {
      child.associatedPosition.set(0, 0, 0);
      child.useParentAssociatedPositionOnly = true;
      child.associatedRotation.identity();
      child.useParentOrientation = true;
      child.parentOffsetTransform = transform;
      if (this.billBoardType === 'None') child.parentOrientation.copyFrom(particle.associatedRotation);
    };

    const newChildren = generator.emit(elapsed, updateChild);
    for (const c of particle.children) if (c.config.followGenerator) updateChild(c);
    for (const c of newChildren) particle.children.push(c);
  }
}

export class ChildGeneratorBasicUpdater extends Updater {
  constructor(offset) { super(); this.allocationOffset = offset; }
  apply(elapsed, particle) {
    const ref = particle.getDynamic(this.allocationOffset);
    const generator = ref?.generator;
    if (!generator) return;
    const emitted = generator.emit(elapsed, (child) => { child.useParentAssociatedPositionOnly = true; });
    for (const c of emitted) particle.children.push(c);
  }
}

// ── screen effects ─────────────────────────────────────────────────────────

export class CameraShakeUpdater extends Updater {
  constructor(offset, opCodeSize) { super(); this.allocationOffset = offset; this.opCodeSize = opCodeSize; }
  read(r) {
    this.near = r.nextFloat();
    this.far = r.nextFloat();
    this.shakeFactor = this.opCodeSize === 4 ? r.nextFloat() : 0;
  }
  apply(elapsed, particle) {
    const data = particle.getDynamic(this.allocationOffset);
    if (!data?.link) return;
    const curve = data.link.getOrPut((id) => particle.runtime.resolveKeyFrame(id, particle.creator));
    if (!curve) return;

    const camera = particle.runtime.camera;
    const distance = Vec3.distance(camera.getPosition(), particle.getWorldSpacePosition());
    const amount = Math.min(0.33,
      1000 * curve.getCurrentValue(particle.getProgress()) * fallOff(distance, this.near, this.far) * this.shakeFactor);
    particle.runtime.applyCameraShake(rand() * amount);
  }
}

/** 0x60 — the full-screen white-out behind a lightning strike. */
export class ScreenFlashApplier extends Updater {
  read(r) {
    this.near = r.nextFloat();
    this.far = r.nextFloat();
    this.nearAngleDistance = r.nextFloat();
    this.farAngleDistance = r.nextFloat();
    r.next32();
    r.next32();
  }

  apply(elapsed, particle) {
    const camera = particle.runtime.camera;
    const particlePos = particle.getWorldSpacePosition();
    const distance = Vec3.distance(camera.getPosition(), particlePos);

    let alphaMultiplier = fallOff(distance, this.near, this.far);
    if (alphaMultiplier <= 0) return;

    const cameraSpacePos = camera.toCameraSpace(particlePos);
    if (cameraSpacePos.z > 0) return;

    const fov = camera.getFoV();
    if (fov == null) return;

    const zoomFactor = ((fov * 180) / Math.PI * 10) / cameraSpacePos.z;
    const angularDistance = Math.pow(zoomFactor * cameraSpacePos.x, 2) + Math.pow(zoomFactor * cameraSpacePos.y, 2);
    alphaMultiplier *= fallOff(angularDistance, this.nearAngleDistance, this.farAngleDistance);

    particle.runtime.addScreenFlash(particle.getColor().withMultipliedAlpha(alphaMultiplier));
  }
}

export class OcclusionUpdater extends Updater {
  read(r) { this.size = r.nextFloat(); this.baseOpacity = r.nextFloat(); }
  apply(elapsed, particle) {
    particle.occlusionSettings = particle.colorMultiplier.a() > 0 ? { size: this.size } : null;
  }
}

// ── opcode table ───────────────────────────────────────────────────────────

const progress = (offset, updateFn, opts = {}) => new ProgressValueUpdater(offset, { ...opts, updateFn });

/** Mirrors xim ParticleGeneratorParser.sec3Handler. */
export function makeUpdater(opCode, allocationOffset, opCodeSize) {
  switch (opCode) {
    case 0x02: return new PositionUpdater(allocationOffset);
    case 0x03: return new VelocityAccelerator(allocationOffset);
    case 0x05: return new RotationUpdater(allocationOffset);
    case 0x06: return new VelocityAccelerator(allocationOffset);
    case 0x08: return new ScaleUpdater(allocationOffset);
    case 0x09: return new VelocityAccelerator(allocationOffset);

    case 0x0b: return new ColorTransformApplier(allocationOffset);
    case 0x0c: return new ColorTransformModifier(allocationOffset);

    case 0x0d: return new SpriteSheetFrameUpdater();
    case 0x0e: return new NoOpParticleUpdater();      // appears to just advance age

    case 0x0f: return progress(allocationOffset, (p, v) => { p.position.x = v; });
    case 0x10: return progress(allocationOffset, (p, v) => { p.position.y = v; });
    case 0x11: return progress(allocationOffset, (p, v) => { p.position.z = v; });

    // Rotation curves are stored in half-turns; the normalisation matters for
    // Haste/Slow/Shell in xim and for the swirling zone effects here.
    case 0x12: return new ProgressValueUpdater(allocationOffset, { initialValueFn: (p) => p.rotation.x / PI_f, updateFn: (p, v) => { p.rotation.x = v * PI_f; } });
    case 0x13: return new ProgressValueUpdater(allocationOffset, { initialValueFn: (p) => p.rotation.y / PI_f, updateFn: (p, v) => { p.rotation.y = v * PI_f; } });
    case 0x14: return new ProgressValueUpdater(allocationOffset, { initialValueFn: (p) => p.rotation.z / PI_f, updateFn: (p, v) => { p.rotation.z = v * PI_f; } });

    case 0x15: return new ProgressValueUpdater(allocationOffset, { initialValueFn: (p) => p.scale.x, updateFn: (p, v) => { p.scale.x = v; } });
    case 0x16: return new ProgressValueUpdater(allocationOffset, { initialValueFn: (p) => p.scale.y, updateFn: (p, v) => { p.scale.y = v; } });
    case 0x17: return new ProgressValueUpdater(allocationOffset, { initialValueFn: (p) => p.scale.z, updateFn: (p, v) => { p.scale.z = v; } });

    case 0x18: return new ProgressValueUpdater(allocationOffset, { initialValueFn: (p) => p.color.r(), updateFn: (p, v) => p.color.r(v) });
    case 0x19: return new ProgressValueUpdater(allocationOffset, { initialValueFn: (p) => p.color.g(), updateFn: (p, v) => p.color.g(v) });
    case 0x1a: return new ProgressValueUpdater(allocationOffset, { initialValueFn: (p) => p.color.b(), updateFn: (p, v) => p.color.b(v) });
    case 0x1b: return new ProgressValueUpdater(allocationOffset, { initialValueFn: (p) => p.color.a(), updateFn: (p, v) => p.color.a(v) });

    case 0x1c: return progress(allocationOffset, (p, v) => { p.texCoordTranslate.x = v; });
    case 0x1d: return progress(allocationOffset, (p, v) => { p.texCoordTranslate.y = v; });

    case 0x1e: return progress(allocationOffset, (p, v) => { p.weightedMeshWeights[0] = v; });
    case 0x1f: return progress(allocationOffset, (p, v) => { p.weightedMeshWeights[1] = v; });
    case 0x20: return progress(allocationOffset, (p, v) => { p.weightedMeshWeights[2] = v; });
    case 0x21: return progress(allocationOffset, (p, v) => { p.weightedMeshWeights[3] = v; });
    case 0x22: return progress(allocationOffset, (p, v) => { p.weightedMeshWeights[4] = v; });

    case 0x24: return new ProgressValueUpdater(allocationOffset, { initialValueFn: (p) => p.hazeOffset.x, updateFn: (p, v) => { p.hazeOffset.x = v; } });

    case 0x25: return new ChildGeneratorBasicUpdater(allocationOffset);
    case 0x26: return new VelocityRotator(allocationOffset);

    case 0x27: return new TextureCoordinateUpdater(0);
    case 0x28: return new TextureCoordinateUpdater(1);

    case 0x29: return new OscillationApplier(allocationOffset, 0);
    case 0x2a: return new OscillationApplier(allocationOffset, 1);
    case 0x2b: return new OscillationApplier(allocationOffset, 2);

    case 0x2c: return new VelocityDampener(allocationOffset);

    case 0x2e: return new DrawDistanceUpdater();
    case 0x2f: return new VelocityRotationUpdater(allocationOffset);

    // These write velocity directly; a no-op unless something integrates it.
    case 0x30: return progress(allocationOffset, (p, v) => { const t = p.getDynamicByType(PositionTransform); if (t) t.velocity.x = v; });
    case 0x31: return progress(allocationOffset, (p, v) => { const t = p.getDynamicByType(PositionTransform); if (t) t.velocity.y = v; });
    case 0x32: return progress(allocationOffset, (p, v) => { const t = p.getDynamicByType(PositionTransform); if (t) t.velocity.z = v; });

    case 0x33: return new ChildGeneratorUpdater(allocationOffset, 'None');
    case 0x34: return new PointListPositionUpdater(allocationOffset);

    case 0x35: return new ProgressValueUpdater(allocationOffset, { initialValueFn: (p) => p.specularParams?.rotation.x ?? 0, updateFn: (p, v) => { if (p.specularParams) p.specularParams.rotation.x = v; } });
    case 0x36: return new ProgressValueUpdater(allocationOffset, { initialValueFn: (p) => p.specularParams?.rotation.y ?? 0, updateFn: (p, v) => { if (p.specularParams) p.specularParams.rotation.y = v; } });
    case 0x37: return new ProgressValueUpdater(allocationOffset, { initialValueFn: (p) => p.specularParams?.rotation.z ?? 0, updateFn: (p, v) => { if (p.specularParams) p.specularParams.rotation.z = v; } });

    case 0x38: return new ProgressValueUpdater(allocationOffset, { initialValueFn: (p) => p.specularParams?.color.r() ?? 0, updateFn: (p, v) => p.specularParams?.color.r(v) });
    case 0x39: return new ProgressValueUpdater(allocationOffset, { initialValueFn: (p) => p.specularParams?.color.g() ?? 0, updateFn: (p, v) => p.specularParams?.color.g(v) });
    case 0x3a: return new ProgressValueUpdater(allocationOffset, { initialValueFn: (p) => p.specularParams?.color.b() ?? 0, updateFn: (p, v) => p.specularParams?.color.b(v) });
    case 0x3b: return new ProgressValueUpdater(allocationOffset, { initialValueFn: (p) => p.specularParams?.color.a() ?? 0, updateFn: (p, v) => p.specularParams?.color.a(v) });

    // RGB are setters (overriding 0x16); alpha is a multiplier that combines.
    case 0x3c: return new ClockValueUpdater(allocationOffset, (p, v) => p.color.r(v));
    case 0x3d: return new ClockValueUpdater(allocationOffset, (p, v) => p.color.g(v));
    case 0x3e: return new ClockValueUpdater(allocationOffset, (p, v) => p.color.b(v));
    case 0x3f: return new ClockValueUpdater(allocationOffset, (p, v) => p.colorMultiplier.multiplyAlphaInPlace(v));

    case 0x40: return new ClockValueUpdater(allocationOffset, (p, v) => { p.scale.x = v; });
    case 0x41: return new ClockValueUpdater(allocationOffset, (p, v) => { p.scale.y = v; });
    case 0x42: return new ClockValueUpdater(allocationOffset, (p, v) => { p.scale.z = v; });

    case 0x43: return new ClockValueUpdater(allocationOffset, (p, v) => { p.audioConfiguration.volumeMultiplier = v; });

    case 0x44: return progress(allocationOffset, (p, v) => { const t = p.getDynamicByType(PositionTransform); if (t) t.dampeningFactor = v; });

    case 0x45: return new MoonPhaseSpriteSheetUpdater();
    case 0x46: return new ChildGeneratorUpdater(allocationOffset, 'XYZ');
    case 0x48: return new DoubleRangeDrawDistanceUpdater();
    case 0x49: return new ClockValueUpdater(allocationOffset, (p, v) => { p.pointLightParams.theta = v; });

    case 0x4a: return new ClockValueUpdater(allocationOffset, (p, v) => p.specularParams?.color.r(v));
    case 0x4b: return new ClockValueUpdater(allocationOffset, (p, v) => p.specularParams?.color.g(v));
    case 0x4c: return new ClockValueUpdater(allocationOffset, (p, v) => p.specularParams?.color.b(v));
    case 0x4d: return new ClockValueUpdater(allocationOffset, (p, v) => p.specularParams?.color.a(v));

    case 0x4e: return new DayOfWeekColorUpdater();
    case 0x4f: return new MoonPhaseColorUpdater();

    case 0x53: return new OcclusionUpdater();

    case 0x54: return new ProgressValueUpdater(allocationOffset, { integrate: true, updateFn: (p, v) => { p.texCoordTranslate.x += v; } });
    case 0x55: return new ProgressValueUpdater(allocationOffset, { integrate: true, updateFn: (p, v) => { p.texCoordTranslate.y += v; } });

    case 0x56: return new ProgressValueUpdater(allocationOffset, { integrate: true, updateFn: (p, v) => { p.rotation.x += v * PI_f; } });
    case 0x57: return new ProgressValueUpdater(allocationOffset, { integrate: true, updateFn: (p, v) => { p.rotation.y += v * PI_f; } });
    case 0x58: return new ProgressValueUpdater(allocationOffset, { integrate: true, updateFn: (p, v) => { p.rotation.z += v * PI_f; } });

    case 0x59: return new AngularDistanceRotationUpdater();

    case 0x5b: return new ProgressValueUpdater(allocationOffset, { initialValueFn: (p) => p.pointLightParams.theta, updateFn: (p, v) => { p.pointLightParams.theta = v; } });
    case 0x5c: return new ProgressValueUpdater(allocationOffset, { initialValueFn: (p) => p.pointLightParams.range, updateFn: (p, v) => { p.pointLightParams.range = v; } });
    case 0x5d: return new ProgressValueUpdater(allocationOffset, { initialValueFn: (p) => p.pointLightParams.thetaMultiplier, updateFn: (p, v) => { p.pointLightParams.thetaMultiplier = v; } });
    case 0x5e: return new ProgressValueUpdater(allocationOffset, { initialValueFn: (p) => p.pointLightParams.rangeMultiplier, updateFn: (p, v) => { p.pointLightParams.rangeMultiplier = v; } });

    case 0x5f: return new CameraShakeUpdater(allocationOffset, opCodeSize);
    case 0x60: return new ScreenFlashApplier();

    case 0x61: return new ClockValueRotationUpdater(allocationOffset, (p, v) => { p.rotation.x += v * PI_f; });
    case 0x62: return new ClockValueRotationUpdater(allocationOffset, (p, v) => { p.rotation.y += v * PI_f; });
    case 0x63: return new ClockValueRotationUpdater(allocationOffset, (p, v) => { p.rotation.z += v * PI_f; });

    case 0x66: return new ClockValueUpdater(allocationOffset, (p, v) => { p.rotation.x = v * PI_f; });
    case 0x67: return new ClockValueUpdater(allocationOffset, (p, v) => { p.rotation.y = v * PI_f; });
    case 0x68: return new ClockValueUpdater(allocationOffset, (p, v) => { p.rotation.z = v * PI_f; });

    case 0x69: return new DaylightBasedColorApplier(allocationOffset);

    case 0x6b: return new ClockValueUpdater(allocationOffset, (p, v) => { p.position.x = v; });
    case 0x6c: return new ClockValueUpdater(allocationOffset, (p, v) => { p.position.y = v; });
    case 0x6d: return new ClockValueUpdater(allocationOffset, (p, v) => { p.position.z = v; });

    case 0x6e: return new DoubleRangeWeightedMeshUpdater();

    default: return null;
  }
}

export const isSubParticleUpdater = (u) => typeof u.applySub === 'function';
