// Particle initializers — opcode section 2. Port of xim ParticleInitializers.kt.
//
// An initializer runs once, at emit time, against a freshly created Particle.
// Every one implements `read(reader, ctx)` (consuming exactly the bytes the
// opcode declares) and `apply(particle)`.
//
// `read` must stay byte-exact even for opcodes whose effect we don't need: the
// parser cross-checks the cursor against the opcode's declared size, so a short
// read is caught rather than silently shifting every following opcode.

import { Vec3, Color, PI_f, posRand, rand } from '../math.js';
import {
  ActorScaleTarget, AttachType, BillBoardType, BlendFunc, DatLink, LinkedDataType,
  RotationOrder, PositionVariance, PositionTransform, RotationTransform, ScaleTransform,
  ParticleTransform, StandardParticleConfiguration, ColorTransform, OscillationParams,
  KeyFrameReference, GeneratorReference, PointListReference, CameraShakeReference,
  DaylightBasedColorMultiplier, PointLightParams, linkedDataTypeFrom,
} from '../types.js';

/** Base class: `read` defaults to consuming nothing (xim NoDataParticleInitializer). */
class Initializer {
  read() {}
  apply() {}
}

// ── 0x01 the core setup ────────────────────────────────────────────────────

export class StandardParticleSetup extends Initializer {
  constructor() { super(); this.config = new StandardParticleConfiguration(); }

  read(r, ctx) {
    const c = this.config;
    const billboardFlags = r.next16();

    c.scaleBeforeRotate = (billboardFlags & 0x0002) !== 0;
    c.followCamera = (billboardFlags & 0x0004) !== 0;
    // Only meaningful together with followCamera.
    c.localPositionInCameraSpace = (billboardFlags & 0x000c) === 0xc;
    c.rotationOrder = (billboardFlags & 0x0200) !== 0 ? RotationOrder.ZYX : RotationOrder.XYZ;
    c.depthMask = (billboardFlags & 0x1000) !== 0;

    this.#modifyCameraRelativeIfNeeded(ctx.def);

    if ((billboardFlags & 0x00c0) === 0xc0) c.billBoardType = BillBoardType.Camera;
    else if ((billboardFlags & 0x0081) === 0x81) c.billBoardType = BillBoardType.Movement;
    else if ((billboardFlags & 0x0080) !== 0) c.billBoardType = BillBoardType.MovementHorizontal;
    else if ((billboardFlags & 0x0040) !== 0) c.billBoardType = BillBoardType.Movement;
    else if ((billboardFlags & 0x4000) !== 0) c.billBoardType = BillBoardType.XZ;
    else if ((billboardFlags & 0x0001) !== 0) c.billBoardType = BillBoardType.XYZ;

    const renderStateFlags = r.next16();
    c.lightingEnabled = (renderStateFlags & 0x0001) !== 0;
    c.cameraSpaceBillboard = (renderStateFlags & 0x0002) !== 0;
    c.hazeEffect = (renderStateFlags & 0x0010) !== 0;
    c.decalEffect = (renderStateFlags & 0x0020) !== 0;
    c.drawPriorityOffset = (renderStateFlags & 0x0040) !== 0;
    c.followGenerator = (renderStateFlags & 0x0080) === 0;
    c.specular = (renderStateFlags & 0x0100) !== 0;
    c.fogEnabled = (renderStateFlags & 0x0200) === 0;   // bit set disables fog
    c.cameraAttachedBasePosition = (renderStateFlags & 0x0400) !== 0;
    c.lowPriorityDraw = (renderStateFlags & 0x0800) !== 0;
    c.ignoreTextureAlpha = (renderStateFlags & 0x1000) !== 0;

    r.next32();                                   // expect 0..0
    c.linkedDataId = new DatLink(r.nextDatId());

    r.nextFloat();                                // expect ~0
    c.basePosition.copyFrom(r.nextVector3f());

    r.next8();                                    // allocation size (modelled differently)
    c.linkedDataType = linkedDataTypeFrom(r.next8());

    c.maxLifeSpan = r.next16();
    c.lifeSpanVariance = r.next16();

    // Lifespan 0 means a singleton that lives forever — the sea, a fixed glow,
    // a looping ambient sound. Such a generator emits exactly once.
    if (c.maxLifeSpan === 0 || this.#isDelkfuttHack()) {
      c.maxLifeSpan = Infinity;
      ctx.def.framesPerEmission = Infinity;
    }

    r.next16();
    r.next32();                                   // expect 0..1
    r.next32();                                   // expect 0..0

    ctx.def.particleConfiguration = c;
  }

