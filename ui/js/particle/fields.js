// Field catalogue for the 0x05 ParticleGenerator — every header field and every
// operand of every opcode, described straight from the bytes.
//
// parser.js decodes a generator into runtime objects and forgets where each
// value came from; an editor needs the opposite: a value's byte range, its type
// and what it means. The layouts here mirror the readers in ops/*.js (a port of
// xim) one for one, so a table that tiles an op's declared size is a table the
// runtime agrees with. Where xim and the PS2 build disagree the field carries a
// note, and only operands both agree on are editable.
//
// Addressing is the recipe's (`generators[].edits`): a header field by its
// offset from the section start, an operand by stream + opcode + nth occurrence
// + offset from the op's config dword. Never by file offset — the race copies of
// a weapon skill are separate files. `applyEdits` / `applyCurve` write exactly
// what `xi ability compose` writes (xi-tools src/xi/ability/xi_genedit.py).
//
// No DOM and no imports: this runs the same in the app and under node.

const SIZES = { u8: 1, u16: 2, u32: 4, i16: 2, i32: 4, f32: 4, datid: 4, rgba: 4 };
const INT_RANGE = {
  u8: [0, 0xff], u16: [0, 0xffff], u32: [0, 0xffffffff],
  i16: [-0x8000, 0x7fff], i32: [-0x80000000, 0x7fffffff],
};
const F32_MAX = 3.4028234663852886e38;

const HEADER_FROM = 0x10;      // the 16-byte section header ends here
const STREAM_TABLE = 0x80;     // four u32 stream offsets; the writable header ends here
const HEADER_END = 0x90;
const MAX_OP_BYTES = 0x1f * 4; // an op's size field is five bits of dwords
const CURVE_KEYS_FROM = 0x10;

/** The effect clock: every "ticks" field is 1/60 s (particle/math.js). */
export const TICKS_PER_SECOND = 60;

export const GROUPS = [
  'Timing', 'Spawn', 'Attach', 'Position', 'Rotation', 'Scale', 'Speed', 'Colour',
  'Alpha & blend', 'Texture & mesh', 'Curves', 'Draw', 'Other',
];

// Section types a generator names by id (xi-tools fx/xi_copy.py _DEP_TYPES): the
// ones compose carries along, so the only ones a `datid` edit may point at.
const DEP_TYPES = new Set([0x20, 0x21, 0x1f, 0x19, 0x2e, 0x3d]);
const SEC_GENERATOR = 0x05;
const SEC_CURVE = 0x19;

// ── field specs ────────────────────────────────────────────────────────────
// A spec is one operand: { at, type, name, label, group, … }. `at` counts from
// the section start (header) or from the op's config dword (ops).
//   count        consecutive elements (a vec3 is f32 × 3)
//   mask, shift  a bit field inside the integer at `at`
//   wire, bits   type 'flags': the integer type it is stored as, and its bits
//   editMask     the bits of a flags field an edit may write
//   unit, scale, offset   shown = raw × scale + offset
//   enum         raw → label
//   ref          what a datid names: curve, generator, pointList, texture, …
//   safe         agreed by xim and the PS2 build: the editor may write it
//   hex          shown as hex: a pointer slot, padding, or an operand nobody reads

const DEG = 180 / Math.PI;
const BYTE_PCT = 100 / 0x80;   // colour bytes: 0x80 is 100%, 0xFF is 2× overbright

const f = (at, type, name, label, group, extra = {}) => ({ at, type, name, label, group, ...extra });
const vec3 = (at, name, label, group, extra = {}) => f(at, 'f32', name, label, group, { count: 3, axes: 'xyz', ...extra });
const skip = (at, type, note, count = 1) => f(at, type, `unk${at.toString(16).toUpperCase()}`, 'Not read', 'Other', { count, hex: true, note });
const ptr = (at) => f(at, 'u32', 'pointer', 'Pointer slot', 'Other', {
  hex: true, note: 'Zero on disk; the client keeps a pointer here while the effect runs. Never written.',
});
const rgba = (at, name, label, group, extra = {}) => f(at, 'rgba', name, label, group, {
  unit: '%', scale: BYTE_PCT, note: 'R, G, B, A bytes; 0x80 is 100%, 0xFF is twice as bright.', ...extra,
});

const SAFE = { safe: true };
const TICKS = { unit: 'ticks' };
const RAD = { unit: '°', scale: DEG };

const ATTACH_TYPES = {
  0x0: 'None', 0x1: 'Source actor', 0x2: 'Target actor', 0x3: 'Source → target basis',
  0x4: 'Target actor, facing the source', 0x5: 'Source actor, facing the target',
  0x6: 'Target → source basis', 0x9: "Source actor's weapon",
  0xa: 'Zone actor (A)', 0xb: 'Zone actor (B)', 0xc: 'Zone actor (C)', 0xe: 'Sun', 0xf: 'Moon',
};

const LINKED_TYPES = {
  0x01: 'Actor', 0x0b: 'Static mesh', 0x0e: 'Sprite sheet', 0x1d: 'Weighted mesh',
  0x22: 'Distortion', 0x24: 'Ring mesh', 0x39: 'Lens flare', 0x3d: 'Sound',
  0x47: 'Point light', 0x57: 'Nothing',
};
// What the 0x01 linked id names, by its linked type.
const LINKED_REF = {
  0x01: 'actor', 0x0b: 'mesh', 0x0e: 'sprites', 0x1d: 'weightedMesh', 0x39: 'sprites', 0x3d: 'sound',
};

const BLEND_MODES = { 0x1: 'Subtract', 0x2: 'Subtract', 0x4: 'Alpha blend', 0x6: 'Zero / inverse source', 0x8: 'Additive' };
const DEFERRED_BLEND = { 0x42: 'Subtract', 0x44: 'Alpha blend', 0x48: 'Additive' };

const HEADER = [
  f(0x10, 'u16', 'attachType', 'Attach to', 'Attach', { mask: 0x000f, enum: ATTACH_TYPES, ...SAFE }),
  f(0x10, 'u16', 'attachJoint0', 'Joint on the source actor', 'Attach', { mask: 0x03f0, shift: 4, ...SAFE }),
  f(0x10, 'u16', 'attachJoint1', 'Joint on the target actor', 'Attach', { mask: 0xfc00, shift: 10, ...SAFE }),
  f(0x12, 'flags', 'attachFlags', 'Actor scaling', 'Attach', {
    wire: 'u16',
    bits: [
      [0x0001, 'source oriented'], [0x0040, 'position scales with the source actor'],
      [0x0080, 'position scales with the target actor'], [0x0400, 'size scales with the source actor'],
      [0x0800, 'size scales with the target actor'],
    ],
    note: 'Known from xim only; nothing here reads it.',
  }),
  skip(0x14, 'u32', null, 3),
  f(0x20, 'f32', 'scalePositionAmount', 'Actor scale → position', 'Scale', { note: 'Known from xim only; nothing here reads it.' }),
  f(0x24, 'f32', 'scaleSizeAmount', 'Actor scale → size', 'Scale', { note: 'Known from xim only; nothing here reads it.' }),
  skip(0x28, 'u32', null, 6),
  f(0x40, 'f32', 'unk40', 'Not read', 'Other', { count: 8, note: 'Eight floats nobody reads; most effects hold 1 1 1 0 1 1 1 1.' }),
  f(0x60, 'u32', 'unkId', 'Stale pointer', 'Other', { hex: true, note: 'Left over from the authoring tool. Written back unchanged.' }),
  f(0x64, 'datid', 'environmentId', 'Lighting environment', 'Draw', { ref: 'environment' }),
  skip(0x68, 'u32', 'Runtime counters; zero on disk.', 3),
  f(0x74, 'u16', 'emissionVariance', 'Spawn interval jitter', 'Timing', {
    ...TICKS, ...SAFE, note: 'A random 0…n ticks added to every interval.',
  }),
  f(0x76, 'u16', 'spawnInterval', 'Spawn interval', 'Timing', {
    ...TICKS, offset: 1, ...SAFE, note: 'Stored as interval − 1. How long it keeps spawning is the routine event\'s duration, not a generator field.',
  }),
  f(0x78, 'u8', 'spawnCount', 'Particles per spawn', 'Spawn', {
    offset: 1, ...SAFE, note: 'Stored as count − 1. The PS2 build reads a ninth bit from the next byte; it is 0 in every effect checked.',
  }),
  f(0x79, 'flags', 'genFlags', 'Generator flags', 'Spawn', {
    wire: 'u8', editMask: 0x14, ...SAFE,
    bits: [
      [0x01, 'spawn count bit 8 (PS2)'], [0x04, 'one particle, kept alive'],
      [0x08, 'active (runtime)'], [0x10, 'auto-run'],
    ],
  }),
  skip(0x7a, 'u8', 'PS2: part of a pre-roll frame count; 0 in every effect checked.'),
  f(0x7b, 'flags', 'batchFlags', 'Batch flags', 'Spawn', {
    wire: 'u8', bits: [[0x10, 'culled (runtime)'], [0x20, 'batched (one draw per spawn; weather)']],
  }),
  f(0x7c, 'u32', 'pointer7C', 'Stale pointer', 'Other', { hex: true, note: 'Written back unchanged.' }),
  f(STREAM_TABLE, 'u32', 'streamOffsets', 'Op stream offsets', 'Other', {
    count: 4, hex: true, note: 'Where the four op streams start, from the section start. Never writable.',
  }),
];

// ── opcode tables ──────────────────────────────────────────────────────────
// { name, dw, fields, slot?, reads?, note? }. `dw` is the op's size in dwords,
// config dword included (an array when the client accepts more than one size).
// `slot: 'curve'` allocates a curve reference in the particle's work memory and
// `reads: 'curve'` samples the one in the same slot — that is how a sec2
// keyframe op finds its sec3 updater.

/** Section 1: a curve over the generator's own life that overwrites a sec2 operand. */
const genCurve = (name, group, what, extra = {}) => ({
  name, dw: 5, overwrites: extra.overwrites ?? null, note: extra.note ?? null,
  fields: [
    ptr(4),
    f(8, 'datid', 'curve', `Curve · ${what}`, 'Curves', { ref: 'curve', curveGroup: group }),
    f(0xc, 'u32', 'curveFlags', 'Curve flags', 'Curves', { hex: true, note: 'PS2: the low four bits pick a spline. Not read here.' }),
    f(0x10, 'f32', 'spare', 'Spare float', 'Curves', { note: extra.spareNote ?? 'Not read here.' }),
  ],
});

