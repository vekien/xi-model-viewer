// 0x05 ParticleGenerator section parser — port of xim ParticleGeneratorParser.
//
// Layout, all offsets from the section start:
//   +0x10  attach flags, joints, actor-scale targets
//   +0x20  actor scale amounts
//   +0x60  unk id + environment id (which `ev01`-style sub-environment lights it)
//   +0x74  emission variance / frames per emission / particles per emission / flags
//   +0x80  four offsets to the opcode streams
//
// Each opcode stream is a run of self-sizing opcodes: the low byte of the config
// dword is the opcode, bits 8-12 are its size in dwords (including the config
// dword itself), and bits 13+ are the per-particle allocation offset the opcode
// reads or writes. A zero opcode terminates the stream.

import { ByteReader } from '../dat/reader.js';
import { ParticleGeneratorDefinition, ActorScaleTarget, attachTypeFrom, AttachType } from './types.js';
import { makeInitializer } from './ops/initializers.js';
import { makeUpdater } from './ops/updaters.js';
import { makeGeneratorUpdater, makeExpirationHandler } from './ops/generator.js';

/**
 * @param {Uint8Array} bytes
 * @param {DataView} dv
 * @param {{start:number,size:number,dataStart:number,id:string}} section
 * @param {{id:string,dir:Object}} entry
 * @param {(msg:string)=>void} [warn]
 * @returns {{kind:'effect', id:string, def:ParticleGeneratorDefinition, localDir:Object}}
 */
export function parseParticleGenerator(bytes, dv, section, entry, warn = () => {}) {
  const def = new ParticleGeneratorDefinition(entry?.id ?? section.id);
  const r = new ByteReader(bytes, dv, 0, section.id);
  const ctx = {
    def,
    // Unknown opcodes are a fact about the format, not about this generator, so
    // the emitted warning is id-free and dedupes to one line per opcode. The
    // per-generator detail is still kept on the definition for debugging.
    warn: (msg, global = false) => {
      def.unknownOpcodes.push(msg);
      warn(global ? msg : `[${def.datId}] ${msg}`);
    },
  };

  r.offsetFromDataStart(section, 0x0);

  const attachFlags = r.next16();
  const attachTypeFlag = attachFlags & 0x0f;
  const attachType = attachTypeFrom(attachTypeFlag);
  if (attachType == null) ctx.warn(`unknown attach type ${attachTypeFlag.toString(16)}`);
  def.attachType = attachType ?? AttachType.None;

  def.attachedJoint0 = (attachFlags & 0x03f0) >>> 4;
  def.attachedJoint1 = (attachFlags & 0xfc00) >>> 10;

  const additionalAttachFlags = r.next16();
  def.attachSourceOriented = (additionalAttachFlags & 0x0001) !== 0;

  const scalePosition = (additionalAttachFlags & 0x0040) !== 0 ? ActorScaleTarget.Source
    : (additionalAttachFlags & 0x0080) !== 0 ? ActorScaleTarget.Target : ActorScaleTarget.None;
  const scaleSize = (additionalAttachFlags & 0x0400) !== 0 ? ActorScaleTarget.Source
    : (additionalAttachFlags & 0x0800) !== 0 ? ActorScaleTarget.Target : ActorScaleTarget.None;

  r.offsetFromDataStart(section, 0x10);
  const scalePositionAmount = r.nextFloat();
  const scaleSizeAmount = r.nextFloat();
  def.actorScaleParams = { scalePosition, scaleSize, scalePositionAmount, scaleSizeAmount };

  r.offsetFromDataStart(section, 0x50);
  def.unkId = r.next32();
  def.environmentId = r.nextDatId() || null;

  // Note the change of base: the fields below are section-start relative.
  r.offsetFrom(section, 0x74);
  def.emissionVariance = r.next16();
  def.framesPerEmission = r.next16() + 1;
  def.particlesPerEmission = r.next8();

  const genFlags = r.next8();
  def.continuousSingleton = (genFlags & 0x04) !== 0;
  def.autoRun = (genFlags & 0x10) !== 0;

  r.next8();
  const moreFlags = r.next8();
  // Batched generators process a group of particles as one draw; used for weather.
  def.batched = (moreFlags & 0x20) !== 0;

  r.offsetFrom(section, 0x80);
  const sectionOffsets = [r.next32(), r.next32(), r.next32(), r.next32()];

  try {
    for (let i = 0; i < 4; i++) {
      if (!sectionOffsets[i]) continue;
      r.offsetFrom(section, sectionOffsets[i]);
      parseOpcodeStream(r, i + 1, section, def, ctx);
    }
  } catch (e) {
    // xim throws here and fails the whole DAT. A viewer would rather lose one
    // generator than a zone, so record it and let the runtime skip this effect.
    def.parseError = e.message;
    warn(`[${def.datId}] generator parse failed: ${e.message}`);
  }

  return { kind: 'effect', id: def.datId, def, localDir: entry?.dir ?? null };
}

function parseOpcodeStream(r, secNum, section, def, ctx) {
  const streamEnd = section.start + section.size;

  while (true) {
    const startPosition = r.position;
    if (startPosition + 4 > streamEnd) return;

    const opCodeConfig = r.next32();
    const opCode = opCodeConfig & 0xff;
    const opCodeSize = (opCodeConfig >>> 8) & 0x1f;
    const allocationOffset = opCodeConfig >>> 0xd;

    if (opCode === 0x00) return;
    if (opCodeSize === 0) throw new Error(`sec${secNum} opcode ${opCode.toString(16)} has zero size`);

    const nextCodePos = startPosition + opCodeSize * 4;
    const op = buildOp(secNum, opCode, allocationOffset, opCodeSize);

    if (!op) {
      ctx.warn(`unknown sec${secNum} opcode 0x${opCode.toString(16)}`, true);
    } else {
      op.read(r, ctx);
      if (r.position !== nextCodePos) {
        throw new Error(`sec${secNum} opcode 0x${opCode.toString(16)} read ${r.position - startPosition} bytes, expected ${opCodeSize * 4}`);
      }
      attachOp(secNum, def, op);
    }

    r.position = nextCodePos;
  }
}

function buildOp(secNum, opCode, allocationOffset, opCodeSize) {
  switch (secNum) {
    case 1: return makeGeneratorUpdater(opCode);
    case 2: return makeInitializer(opCode, allocationOffset);
    case 3: return makeUpdater(opCode, allocationOffset, opCodeSize);
    case 4: return makeExpirationHandler(opCode);
    default: return null;
  }
}

function attachOp(secNum, def, op) {
  switch (secNum) {
    case 1: def.generatorUpdaters.push(op); break;
    case 2: def.initializers.push(op); break;
    case 3: def.updaters.push(op); break;
    case 4: def.expirationHandlers.push(op); break;
  }
}