  apply(particle) {
    const c = this.config;
    particle.config = c;
    particle.meshProvider = particle.runtime.resolveMesh(c.linkedDataType, c.linkedDataId, particle.creator);
    particle.maxAge = c.maxLifeSpan + posRand(c.lifeSpanVariance);

    if (c.linkedDataType === LinkedDataType.Audio) {
      particle.audioEmitter = particle.runtime.createAudioEmitter(c.linkedDataId, particle.creator);
    }
    // LinkedDataType.Actor spawns a dummy actor in xim; only a couple of avatar
    // abilities use it and nothing in a zone does, so it stays unhandled here.
  }

  /** Point-lights with a 1-frame life flicker badly; xim makes them singletons. */
  #isDelkfuttHack() {
    return this.config.linkedDataType === LinkedDataType.PointLight && this.config.maxLifeSpan === 1;
  }

  #modifyCameraRelativeIfNeeded(def) {
    // A few effects combine an actor attach-type with camera-relative placement,
    // which doesn't make sense; xim resolves each case in favour of the other.
    if (def.attachType === AttachType.TargetActor) {
      this.config.followCamera = false;
      this.config.localPositionInCameraSpace = false;
    }
    if (def.attachType === AttachType.SourceActor && this.config.localPositionInCameraSpace) {
      def.attachType = AttachType.None;
    }
  }
}

// ── spawn position ─────────────────────────────────────────────────────────

class SphericalPositionVariance extends Initializer {
  apply(particle) {
    if (particle.subParticles) return;
    particle.initialPosition.addInPlace(this.positionVariance.getOffset(particle, particle.runtime.camera));
    particle.initialPositionCameraOriented = this.positionVariance.cameraOriented;
  }

  applySub(particle, subParticle) {
    subParticle.position.addInPlace(this.positionVariance.getOffset(particle, particle.runtime.camera));
  }
}

export class SphericalPositionVarianceSimple extends SphericalPositionVariance {
  read(r) {
    const radiusVariance = r.nextFloat();
    const baseRadius = r.nextFloat();
    r.next32();
    this.positionVariance = new PositionVariance({ radiusVariance, baseRadius });
  }
}

export class SphericalPositionVarianceMedium extends SphericalPositionVariance {
  read(r, ctx) {
    const batchMultiplier = ctx.def.batched ? 2 : 1;
    const radiusVariance = r.nextFloat() * batchMultiplier;
    const baseRadius = r.nextFloat();
    const radiusScaleX = r.nextFloat();
    const radiusScaleY = r.nextFloat();
    const radiusScaleZ = r.nextFloat();
    r.nextFloat();                       // unknown, very small
    const rotationYAxis = r.nextFloat();
    this.positionVariance = new PositionVariance({
      radiusVariance, baseRadius, radiusScaleX, radiusScaleY, radiusScaleZ, rotationYAxis,
    });
  }
}

export class SphericalPositionVarianceFull extends SphericalPositionVariance {
  read(r) {
    const radiusVariance = r.nextFloat();
    const baseRadius = r.nextFloat();
    const radiusScaleX = r.nextFloat();
    const radiusScaleY = r.nextFloat();
    const radiusScaleZ = r.nextFloat();
    const rotationZAxis = r.nextFloat();
    const rotationYAxis = r.nextFloat();
    const tilt = r.nextFloat();
    const tiltVariance = r.nextFloat();
    const cameraOriented = r.next32() === 0x1;
    const rotationDivisor = 1 + r.next32();
    this.positionVariance = new PositionVariance({
      radiusVariance, baseRadius, radiusScaleX, radiusScaleY, radiusScaleZ,
      rotationZAxis, rotationYAxis, tilt, tiltVariance, cameraOriented, rotationDivisor,
    });
  }
}

/** 0x4E/0x4F — spawn positions cycle through an authored point list. */
export class FixedPointPositionVarianceSetup extends Initializer {
  read(r) {
    r.next32();
    this.pointRef = new DatLink(r.nextDatId());
    r.next32();
  }

  apply(particle) {
    const list = this.pointRef.getOrPut((id) => particle.runtime.resolvePointList(id, particle.creator));
    if (!list) return;
    const points = list.points;
    particle.initialPosition.addInPlace(points[particle.creator.totalParticlesEmitted % points.length]);
  }
}

// ── velocity ───────────────────────────────────────────────────────────────

export class TranslationVelocitySetup extends Initializer {
  constructor(offset) { super(); this.allocationOffset = offset; this.velocity = new Vec3(); }
  read(r) { this.velocity.copyFrom(r.nextVector3f()); }
  apply(particle) {
    particle.allocate(this.allocationOffset, new PositionTransform()).velocity.copyFrom(this.velocity);
  }
}