const SEC1 = {
  0x04: genCurve('EmissionFrequency', 'Timing', 'spawns per 60 ticks', {
    overwrites: [{ sec: 0, name: 'spawnInterval' }],
    note: 'Replaces the header spawn interval while the generator runs. The PS2 build also rewrites the spawn count from it.',
    spareNote: 'PS2: seeds the curve\'s first key. xim seeds it from the header interval instead.',
  }),
  0x05: genCurve('RelativeVelocity', 'Speed', 'outward speed', { overwrites: [{ sec: 2, op: 0x08, name: 'speed' }] }),
  0x06: genCurve('SphericalRadius', 'Position', 'spawn radius', {
    overwrites: [{ sec: 2, op: 0x1f, name: 'baseRadius' }],
    note: 'xim drives the 0x1F base radius with this one and the variance with 0x07; the PS2 build has them the other way round. Unsettled for the PC client.',
  }),
  0x07: genCurve('SphericalRadiusVariance', 'Position', 'spawn radius variance', {
    overwrites: [{ sec: 2, op: 0x1f, name: 'radiusVariance' }],
    note: 'See 0x06: which of the two radii this drives is unsettled.',
  }),
  0x08: genCurve('SphericalRotationZ', 'Position', 'spawn shell Z rotation (half-turns)', { overwrites: [{ sec: 2, op: 0x1f, name: 'rotationZ' }] }),
  0x09: genCurve('SphericalRotationY', 'Position', 'spawn shell Y rotation (half-turns)', { overwrites: [{ sec: 2, op: 0x1f, name: 'rotationY' }] }),
  0x0a: {
    name: 'GeneratorCull', dw: 4,
    fields: [
      f(4, 'f32', 'maxDistance', 'Stop spawning beyond', 'Draw', { unit: 'units', ...SAFE, note: '0 leaves it to the zone\'s clip range.' }),
      f(8, 'f32', 'minDistance', 'Minimum distance', 'Draw', { note: 'PS2: a minimum distance. Not read here.' }),
      f(0xc, 'u32', 'cullFlags', 'Cull flags', 'Draw', { hex: true, note: 'PS2: bit 0 deactivates the generator. Not read here.' }),
    ],
  },
  0x0b: genCurve('BasePositionX', 'Position', 'emitter X', { overwrites: [{ sec: 2, op: 0x01, name: 'basePosition', axis: 0 }] }),
  0x0c: genCurve('BasePositionY', 'Position', 'emitter Y', { overwrites: [{ sec: 2, op: 0x01, name: 'basePosition', axis: 1 }] }),
  0x0d: genCurve('BasePositionZ', 'Position', 'emitter Z', { overwrites: [{ sec: 2, op: 0x01, name: 'basePosition', axis: 2 }] }),
  0x0e: genCurve('GeneratorRotationX', 'Rotation', 'emitter X rotation (half-turns)'),
  0x0f: genCurve('GeneratorRotationY', 'Rotation', 'emitter Y rotation (half-turns)'),
  0x10: genCurve('GeneratorRotationZ', 'Rotation', 'emitter Z rotation (half-turns)'),
  0x11: {
    name: 'Association', dw: 2,
    fields: [
      f(4, 'flags', 'follow', 'Follow the attachment', 'Attach', {
        wire: 'u32', bits: [[0x1, 'position'], [0x2, 'facing'], [0xfffffffc, 'rubber-band rate (not modelled)']],
      }),
    ],
  },
  0x12: genCurve('GeneratorVelocityX', 'Speed', 'velocity X', { overwrites: [{ sec: 2, op: 0x02, name: 'velocity', axis: 0 }] }),
  0x13: genCurve('GeneratorVelocityY', 'Speed', 'velocity Y', { overwrites: [{ sec: 2, op: 0x02, name: 'velocity', axis: 1 }] }),
  0x14: genCurve('GeneratorVelocityZ', 'Speed', 'velocity Z', { overwrites: [{ sec: 2, op: 0x02, name: 'velocity', axis: 2 }] }),
};

/** Section 2 keyframe reference: the curve a sec3 updater in the same slot samples. */
const keyFrame = (name, group, what) => ({
  name, dw: 4, slot: 'curve', what, curveGroup: group,
  fields: [
    ptr(4),
    f(8, 'datid', 'curve', `Curve · ${what}`, 'Curves', {
      ref: 'curve', curveGroup: group, ...SAFE,
      note: 'A 0x19 curve in the same DAT. Curves are shared: every op that names this one follows an edit to it.',
    }),
    f(0xc, 'u32', 'cycles', 'Curve cycles over the particle\'s life', 'Curves', {
      mask: 0x3fe0, shift: 5, ...SAFE, note: '0 and 1 both play the curve once.',
    }),
    f(0xc, 'flags', 'curveFlags', 'Curve flags', 'Curves', {
      wire: 'u32', mask: 0xffffc01f,
      bits: [[0x0000000f, 'interpolation tweak'], [0x00000010, 'progress locked'], [0xffffc000, 'unknown']],
      note: 'Not read here.',
    }),
  ],
});

const KEYFRAMES = {};
const keyFrames = (first, group, prefix, whats) => whats.forEach((what, i) => {
  const name = `KeyFrame.${prefix}${what.replace(/[^A-Za-z0-9]/g, '')}`;
  KEYFRAMES[first + i] = keyFrame(name, group, prefix === 'ToD' ? `${what} by time of day` : what);
});
keyFrames(0x21, 'Position', '', ['position X', 'position Y', 'position Z']);
keyFrames(0x24, 'Rotation', '', ['rotation X', 'rotation Y', 'rotation Z']);
keyFrames(0x27, 'Scale', '', ['scale X', 'scale Y', 'scale Z']);
keyFrames(0x2a, 'Colour', '', ['red', 'green', 'blue']);
keyFrames(0x2d, 'Alpha & blend', '', ['alpha']);
keyFrames(0x2e, 'Texture & mesh', '', ['texture U', 'texture V']);
keyFrames(0x33, 'Texture & mesh', '', ['mesh weight 0', 'mesh weight 1', 'mesh weight 2', 'mesh weight 3', 'mesh weight 4']);
keyFrames(0x39, 'Curves', '', ['value']);
keyFrames(0x50, 'Speed', '', ['velocity X', 'velocity Y', 'velocity Z']);
keyFrames(0x59, 'Draw', '', ['specular rotation X', 'specular rotation Y', 'specular rotation Z']);
keyFrames(0x5c, 'Colour', '', ['specular red', 'specular green', 'specular blue', 'specular alpha']);
keyFrames(0x60, 'Colour', 'ToD', ['red', 'green', 'blue']);
keyFrames(0x63, 'Alpha & blend', 'ToD', ['alpha']);
keyFrames(0x64, 'Scale', 'ToD', ['scale X', 'scale Y', 'scale Z']);
keyFrames(0x68, 'Other', 'ToD', ['volume']);
keyFrames(0x69, 'Speed', '', ['drag']);
keyFrames(0x6c, 'Draw', '', ['point light']);
keyFrames(0x6d, 'Colour', 'ToD', ['specular red', 'specular green', 'specular blue', 'specular alpha']);
keyFrames(0x74, 'Texture & mesh', '', ['texture U speed', 'texture V speed']);
keyFrames(0x76, 'Rotation', '', ['spin X', 'spin Y', 'spin Z']);
keyFrames(0x7c, 'Draw', '', ['point light theta', 'point light range']);
keyFrames(0x80, 'Draw', '', ['point light theta multiplier', 'point light range multiplier']);
keyFrames(0x83, 'Rotation', 'ToD', ['spin X', 'spin Y', 'spin Z']);
keyFrames(0x8b, 'Rotation', 'ToD', ['rotation X', 'rotation Y', 'rotation Z']);
keyFrames(0x95, 'Position', 'ToD', ['position X', 'position Y', 'position Z']);

const presence = (name, group, note) => ({ name, dw: 1, fields: [], group, note });
const childGenerator = (name, note) => ({
  name, dw: 3, note,
  fields: [ptr(4), f(8, 'datid', 'generator', 'Child generator', 'Spawn', { ref: 'generator' })],
});
const pointList = (name) => ({
  name, dw: 4,
  fields: [ptr(4), f(8, 'datid', 'pointList', 'Point list', 'Position', { ref: 'pointList' }), skip(0xc, 'u32')],
});
const RENDER_NOTE = 'Spawn radius: particles start on a shell of this radius, plus a random 0…variance.';

