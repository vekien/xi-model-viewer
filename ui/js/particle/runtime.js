// Particle + ParticleGenerator — ports of xim Particle.kt and ParticleGenerator.kt.
//
// The transform chain is the part that has to be exact. Each particle carries
// two matrices:
//
//   worldTransform     where the particle sits: generator attachment position and
//                      rotation, then basePosition, then its own accumulated
//                      position/initialPosition/parent offsets.
//   particleTransform  how the geometry is oriented at that point: billboarding,
//                      rotation (XYZ or ZYX) and scale.
//
// Drawing multiplies world * particle. Splitting them matters because
// billboarding and scale must not disturb the placement, and child generators
// re-use the world transform on its own.

import { Vec3, Mat4, Color, PI_f, posRand, rand } from './math.js';
import { AttachType, BillBoardType, LinkedDataType, RotationOrder, BlendFunc, PointLightParams, PositionTransform } from './types.js';

let particleCounter = 1;

class SubParticle {
  constructor() { this.position = new Vec3(); this.relativeVelocity = new Vec3(); }
}

export class Particle {
  constructor(creator, association, parent, subParticles) {
    this.creator = creator;
    this.association = association;
    this.parent = parent ?? null;
    this.subParticles = subParticles ?? null;

    this.runtime = creator.runtime;
    this.datId = creator.datId;
    this.internalId = particleCounter++;
    this.definition = creator.def;

    this.attachmentSource = creator;

    this.age_ = 0;
    this.maxAge = 0;
    this.forceExpired = false;

    this.position = new Vec3();
    this.rotation = new Vec3();
    this.scale = new Vec3();

    this.negateRotationY = false;
    this.texCoordTranslate = { x: 0, y: 0 };
    this.spriteSheetIndex = 0;

    this.attachType = creator.def.attachType;
    this.associatedPosition = new Vec3();
    this.associatedRotation = new Mat4();

    this.config = null;
    this.meshProvider = null;
    this.ringMeshParams = null;

    this.dynamicallyAllocated = new Map();

    this.previousPosition = new Vec3();
    this.lastMovementAmount = new Vec3();

    this.initialPosition = new Vec3();
    this.initialPositionCameraOriented = false;

    this.weightedMeshWeights = [0, 0, 0, 0, 0];

    this.color = new Color(1, 1, 1, 1);
    this.colorMultiplier = new Color(1, 1, 1, 1);
    this.alphaOverride = null;
    this.colorDayOfWeek = null;
    this.colorMoonPhase = null;

    this.blendFunc = BlendFunc.Src_One_Add;
    this.deferredBlendFunc = BlendFunc.Src_One_Add;

    this.projectionBias = { param0: -0.005, param1: 0 };
    this.occlusionSettings = null;

    this.children = [];
    this.parentPositionSnapshot = new Vec3();
    this.parentOffsetTransform = null;
    this.parentOrientation = new Mat4();

    this.useParentAssociatedPositionOnly = false;
    this.useParentOrientation = false;

    this.progressOffsetParams = null;
    this.footMarkEffect = false;
    this.drawDistanceCulled = false;

    this.audioConfiguration = { looping: false, pathLink: null, farDistance: 0, nearDistance: 0, volumeMultiplier: 1 };
    this.emittedAudio = [];
    this.audioEmitter = null;

    this.specularParams = null;
    this.pointLightParams = new PointLightParams(0, 1, 1, 1);
    this.attachedPointLights = [];

    this.hazeOffset = { x: 0, y: 0 };
    this.batched = false;

    this.worldTransform = new Mat4();
    this.particleTransform = new Mat4();
    this.worldSpacePosition = new Vec3();

    // Memoized floor lookup for decal projection — recomputed only when the
    // particle has actually moved (xim DecalProjectionMemoize).
    this._decalRefPosition = null;
    this._decalFloorY = null;
  }

  isZoneAssociated() { return this.association.kind === 'zone'; }
  isActorAssociated() { return this.association.kind === 'actor'; }
  isWeatherAssociated() { return this.association.kind === 'weather'; }

  age() { return this.age_; }
  resetAge() { if (!this.forceExpired) this.age_ = 1e-7; }
  isExpired() { return this.forceExpired || this.age_ >= this.maxAge; }
  forceExpire() { this.forceExpired = true; }