export class RotationVelocitySetup extends Initializer {
  constructor(offset) { super(); this.allocationOffset = offset; this.velocity = new Vec3(); }
  read(r) { this.velocity.copyFrom(r.nextVector3f()); }
  apply(particle) {
    particle.allocate(this.allocationOffset, new RotationTransform()).velocity.copyFrom(this.velocity);
  }
}

export class ScaleVelocitySetup extends Initializer {
  constructor(offset) { super(); this.allocationOffset = offset; this.velocity = new Vec3(); }
  read(r) { this.velocity.copyFrom(r.nextVector3f()); }
  apply(particle) {
    particle.allocate(this.allocationOffset, new ScaleTransform()).velocity.copyFrom(this.velocity);
  }
}

/** Velocity along the spawn offset direction — makes shells expand outward. */
export class RelativeVelocitySetup extends Initializer {
  constructor(offset) { super(); this.allocationOffset = offset; this.velocity = 0; }
  read(r) { this.velocity = r.nextFloat(); }

  apply(particle) {
    const t = particle.getDynamic(this.allocationOffset);
    if (!t) return;
    t.relativeVelocity.copyFrom(this.#compute(particle.initialPosition));
  }

  applySub(particle, subParticle) {
    subParticle.relativeVelocity.copyFrom(this.#compute(subParticle.position));
  }

  #compute(initialPosition) {
    if (initialPosition.magnitudeSquare() === 0) return new Vec3();
    return initialPosition.normalize().scale(this.velocity);
  }
}

export class VelocityVarianceSetup extends Initializer {
  constructor(offset) { super(); this.allocationOffset = offset; this.variance = new Vec3(); }
  read(r) { this.variance.copyFrom(r.nextVector3f()); }
  apply(particle) {
    const t = particle.getDynamic(this.allocationOffset);
    if (!t) return;
    t.velocity.addInPlace(new Vec3(
      this.variance.x * rand(), this.variance.y * rand(), this.variance.z * rand(),
    ));
  }
}

export class RelativeVelocityVarianceSetup extends Initializer {
  constructor(offset) { super(); this.allocationOffset = offset; this.variance = 0; }
  read(r) { this.variance = r.nextFloat(); }
  apply(particle) {
    const t = particle.getDynamic(this.allocationOffset);
    if (!t || particle.initialPosition.magnitudeSquare() === 0) return;
    t.relativeVelocity.addInPlace(particle.initialPosition.normalize().scale(this.variance * rand()));
  }
}

/** 0x31 — one random value written to all three axes (scale pulsing). */
export class RandomVelocitySetup extends Initializer {
  constructor(offset) { super(); this.allocationOffset = offset; this.value = 0; }
  read(r) { this.value = r.nextFloat(); }
  apply(particle) {
    const t = particle.getDynamic(this.allocationOffset);
    if (!t) return;
    const v = this.value * rand();
    t.velocity.set(v, v, v);
  }
}

/** 0x67 — start at the end of the trajectory and run it backwards. */
export class ReverseDisplacementSetup extends Initializer {
  constructor(offset) { super(); this.allocationOffset = offset; }
  read(r) { r.nextFloat(); }
  apply(particle) {
    const t = particle.getDynamic(this.allocationOffset);
    if (!(t instanceof PositionTransform)) return;
    particle.position.addInPlace(particle.getTotalVelocity(t).scale(particle.maxAge));
    t.velocity.scaleInPlace(-1);
    t.relativeVelocity.scaleInPlace(-1);
  }
}

// ── keyframe-driven values ─────────────────────────────────────────────────

/**
 * Allocates a curve reference that a matching section-3 updater samples each
 * frame. This single opcode backs alpha fades, colour ramps, scale pulses, UV
 * scroll and time-of-day tinting — the reason water looked static without it.
 */
export class KeyFrameValueSetup extends Initializer {
  constructor(offset) { super(); this.allocationOffset = offset; }

  read(r) {
    r.next32();
    this.link = new DatLink(r.nextDatId());
    // Bits 0-3 tweak the interpolation, bit 4 locks progress, bits 5+ are cycles.
    const config = r.next32();
    this.numCycles = Math.max(1, (config & 0xffff) >> 5);
  }