const SEC2 = {
  ...KEYFRAMES,
  0x01: {
    name: 'StandardSetup', dw: 12,
    fields: [
      f(4, 'flags', 'billboard', 'Billboard and rotation', 'Draw', {
        wire: 'u16', editMask: 0x52cf, ...SAFE,
        bits: [
          [0x0001, 'billboard XYZ (with 0x80: faces its movement)'], [0x0002, 'scale before rotate'],
          [0x0004, 'follows the camera'], [0x0008, 'position in camera space (needs follows the camera)'],
          [0x0040, 'faces its movement (with 0x80: faces the camera)'], [0x0080, 'faces its movement, horizontal'],
          [0x0200, 'rotation order ZYX'], [0x1000, 'depth mask'], [0x4000, 'billboard XZ'],
        ],
      }),
      f(6, 'flags', 'render', 'Render state', 'Draw', {
        wire: 'u16', editMask: 0x1f73, ...SAFE,
        bits: [
          [0x0001, 'lit'], [0x0002, 'camera-space billboard'], [0x0010, 'haze'], [0x0020, 'decal'],
          [0x0040, 'draw-priority offset'], [0x0080, 'does not follow the generator'], [0x0100, 'specular'],
          [0x0200, 'fog off'], [0x0400, 'base position rides the camera'], [0x0800, 'low draw priority'],
          [0x1000, 'ignores texture alpha'],
        ],
        note: '"Does not follow the generator" also sizes the particle\'s work memory on PS2, so that bit is never written.',
      }),
      ptr(8),
      f(0xc, 'datid', 'linkedId', 'Draws', 'Texture & mesh', {
        ref: 'linked', ...SAFE,
        note: 'The mesh, sprite sheet or sound this particle is. The texture is named inside that mesh. A new id must already be in the same DAT.',
      }),
      skip(0x10, 'f32', 'Always about 0.'),
      vec3(0x14, 'basePosition', 'Emitter offset', 'Position', { unit: 'units', ...SAFE }),
      f(0x20, 'u8', 'workSize', 'Per-particle work memory', 'Other', { unit: 'bytes', note: 'The sum of the slots the ops allocate. Structural: never written.' }),
      f(0x21, 'u8', 'linkedType', 'Draws a', 'Texture & mesh', { enum: LINKED_TYPES, ...SAFE, note: 'Must match what the linked id names.' }),
      f(0x22, 'u16', 'life', 'Particle life', 'Timing', { ...TICKS, ...SAFE, note: '0 is a single particle that never dies.' }),
      f(0x24, 'u16', 'lifeVariance', 'Particle life variance', 'Timing', { ...TICKS, ...SAFE, note: 'A random 0…n ticks added to the life.' }),
      skip(0x26, 'u16'),
      skip(0x28, 'u32', '0 or 1.'),
      skip(0x2c, 'u32'),
    ],
  },
  0x02: { name: 'TranslationVelocity', dw: 4, fields: [vec3(4, 'velocity', 'Velocity', 'Speed', { unit: 'units/tick', ...SAFE })] },
  0x03: { name: 'VelocityVariance', dw: 4, fields: [vec3(4, 'variance', 'Velocity variance (±)', 'Speed', { unit: 'units/tick', ...SAFE })] },
  0x06: {
    name: 'SphericalPositionSimple', dw: 4, note: RENDER_NOTE,
    fields: [
      f(4, 'f32', 'radiusVariance', 'Spawn radius variance', 'Position', { unit: 'units', ...SAFE }),
      f(8, 'f32', 'baseRadius', 'Spawn radius', 'Position', { unit: 'units', ...SAFE }),
      skip(0xc, 'u32'),
    ],
  },
  0x07: {
    name: 'SphericalPositionMedium', dw: 8, note: RENDER_NOTE,
    fields: [
      f(4, 'f32', 'radiusVariance', 'Spawn radius variance', 'Position', { unit: 'units', ...SAFE, note: 'Doubled at run time on a batched generator.' }),
      f(8, 'f32', 'baseRadius', 'Spawn radius', 'Position', { unit: 'units', ...SAFE }),
      vec3(0xc, 'radiusScale', 'Spawn shell scale', 'Position'),
      skip(0x18, 'f32', 'Unknown; very small.'),
      f(0x1c, 'f32', 'rotationY', 'Spawn shell Y rotation', 'Position', { ...RAD }),
    ],
  },
  0x08: { name: 'RelativeVelocity', dw: 2, fields: [f(4, 'f32', 'speed', 'Outward speed', 'Speed', { unit: 'units/tick', ...SAFE })] },
  0x09: { name: 'Rotation', dw: 4, fields: [vec3(4, 'rotation', 'Rotation', 'Rotation', { ...RAD, ...SAFE })] },
  0x0a: { name: 'RotationVariance', dw: 4, fields: [vec3(4, 'variance', 'Rotation variance (±)', 'Rotation', { ...RAD, ...SAFE })] },
  0x0b: { name: 'RotationVelocity', dw: 4, fields: [vec3(4, 'velocity', 'Spin', 'Rotation', { unit: '°/tick', scale: DEG, ...SAFE })] },
  0x0c: { name: 'RotationVelocityVariance', dw: 4, fields: [vec3(4, 'variance', 'Spin variance (±)', 'Rotation', { unit: '°/tick', scale: DEG, ...SAFE })] },
  0x0f: { name: 'Scale', dw: 4, fields: [vec3(4, 'scale', 'Scale', 'Scale', { ...SAFE })] },
  0x10: { name: 'ScaleVariance', dw: 4, fields: [vec3(4, 'variance', 'Scale variance (0…n per axis)', 'Scale', { ...SAFE })] },
  0x11: { name: 'UniformScaleVariance', dw: 2, fields: [f(4, 'f32', 'variance', 'Scale variance (0…n, all axes)', 'Scale', { ...SAFE })] },
  0x12: { name: 'ScaleVelocity', dw: 4, fields: [vec3(4, 'velocity', 'Growth', 'Scale', { unit: '/tick', ...SAFE })] },
  0x13: { name: 'ScaleVelocityVariance', dw: 4, fields: [vec3(4, 'variance', 'Growth variance (±)', 'Scale', { unit: '/tick', ...SAFE })] },
  0x16: { name: 'Color', dw: 2, fields: [rgba(4, 'colour', 'Colour', 'Colour', { ...SAFE })] },
  0x17: {
    name: 'ColorVariance', dw: 2,
    fields: [rgba(4, 'variance', 'Colour variance (0…n per channel)', 'Colour', {
      ...SAFE, note: 'R, G, B, A bytes added at random. The PS2 build leaves alpha alone; xim varies it too.',
    })],
  },
  0x18: {
    name: 'UniformColorVariance', dw: 2,
    fields: [
      f(4, 'u8', 'variance', 'Brightness variance (0…n, all channels)', 'Colour', {
        unit: '%', scale: BYTE_PCT, ...SAFE, note: 'The PS2 build leaves alpha alone; xim varies it too.',
      }),
      skip(5, 'u8', null, 3),
    ],
  },
  0x19: {
    name: 'ColorTransform', dw: 3, note: 'A sec3 0x0B in the same slot adds this to the colour every tick.',
    fields: [f(4, 'i16', 'rate', 'Colour change per tick', 'Colour', {
      count: 4, axes: 'rgba', unit: 'bytes/tick', scale: 1 / 256, ...SAFE, note: 'Signed 8.8 fixed point per channel: 256 adds one colour byte a tick.',
    })],
  },
  0x1a: {
    name: 'ColorTransformVariance', dw: 3,
    fields: [f(4, 'i16', 'variance', 'Colour change variance', 'Colour', {
      count: 4, axes: 'rgba', unit: 'bytes/tick', scale: 1 / 256, ...SAFE,
      note: 'xim adds a random 0…n on all four channels; the PS2 build adds ±n and leaves alpha alone.',
    })],
  },
  0x1d: {
    name: 'SpriteSheet', dw: 2,
    fields: [
      f(4, 'i16', 'loops', 'Extra sprite-sheet loops', 'Texture & mesh', { note: 'PS2 only: the sheet plays n + 1 times over the life. xim calls it unused.' }),
      skip(6, 'u16'),
    ],
  },
  0x1e: {
    name: 'BlendFunc', dw: 2,
    fields: [
      f(4, 'u8', 'blend', 'Blend mode', 'Alpha & blend', { mask: 0x0f, enum: BLEND_MODES, ...SAFE }),
      f(4, 'flags', 'blendFlags', 'Blend flags', 'Alpha & blend', {
        wire: 'u8', mask: 0xf0, editMask: 0x70, ...SAFE,
        bits: [[0x10, 'opaque (no blending)'], [0x20, 'fixed alpha (the byte below)'], [0x40, 'normal source'], [0x80, 'unknown']],
      }),
      f(5, 'u8', 'alpha', 'Fixed alpha', 'Alpha & blend', {
        unit: '%', scale: BYTE_PCT, max: 0x80, ...SAFE, note: '0…0x80, used only with the fixed-alpha flag.',
      }),
      skip(6, 'u8', null, 2),
    ],
  },
  0x1f: {
    name: 'SphericalPositionFull', dw: 12, note: RENDER_NOTE,
    fields: [
      f(4, 'f32', 'radiusVariance', 'Spawn radius variance', 'Position', { unit: 'units', ...SAFE }),
      f(8, 'f32', 'baseRadius', 'Spawn radius', 'Position', { unit: 'units', ...SAFE }),
      vec3(0xc, 'radiusScale', 'Spawn shell scale', 'Position', { ...SAFE }),
      f(0x18, 'f32', 'rotationZ', 'Spawn shell Z rotation', 'Position', { ...RAD, ...SAFE }),
      f(0x1c, 'f32', 'rotationY', 'Spawn shell Y rotation', 'Position', { ...RAD, ...SAFE }),
      f(0x20, 'f32', 'tilt', 'Spawn shell tilt', 'Position', { ...RAD, ...SAFE }),
      f(0x24, 'f32', 'tiltVariance', 'Spawn shell tilt variance', 'Position', { ...RAD, ...SAFE }),
      f(0x28, 'u32', 'cameraOriented', 'Shell faces the camera', 'Position', { enum: { 0: 'no', 1: 'yes' } }),
      f(0x2c, 'u32', 'rotationDivisor', 'Even spacing round the shell', 'Position', { offset: 1, note: 'Stored as n − 1.' }),
    ],
  },
  0x30: { name: 'DepthBias', dw: 2, fields: [f(4, 'f32', 'bias', 'Depth bias', 'Draw')] },
  0x31: { name: 'RandomScaleVelocity', dw: 2, fields: [f(4, 'f32', 'value', 'Random growth (±, all axes)', 'Scale', { unit: '/tick', ...SAFE, note: 'Overwrites what 0x12 and 0x13 set.' })] },
  0x32: { name: 'HazeOffset', dw: 3, fields: [skip(4, 'f32'), f(8, 'f32', 'offsetX', 'Haze offset X', 'Draw')] },
  0x3a: {
    name: 'RingMesh', dw: 10,
    fields: [
      f(4, 'f32', 'radii', 'Ring radii', 'Texture & mesh', { count: 4, unit: 'units', ...SAFE }),
      rgba(0x14, 'colour0', 'Ring colour 0', 'Colour', { ...SAFE }),
      rgba(0x18, 'colour1', 'Ring colour 1', 'Colour', { ...SAFE }),
      rgba(0x1c, 'colour2', 'Ring colour 2', 'Colour', { ...SAFE }),
      rgba(0x20, 'colour3', 'Ring colour 3', 'Colour', { ...SAFE }),
      f(0x24, 'u8', 'verticesPerLayer', 'Vertices per ring', 'Texture & mesh', { ...SAFE }),
      f(0x25, 'u8', 'layers', 'Rings', 'Texture & mesh', { offset: 2, ...SAFE, note: 'Stored as rings − 2; four at most.' }),
      skip(0x26, 'u8', null, 2),
    ],
  },
  0x3b: { name: 'IncrementalRotation', dw: 4, fields: [vec3(4, 'step', 'Rotation step per particle', 'Rotation', { ...RAD, ...SAFE })] },
  0x3c: childGenerator('OnceChildGenerator', 'Spawns the child once, at birth.'),
  0x3d: presence('Oscillation', 'Position', 'Allocates the sway the sec3 0x29–0x2B ops drive.'),
  0x3e: { name: 'OscillationAccelX', dw: 3, fields: [f(4, 'f32', 'acceleration', 'Sway strength X', 'Position'), f(8, 'f32', 'variance', 'Sway strength variance X (±)', 'Position')] },
  0x3f: { name: 'OscillationAccelY', dw: 3, fields: [f(4, 'f32', 'acceleration', 'Sway strength Y', 'Position'), f(8, 'f32', 'variance', 'Sway strength variance Y (±)', 'Position')] },
  0x40: { name: 'OscillationAccelZ', dw: 3, fields: [f(4, 'f32', 'acceleration', 'Sway strength Z', 'Position'), f(8, 'f32', 'variance', 'Sway strength variance Z (±)', 'Position')] },
  0x41: { name: 'RelativeVelocityVariance', dw: 2, fields: [f(4, 'f32', 'variance', 'Outward speed variance (±)', 'Speed', { unit: 'units/tick', ...SAFE })] },
  0x42: presence('GroundProjection', 'Position', 'Drops the particle onto the ground below it.'),
  0x43: { name: 'DeferredBlendFunc', dw: 2, fields: [f(4, 'u32', 'blend', 'Deferred blend mode', 'Alpha & blend', { enum: DEFERRED_BLEND, note: 'Parsed, but the drawer here does not use it.' })] },
  0x44: childGenerator('ChildGenerator', 'The child runs for as long as this particle lives.'),
  0x45: presence('ParentPositionCopy', 'Position', 'Takes the parent particle\'s position.'),
  0x46: { name: 'ParentVelocity', dw: 2, fields: [f(4, 'f32', 'multiplier', 'Share of the parent\'s velocity', 'Speed')] },
  0x47: presence('ParentRotate', 'Rotation', 'Takes the parent particle\'s rotation.'),
  0x48: presence('ParentColor', 'Colour', 'Takes the parent particle\'s colour.'),
  0x49: presence('ParentScale', 'Scale', 'Takes the parent particle\'s scale.'),
  0x4a: presence('ParentTexCoord', 'Texture & mesh', 'Takes the parent particle\'s texture offset.'),
  0x4c: {
    name: 'AudioRange', dw: 4, note: 'Also makes the generator a single looping particle.',
    fields: [f(4, 'f32', 'far', 'Silent beyond', 'Other', { unit: 'units' }), f(8, 'f32', 'near', 'Full volume within', 'Other', { unit: 'units' }), skip(0xc, 'f32')],
  },
  0x4e: pointList('FixedPointPosition'),
  0x4f: pointList('FixedPointPosition'),
  0x53: childGenerator('ChildGenerator', 'The child runs for as long as this particle lives.'),
  0x54: {
    name: 'PointListPosition', dw: 6,
    fields: [
      ptr(4), f(8, 'datid', 'curve', 'Curve · progress along the points', 'Curves', { ref: 'curve', curveGroup: 'Position' }),
      skip(0xc, 'u32'), skip(0x10, 'u32'),
      f(0x14, 'datid', 'pointList', 'Point list', 'Position', { ref: 'pointList' }),
    ],
  },
  0x55: {
    name: 'SpecularParams', dw: 10,
    fields: [
      vec3(4, 'rotation', 'Specular rotation', 'Draw', { ...SAFE }),
      f(0x10, 'datid', 'texture', 'Specular texture', 'Texture & mesh', { ref: 'texture' }),
      skip(0x14, 'u32'), skip(0x18, 'f32', 'Commonly 10.'), skip(0x1c, 'f32', 'Commonly 30.'),
      rgba(0x20, 'colour', 'Specular colour', 'Colour', { ...SAFE }),
      f(0x24, 'u32', 'specularFlags', 'Specular flags', 'Draw', { hex: true, note: 'Always 1.' }),
    ],
  },
  0x56: { name: 'Batching', dw: 2, fields: [skip(4, 'u32')] },
  0x58: {
    name: 'PointLightParams', dw: 5,
    fields: [
      f(4, 'f32', 'range', 'Light range', 'Draw', { ...SAFE }),
      f(8, 'f32', 'theta', 'Light theta', 'Draw', { ...SAFE }),
      f(0xc, 'f32', 'rangeMultiplier', 'Light range multiplier', 'Draw', { ...SAFE, note: 'Stored as an exponent: v ≥ 0 is 2^v, −1…0 is 1 + v.' }),
      f(0x10, 'f32', 'thetaMultiplier', 'Light theta multiplier', 'Draw', { ...SAFE, note: 'Stored as an exponent: v ≥ 0 is 2^v, −1…0 is 1 + v.' }),
    ],
  },
  0x67: { name: 'ReverseDisplacement', dw: 2, note: 'Starts at the end of its path and runs it backwards.', fields: [skip(4, 'f32')] },
  0x6a: childGenerator('ChildGenerator', 'The child runs for as long as this particle lives.'),
  0x6b: { name: 'PathReference', dw: 4, fields: [f(4, 'datid', 'path', 'Path', 'Position', { ref: 'path' }), skip(8, 'u32'), skip(0xc, 'u32')] },
  0x72: { name: 'ProjectionBias', dw: 3, fields: [f(4, 'f32', 'bias0', 'Projection bias 0', 'Draw'), f(8, 'f32', 'bias1', 'Projection bias 1', 'Draw')] },
  0x79: presence('ParentRotate', 'Rotation', 'Takes the parent particle\'s rotation.'),
  0x7b: {
    name: 'ProgressPositionOffset', dw: 7, note: 'In xim but not in the PS2 build; stubbed at run time here.',
    fields: [vec3(4, 'offset0', 'Progress offset 0', 'Position'), vec3(0x10, 'offset1', 'Progress offset 1', 'Position')],
  },
  0x7e: presence('ParentTheta', 'Draw', 'Takes the parent\'s point-light theta.'),
  0x7f: presence('ParentRange', 'Draw', 'Takes the parent\'s point-light range.'),
  0x82: {
    name: 'CameraShake', dw: 6, slot: 'curve',
    fields: [
      ptr(4), f(8, 'datid', 'curve', 'Curve · camera shake', 'Curves', { ref: 'curve', curveGroup: 'Draw' }),
      skip(0xc, 'u32'), skip(0x10, 'f32'), skip(0x14, 'u32'),
    ],
  },
  0x88: { name: 'PointLightAttachment', dw: 3, fields: [f(4, 'datid', 'pointLight', 'Point light', 'Draw', { ref: 'pointLight' }), skip(8, 'u32')] },
  0x8e: presence('FootMark', 'Draw', 'Marks the particle as a footprint.'),
  0x90: presence('DaylightColorAdjuster', 'Colour', 'Tints by the strongest light of the environment; zones only.'),
  0x91: { name: 'DaylightColorSetup', dw: 2, fields: [skip(4, 'u32')] },
  0x9b: presence('ParentPositionSnapshot', 'Position', 'Takes the parent\'s position once, at birth.'),
};

