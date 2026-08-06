// Shared value types for the particle system — ports of xim
// ParticleGeneratorSettings.kt.
//
// The per-particle "dynamically allocated data" model is kept as-is: opcodes
// carry an allocation offset in their config dword, initializers allocate a
// record at that offset, and updaters read it back. That indirection is how a
// generator wires (say) a velocity initializer to the position updater that
// integrates it, so flattening it would break the pairing.

import { Vec3, Mat4, Color, PI_f, posRand, rand } from './math.js';

export const AttachType = {
  None: 0x0,
  SourceActor: 0x1,
  TargetActor: 0x2,
  SourceToTargetBasis: 0x3,
  TargetActorSourceFacing: 0x4,
  SourceActorTargetFacing: 0x5,
  TargetToSourceBasis: 0x6,
  SourceActorWeapon: 0x9,
  ZoneActor0xA: 0xa,
  ZoneActor0xB: 0xb,
  ZoneActor0xC: 0xc,
  Sun: 0xe,
  Moon: 0xf,
};
const ATTACH_VALUES = new Set(Object.values(AttachType));
export const attachTypeFrom = (flag) => (ATTACH_VALUES.has(flag) ? flag : null);

export const BillBoardType = {
  None: 'None',
  XYZ: 'XYZ',
  XZ: 'XZ',
  Camera: 'Camera',
  Movement: 'Movement',
  MovementHorizontal: 'MovementHorizontal',
};

export const LinkedDataType = {
  Actor: 0x01,
  StaticMesh: 0x0b,
  SpriteSheet: 0x0e,
  WeightedMesh: 0x1d,
  Distortion: 0x22,
  RingMesh: 0x24,
  LensFlare: 0x39,
  Audio: 0x3d,
  PointLight: 0x47,
  Null: 0x57,
  Unknown: -1,
};
const LINKED_VALUES = new Set(Object.values(LinkedDataType));
export const linkedDataTypeFrom = (v) => (LINKED_VALUES.has(v) ? v : LinkedDataType.Unknown);
export const linkedDataName = (v) =>
  Object.keys(LinkedDataType).find((k) => LinkedDataType[k] === v) ?? `0x${v.toString(16)}`;

export const RotationOrder = { XYZ: 'XYZ', ZYX: 'ZYX' };

export const ActorScaleTarget = { None: 'None', Source: 'Source', Target: 'Target' };

/** Blend equations, named as in xim BlendFunc. */
export const BlendFunc = {
  One_Zero: 'One_Zero',
  Src_One_Add: 'Src_One_Add',
  Src_One_RevSub: 'Src_One_RevSub',
  Src_InvSrc_Add: 'Src_InvSrc_Add',
  Zero_InvSrc_Add: 'Zero_InvSrc_Add',
};

export const Axis = { X: 0, Y: 1, Z: 2 };

// ── per-particle dynamic data ──────────────────────────────────────────────

export class ParticleTransform {
  constructor() {
    this.velocity = new Vec3();
    this.relativeVelocity = new Vec3();
    this.velocityRotation = new Vec3();
    this.dampeningFactor = null;
  }
}
export class PositionTransform extends ParticleTransform {}
export class RotationTransform extends ParticleTransform {}
export class ScaleTransform extends ParticleTransform {}

export class OscillationParams {
  constructor() {
    this.acceleration = new Vec3();
    this.previousAmplitude = new Vec3();
  }
}

export class ColorTransform {
  constructor(r = 0, g = 0, b = 0, a = 0) { this.r = r; this.g = g; this.b = b; this.a = a; }
  copy() { return new ColorTransform(this.r, this.g, this.b, this.a); }
}

export class KeyFrameReference {
  constructor(link, numCycles) {
    this.link = link;
    this.numCycles = numCycles;
    this.initialValueOverride = null;
  }
}

export class GeneratorReference {
  constructor(id) { this.id = id; this.generator = null; }
}

export class PointListReference {
  constructor(keyFrameLink, pointListLink) {
    this.keyFrameLink = keyFrameLink;
    this.pointListLink = pointListLink;
  }
}

export class CameraShakeReference {
  constructor(link) { this.link = link; }
}

export class DaylightBasedColorMultiplier {}

export class PointLightParams {
  constructor(range, theta, rangeMultiplier, thetaMultiplier) {
    this.range = range; this.theta = theta;
    this.rangeMultiplier = rangeMultiplier; this.thetaMultiplier = thetaMultiplier;
  }
  clone() { return new PointLightParams(this.range, this.theta, this.rangeMultiplier, this.thetaMultiplier); }
}

/**
 * A lazily-resolved reference to another resource by DatId. xim's DatLink caches
 * the lookup on first use; resolution order is supplied by the caller because it
 * differs per resource type (local dir → parents → root → global).
 */
export class DatLink {
  constructor(id) { this.id = id; this._value = undefined; }
  static of(id) { return id ? new DatLink(id) : null; }

  getOrPut(resolve) {
    if (this._value === undefined) this._value = resolve(this.id) ?? null;
    return this._value;
  }

  getIfPresent() { return this._value === undefined ? null : this._value; }
}

// ── spawn-position variance ────────────────────────────────────────────────

/**
 * xim PositionVariance — a random point in a scaled, rotated spherical shell.
 * This is what scatters rain/snow/thunder around the camera and spreads spray
 * across a wave crest.
 */