  apply(particle) {
    particle.allocate(this.allocationOffset, new KeyFrameReference(this.link, this.numCycles));
  }
}

export class PointListPositionSetup extends Initializer {
  constructor(offset) { super(); this.allocationOffset = offset; }
  read(r) {
    r.next32();
    this.keyFrameLink = DatLink.of(r.nextDatId());
    r.next32();
    r.next32();
    this.pointListLink = new DatLink(r.nextDatId());
  }
  apply(particle) {
    particle.allocate(this.allocationOffset, new PointListReference(this.keyFrameLink, this.pointListLink));
  }
}

// ── colour ─────────────────────────────────────────────────────────────────

export class ColorSetup extends Initializer {
  constructor() { super(); this.color = new Color(0, 0, 0, 0); }
  read(r) { this.color = Color.fromBytes(r.nextRGBA()); }
  apply(particle) { particle.color.copyFrom(this.color); }
}

export class ColorVarianceSetup extends Initializer {
  constructor() { super(); this.variance = new Color(0, 0, 0, 0); }
  read(r) { this.variance = Color.fromBytes(r.nextRGBA()); }
  apply(particle) {
    for (let i = 0; i < 4; i++) particle.color.rgba[i] += this.variance.rgba[i] * posRand(1);
  }
}

export class UniformColorVarianceSetup extends Initializer {
  read(r) { this.variance = (r.next32() & 0xff) / 255; }
  apply(particle) {
    const f = this.variance * posRand(1);
    for (let i = 0; i < 4; i++) particle.color.rgba[i] += f;
  }
}

export class ColorTransformSetup extends Initializer {
  constructor(offset) { super(); this.allocationOffset = offset; }
  read(r) {
    this.colorTransform = new ColorTransform(r.next16Signed(), r.next16Signed(), r.next16Signed(), r.next16Signed());
  }
  apply(particle) { particle.allocate(this.allocationOffset, this.colorTransform.copy()); }
}

export class ColorTransformVariance extends Initializer {
  constructor(offset) { super(); this.allocationOffset = offset; }
  read(r) {
    this.variance = new ColorTransform(r.next16Signed(), r.next16Signed(), r.next16Signed(), r.next16Signed());
  }
  apply(particle) {
    const ct = particle.getDynamic(this.allocationOffset);
    if (!ct) return;
    ct.r += Math.round(posRand(1) * this.variance.r);
    ct.g += Math.round(posRand(1) * this.variance.g);
    ct.b += Math.round(posRand(1) * this.variance.b);
    ct.a += Math.round(posRand(1) * this.variance.a);
  }
}

export class DaylightBasedColorAdjuster extends Initializer {
  apply(particle) {
    const lighting = particle.runtime.getModelLighting(particle.creator.def.environmentId);
    const strongest = strongestLight(lighting);
    if (strongest) particle.color.modulateRgbInPlace(strongest, 1);
  }
}

export class DaylightBasedColorSetup extends Initializer {
  constructor(offset) { super(); this.allocationOffset = offset; }
  read(r) { r.next32(); }
  apply(particle) { particle.allocate(this.allocationOffset, new DaylightBasedColorMultiplier()); }
}

function strongestLight(lighting) {
  let best = null, bestSum = -Infinity;
  for (const l of lighting?.lights ?? []) {
    const sum = l.color.r() + l.color.g() + l.color.b();
    if (sum > bestSum) { bestSum = sum; best = l.color; }
  }
  return best;
}

// ── rotation / scale ───────────────────────────────────────────────────────

export class RotationInitializer extends Initializer {
  constructor() { super(); this.rotation = new Vec3(); }
  read(r) { this.rotation.copyFrom(r.nextVector3f()); }
  apply(particle) { particle.rotation.copyFrom(this.rotation); }
}

export class RotationVarianceInitializer extends Initializer {
  constructor() { super(); this.variance = new Vec3(); }
  read(r) { this.variance.copyFrom(r.nextVector3f()); }
  apply(particle) {
    particle.rotation.x += this.variance.x * rand();
    particle.rotation.y += this.variance.y * rand();
    particle.rotation.z += this.variance.z * rand();
  }
}

/** 0x3B — each successive particle is rotated one more step round. */
export class IncrementalRotationApplier extends Initializer {
  constructor() { super(); this.incrementalRotation = new Vec3(); }
  read(r) { this.incrementalRotation.copyFrom(r.nextVector3f()); }
  apply(particle) {
    const n = 1 + particle.creator.totalParticlesEmitted;
    particle.rotation.addInPlace(this.incrementalRotation.scale(n));
    // xim verified this happens even for a zero increment.
    particle.negateRotationY = true;
  }
}

export class ScaleInitializer extends Initializer {
  constructor() { super(); this.scale = new Vec3(); }
  read(r) { this.scale.copyFrom(r.nextVector3f()); }
  apply(particle) { particle.scale.copyFrom(this.scale); }
}

export class ScaleVarianceInitializer extends Initializer {
  constructor() { super(); this.variance = new Vec3(); }
  read(r) { this.variance.copyFrom(r.nextVector3f()); }
  apply(particle) {
    particle.scale.addInPlace(new Vec3(
      this.variance.x * posRand(1), this.variance.y * posRand(1), this.variance.z * posRand(1),
    ));
  }
}

export class SingleScaleVarianceInitializer extends Initializer {
  read(r) { this.variance = r.nextFloat(); }
  apply(particle) {
    const v = posRand(this.variance);
    particle.scale.x += v; particle.scale.y += v; particle.scale.z += v;
  }
}

// ── oscillation ────────────────────────────────────────────────────────────

export class OscillationSetup extends Initializer {
  constructor(offset) { super(); this.allocationOffset = offset; }
  apply(particle) { particle.allocate(this.allocationOffset, new OscillationParams()); }
}

export class OscillationAccelerationSetup extends Initializer {
  constructor(offset, axis) { super(); this.allocationOffset = offset; this.axis = axis; }
  read(r) { this.acceleration = r.nextFloat(); this.accelerationVariance = r.nextFloat(); }
  apply(particle) {
    const p = particle.getDynamic(this.allocationOffset);
    if (!p) return;
    p.acceleration.setAxis(this.axis, this.acceleration + this.accelerationVariance * rand());
  }
}

// ── child generators ───────────────────────────────────────────────────────

/** 0x44/0x53/0x6A — a child generator that lives as long as the parent particle. */
export class ChildGeneratorSetup extends Initializer {
  constructor(offset) { super(); this.allocationOffset = offset; }
  read(r) { r.next32(); this.generatorLink = new DatLink(r.nextDatId()); }