/** Section 3 ops that sample the curve a sec2 keyframe op put in their slot. */
const SEC3_CURVES = {};
const curveOps = (first, group, by, whats, note) => whats.forEach((what, i) => {
  SEC3_CURVES[first + i] = { name: `${by}.${what.replace(/[^A-Za-z0-9]/g, '')}`, dw: 1, fields: [], reads: 'curve', what, group, by, note };
});
const HALF_TURNS = 'The curve is in half-turns (× π).';
const COLOUR_CURVE = 'The curve runs 0…1 of a colour byte, so 0.5 is 100%. Its first key is replaced by the particle\'s colour at birth.';
curveOps(0x0f, 'Position', 'Progress', ['position X', 'position Y', 'position Z']);
curveOps(0x12, 'Rotation', 'Progress', ['rotation X', 'rotation Y', 'rotation Z'], HALF_TURNS);
curveOps(0x15, 'Scale', 'Progress', ['scale X', 'scale Y', 'scale Z'], 'The first key is replaced by the particle\'s scale at birth.');
curveOps(0x18, 'Colour', 'Progress', ['red', 'green', 'blue'], COLOUR_CURVE);
curveOps(0x1b, 'Alpha & blend', 'Progress', ['alpha'], COLOUR_CURVE);
curveOps(0x1c, 'Texture & mesh', 'Progress', ['texture U', 'texture V']);
curveOps(0x1e, 'Texture & mesh', 'Progress', ['mesh weight 0', 'mesh weight 1', 'mesh weight 2', 'mesh weight 3', 'mesh weight 4']);
curveOps(0x24, 'Draw', 'Progress', ['haze offset X']);
curveOps(0x30, 'Speed', 'Progress', ['velocity X', 'velocity Y', 'velocity Z']);
curveOps(0x35, 'Draw', 'Progress', ['specular rotation X', 'specular rotation Y', 'specular rotation Z']);
curveOps(0x38, 'Colour', 'Progress', ['specular red', 'specular green', 'specular blue', 'specular alpha']);
curveOps(0x3c, 'Colour', 'Clock', ['red', 'green', 'blue'], 'Sampled by the time of day; zones only.');
curveOps(0x3f, 'Alpha & blend', 'Clock', ['alpha multiplier'], 'Sampled by the time of day; zones only.');
curveOps(0x40, 'Scale', 'Clock', ['scale X', 'scale Y', 'scale Z'], 'Sampled by the time of day; zones only.');
curveOps(0x43, 'Other', 'Clock', ['volume'], 'Sampled by the time of day; zones only.');
curveOps(0x44, 'Speed', 'Progress', ['drag']);
curveOps(0x49, 'Draw', 'Clock', ['point light theta'], 'Sampled by the time of day; zones only.');
curveOps(0x4a, 'Colour', 'Clock', ['specular red', 'specular green', 'specular blue', 'specular alpha'], 'Sampled by the time of day; zones only.');
curveOps(0x54, 'Texture & mesh', 'Progress', ['texture U speed', 'texture V speed'], 'The curve is a speed, added up every tick.');
curveOps(0x56, 'Rotation', 'Progress', ['spin X', 'spin Y', 'spin Z'], 'The curve is a spin in half-turns per tick, added up every tick.');
curveOps(0x5b, 'Draw', 'Progress', ['point light theta', 'point light range', 'point light theta multiplier', 'point light range multiplier']);
curveOps(0x66, 'Rotation', 'Clock', ['rotation X', 'rotation Y', 'rotation Z'], `Sampled by the time of day; zones only. ${HALF_TURNS}`);
curveOps(0x6b, 'Position', 'Clock', ['position X', 'position Y', 'position Z'], 'Sampled by the time of day; zones only.');