  isComplete() {
    return this.isExpired() && this.children.every((c) => c.isComplete())
      && this.emittedAudio.every((a) => a.isComplete());
  }

  getProgress() { return Math.min(1, Math.max(0, this.age_ / this.maxAge)); }

  onInitialized() { this.#updateTransforms(); }

  update(numFrames) {
    for (const c of this.children) c.update(numFrames);
    this.children = this.children.filter((c) => !c.isComplete());

    if (this.isExpired()) return;

    this.age_ += numFrames;
    this.audioEmitter?.update(this);

    if (this.isExpired()) {
      for (const h of this.definition.expirationHandlers) h.onExpire(this);
      return;
    }

    if (numFrames !== 0) this.previousPosition.copyFrom(this.position);
    this.colorMultiplier.copyFrom(Color.NO_MASK);

    try {
      for (const updater of this.definition.updaters) {
        updater.apply(numFrames, this);
        if (!this.subParticles || typeof updater.applySub !== 'function') continue;
        for (const sub of this.subParticles) updater.applySub(numFrames, this, sub);
      }
    } catch (e) {
      this.runtime.warn(`[${this.datId}] particle update failed: ${e.message}`);
      this.forceExpire();
      return;
    }

    if (numFrames !== 0) this.lastMovementAmount.copyFrom(this.position.sub(this.previousPosition));
    this.#updateTransforms();
  }

  #updateTransforms() {
    this.#updateAssociatedPosition();
    this.#updateAssociatedFacing();
    this.computeWorldSpaceTransform(this.worldTransform);
    this.computeParticleSpaceOrientationTransform(this.particleTransform);

    const total = new Mat4();
    this.worldTransform.multiply(this.particleTransform, total);
    this.worldSpacePosition.copyFrom(total.getTranslation());
  }

  #updateAssociatedPosition() {
    if (this.useParentAssociatedPositionOnly) return;

    // Sun/moon must keep following their celestial position even when the
    // generator isn't followed (xim leaves a TODO here for the same reason).
    if (!this.isSunOrMoon() && this.age_ > 0 && !this.config.followGenerator) return;