  apply(particle) {
    const effect = this.generatorLink.getOrPut((id) => particle.runtime.resolveEffect(id, particle.creator));
    if (!effect) {
      particle.runtime.warn(`[${particle.creator.datId}] child generator not found: ${this.generatorLink.id}`);
      return;
    }
    const lifeSpan = particle.creator.def.continuousSingleton ? Infinity : particle.maxAge;
    const ref = particle.allocate(this.allocationOffset, new GeneratorReference(this.generatorLink.id));
    ref.generator = particle.runtime.createGenerator(effect, particle.creator.association, lifeSpan, particle);
  }
}

/** 0x3C — emit the child exactly once, at birth. */
export class OnceChildGeneratorSetup extends Initializer {
  read(r) { r.next32(); this.childId = r.nextDatId(); }

  apply(particle) {
    const effect = particle.runtime.resolveEffect(this.childId, particle.creator);
    if (!effect) {
      particle.runtime.warn(`[${particle.creator.datId}] one-shot child not found: ${this.childId}`);
      return;
    }
    // Children can copy parent state, so the parent's transforms must be current.
    particle.onInitialized();
    const generator = particle.runtime.createGenerator(effect, particle.association, Infinity, particle);
    const emitted = generator.emit(0, (child) => { child.attachmentSource = particle.creator; });
    for (const c of emitted) particle.children.push(c);
  }
}

// ── inheriting from the parent particle ────────────────────────────────────

export class ParentPositionCopyConfig extends Initializer {
  apply(particle) {
    const parent = particle.parent;
    if (!parent) return;
    if (particle.parentOffsetTransform) return;

    if (parent.parentOffsetTransform) {
      particle.associatedPosition.copyFrom(parent.getWorldSpacePosition());
      return;
    }

    if (particle.config.localPositionInCameraSpace) particle.useParentAssociatedPositionOnly = false;

    const batchOffset = parent.subParticles?.[0]?.position ?? Vec3.ZERO;

    particle.associatedPosition.copyFrom(parent.associatedPosition);
    particle.parentPositionSnapshot
      .copyFrom(parent.position)
      .addInPlace(parent.initialPosition)
      .addInPlace(batchOffset)
      .addInPlace(parent.config.basePosition)
      .addInPlace(parent.parentPositionSnapshot)
      .addInPlace(parent.computeProgressPositionOffset());

    if (particle.creator.transitionLink) return;

    particle.attachType = parent.attachType;
    particle.creator.syncFromParent();
  }
}

export class ParentPositionSnapshotConfig extends Initializer {
  apply(particle) {
    if (!particle.parent) return;
    particle.associatedPosition.copyFrom(particle.parent.getWorldSpacePosition());
  }
}

export class ParentVelocityConfig extends Initializer {
  constructor(offset) { super(); this.allocationOffset = offset; }
  read(r) { this.multiplier = r.nextFloat(); }
  apply(particle) {
    if (!particle.parent) return;
    const t = particle.getDynamic(this.allocationOffset);
    if (!t) return;
    t.velocity.copyFrom(particle.parent.getTotalVelocity().scale(this.multiplier));
  }
}

export class ParentRotateConfig extends Initializer {
  apply(particle) { if (particle.parent) particle.rotation.copyFrom(particle.parent.rotation); }
}

export class ParentScaleConfig extends Initializer {
  apply(particle) { if (particle.parent) particle.scale.copyFrom(particle.parent.scale); }
}

export class ParentColorConfig extends Initializer {
  apply(particle) { if (particle.parent) particle.color.copyFrom(particle.parent.getColor()); }
}

export class ParentTexCoordConfig extends Initializer {
  apply(particle) {
    if (!particle.parent) return;
    particle.texCoordTranslate.x = particle.parent.texCoordTranslate.x;
    particle.texCoordTranslate.y = particle.parent.texCoordTranslate.y;
  }
}

export class ParentThetaConfig extends Initializer {
  apply(particle) {
    if (particle.parent) particle.pointLightParams.theta = particle.parent.pointLightParams.theta;
  }
}

export class ParentRangeConfig extends Initializer {
  apply(particle) {
    if (particle.parent) particle.pointLightParams.range = particle.parent.pointLightParams.range;
  }
}

// ── render state ───────────────────────────────────────────────────────────

export class BlendFuncInitializer extends Initializer {
  read(r, ctx) {
    const p0 = r.next8();
    const p1 = r.next8();
    r.next8();
    r.next8();

    this.alphaOverride = (p0 & 0x20) !== 0 ? Math.min(0xff, p1 * 2) : null;

    const highNibble = (p0 >>> 4) & 0b1101;   // the alpha-override bit isn't part of this
    const lowNibble = p0 & 0x0f;

    if ((highNibble & 0x01) !== 0) { this.blendFunc = BlendFunc.One_Zero; return; }
    if (highNibble !== 0x04) ctx.warn(`unknown source-blend flag ${highNibble.toString(16)}`);

    switch (lowNibble) {
      case 0x1: case 0x2: this.blendFunc = BlendFunc.Src_One_RevSub; break;
      case 0x4: this.blendFunc = BlendFunc.Src_InvSrc_Add; break;
      case 0x6: this.blendFunc = BlendFunc.Zero_InvSrc_Add; break;
      case 0x8: this.blendFunc = BlendFunc.Src_One_Add; break;
      default:
        ctx.warn(`unknown blend flag ${lowNibble.toString(16)}`);
        this.blendFunc = BlendFunc.Src_One_Add;
    }
  }