const accelerator = (what, group, extra) => ({
  name: 'VelocityAccelerator', dw: 4,
  fields: [vec3(4, 'acceleration', what, group, { ...SAFE, ...extra })],
});
const doubleRange = (name, note) => ({
  name, dw: 6, note,
  fields: [
    f(4, 'f32', 'nearRange', 'Fades in between', 'Draw', { count: 2, unit: 'units' }),
    f(0xc, 'f32', 'farRange', 'Fades out between', 'Draw', { count: 2, unit: 'units' }),
    skip(0x14, 'f32'),
  ],
});
const oscillation = (axis) => ({
  name: `Oscillation${axis}`, dw: 4,
  fields: [
    f(4, 'f32', 'period', `Sway period ${axis}`, 'Position', { ...SAFE, note: 'The sway rate is 180 / this value.' }),
    f(8, 'f32', 'phase', `Sway phase ${axis}`, 'Position', { ...RAD, ...SAFE }),
    skip(0xc, 'f32'),
  ],
});
const tintTable = (name, n, what) => ({
  name, dw: 2 + n, note: `${what}; zones only.`,
  fields: [skip(4, 'u32'), ...Array.from({ length: n }, (_, i) => rgba(8 + i * 4, `colour${i}`, `Tint ${i}`, 'Colour', { ...SAFE }))],
});
const clockRotation = (axis) => ({
  name: `ClockRotation${axis}`, dw: 5, reads: 'curve', what: `spin ${axis} by time of day`, group: 'Rotation', by: 'Clock',
  note: 'Sampled by the time of day; zones only. The curve is added to the rotation on every update, in half-turns (× π).',
  fields: [skip(4, 'f32', null, 4)],
});

const SEC3 = {
  ...SEC3_CURVES,
  0x02: presence('PositionUpdater', 'Speed', 'Moves the particle by the velocity in its slot.'),
  0x03: accelerator('Acceleration', 'Speed', { unit: 'units/tick²', note: 'Y is down in game space: a positive Y pulls the particle down (gravity), a negative Y lifts it. Skipped on a batched generator (PS2).' }),
  0x05: presence('RotationUpdater', 'Rotation', 'Turns the particle by the spin in its slot.'),
  0x06: accelerator('Spin acceleration', 'Rotation', { unit: '°/tick²', scale: DEG }),
  0x08: presence('ScaleUpdater', 'Scale', 'Grows the particle by the growth in its slot.'),
  0x09: accelerator('Growth acceleration', 'Scale', { unit: '/tick²' }),
  0x0b: presence('ColorTransformApplier', 'Colour', 'Adds the sec2 0x19 colour change every tick.'),
  0x0c: {
    name: 'ColorTransformModifier', dw: 3,
    fields: [f(4, 'i16', 'rate', 'Change of the colour change', 'Colour', {
      count: 4, axes: 'rgba', note: 'Units unsettled: xim applies it per 30 ticks, the PS2 build per tick.',
    })],
  },
  0x0d: presence('SpriteSheetFrame', 'Texture & mesh', 'Steps through the sprite sheet over the particle\'s life.'),
  0x0e: presence('Progress', 'Timing', 'PS2: works out the particle\'s progress for the curve ops after it. Must come before them.'),
  0x25: presence('ChildGeneratorBasic', 'Spawn', 'Runs the child generator in its slot.'),
  0x26: {
    name: 'VelocityRotator', dw: 4,
    fields: [vec3(4, 'rotate', 'Velocity turn', 'Speed', { unit: '°/tick', scale: DEG * 0.5, ...SAFE, note: 'Radians per tick, halved at run time.' })],
  },
  0x27: { name: 'TextureScrollU', dw: 2, fields: [f(4, 'f32', 'speed', 'Texture scroll U', 'Texture & mesh', { unit: '/tick', ...SAFE })] },
  0x28: { name: 'TextureScrollV', dw: 2, fields: [f(4, 'f32', 'speed', 'Texture scroll V', 'Texture & mesh', { unit: '/tick', ...SAFE })] },
  0x29: oscillation('X'),
  0x2a: oscillation('Y'),
  0x2b: oscillation('Z'),
  0x2c: {
    name: 'VelocityDampener', dw: 3,
    fields: [f(4, 'f32', 'drag', 'Drag', 'Speed', { ...SAFE, note: 'Velocity is multiplied by this every tick: 1 is none, 0.9 sheds a tenth a tick.' }), skip(8, 'f32')],
  },
  0x2e: {
    name: 'DrawDistance', dw: 4,
    fields: [
      f(4, 'f32', 'near', 'Starts to fade at', 'Draw', { unit: 'units', ...SAFE }),
      f(8, 'f32', 'far', 'Gone beyond', 'Draw', { unit: 'units', ...SAFE }),
      skip(0xc, 'u32'),
    ],
  },
  0x2f: presence('VelocityRotation', 'Speed', 'Turns the velocity to follow the particle\'s rotation.'),
  0x33: presence('ChildGenerator', 'Spawn', 'Runs the child generator in its slot, in this particle\'s space.'),
  0x34: presence('PointListPosition', 'Position', 'Moves along the point list in its slot.'),
  0x45: presence('MoonPhaseSprite', 'Texture & mesh', 'Picks the sprite by moon phase; zones only.'),
  0x46: presence('ChildGenerator', 'Spawn', 'Runs the child generator in its slot, billboarded.'),
  0x48: doubleRange('DoubleRangeDrawDistance', 'Visible only inside a band of distances.'),
  0x4e: tintTable('DayOfWeekColor', 8, 'One tint per day of the week'),
  0x4f: tintTable('MoonPhaseColor', 12, 'One tint per moon phase'),
  0x53: { name: 'Occlusion', dw: 3, fields: [f(4, 'f32', 'size', 'Occlusion size', 'Draw'), f(8, 'f32', 'opacity', 'Base opacity', 'Draw')] },
  0x59: {
    name: 'AngularDistanceRotation', dw: 4,
    fields: [f(4, 'f32', 'angularFactor', 'Turn per angle and distance', 'Rotation'), f(8, 'f32', 'constant', 'Constant turn', 'Rotation'), skip(0xc, 'u32')],
  },
  0x5f: {
    name: 'CameraShake', dw: [3, 4], reads: 'curve', what: 'camera shake', group: 'Draw', by: 'Progress',
    fields: [
      f(4, 'f32', 'near', 'Full shake within', 'Draw', { unit: 'units' }),
      f(8, 'f32', 'far', 'No shake beyond', 'Draw', { unit: 'units' }),
      f(0xc, 'f32', 'factor', 'Shake strength', 'Draw', { ifWords: 4 }),
    ],
  },
  0x60: {
    name: 'ScreenFlash', dw: 7,
    fields: [
      f(4, 'f32', 'near', 'Full flash within', 'Draw', { unit: 'units' }),
      f(8, 'f32', 'far', 'No flash beyond', 'Draw', { unit: 'units' }),
      f(0xc, 'f32', 'nearAngle', 'Full flash inside this angular distance', 'Draw'),
      f(0x10, 'f32', 'farAngle', 'No flash outside this angular distance', 'Draw'),
      skip(0x14, 'u32', null, 2),
    ],
  },
  0x61: clockRotation('X'),
  0x62: clockRotation('Y'),
  0x63: clockRotation('Z'),
  0x69: { name: 'DaylightColorApplier', dw: 2, note: 'Tints by the strongest light of the environment; zones only.', fields: [skip(4, 'u32')] },
  0x6e: doubleRange('DoubleRangeWeightedMesh', 'Blends two mesh weights by distance.'),
};

const SEC4 = {
  0x01: childGenerator('EmitChild', 'Spawns the child once, when this particle dies.'),
  0x05: presence('Repeat', 'Timing', 'The particle starts over instead of dying.'),
};

// Ops only the PS2 build handles, named where its code says what they do. Their
// operands are unknown, so they stay raw.
const ps2 = (named, codes = []) => ({ ...Object.fromEntries(codes.map((c) => [c, null])), ...named });
const PS2_ONLY = {
  1: ps2({ 0x15: 'ViewClipBox', 0x16: 'JumpToGeneratorStream', 0x17: 'EmissionFrequencyByTimeOfDay' }),
  2: ps2({}, [0x38, 0x4b, 0x57, 0x71, 0x7a, 0x86, 0x87, 0x89, 0x8a, 0x8f, 0x92, 0x93, 0x94, 0x98, 0x99, 0x9a, 0x9c, 0x9d, 0x9e]),
  3: ps2(
    { 0x01: 'ConstantPositionAdd', 0x04: 'ConstantRotationAdd', 0x07: 'ConstantScaleAdd', 0x0a: 'ConstantColorAdd' },
    [0x23, 0x47, 0x50, 0x51, 0x5a, 0x64, 0x65, 0x6a],
  ),
  4: ps2({ 0x02: 'RunScheduler', 0x04: 'ReleaseWorkReference', 0x06: 'JumpToGeneratorStream', 0x07: 'ReleaseWorkReference' }),
};

const TABLES = { 1: SEC1, 2: SEC2, 3: SEC3, 4: SEC4 };
const STREAM_NAMES = { 1: 'generator updaters', 2: 'initializers', 3: 'updaters', 4: 'expiration handlers' };

// ── bytes ──────────────────────────────────────────────────────────────────

const asBytes = (b) => (b instanceof Uint8Array ? b
  : new Uint8Array(b instanceof ArrayBuffer ? b : b.buffer, b.byteOffset ?? 0, b.byteLength));
const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const hexByte = (v) => v.toString(16).padStart(2, '0');
const hex = (v, width = 2) => `0x${(v >>> 0).toString(16).toUpperCase().padStart(width, '0')}`;
const hexRun = (bytes, from, to) => {
  let s = '';
  for (let p = from; p < to; p++) s += (p > from && (p - from) % 4 === 0 ? ' ' : '') + hexByte(bytes[p]);
  return s;
};

/** A 4-byte id as the particle parser reads it (dat/reader.js nextDatId). */
function datIdAt(bytes, p) {
  let s = '';
  for (let i = 0; i < 4; i++) s += String.fromCharCode(bytes[p + i]);
  return s.replace(/\0+$/, '').trim();
}

function readScalar(dv, type, p) {
  switch (type) {
    case 'u8': return dv.getUint8(p);
    case 'u16': return dv.getUint16(p, true);
    case 'u32': return dv.getUint32(p, true);
    case 'i16': return dv.getInt16(p, true);
    case 'i32': return dv.getInt32(p, true);
    case 'f32': return dv.getFloat32(p, true);
    default: throw new Error(`not a scalar type: ${type}`);
  }
}

/** Size in bytes a section's own header declares (19-bit size in 16-byte units). */
function declaredSize(bytes, start) {
  if (start + 8 > bytes.length) return 0;
  const meta = (bytes[start + 4] | (bytes[start + 5] << 8) | (bytes[start + 6] << 16) | (bytes[start + 7] << 24)) >>> 0;
  return ((meta >>> 7) & 0x7ffff) * 0x10;
}

function sectionEnd(bytes, start, size) {
  const n = size > 0 ? size : declaredSize(bytes, start);
  return Math.min(start + n, bytes.length);
}

/**
 * Every section of a DAT: { id, type, start, size }. The same walk the Data
 * view does (dat/inspect.js); it stops at the first header that cannot be one.
 */