    if (this.config.cameraAttachedBasePosition) {
      if (this.age_ > 0) return;
      // Anchored to the camera POSITION but NOT its rotation: the offset is in
      // fixed world axes, and the drawer renders these through a static
      // world−Z view (xim GLDrawer StaticCamera; radiance FFXIEffectFacade:2195
      // — mapping onto the live basis made the quads swing with the view).
      // Rank-up emblems and similar screen images ride this path.
      this.associatedPosition.copyFrom(this.runtime.camera.getPosition())
        .addInPlace(this.config.basePosition);
    } else if (this.config.followCamera) {
      this.associatedPosition.copyFrom(this.runtime.camera.getPosition());
    } else {
      this.associatedPosition.copyFrom(this.attachmentSource.getAssociatedPosition());
    }
  }

  #updateAssociatedFacing() {
    if (this.useParentOrientation) return;
    if (this.age_ > 0 && !this.config.followGenerator) return;
    this.associatedRotation.copyFrom(this.attachmentSource.getAssociatedFacing());
  }

  isSunOrMoon() { return this.attachType === AttachType.Sun || this.attachType === AttachType.Moon; }

  isFogEnabled() {
    if (this.isSunOrMoon()) return false;
    return this.config.fogEnabled;
  }

  isPointLight() { return this.config.linkedDataType === LinkedDataType.PointLight; }
  isLensFlare() { return this.config.linkedDataType === LinkedDataType.LensFlare; }
  isDistortion() { return this.config.linkedDataType === LinkedDataType.Distortion; }

  hasMeshes() { return this.meshProvider ? this.meshProvider.hasMeshes(this) : false; }

  getMeshes() {
    try {
      return this.meshProvider.getMeshes(this);
    } catch (e) {
      this.creator.stopEmitting();
      this.forceExpire();
      this.runtime.warn(`[${this.datId}] failed to evaluate meshes: ${e.message}`);
      return [];
    }
  }

  getChildrenRecursively() {
    const out = [];
    for (const c of this.children) { out.push(c); out.push(...c.getChildrenRecursively()); }
    return out;
  }

  /**
   * Final tint handed to the shader. Day-of-week and moon-phase tints are
   * MODULATE2X, matching the fixed-function stage the client used.
   */
  getColor() {
    const out = this.color.mul(this.colorMultiplier);
    if (this.colorDayOfWeek) out.modulateInPlace(this.colorDayOfWeek, 2);
    if (this.colorMoonPhase) out.modulateInPlace(this.colorMoonPhase, 2);
    if (this.alphaOverride != null) out.a(this.alphaOverride / 255);
    if (this.#shouldSnapAlpha(out)) out.a(1);
    return out;
  }

  /**
   * Alpha-blended particle meshes snap to fully opaque past the halfway point.
   * xim confirmed this by switching Bibiki Bay's ocean to a zone mesh, which
   * stops snapping — so the behaviour is tied to particle meshes specifically.
   */
  #shouldSnapAlpha(color) {
    return this.blendFunc === BlendFunc.Src_InvSrc_Add
      && color.a() >= 127 / 255
      && this.meshProvider?.isParticleMesh === true;
  }

  // ── transforms ───────────────────────────────────────────────────────────

  getParticleSpaceOrientationTransform() { return new Mat4().copyFrom(this.particleTransform); }
  getWorldSpaceTransform() { return new Mat4().copyFrom(this.worldTransform); }
  getWorldSpacePosition() { return this.worldSpacePosition.clone(); }

  computeParticleSpaceOrientationTransform(particleTransform, specialBillBoardType = null, rotationOrderOverride = null) {
    particleTransform.identity();

    const camera = this.runtime.camera;
    let directionOrientation = null;
    if (this.config.billBoardType === BillBoardType.Movement) directionOrientation = this.lastMovementAmount;
    else if (this.config.billBoardType === BillBoardType.MovementHorizontal) directionOrientation = this.lastMovementAmount.withY(0);
    else if (this.config.billBoardType === BillBoardType.Camera) directionOrientation = camera.getPosition().sub(this.getWorldSpacePosition());

    if (specialBillBoardType === BillBoardType.XYZ) {
      particleTransform.axisBillboardInPlace(camera.getViewVector());
    } else if (directionOrientation) {
      this.#applyMovementOrientation(directionOrientation, particleTransform);
    } else if (this.parent && this.config.billBoardType === BillBoardType.None) {
      particleTransform.multiplyInPlace(this.parentOrientation);
    }

    const targetAdjustedScale = this.scale.clone();

    if (this.config.scaleBeforeRotate) particleTransform.scaleInPlace(targetAdjustedScale);

    const yMul = this.negateRotationY ? -1 : 1;
    const order = rotationOrderOverride ?? this.config.rotationOrder;
    if (order === RotationOrder.XYZ) {
      particleTransform.rotateXYZInPlace(this.rotation.x, yMul * this.rotation.y, this.rotation.z);
    } else {
      particleTransform.rotateZYXInPlace(this.rotation.x, yMul * this.rotation.y, this.rotation.z);
    }

    if (!this.config.scaleBeforeRotate) particleTransform.scaleInPlace(targetAdjustedScale);
  }

  computeWorldSpaceTransform(worldTransform) {
    worldTransform.identity();
    const positionTransform = new Mat4();

    if (this.parentOffsetTransform) {
      positionTransform.copyFrom(this.parentOffsetTransform);
    } else {
      worldTransform.translateDirect(this.associatedPosition);
      worldTransform.multiplyInPlace(this.associatedRotation);
    }

    if (this.config.cameraSpaceBillboard) {
      worldTransform.identityUpperLeft();
      positionTransform.multiplyInPlace(this.#horizontalCameraBillboard());
    }

    if (!this.config.cameraAttachedBasePosition) {
      worldTransform.translateInPlace(positionTransform.transform(this.config.basePosition));
    }

    if (this.initialPositionCameraOriented) worldTransform.identityUpperLeft();

    const progressOffset = this.computeProgressPositionOffset();
    const local = this.initialPosition.add(this.position).addInPlace(this.parentPositionSnapshot).addInPlace(progressOffset);
    worldTransform.translateInPlace(positionTransform.transform(local, 0));

    if (this.config.billBoardType === BillBoardType.Camera) worldTransform.identityUpperLeft();

    if (this.config.decalEffect) {
      const approx = worldTransform.getTranslation();
      const floorY = this.#memoizedFloorY(approx);
      if (floorY != null) worldTransform.m[13] = floorY;
    }
  }

  #memoizedFloorY(position) {
    const ref = this._decalRefPosition;
    if (ref && Vec3.distance(ref, position) < 0.32) return this._decalFloorY;
    this._decalRefPosition = position.clone();
    this._decalFloorY = this.runtime.getNearestFloorY(position);
    return this._decalFloorY;
  }

  #horizontalCameraBillboard() {
    const bb = new Mat4().axisBillboardInPlace(this.runtime.camera.getViewVector());
    bb.m[4] = 0; bb.m[5] = 1; bb.m[6] = 0;
    return bb;
  }

  /** Only meaningful for the actor-to-actor attach types, which zones don't use. */
  computeProgressPositionOffset() { return Vec3.ZERO; }

  #applyMovementOrientation(directionOrientation, particleTransform) {
    if (this.batched) return;   // movement orientation is ignored when batching
    const movement = directionOrientation.clone();
    if (movement.magnitudeSquare() === 0) return;
    movement.normalizeInPlace();

    if (Math.abs(movement.y) < 0.999) {
      const left = Vec3.Y.cross(movement).normalizeInPlace();
      const up = movement.cross(left).normalizeInPlace();
      const angle = -Math.acos(Math.max(-1, Math.min(1, up.dot(Vec3.Y)))) * Math.sign(movement.y);
      particleTransform.axisAngleRotationInPlace(left, angle);
      particleTransform.rotateYInPlace(-Math.atan2(movement.z, movement.x));
    } else {
      particleTransform.rotateZInPlace(Math.sign(movement.y) * PI_f / 2);
    }
  }

  // ── dynamic data ─────────────────────────────────────────────────────────

  allocate(offset, data) {
    this.dynamicallyAllocated.set(offset, data);
    return data;
  }

  getDynamic(offset) { return this.dynamicallyAllocated.get(offset) ?? null; }

  getDynamicByType(type) {
    for (const v of this.dynamicallyAllocated.values()) if (v instanceof type) return v;
    return null;
  }

  getTotalVelocity(transform = this.getDynamicByType(PositionTransform)) {
    const t = transform;
    if (!t) return Vec3.ZERO;
    const yMul = this.negateRotationY ? -1 : 1;
    const r = t.velocityRotation;
    const velocityRotation = new Mat4().rotateZYXInPlace(r.x, r.y * yMul, r.z);
    return velocityRotation.transform(t.velocity.add(t.relativeVelocity), 0);
  }

  getParticleBatch() {
    if (!this.subParticles) return null;
    const offsets = new Float32Array(4 * this.subParticles.length);
    for (let i = 0; i < this.subParticles.length; i++) {
      const p = this.subParticles[i].position;
      offsets[4 * i] = p.x; offsets[4 * i + 1] = p.y; offsets[4 * i + 2] = p.z; offsets[4 * i + 3] = 0;
    }
    return { batchCount: this.subParticles.length, batchOffsets: offsets };
  }
}