export class PositionVariance {
  constructor({
    radiusVariance, baseRadius,
    radiusScaleX = 1, radiusScaleY = 1, radiusScaleZ = 1,
    rotationZAxis = 0, rotationYAxis = 0,
    tilt = 0, tiltVariance = PI_f,
    cameraOriented = false, rotationDivisor = 1,
  }) {
    this.radiusVariance = radiusVariance;
    this.baseRadius = baseRadius;
    this.radiusScaleX = radiusScaleX;
    this.radiusScaleY = radiusScaleY;
    this.radiusScaleZ = radiusScaleZ;
    this.rotationZAxis = rotationZAxis;
    this.rotationYAxis = rotationYAxis;
    this.tilt = tilt;
    this.tiltVariance = tiltVariance;
    this.cameraOriented = cameraOriented;
    this.rotationDivisor = rotationDivisor;
  }

  /**
   * @param {Object} particle    needs `creator.totalParticlesEmitted` + `config`
   * @param {Object} cameraRef   { getViewVector() } — camera-oriented shells
   */
  getOffset(particle, cameraRef) {
    const phi = this.rotationDivisor === 1
      ? Math.random() * 2 * Math.PI
      : Math.PI + ((2 * Math.PI) / this.rotationDivisor)
        * (particle.creator.totalParticlesEmitted % this.rotationDivisor);

    // Cube root keeps the distribution uniform by volume rather than by radius.
    const random = this.radiusVariance === 0 ? 0 : Math.pow(posRand(1), 1 / 3);
    const translate = new Vec3(this.baseRadius + this.radiusVariance * random, 0, 0);
    const tiltAngle = this.tilt + this.tiltVariance * rand();

    const transform = new Mat4()
      .rotateYInPlace(this.rotationYAxis)
      .rotateZInPlace(this.rotationZAxis)
      .scaleInPlace(new Vec3(this.radiusScaleX, this.radiusScaleY, this.radiusScaleZ))
      .rotateYInPlace(phi)
      .rotateZInPlace(tiltAngle)
      .translateInPlace(translate);

    if (this.cameraOriented && !particle.config?.localPositionInCameraSpace && cameraRef) {
      const bb = new Mat4().axisBillboardInPlace(cameraRef.getViewVector());
      bb.multiply(transform, transform);
    }

    return transform.getTranslation();
  }
}

// ── generator definition ───────────────────────────────────────────────────

/** xim StandardParticleConfiguration — the flags decoded from opcode 0x01. */
export class StandardParticleConfiguration {
  constructor() {
    this.billBoardType = BillBoardType.None;
    this.rotationOrder = RotationOrder.XYZ;
    this.followCamera = false;
    this.scaleBeforeRotate = false;
    this.localPositionInCameraSpace = false;

    this.depthMask = false;
    this.lightingEnabled = false;
    this.cameraSpaceBillboard = false;
    this.ignoreTextureAlpha = false;
    this.fogEnabled = false;
    this.specular = false;
    this.hazeEffect = false;
    this.decalEffect = false;
    this.followGenerator = true;
    this.drawPriorityOffset = false;
    this.lowPriorityDraw = false;
    this.cameraAttachedBasePosition = false;

    this.basePosition = new Vec3();

    this.linkedDataId = null;      // DatLink
    this.linkedDataType = LinkedDataType.Unknown;

    this.maxLifeSpan = 0;
    this.lifeSpanVariance = 0;
  }
}

export class AudioConfiguration {
  constructor() {
    this.looping = false;
    this.pathLink = null;
    this.farDistance = 0;
    this.nearDistance = 0;
    this.volumeMultiplier = 1;
  }
}

/** xim ParticleGeneratorDefinition. */
export class ParticleGeneratorDefinition {
  constructor(datId) {
    this.datId = datId;

    this.particleConfiguration = null;   // StandardParticleConfiguration
    this.actorScaleParams = {
      scaleSize: ActorScaleTarget.None,
      scalePosition: ActorScaleTarget.None,
      scaleSizeAmount: 0,
      scalePositionAmount: 0,
    };

    this.generatorUpdaters = [];
    this.initializers = [];
    this.updaters = [];
    this.expirationHandlers = [];

    this.unkId = 0;
    this.environmentId = null;

    this.attachType = AttachType.None;
    this.attachedJoint0 = 0;
    this.attachedJoint1 = 0;
    this.attachSourceOriented = false;

    this.emissionVariance = 0;
    this.framesPerEmission = 0;
    this.particlesPerEmission = 0;

    this.continuousSingleton = false;
    this.autoRun = false;
    this.batched = false;

    /** Set when an opcode failed to parse; the generator is skipped entirely. */
    this.parseError = null;
    /** Opcodes we saw but don't implement, for diagnostics. */
    this.unknownOpcodes = [];
  }

  /**
   * xim getNumParticlesPerEmission — weather effects deliberately emit a third
   * of the authored count (the retail client has a flag for this), which is what
   * keeps rain/snow from being a solid wall.
   */
  getNumParticlesPerEmission(isWeather) {
    if (this.continuousSingleton) return 1;
    if (!isWeather) return this.particlesPerEmission + 1;
    const batchMultiplier = this.batched ? 2 : 1;
    return Math.floor((this.particlesPerEmission * batchMultiplier) / 3) + 1;
  }

  shouldApplyBatchingOptimization() { return this.batched; }
}

export { Vec3, Mat4, Color };