export function walkSections(buffer) {
  const bytes = asBytes(buffer);
  const out = [];
  let pos = 0;
  while (pos + 16 <= bytes.length) {
    const size = declaredSize(bytes, pos);
    if (size <= 0 || pos + size > bytes.length) break;
    out.push({ id: nameAt(bytes, pos), type: bytes[pos + 4] & 0x7f, start: pos, size });
    pos += size;
  }
  return out;
}

/** A section name the way xi-tools cleans one: trailing NULs and spaces dropped. */
function nameAt(bytes, p) {
  let s = '';
  for (let i = 0; i < 4; i++) s += String.fromCharCode(bytes[p + i]);
  return s.replace(/[\0 ]+$/, '');
}

/**
 * What a `datid` edit may name in this DAT: clean id → the four bytes as the
 * DAT spells it. Compose builds the same map, so a short id is padded the way
 * its section is.
 */
export function datIds(buffer) {
  const bytes = asBytes(buffer);
  const ids = new Map();
  for (const s of walkSections(bytes)) {
    if (DEP_TYPES.has(s.type)) ids.set(s.id, bytes.slice(s.start, s.start + 4));
  }
  return ids;
}

// ── describing ─────────────────────────────────────────────────────────────

const fmtNum = (v) => {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-4 || a >= 1e7)) return v.toExponential(3);
  return String(Number(v.toPrecision(6)));
};

/** Stored value → the number the editor shows (interval + 1, radians as degrees, …). */
export function toDisplay(field, raw) {
  const d = field.display ?? {};
  return raw * (d.scale ?? 1) + (d.offset ?? 0);
}

/** The inverse of toDisplay; integer types round to the nearest stored value. */
export function fromDisplay(field, shown) {
  const d = field.display ?? {};
  const raw = (shown - (d.offset ?? 0)) / (d.scale ?? 1);
  return field.type === 'f32' ? raw : Math.round(raw);
}

function displayText(field) {
  const d = field.display;
  const v = field.value;
  if (field.type === 'datid') return v || '(none)';
  if (field.type === 'flags') {
    const on = d.bits.filter((b) => b.on).map((b) => (b.value != null ? `${b.label} ${b.value}` : b.label));
    return on.length ? on.join(', ') : 'none';
  }
  if (field.type === 'rgba') {
    return `${v.join(' ')} · ${v.map((c) => `${Math.round(c * BYTE_PCT)}%`).join(' ')}`;
  }
  if (d.enum) return d.enum[v] != null ? `${d.enum[v]} (${hex(v)})` : `${hex(v)} (unknown)`;
  if (d.hex && field.type !== 'f32') return (Array.isArray(v) ? v : [v]).map((n) => hex(n, SIZES[field.type] * 2)).join(' ');
  const one = (n) => fmtNum(toDisplay(field, n));
  const body = Array.isArray(v) ? v.map(one).join(', ') : one(v);
  if (d.unit === 'ticks' && !Array.isArray(v)) {
    const ticks = toDisplay(field, v);
    return `${body} ticks (${fmtNum(Number((ticks / TICKS_PER_SECOND).toFixed(3)))} s)`;
  }
  if (!d.unit) return body;
  return /^[%°]/.test(d.unit) ? `${body}${d.unit}` : `${body} ${d.unit}`;
}

function makeField(bytes, dv, spec, where) {
  const type = spec.type;
  const wire = type === 'flags' ? spec.wire : type;
  const count = spec.count ?? 1;
  const size = SIZES[wire] * count;
  const offset = where.base + spec.at;          // from the section start
  const p = where.start + offset;               // in the buffer

  let value;
  if (type === 'datid') value = datIdAt(bytes, p);
  else if (type === 'rgba') value = [bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]];
  else if (count > 1) value = Array.from({ length: count }, (_, i) => readScalar(dv, wire, p + i * SIZES[wire]));
  else value = readScalar(dv, wire, p);

  const full = size >= 4 ? 0xffffffff : (1 << (8 * size)) - 1;
  const mask = spec.mask ?? null;
  if (mask != null && typeof value === 'number') value = ((value & mask) >>> (spec.shift ?? 0)) >>> 0;

  const display = {
    unit: spec.unit ?? null, scale: spec.scale ?? 1, offset: spec.offset ?? 0,
    enum: spec.enum ?? null, hex: !!spec.hex, axes: spec.axes ?? null, max: spec.max ?? null,
  };
  if (type === 'flags') {
    display.bits = spec.bits.map(([bit, label]) => {
      const single = (bit & (bit - 1)) === 0;
      const got = (value & bit) >>> 0;
      return {
        mask: bit, label, on: got !== 0,
        // A multi-bit entry is a small number packed beside the flags.
        value: single ? null : got / (bit & -bit),
        editable: !!spec.safe && ((spec.editMask ?? full) & bit) === bit,
      };
    });
  }

  const field = {
    key: where.sec === 0 ? `hdr.${spec.name}` : `s${where.sec}.${hex(where.op)}.${where.nth}.${spec.name}`,
    name: spec.name, label: spec.label, group: spec.group,
    type, wire, count, size,
    sec: where.sec, op: where.op, nth: where.nth,
    at: spec.at, offset,
    mask, shift: spec.shift ?? 0, editMask: type === 'flags' ? (spec.editMask ?? mask ?? full) : null,
    ref: spec.ref ?? null, curveGroup: spec.curveGroup ?? null,
    value, raw: hexRun(bytes, p, p + size),
    display, editable: !!spec.safe && where.layoutOk !== false,
    note: spec.note ?? null, driven: null,
  };
  field.display.text = displayText(field);
  return field;
}

/** True when `specs` cover bytes [from, to) exactly once (bit fields may share an integer). */
function tiles(specs, from, to) {
  const seen = new Uint8Array(to);
  for (const s of specs) {
    const wire = s.type === 'flags' ? s.wire : s.type;
    const size = SIZES[wire] * (s.count ?? 1);
    if (s.at < from || s.at + size > to) return false;
    for (let p = s.at; p < s.at + size; p++) {
      if (seen[p] && s.mask == null) return false;
      if (seen[p] === 1) return false;
      seen[p] = s.mask == null ? 1 : 2;
    }
  }
  for (let p = from; p < to; p++) if (!seen[p]) return false;
  return true;
}

const rawDwords = (sizeWords, note) => Array.from({ length: sizeWords - 1 }, (_, i) =>
  f(4 + i * 4, 'u32', `dw${i + 1}`, `Dword ${i + 1}`, 'Other', { hex: true, note }));

function describeOp(bytes, dv, start, sec, pos, config, nth) {
  const op = config & 0xff;
  const sizeWords = (config >>> 8) & 0x1f;
  const spec = TABLES[sec][op] ?? null;
  const where = { start, base: pos, sec, op, nth };

  let specs;
  let layoutOk = true;
  let note = spec?.note ?? null;
  if (!spec) {
    specs = rawDwords(sizeWords, null);
    note = op in PS2_ONLY[sec] ? 'Only the PS2 build handles this op; its operands are unknown.'
      : 'Unknown op: the runtime here skips it.';
  } else {
    specs = spec.fields.filter((s) => s.ifWords == null || s.ifWords === sizeWords);
    const sizes = Array.isArray(spec.dw) ? spec.dw : [spec.dw];
    layoutOk = sizes.includes(sizeWords) && tiles(specs, 4, sizeWords * 4);
    if (!layoutOk) {
      specs = rawDwords(sizeWords, null);
      note = `Declares ${sizeWords} dwords where ${sizes.join(' or ')} are expected, so it is shown raw. The runtime rejects the whole generator for this.`;
    }
  }
  where.layoutOk = layoutOk;

  return {
    sec, op, nth,
    name: spec?.name ?? PS2_ONLY[sec][op] ?? `op_${hexByte(op).toUpperCase()}`,
    offset: pos, sizeWords, config,
    // The per-particle work-memory slot; how a sec2 op finds its sec3 partner.
    alloc: config >>> 13,
    known: !!spec, layoutOk,
    slot: spec?.slot ?? null, reads: spec?.reads ?? null,
    what: spec?.what ?? null, group: spec?.group ?? spec?.curveGroup ?? null, by: spec?.by ?? null,
    fields: specs.map((s) => makeField(bytes, dv, s, where)),
    hex: hexRun(bytes, start + pos + 4, start + pos + sizeWords * 4),
    note, drives: [], curve: null,
  };
}

/** Walks one op stream the way compose does (xi_genedit.walk_stream). */
function walkStream(bytes, dv, start, end, sec) {
  const stream = { sec, name: STREAM_NAMES[sec], offset: dv.getUint32(start + STREAM_TABLE + (sec - 1) * 4, true), ops: [], overrun: null, error: null };
  const counts = new Map();
  let pos = stream.offset;
  while (pos > 0 && start + pos + 4 <= end) {
    const config = dv.getUint32(start + pos, true);
    const op = config & 0xff;
    const bytesLong = ((config >>> 8) & 0x1f) * 4;
    if (op === 0) break;
    if (bytesLong === 0) {
      // Reported, not an overrun: compose still walks the ops before it and writes their edits.
      stream.error = `sec ${sec} op ${hex(op)} at +${hex(pos, 1)} has zero size; the runtime rejects the whole generator for this`;
      break;
    }
    if (start + pos + bytesLong > end) {
      stream.overrun = `sec ${sec} op ${hex(op)} at +${hex(pos, 1)} runs past the section`;
      break;
    }
    const nth = counts.get(op) ?? 0;
    counts.set(op, nth + 1);
    stream.ops.push(describeOp(bytes, dv, start, sec, pos, config, nth));
    pos += bytesLong;
  }
  return stream;
}

/** Pairs each sec2 keyframe op with the sec3 updater that samples its slot. */
function bindSlots(streams) {
  const bySlot = new Map();
  for (const op of streams[1].ops) if (op.slot === 'curve') bySlot.set(op.alloc, op);
  for (const op of streams[2].ops) {
    if (op.reads !== 'curve') continue;
    const src = bySlot.get(op.alloc);
    if (!src) continue;
    const curve = src.fields.find((x) => x.name === 'curve');
    op.curve = { id: curve?.value ?? null, sec: 2, op: src.op, nth: src.nth, key: curve?.key ?? null };
    src.drives.push({ sec: 3, op: op.op, nth: op.nth, name: op.name, what: op.what, group: op.group, by: op.by });
  }
}