export class ParticleGenerator {
  constructor(runtime, resource, association, maxEmitTime = Infinity, parent = null) {
    this.runtime = runtime;
    this.resource = resource;
    this.association = association;
    this.maxEmitTime = maxEmitTime;
    this.parent = parent;

    this.datId = resource.id;
    this.def = resource.def;
    this.localDir = resource.localDir;

    this.lifeTime = 0;
    this.framesUntilNextParticle = 0;
    this.activeParticles = [];

    this.framesPerEmission = this.def.framesPerEmission;
    this.totalParticlesEmitted = 0;

    this.stopEmittingFlag = false;
    this.invalid = !!this.def.parseError || !this.def.particleConfiguration;

    this.genAssociatedPosition = new Vec3();
    this.genAssociatedRotation = new Mat4();

    this.rotation = new Vec3();
    this.emitCulled = false;
    this.transitionLink = null;

    this.updateAssociatedPosition(0);
    this.updateAssociatedFacing(0);
  }

  isExpired() { return this.invalid || (this.activeParticles.length === 0 && this.#isDoneEmitting()); }

  #isDoneEmitting() {
    if (this.stopEmittingFlag) return true;
    return !this.def.autoRun && this.lifeTime >= this.maxEmitTime && this.totalParticlesEmitted > 0;
  }

  stopEmitting() { this.stopEmittingFlag = true; }

  /** Advance this generator and everything it owns. */
  update(elapsedFrames) {
    this.emit(elapsedFrames);
    for (const p of this.activeParticles) p.update(elapsedFrames);
    this.activeParticles = this.activeParticles.filter((p) => !p.isComplete());
  }

  getActiveParticles() { return this.activeParticles; }

  emit(elapsedFrames, preInitialize = null) {
    if (this.invalid) return [];

    this.activeParticles = this.activeParticles.filter((p) => !p.isComplete());

    this.lifeTime += elapsedFrames;
    if (this.isExpired()) return [];

    for (const u of this.def.generatorUpdaters) u.apply(elapsedFrames, this);
    if (this.emitCulled || this.#isDoneEmitting()) return [];
    if (!this.#checkEnvironmentMatch()) return [];

    const newParticles = [];
    this.framesUntilNextParticle -= elapsedFrames;

    while (this.framesUntilNextParticle <= 0) {
      // A "continuous singleton" keeps exactly one particle alive forever —
      // the sea plane, a fixed glow, a looping ambient sound.
      if (this.def.continuousSingleton && this.activeParticles.length > 0) break;

      this.framesUntilNextParticle += this.framesPerEmission + posRand(this.def.emissionVariance);
      if (!Number.isFinite(this.framesPerEmission)) {
        // Singleton generators emit once; guard against an infinite loop.
        if (this.totalParticlesEmitted > 0) break;
      }

      try {
        const isWeather = this.association.kind === 'weather';
        const count = this.def.shouldApplyBatchingOptimization() ? 1 : this.def.getNumParticlesPerEmission(isWeather);

        for (let i = 0; i < count; i++) {
          const particle = this.#generateParticle(preInitialize, isWeather);
          newParticles.push(particle);
          this.activeParticles.push(particle);
          this.totalParticlesEmitted += 1;
          if (this.def.continuousSingleton) break;
        }
      } catch (e) {
        this.runtime.warn(`[${this.datId}] couldn't generate particle: ${e.message}`);
        this.invalid = true;
        return [];
      }

      if (this.isExpired()) break;
    }

    return newParticles;
  }

  #generateParticle(preInitialize, isWeather) {
    const subParticles = this.def.shouldApplyBatchingOptimization()
      ? Array.from({ length: this.def.getNumParticlesPerEmission(isWeather) }, () => new SubParticle())
      : null;

    const particle = new Particle(this, this.association, this.parent, subParticles);
    preInitialize?.(particle);

    for (const initializer of this.def.initializers) {
      initializer.apply(particle);
      if (!particle.subParticles || typeof initializer.applySub !== 'function') continue;
      for (const sub of particle.subParticles) initializer.applySub(particle, sub);
    }

    particle.onInitialized();
    return particle;
  }

  updateAssociatedPosition(elapsedFrames) {
    const attach = this.def.attachType;
    if (attach === AttachType.Sun) {
      this.genAssociatedPosition.copyFrom(this.runtime.getSunPosition())
        .addInPlace(this.runtime.camera.getPosition());
    } else if (attach === AttachType.Moon) {
      this.genAssociatedPosition.copyFrom(this.runtime.getMoonPosition())
        .addInPlace(this.runtime.camera.getPosition());
    }
    // Actor attach types need an actor association, which zone effects never have.
  }

  getAssociatedPosition() { return this.genAssociatedPosition; }

  updateAssociatedFacing() { /* zone generators have no actor facing to track */ }

  getAssociatedFacing() {
    return new Mat4().copyFrom(this.genAssociatedRotation).rotateZYXInPlace(this.rotation.x, this.rotation.y, this.rotation.z);
  }

  getTotalLifeTime() { return this.lifeTime; }

  syncFromParent() {
    if (!this.parent || this.parent.datId === this.datId) return;
    this.genAssociatedPosition.copyFrom(this.parent.attachmentSource.genAssociatedPosition);
    this.genAssociatedRotation.copyFrom(this.parent.attachmentSource.genAssociatedRotation);
  }

  /**
   * Camera-attached weather effects only emit while the viewer is in the default
   * environment, which is what stops rain and snow appearing inside caves.
   */
  #checkEnvironmentMatch() {
    if (this.association.kind !== 'weather' || this.totalParticlesEmitted === 0) return true;
    const config = this.def.particleConfiguration;
    if (!config.followCamera && !config.cameraAttachedBasePosition) return true;
    return this.runtime.getViewerEnvironmentId() == null;
  }
}

export { SubParticle };