  apply(particle) {
    particle.blendFunc = this.blendFunc;
    particle.alphaOverride = this.alphaOverride;

    // For most particles the alpha-override bit also discards texture alpha,
    // but not for weighted meshes (xim: the jumping flowers in La Theine).
    if (this.alphaOverride != null && particle.isZoneAssociated()
        && particle.config.linkedDataType !== LinkedDataType.WeightedMesh) {
      particle.config.ignoreTextureAlpha = true;
    }
  }
}

export class DeferredBlendFuncInitializer extends Initializer {
  read(r, ctx) {
    const value = r.next32();
    switch (value) {
      case 0x42: this.blendFunc = BlendFunc.Src_One_RevSub; break;
      case 0x44: this.blendFunc = BlendFunc.Src_InvSrc_Add; break;
      case 0x48: this.blendFunc = BlendFunc.Src_One_Add; break;
      default:
        ctx.warn(`unknown deferred blend flag ${value.toString(16)}`);
        this.blendFunc = BlendFunc.Src_One_Add;
    }
  }
  apply(particle) { particle.deferredBlendFunc = this.blendFunc; }
}

export class DepthBiasInitializer extends Initializer {
  read(r) { this.bias = { param0: r.nextFloat(), param1: 0 }; }
  apply(particle) { particle.projectionBias = this.bias; }
}

export class ProjectionBiasInitializer extends Initializer {
  read(r) { this.bias = { param0: r.nextFloat(), param1: r.nextFloat() }; }
  apply(particle) { particle.projectionBias = this.bias; }
}

export class SpriteSheetInitializer extends Initializer {
  read(r) { r.next32(); }
}

export class BatchingSetup extends Initializer {
  read(r) { r.next32(); }
  apply(particle) { particle.batched = true; }
}

export class HazeOffsetInitializer extends Initializer {
  read(r) { r.nextFloat(); this.horizontalOffset = r.nextFloat(); }
  apply(particle) { particle.hazeOffset.x = this.horizontalOffset; }
}

export class FootMarkEffectSetup extends Initializer {
  apply(particle) { particle.footMarkEffect = true; }
}

/** 0x42 — snap the particle down onto the terrain below it. */
export class GroundProjectionSetup extends Initializer {
  apply(particle) {
    particle.onInitialized();
    const world = particle.getWorldSpacePosition();
    const floorY = particle.runtime.getNearestFloorY(world);
    if (floorY == null) return;
    particle.position.y -= world.y - floorY;
  }
}

export class RingMeshSetup extends Initializer {
  read(r) {
    const radii = [r.nextFloat(), r.nextFloat(), r.nextFloat(), r.nextFloat()];
    const colors = [r.nextRGBA(), r.nextRGBA(), r.nextRGBA(), r.nextRGBA()];
    const verticesPerLayer = r.next8();
    const numLayers = 2 + r.next8();
    r.next8(); r.next8();
    this.ringParams = {
      layerRadius: radii.slice(0, numLayers),
      layerColor: colors.slice(0, numLayers),
      verticesPerLayer,
      numLayers,
    };
  }
  apply(particle) { particle.ringMeshParams = this.ringParams; }
}

export class SpecularParamsInitializer extends Initializer {
  read(r, ctx) {
    this.rotation = r.nextVector3f();
    this.textureLink = DatLink.of(r.nextDatId());
    r.next32();
    r.nextFloat();     // commonly 10.0
    r.nextFloat();     // commonly 30.0
    this.color = r.nextRGBA();
    const specFlags = r.next32();
    if (specFlags !== 0x01) ctx.warn(`unhandled specular flags: ${specFlags}`);
  }
  apply(particle) {
    particle.specularParams = {
      rotation: this.rotation.clone(),
      textureLink: this.textureLink,
      color: Color.fromBytes(this.color),
    };
  }
}

export class PointLightParamsInitializer extends Initializer {
  read(r) {
    const range = r.nextFloat();
    const theta = r.nextFloat();
    const rangeMultiplier = mapMultiplier(r.nextFloat());
    const thetaMultiplier = mapMultiplier(r.nextFloat());
    this.params = new PointLightParams(range, theta, rangeMultiplier, thetaMultiplier);
  }
  apply(particle) { particle.pointLightParams = this.params.clone(); }
}

function mapMultiplier(base) {
  if (base >= 0) return Math.pow(2, base);
  if (base >= -1) return 1 + base;
  return 0;
}

export class PointLightAttachmentSetup extends Initializer {
  read(r) { this.pointLightId = r.nextDatId(); r.next32(); }
  apply(particle) { particle.attachedPointLights.push(this.pointLightId); }
}

// ── audio ──────────────────────────────────────────────────────────────────

/**
 * 0x4C — distance falloff for a particle-attached sound. Also forces the
 * generator to be a singleton so a looping ambience can't stack.
 */
export class AudioRangeSetup extends Initializer {
  read(r) { this.far = r.nextFloat(); this.near = r.nextFloat(); r.nextFloat(); }
  apply(particle) {
    particle.creator.def.continuousSingleton = true;
    if (!Number.isFinite(particle.maxAge)) particle.audioConfiguration.looping = true;
    particle.audioConfiguration.farDistance = this.far;
    particle.audioConfiguration.nearDistance = this.near;
  }
}

/** 0x6B — the emitter follows the nearest point on a path (shoreline waves). */
export class PathReferenceSetup extends Initializer {
  read(r) { this.link = new DatLink(r.nextDatId()); r.next32(); r.next32(); }
  apply(particle) {
    this.link.getOrPut((id) => particle.runtime.resolvePath(id, particle.creator));
    particle.audioConfiguration.pathLink = this.link;
  }
}

export class CameraShakeSetup extends Initializer {
  constructor(offset) { super(); this.allocationOffset = offset; }
  read(r) {
    r.next32();
    this.link = new DatLink(r.nextDatId());
    r.next32(); r.nextFloat(); r.next32();
  }
  apply(particle) { particle.allocate(this.allocationOffset, new CameraShakeReference(this.link)); }
}

export class ProgressPositionOffsetConfig extends Initializer {
  read(r) { this.offset = [r.nextVector3f(), r.nextVector3f()]; }
  apply(particle) { particle.progressOffsetParams = this.offset; }
}

// ── opcode table ───────────────────────────────────────────────────────────

const KEYFRAME_OPCODES = new Set([
  // position / rotation / scale / colour / texcoord
  0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f,
  // weighted-mesh weights
  0x33, 0x34, 0x35, 0x36, 0x37,
  0x39,
  // velocity
  0x50, 0x51, 0x52,
  // specular rotation + colour
  0x59, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f,
  // time-of-day colour + scale
  0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66,
  0x68,                        // ToD volume
  0x69,                        // velocity dampener
  0x6c,                        // point-light params
  0x6d, 0x6e, 0x6f, 0x70,      // ToD specular colour
  0x74, 0x75,                  // UV velocity
  0x76, 0x77, 0x78,            // rotational velocity
  0x7c, 0x7d,                  // point-light theta / range
  0x80, 0x81,                  // point-light theta / range multipliers
  0x83, 0x84, 0x85,            // ToD rotation velocity
  0x8b, 0x8c, 0x8d,            // ToD rotation
  0x95, 0x96, 0x97,            // ToD position
]);

/**
 * Build the initializer for a section-2 opcode, or null if we don't know it.
 * Mirrors xim ParticleGeneratorParser.sec2Handler.
 */
export function makeInitializer(opCode, allocationOffset) {
  if (KEYFRAME_OPCODES.has(opCode)) return new KeyFrameValueSetup(allocationOffset);

  switch (opCode) {
    case 0x01: return new StandardParticleSetup();

    case 0x02: return new TranslationVelocitySetup(allocationOffset);
    case 0x03: return new VelocityVarianceSetup(allocationOffset);   // position velocity variance

    case 0x06: return new SphericalPositionVarianceSimple();
    case 0x07: return new SphericalPositionVarianceMedium();

    case 0x08: return new RelativeVelocitySetup(allocationOffset);

    case 0x09: return new RotationInitializer();
    case 0x0a: return new RotationVarianceInitializer();

    case 0x0b: return new RotationVelocitySetup(allocationOffset);
    case 0x0c: return new VelocityVarianceSetup(allocationOffset);   // rotation velocity variance

    case 0x0f: return new ScaleInitializer();
    case 0x10: return new ScaleVarianceInitializer();
    case 0x11: return new SingleScaleVarianceInitializer();

    case 0x12: return new ScaleVelocitySetup(allocationOffset);
    case 0x13: return new VelocityVarianceSetup(allocationOffset);   // scale velocity variance

    case 0x16: return new ColorSetup();
    case 0x17: return new ColorVarianceSetup();
    case 0x18: return new UniformColorVarianceSetup();

    case 0x19: return new ColorTransformSetup(allocationOffset);
    case 0x1a: return new ColorTransformVariance(allocationOffset);

    case 0x1d: return new SpriteSheetInitializer();
    case 0x1e: return new BlendFuncInitializer();
    case 0x1f: return new SphericalPositionVarianceFull();

    case 0x30: return new DepthBiasInitializer();
    case 0x31: return new RandomVelocitySetup(allocationOffset);
    case 0x32: return new HazeOffsetInitializer();

    case 0x3a: return new RingMeshSetup();
    case 0x3b: return new IncrementalRotationApplier();
    case 0x3c: return new OnceChildGeneratorSetup();

    case 0x3d: return new OscillationSetup(allocationOffset);
    case 0x3e: return new OscillationAccelerationSetup(allocationOffset, 0);
    case 0x3f: return new OscillationAccelerationSetup(allocationOffset, 1);
    case 0x40: return new OscillationAccelerationSetup(allocationOffset, 2);

    case 0x41: return new RelativeVelocityVarianceSetup(allocationOffset);
    case 0x42: return new GroundProjectionSetup();
    case 0x43: return new DeferredBlendFuncInitializer();
    case 0x44: return new ChildGeneratorSetup(allocationOffset);
    case 0x45: return new ParentPositionCopyConfig();
    case 0x46: return new ParentVelocityConfig(allocationOffset);
    case 0x47: return new ParentRotateConfig();
    case 0x48: return new ParentColorConfig();
    case 0x49: return new ParentScaleConfig();
    case 0x4a: return new ParentTexCoordConfig();

    case 0x4c: return new AudioRangeSetup();

    case 0x4e: return new FixedPointPositionVarianceSetup();
    case 0x4f: return new FixedPointPositionVarianceSetup();

    case 0x53: return new ChildGeneratorSetup(allocationOffset);
    case 0x54: return new PointListPositionSetup(allocationOffset);
    case 0x55: return new SpecularParamsInitializer();
    case 0x56: return new BatchingSetup();
    case 0x58: return new PointLightParamsInitializer();

    case 0x67: return new ReverseDisplacementSetup(allocationOffset);

    case 0x6a: return new ChildGeneratorSetup(allocationOffset);
    case 0x6b: return new PathReferenceSetup();

    case 0x72: return new ProjectionBiasInitializer();

    case 0x79: return new ParentRotateConfig();
    case 0x7b: return new ProgressPositionOffsetConfig();

    case 0x7e: return new ParentThetaConfig();
    case 0x7f: return new ParentRangeConfig();

    case 0x82: return new CameraShakeSetup(allocationOffset);

    case 0x88: return new PointLightAttachmentSetup();

    case 0x8e: return new FootMarkEffectSetup();

    case 0x90: return new DaylightBasedColorAdjuster();
    case 0x91: return new DaylightBasedColorSetup(allocationOffset);

    case 0x9b: return new ParentPositionSnapshotConfig();

    default: return null;
  }
}

/** Initializers that also run per sub-particle when batching is on. */
export const isSubParticleInitializer = (init) => typeof init.applySub === 'function';