/** Marks the static operands a sec1 curve overwrites every tick. */
function markDriven(desc) {
  for (const op of desc.streams[0].ops) {
    const targets = TABLES[1][op.op]?.overwrites;
    if (!targets || !op.layoutOk) continue;
    const curve = op.fields.find((x) => x.name === 'curve')?.value ?? '';
    for (const t of targets) {
      const fields = t.sec === 0 ? desc.header
        : desc.streams[t.sec - 1].ops.filter((o) => o.op === t.op).flatMap((o) => o.fields);
      for (const field of fields) {
        if (field.name !== t.name) continue;
        field.driven = { sec: 1, op: op.op, nth: op.nth, curve, axis: t.axis ?? null };
        const axis = t.axis != null ? `${'XYZ'[t.axis]} is ` : '';
        const line = `${axis}overwritten while the generator runs by the sec1 ${hex(op.op)} curve ${curve}.`;
        field.note = field.note ? `${field.note} ${line[0].toUpperCase()}${line.slice(1)}` : `${line[0].toUpperCase()}${line.slice(1)}`;
      }
    }
  }
}

/**
 * Describes a 0x05 ParticleGenerator section from its bytes.
 * @param {Uint8Array|ArrayBuffer} buffer  the DAT (or just the section)
 * @param {number} sectionStart            where the section's 16-byte header starts
 * @param {number} [sectionSize]           its size; read from the header when omitted
 * @returns {{id, start, size, header, streams, warnings}|null} null when too short to be a generator
 */
export function describeGenerator(buffer, sectionStart = 0, sectionSize = 0) {
  const bytes = asBytes(buffer);
  const start = sectionStart | 0;
  const end = sectionEnd(bytes, start, sectionSize);
  if (end - start < HEADER_END) return null;
  const dv = viewOf(bytes);

  const where = { start, base: 0, sec: 0, op: null, nth: 0 };
  const desc = {
    id: datIdAt(bytes, start), start, size: end - start,
    header: HEADER.map((s) => makeField(bytes, dv, s, where)),
    streams: [1, 2, 3, 4].map((sec) => walkStream(bytes, dv, start, end, sec)),
    warnings: [],
  };
  for (const s of desc.streams) {
    if (s.overrun) desc.warnings.push(s.overrun);
    if (s.error) desc.warnings.push(s.error);
  }
  bindSlots(desc.streams);
  markDriven(desc);
  return desc;
}

/** Every field of a description, header first, then the streams in byte order. */
export function allFields(desc) {
  return [...desc.header, ...desc.streams.flatMap((s) => s.ops.flatMap((o) => o.fields))];
}

/**
 * Describes a 0x19 ParticleKeyFrameData section: f32 (time, value) pairs from
 * +0x10 up to and including the key at time 1 (dat/sections.js parseKeyFrame).
 */
export function describeCurve(buffer, sectionStart = 0, sectionSize = 0) {
  const bytes = asBytes(buffer);
  const start = sectionStart | 0;
  const end = sectionEnd(bytes, start, sectionSize);
  if (end - start < CURVE_KEYS_FROM + 8) return null;
  const dv = viewOf(bytes);
  const keys = [];
  let terminated = false;
  for (let p = start + CURVE_KEYS_FROM; p + 8 <= end; p += 8) {
    const time = dv.getFloat32(p, true);
    keys.push([time, dv.getFloat32(p + 4, true)]);
    if (time === 1) { terminated = true; break; }
  }
  return {
    id: datIdAt(bytes, start), start, size: end - start,
    keys, keysAt: CURVE_KEYS_FROM, terminated,
    // Bytes after the last key are padding up to the 16-byte section grid.
    padding: end - (start + CURVE_KEYS_FROM + keys.length * 8),
  };
}

// ── editing ────────────────────────────────────────────────────────────────

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const isSectionId = (v) => typeof v === 'string' && /^[\x20-\x7e]{1,4}$/.test(v) && v.trim() !== '';
const valuesOf = (edit) => (Array.isArray(edit.value) ? edit.value : [edit.value]);
const sizeOf = (type) => (INT_RANGE[type] ? SIZES[type] : 4);
const EDIT_KEYS = new Set(['sec', 'op', 'nth', 'at', 'type', 'value', 'mask']);
const EDIT_TYPES = [...Object.keys(INT_RANGE), 'f32', 'datid'];

/** An opcode as an integer or a hex string, by the rule of a recipe event's `op`. */
export function opcodeOf(v) {
  if (isInt(v)) return v >= 0 && v <= 255 ? v : null;
  if (typeof v === 'string' && /^(0x)?[0-9A-Fa-f]{1,2}$/.test(v)) return parseInt(v, 16);
  return null;
}

/** What is wrong with one EDIT on its own; empty when compose would accept it. */
export function checkEdit(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return ['must be an object'];
  const errs = Object.keys(e).filter((k) => !EDIT_KEYS.has(k)).map((k) => `unknown key '${k}'`);
  const secOk = isInt(e.sec) && e.sec >= 0 && e.sec <= 4;
  if (!secOk) errs.push('sec must be 0 (the header) or 1–4 (an op stream)');
  else if (e.sec === 0) {
    if ('op' in e || (e.nth ?? 0) !== 0) errs.push('op and nth do not apply to sec 0 (the header)');
  } else if (opcodeOf(e.op) == null) errs.push('op must be an opcode 0–255 (or hex string)');
  if ('nth' in e && !(isInt(e.nth) && e.nth >= 0)) errs.push('nth must be a non-negative integer');
  const atOk = isInt(e.at) && e.at >= 0;
  if (!atOk) errs.push('at must be a non-negative byte offset');
  const typeOk = EDIT_TYPES.includes(e.type);
  if (!typeOk) errs.push(`type must be one of ${EDIT_TYPES.join(', ')}`);
  let valueOk = 'value' in e && !(Array.isArray(e.value) && !e.value.length);
  if (!valueOk) errs.push('value is required (one value, or a non-empty list of consecutive ones)');
  else if (typeOk) {
    for (const v of valuesOf(e)) {
      if (INT_RANGE[e.type]) {
        const [lo, hi] = INT_RANGE[e.type];
        if (!(isInt(v) && v >= lo && v <= hi)) { errs.push(`value ${JSON.stringify(v)} is not a ${e.type} (${lo}..${hi})`); valueOk = false; }
      } else if (e.type === 'f32') {
        if (!(typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= F32_MAX)) { errs.push(`value ${JSON.stringify(v)} is not a finite f32`); valueOk = false; }
      } else if (!isSectionId(v)) { errs.push(`value ${JSON.stringify(v)} is not a 1–4 character section id`); valueOk = false; }
    }
  }
  if ('mask' in e) {
    if (!typeOk || !INT_RANGE[e.type]) errs.push('mask applies to integer types only');
    else if (!(isInt(e.mask) && e.mask >= 0 && e.mask <= 2 ** (8 * sizeOf(e.type)) - 1)) errs.push(`mask must fit a ${e.type}`);
  }
  if (secOk && atOk && typeOk && valueOk) {
    const to = e.at + sizeOf(e.type) * valuesOf(e).length;
    if (e.sec === 0 && !(e.at >= HEADER_FROM && to <= STREAM_TABLE)) {
      errs.push(`sec 0 writes stay inside the generator header, ${hex(HEADER_FROM)} <= at and at + size <= ${hex(STREAM_TABLE)}`);
    } else if (e.sec && e.at < 4) errs.push("at must be 4 or more: the op's config dword is not writable");
    else if (e.sec && to > MAX_OP_BYTES) errs.push(`at + size runs past the longest op (${MAX_OP_BYTES} bytes)`);
  }
  return errs;
}

/**
 * The absolute byte range [start, end) of the buffer an EDIT writes, with the
 * contract's bounds checked against this generator's own layout. Throws when
 * the edit does not fit.
 */
export function resolveEdit(desc, edit) {
  const errs = checkEdit(edit);
  if (errs.length) throw new Error(errs[0]);
  const nbytes = sizeOf(edit.type) * valuesOf(edit).length;
  const { sec, at } = edit;
  if (sec === 0) {
    if (at + nbytes > desc.size) throw new Error(`at ${hex(at)} + ${nbytes} bytes runs past the section (${desc.size} bytes)`);
    return { start: desc.start + at, end: desc.start + at + nbytes };
  }
  const stream = desc.streams[sec - 1];
  if (stream.overrun) throw new Error(stream.overrun);
  const code = opcodeOf(edit.op);
  const nth = edit.nth ?? 0;
  const found = stream.ops.filter((o) => o.op === code);
  if (nth >= found.length) {
    throw new Error(`sec ${sec} has ${found.length || 'no'} op ${hex(code)}${found.length ? `, so no nth ${nth}` : ''}`);
  }
  const op = found[nth];
  if (at + nbytes > op.sizeWords * 4) {
    throw new Error(`at ${at} + ${nbytes} bytes runs past sec ${sec} op ${hex(code)} (${op.sizeWords * 4} bytes)`);
  }
  const from = desc.start + op.offset + at;
  return { start: from, end: from + nbytes };
}

/** The four bytes a `datid` writes (xi_genedit._id_bytes). */
function idBytes(value, old, ids) {
  const name = value.replace(/ +$/, '');
  if (ids) {
    const spelt = ids.get(name);
    if (!spelt) throw new Error(`no texture, mesh, curve or sound section named '${name}' in the source DAT`);
    return spelt;
  }
  const pad = old[3] === 0x20 ? 0x20 : 0;
  const out = new Uint8Array(4).fill(pad);
  for (let i = 0; i < name.length; i++) out[i] = name.charCodeAt(i) & 0xff;
  return out;
}

/**
 * The buffer with a generator's EDITs written: same-size, little-endian,
 * absolute values, in order — byte for byte what `xi ability compose` writes.
 * Returns a patched copy; `opts.inPlace` writes into `buffer` itself.
 * `opts.ids` (see datIds) is what a `datid` may name; without it a short id is
 * padded the way the bytes it replaces are.
 */
export function applyEdits(buffer, sectionStart, edits, opts = {}) {
  const src = asBytes(buffer);
  const desc = describeGenerator(src, sectionStart, opts.sectionSize ?? 0);
  if (!desc) throw new Error('the section is too short to be a generator (no stream table at +0x80)');
  const out = opts.inPlace ? src : src.slice();
  const dv = viewOf(out);
  (edits ?? []).forEach((e, j) => {
    try {
      const { start } = resolveEdit(desc, e);
      const size = sizeOf(e.type);
      valuesOf(e).forEach((v, n) => {
        const a = start + n * size;
        if (e.type === 'datid') out.set(idBytes(v, out.subarray(a, a + 4), opts.ids ?? null), a);
        else if (e.type === 'f32') dv.setFloat32(a, v, true);
        else writeInt(dv, a, size, v, e.mask);
      });
    } catch (err) {
      throw new Error(`${opts.where ?? 'edits'}[${j}]: ${err.message}`);
    }
  });
  return out;
}

function writeInt(dv, a, size, v, mask) {
  const full = size === 4 ? 0xffffffff : (1 << (8 * size)) - 1;
  const m = (mask ?? full) >>> 0;
  const old = size === 1 ? dv.getUint8(a) : size === 2 ? dv.getUint16(a, true) : dv.getUint32(a, true);
  const next = (((old & ~m) | (v & full & m)) >>> 0);
  if (size === 1) dv.setUint8(a, next);
  else if (size === 2) dv.setUint16(a, next, true);
  else dv.setUint32(a, next, true);
}

const toF32 = (v) => Math.fround(v);

/**
 * The buffer with a 0x19 curve's keys replaced (xi_genedit.apply_curve): the
 * key count is the source's, and the last key keeps the source's time — that
 * key ends the curve, and a reader stops at it.
 */
export function applyCurve(buffer, sectionStart, keys, opts = {}) {
  const src = asBytes(buffer);
  const where = opts.where ?? 'curve';
  const have = describeCurve(src, sectionStart, opts.sectionSize ?? 0)?.keys ?? [];
  if (!Array.isArray(keys) || keys.length !== have.length) {
    throw new Error(`${where}: ${keys?.length ?? 0} keys for a curve of ${have.length} (the key count cannot change)`);
  }
  const out = opts.inPlace ? src : src.slice();
  const dv = viewOf(out);
  const last = have.length - 1;
  keys.forEach((key, k) => {
    // Exactly two numbers, as xi_genedit.check_keys wants: a longer key is refused there too.
    if (!Array.isArray(key) || key.length !== 2
        || !key.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= F32_MAX)) {
      throw new Error(`${where}: keys[${k}] must be [time, value], two finite numbers`);
    }
    const [time, value] = key;
    if (time < 0 || time > 1) throw new Error(`${where}: keys[${k}]: time must be 0..1 (a fraction of the particle's life)`);
    const t = k === last ? have[last][0] : toF32(time);
    if (k !== last && t === 1) throw new Error(`${where}: keys[${k}] has time 1, which ends the curve; only the last key may`);
    const p = (sectionStart | 0) + CURVE_KEYS_FROM + k * 8;
    dv.setFloat32(p, t, true);
    dv.setFloat32(p + 4, value, true);
  });
  return out;
}

/**
 * The EDIT that sets a field to `value` — the stored value, not the shown one
 * (see fromDisplay). `index` writes one element of a vector. A flags field
 * takes the whole integer and writes only its editable bits.
 */
export function editFor(field, value, index = null) {
  if (!field.editable) throw new Error(`${field.key} is read-only`);
  const where = field.sec === 0 ? { sec: 0 } : { sec: field.sec, op: hex(field.op), nth: field.nth };
  // An rgba channel is one byte, though the field's wire size is all four.
  const step = field.type === 'rgba' ? 1 : SIZES[field.wire];
  const at = field.at + (index != null ? index * step : 0);
  if (field.type === 'rgba') {
    return index != null ? { ...where, at, type: 'u8', value } : { ...where, at, type: 'u8', value: [...value] };
  }
  if (field.type === 'datid' || field.type === 'f32') {
    return { ...where, at, type: field.type, value: Array.isArray(value) ? [...value] : value };
  }
  if (field.type === 'flags') return { ...where, at, type: field.wire, value, mask: field.editMask };
  if (field.mask != null) {
    if (!isInt(value) || value < 0 || value > field.mask >>> field.shift) {
      throw new Error(`${field.key} holds 0..${field.mask >>> field.shift}`);
    }
    return { ...where, at, type: field.type, value: (value << field.shift) >>> 0, mask: field.mask };
  }
  return { ...where, at, type: field.type, value: Array.isArray(value) ? [...value] : value };
}

// ── who uses what ──────────────────────────────────────────────────────────

/** What a datid field names: curve, generator, mesh, sprites, sound, texture, … */
function refKind(field, op) {
  if (field.ref !== 'linked') return field.ref;
  const type = op?.fields.find((x) => x.name === 'linkedType')?.value;
  return LINKED_REF[type] ?? 'linked';
}

/** Every id a generator names: [{ kind, id, key, label, sec, op, nth }]. */
export function references(desc) {
  const out = [];
  const add = (field, op) => {
    if (field.type !== 'datid' || !field.ref || !field.value) return;
    out.push({ kind: refKind(field, op), id: field.value, key: field.key, label: field.label, sec: field.sec, op: field.op, nth: field.nth });
  };
  desc.header.forEach((x) => add(x, null));
  for (const s of desc.streams) for (const op of s.ops) op.fields.forEach((x) => add(x, op));
  return out;
}

/**
 * The generators of a DAT that name `id` — the "used by" list to show before a
 * shared curve, mesh or sprite sheet is edited. `kind` narrows it to one kind
 * of reference ('curve', 'mesh', 'sprites', 'generator', …).
 * @returns {{id, start, size, uses: {key, label, kind}[]}[]}
 */
export function generatorsUsing(buffer, id, kind = null) {
  const bytes = asBytes(buffer);
  const want = String(id ?? '').replace(/[\0 ]+$/, '');
  const out = [];
  for (const s of walkSections(bytes)) {
    if (s.type !== SEC_GENERATOR) continue;
    const desc = describeGenerator(bytes, s.start, s.size);
    if (!desc) continue;
    const uses = references(desc)
      .filter((r) => r.id === want && (!kind || r.kind === kind))
      .map((r) => ({ key: r.key, label: r.label, kind: r.kind }));
    if (uses.length) out.push({ id: desc.id, start: s.start, size: s.size, uses });
  }
  return out;
}

/** The 0x19 curves of a DAT by id (the first of a name wins, as the runtime's lookup does). */
export function curvesOf(buffer) {
  const bytes = asBytes(buffer);
  const out = new Map();
  for (const s of walkSections(bytes)) {
    if (s.type !== SEC_CURVE || out.has(s.id)) continue;
    const c = describeCurve(bytes, s.start, s.size);
    if (c) out.set(s.id, c);
  }
  return out;
}

// ── hue ────────────────────────────────────────────────────────────────────

/** Rotates the hue of an r,g,b triple on any scale (bytes, 0…1, overbright). */
export function rotateHue([r, g, b], degrees) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const c = max - min;
  if (c === 0) return [r, g, b];
  let h = max === r ? ((g - b) / c) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4;
  h = (((h * 60 + degrees) % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const [r1, g1, b1] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x]
    : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return [r1 + min, g1 + min, b1 + min];
}

// sec3 ops that set one colour channel from a curve, as R, G, B triples.
const COLOUR_TRIPLES = [
  { ops: [0x18, 0x19, 0x1a], label: 'colour' },
  { ops: [0x38, 0x39, 0x3a], label: 'specular colour' },
  { ops: [0x3c, 0x3d, 0x3e], label: 'time-of-day colour' },
  { ops: [0x4a, 0x4b, 0x4c], label: 'time-of-day specular colour' },
];

/**
 * What rotating a generator's hue by `degrees` writes.
 *
 * Plain RGBA operands (0x16, 0x17, ring, specular and tint-table colours)
 * become EDITs. A colour driven by curves is three separate 0x19 curves, one a
 * channel: they rotate key by key, which is in place only while all three have
 * the same key times — otherwise the triple is reported, not rotated. Signed
 * colour rates (0x19 / 0x1A) have no hue and are reported too.
 *
 * `curves` is the DAT's curves by id (curvesOf). Curves are shared, so check
 * generatorsUsing before applying a curve change.
 * @returns {{edits: object[], curves: {ref, keys, channel, label}[], notRotatable: {what, why}[]}}
 */
export function hueRotate(desc, degrees, curves = null) {
  const edits = [];
  const curveChanges = [];
  const notRotatable = [];
  const clampByte = (v) => Math.max(0, Math.min(255, Math.round(v)));

  for (const field of allFields(desc)) {
    if (field.type === 'rgba' && field.editable) {
      const [r, g, b, a] = field.value;
      const next = [...rotateHue([r, g, b], degrees).map(clampByte), a];
      if (next.some((v, i) => v !== field.value[i])) edits.push(editFor(field, next));
    } else if (field.type === 'i16' && field.display.axes === 'rgba' && field.value.slice(0, 3).some((v) => v !== 0)) {
      notRotatable.push({ what: `${field.key} (${field.label})`, why: 'a signed change per tick has no hue; rotate it by hand' });
    }
  }

  const sec3 = desc.streams[2].ops;
  for (const triple of COLOUR_TRIPLES) {
    const ops = triple.ops.map((code) => sec3.find((o) => o.op === code && o.curve?.id));
    const got = ops.filter(Boolean);
    if (!got.length) continue;
    const what = `${triple.label} curves ${ops.map((o) => o?.curve.id ?? '—').join(' / ')}`;
    if (got.length < 3) {
      notRotatable.push({ what, why: 'not every channel has a curve, and adding one would resize the generator' });
      continue;
    }
    const ids = ops.map((o) => o.curve.id);
    if (ids[0] === ids[1] && ids[1] === ids[2]) continue;   // one curve on all three is grey: no hue to turn
    if (new Set(ids).size < 3) {
      notRotatable.push({ what, why: 'two channels share one curve, so they cannot take different values' });
      continue;
    }
    const others = references(desc).filter((r) => r.kind === 'curve' && ids.includes(r.id)
      && !ops.some((o) => o.curve.key === r.key));
    if (others.length) {
      notRotatable.push({ what, why: `${others.map((r) => r.id).join(', ')} also drives ${others.map((r) => r.label).join(', ')} in this generator` });
      continue;
    }
    const found = ids.map((id) => (typeof curves === 'function' ? curves(id) : curves?.get(id)) ?? null);
    if (found.some((c) => !c)) {
      notRotatable.push({ what, why: curves ? 'a curve is not in this DAT' : 'the curves were not supplied' });
      continue;
    }
    const [cr, cg, cb] = found;
    const sameTimes = cr.keys.length === cg.keys.length && cr.keys.length === cb.keys.length
      && cr.keys.every(([t], k) => t === cg.keys[k][0] && t === cb.keys[k][0]);
    if (!sameTimes) {
      notRotatable.push({ what, why: 'the three curves have different key times, so rotating them would change their key counts' });
      continue;
    }
    const turned = cr.keys.map(([, r], k) => rotateHue([r, cg.keys[k][1], cb.keys[k][1]], degrees).map(toF32));
    found.forEach((c, ch) => {
      const keys = c.keys.map(([t], k) => [t, turned[k][ch]]);
      if (keys.some(([, v], k) => v !== c.keys[k][1])) {
        curveChanges.push({ ref: c.id, keys, channel: 'rgb'[ch], label: triple.label });
      }
    });
  }

  return { edits, curves: curveChanges, notRotatable };
}
