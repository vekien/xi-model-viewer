// High-poly character-creation models (DATura port, per
// HIGH_POLY_CHARACTER_MODELS_AND_ANIMATION.md). A displayed character is an
// RT/SHAPE body mesh + DMB body material + RT/SHAPE head mesh + DMB head
// material, with SQLE chunks inside the mesh DATs carrying skeleton (type 11)
// and skin clusters (type 21), and separate SQLE motion DATs holding either
// uncompressed FrameChannel v.4 clips (standing idle) or bit-packed
// PBChannel v.3 streams (the long character-creation presentation).
//
// Body and head each carry their own skeleton, but their bind poses live in
// one shared world (body bone 4 and head bone 1 land on the same point), and
// the motion roots are absolute in that same world — so assembly needs no
// attach offsets: parse both, append the skeletons, and play the matched pair.
//
// Creation meshes use the opposite vertical axis from the ordinary model path;
// Y is reflected on vertices/normals at parse and every local bone matrix is
// conjugated by the same reflection so hierarchy multiplication stays intact.

// ---------------------------------------------------------------------------
// Race / face / motion table (DATura character_creation_dat_table.h +
// kCreationSqlePairs / kCreationSqleHeadSets). Paths are game-relative.
// "Initial Equipment" bodies live two DAT indices after the no-equipment pair.
// Face A and B share the head mesh and motions; only the material differs.
//
// pbBodyEquipped: for Tarutaru/Mithra/Galka the initial-equipment body has a
// different skeleton (cloth bones), and the long PB creation sequence is
// authored for THAT skeleton while the standing idle matches the naked one —
// each animation plays on exactly one equipment variant. Hume/Elvaan bodies
// share one 299-channel skeleton across both variants, so everything pairs.
// ---------------------------------------------------------------------------

// headY: per-face vertical alignment for the head.
//
// A race's faces are NOT authored at a common height: measuring the bottom of
// each faceShape (the chin) shows Hume male faces 1/2 at -14.69 but face 3 at
// -15.35 and face 4 at -15.24, and Hume female face 1 at -13.11 against -13.66
// for its siblings. The body is shared, so a face that sits low buries its chin
// in the collar and one that sits high floats above it.
//
// These values realign each face's chin to the height most of its race's faces
// already use (measured from the DATs, not eyeballed — see the derivation in
// scratchpad/chinall2.mjs). They supersede DATura's hand-authored -0.40/-0.50
// pair, which only ever corrected the two female races and by roughly a fifth
// of the actual discrepancy.
const face = (mesh, matA, matB, base, idle, headY = 0) => ({ mesh, matA, matB, base, idle, headY });

export const CREATION_RACES = [
  {
    id: 'HumeM', label: 'Hume Male',
    bodyMesh: 'ROM/63/81.dat', bodyMat: 'ROM/63/80.dat',
    bodyBase: 'ROM/66/16.dat', bodyIdle: 'ROM/66/14.dat',
    cameras: [['ROM/66/8.dat', 'ROM/66/9.dat'], ['ROM/66/10.dat', 'ROM/66/11.dat']],
    faces: [
      face('ROM/63/85.dat', 'ROM/63/84.dat', 'ROM/63/86.dat', 'ROM/66/22.dat', 'ROM/66/20.dat'),
      face('ROM/63/89.dat', 'ROM/63/88.dat', 'ROM/63/90.dat', 'ROM/66/34.dat', 'ROM/66/32.dat'),
      face('ROM/63/93.dat', 'ROM/63/92.dat', 'ROM/63/94.dat', 'ROM/66/46.dat', 'ROM/66/44.dat', 0.653),
      face('ROM/63/97.dat', 'ROM/63/96.dat', 'ROM/63/98.dat', 'ROM/66/58.dat', 'ROM/66/56.dat', 0.546),
    ],
  },
  {
    id: 'HumeF', label: 'Hume Female',
    bodyMesh: 'ROM/63/61.dat', bodyMat: 'ROM/63/60.dat',
    bodyBase: 'ROM/65/86.dat', bodyIdle: 'ROM/65/84.dat',
    cameras: [['ROM/65/78.dat', 'ROM/65/79.dat'], ['ROM/65/80.dat', 'ROM/65/81.dat']],
    faces: [
      face('ROM/63/65.dat', 'ROM/63/64.dat', 'ROM/63/66.dat', 'ROM/65/92.dat', 'ROM/65/90.dat', -0.545),
      face('ROM/63/69.dat', 'ROM/63/68.dat', 'ROM/63/70.dat', 'ROM/65/104.dat', 'ROM/65/102.dat'),
      face('ROM/63/73.dat', 'ROM/63/72.dat', 'ROM/63/74.dat', 'ROM/65/116.dat', 'ROM/65/114.dat'),
      face('ROM/63/77.dat', 'ROM/63/76.dat', 'ROM/63/78.dat', 'ROM/66/0.dat', 'ROM/65/126.dat'),
    ],
  },
  {
    id: 'ElvaanM', label: 'Elvaan Male',
    bodyMesh: 'ROM/63/21.dat', bodyMat: 'ROM/63/20.dat',
    bodyBase: 'ROM/64/98.dat', bodyIdle: 'ROM/64/96.dat',
    cameras: [['ROM/64/90.dat', 'ROM/64/91.dat'], ['ROM/64/92.dat', 'ROM/64/93.dat']],
    faces: [
      face('ROM/63/25.dat', 'ROM/63/24.dat', 'ROM/63/26.dat', 'ROM/64/104.dat', 'ROM/64/102.dat'),
      face('ROM/63/29.dat', 'ROM/63/28.dat', 'ROM/63/30.dat', 'ROM/64/116.dat', 'ROM/64/114.dat'),
      face('ROM/63/33.dat', 'ROM/63/32.dat', 'ROM/63/34.dat', 'ROM/65/0.dat', 'ROM/64/126.dat'),
      face('ROM/63/37.dat', 'ROM/63/36.dat', 'ROM/63/38.dat', 'ROM/65/12.dat', 'ROM/65/10.dat', -0.842),
    ],
  },
  {
    id: 'ElvaanF', label: 'Elvaan Female',
    bodyMesh: 'ROM/63/1.dat', bodyMat: 'ROM/63/0.dat',
    bodyBase: 'ROM/64/40.dat', bodyIdle: 'ROM/64/38.dat',
    cameras: [['ROM/64/32.dat', 'ROM/64/33.dat'], ['ROM/64/34.dat', 'ROM/64/35.dat']],
    faces: [
      face('ROM/63/5.dat', 'ROM/63/4.dat', 'ROM/63/6.dat', 'ROM/64/46.dat', 'ROM/64/44.dat', -0.645),
      face('ROM/63/9.dat', 'ROM/63/8.dat', 'ROM/63/10.dat', 'ROM/64/58.dat', 'ROM/64/56.dat'),
      face('ROM/63/13.dat', 'ROM/63/12.dat', 'ROM/63/14.dat', 'ROM/64/52.dat', 'ROM/64/50.dat', -0.645),
      face('ROM/63/17.dat', 'ROM/63/16.dat', 'ROM/63/18.dat', 'ROM/64/82.dat', 'ROM/64/80.dat'),
    ],
  },
  {
    id: 'TaruM', label: 'Tarutaru Male', pbBodyEquipped: true,
    bodyMesh: 'ROM/64/13.dat', bodyMat: 'ROM/64/12.dat',
    // The capture shows Tarutaru male plays 67/58, not 67/4 — the doc had it
    // sharing Tarutaru FEMALE's body clip, which is why its head never matched
    // (1315 body frames against 1624 head). 67/58 is 1624, an exact pair.
    // bodyBase stays 67/4 because the short Motion clips hang off it.
    seqBody: 'ROM/67/58.dat',
    bodyBase: 'ROM/67/4.dat', bodyIdle: 'ROM/67/2.dat',
    cameras: [['ROM/67/54.dat', 'ROM/67/55.dat'], ['ROM/67/56.dat', 'ROM/67/57.dat']],
    faces: [
      face('ROM/64/17.dat', 'ROM/64/16.dat', 'ROM/64/18.dat', 'ROM/67/64.dat', 'ROM/67/62.dat', -0.069),
      face('ROM/64/21.dat', 'ROM/64/20.dat', 'ROM/64/22.dat', 'ROM/67/76.dat', 'ROM/67/74.dat'),
      face('ROM/64/25.dat', 'ROM/64/24.dat', 'ROM/64/26.dat', 'ROM/67/88.dat', 'ROM/67/86.dat', -0.069),
      face('ROM/64/29.dat', 'ROM/64/28.dat', 'ROM/64/30.dat', 'ROM/67/100.dat', 'ROM/67/98.dat'),
    ],
  },
  {
    id: 'TaruF', label: 'Tarutaru Female', pbBodyEquipped: true,
    bodyMesh: 'ROM/63/121.dat', bodyMat: 'ROM/63/120.dat',
    bodyBase: 'ROM/67/4.dat', bodyIdle: 'ROM/67/2.dat',
    cameras: [['ROM/66/124.dat', 'ROM/66/125.dat'], ['ROM/66/126.dat', 'ROM/66/127.dat']],
    faces: [
      face('ROM/63/125.dat', 'ROM/63/124.dat', 'ROM/63/126.dat', 'ROM/67/10.dat', 'ROM/67/8.dat'),
      face('ROM/64/1.dat', 'ROM/64/0.dat', 'ROM/64/2.dat', 'ROM/67/22.dat', 'ROM/67/20.dat'),
      face('ROM/64/5.dat', 'ROM/64/4.dat', 'ROM/64/6.dat', 'ROM/67/34.dat', 'ROM/67/32.dat'),
      face('ROM/64/9.dat', 'ROM/64/8.dat', 'ROM/64/10.dat', 'ROM/67/46.dat', 'ROM/67/44.dat'),
    ],
  },
  {
    id: 'Mithra', label: 'Mithra', pbBodyEquipped: true,
    bodyMesh: 'ROM/63/101.dat', bodyMat: 'ROM/63/100.dat',
    bodyBase: 'ROM/66/74.dat', bodyIdle: 'ROM/66/72.dat',
    cameras: [['ROM/66/66.dat', 'ROM/66/67.dat'], ['ROM/66/68.dat', 'ROM/66/69.dat']],
    faces: [
      face('ROM/63/105.dat', 'ROM/63/104.dat', 'ROM/63/106.dat', 'ROM/66/80.dat', 'ROM/66/78.dat'),
      face('ROM/63/109.dat', 'ROM/63/108.dat', 'ROM/63/110.dat', 'ROM/66/92.dat', 'ROM/66/90.dat'),
      face('ROM/63/113.dat', 'ROM/63/112.dat', 'ROM/63/114.dat', 'ROM/66/104.dat', 'ROM/66/102.dat'),
      face('ROM/63/117.dat', 'ROM/63/116.dat', 'ROM/63/118.dat', 'ROM/66/116.dat', 'ROM/66/114.dat'),
    ],
  },
  {
    id: 'Galka', label: 'Galka', pbBodyEquipped: true,
    bodyMesh: 'ROM/63/41.dat', bodyMat: 'ROM/63/40.dat',
    bodyBase: 'ROM/65/28.dat', bodyIdle: 'ROM/65/26.dat',
    cameras: [['ROM/65/20.dat', 'ROM/65/21.dat'], ['ROM/65/22.dat', 'ROM/65/23.dat']],
    faces: [
      face('ROM/63/45.dat', 'ROM/63/44.dat', 'ROM/63/46.dat', 'ROM/65/34.dat', 'ROM/65/32.dat'),
      face('ROM/63/49.dat', 'ROM/63/48.dat', 'ROM/63/50.dat', 'ROM/65/40.dat', 'ROM/65/38.dat'),
      face('ROM/63/53.dat', 'ROM/63/52.dat', 'ROM/63/54.dat', 'ROM/65/46.dat', 'ROM/65/44.dat'),
      face('ROM/63/57.dat', 'ROM/63/56.dat', 'ROM/63/58.dat', 'ROM/65/52.dat', 'ROM/65/50.dat'),
    ],
  },
];

/** "ROM/63/81.dat" + 2 -> "ROM/63/83.dat" (initial-equipment body derivation). */
export function bumpDatIndex(rel, by) {
  return rel.replace(/\/(\d+)\.dat$/i, (_, n) => `/${+n + by}.dat`);
}

/**
 * Every race stores a CLUSTER of motions, not the three the doc names. Body
 * clip B pairs with head clip B+6 at the same offset from the long sequence,
 * and each pair shares a frame count — verified across all eight races:
 *
 *   -4  short   (0.6-0.9s)      -1  short   (0.9-1.3s)
 *   -3  short   (0.6-0.7s)       0  the long PB sequence (41-100s)
 *   -2  the standing idle (2-3s)
 *
 * The doc exposed only -4, -2 and 0, which left the liveliest clips (-3, -1)
 * unreachable — they are FrameChannel, the encoding that always played
 * correctly, and they animate far more of the skeleton than the long sequence
 * does (which holds the arms still for its whole duration).
 */
export const CREATION_CLIPS = [
  { id: 'm1', offset: -4, label: 'Motion 1' },
  { id: 'm2', offset: -3, label: 'Motion 2' },
  { id: 'idle', offset: -2, label: 'Standing idle' },
  { id: 'm3', offset: -1, label: 'Motion 3' },
  // Incomplete on purpose: the retail screen runs this pose track underneath a
  // frame-indexed event track (the "OC:01.00" DAT) that fires ~50-130 actions
  // from a per-race action table. Without that layer this plays as a stiff,
  // near-static performance. The four clips above are complete and correct.
  { id: 'seq', offset: 0, label: 'Creation sequence (incomplete)' },
];

/**
 * The retail client also loads FOUR companion tracks alongside the long
 * sequence — confirmed by a Process Monitor capture of character creation,
 * which for Hume male opens 66/8, 66/9, 66/10, 66/11, 66/16, 66/17 plus the
 * head pair. They sit at fixed offsets from the body sequence:
 *
 *   -8 : 1 channel, constant  -> camera A field of view (37.85 degrees)
 *   -7 : 16 channels          -> camera A world matrix, one per frame
 *   -6 : 1 channel, constant  -> camera B field of view
 *   -5 : 16 channels          -> camera B world matrix
 *
 * 16 floats per frame is a 4x4: the last row is exactly (0,0,0,1), the 3x3 is
 * orthonormal and the translation sits in the last column. The cameras sweep
 * a long way (camera A's position spans ~130 units in Z), which is where most
 * of the apparent movement in the real creation screen comes from — the body
 * track itself only rotates ~30 degrees.
 */
/**
 * Camera DAT paths for a race. These are listed explicitly rather than derived
 * by offset: the capture shows -8..-5 from the body sequence for seven races
 * but -4..-1 for Tarutaru male, so arithmetic finds the wrong files there.
 */
export function creationCameraPaths(race) {
  if (!race?.cameras) return [];
  return race.cameras.map((c, i) => ({ label: `Camera ${i + 1}`, fov: c[0], matrix: c[1] }));
}

/** The body motion the creation screen actually plays for this race. */
export function creationSequenceBody(race) {
  return race?.seqBody ?? race?.bodyBase;
}

/**
 * Build a per-frame camera track from the decoded fov + matrix motions.
 * Returns { fovDegrees, frameCount, eye(frame), forward(frame) } in the same
 * Y-reflected space the creation meshes are built in, so it lines up with the
 * model without any further conversion.
 */
export function buildCreationCamera(fovMotion, matrixMotion) {
  if (!matrixMotion?.values || matrixMotion.channelCount !== 16) return null;
  const { values, frameCount } = matrixMotion;
  const fovDegrees = fovMotion?.values?.[0] > 1 ? fovMotion.values[0] : 37.85;
  const at = (frame) => {
    const f = Math.min(Math.max(Math.round(frame), 0), frameCount - 1);
    const o = f * 16;
    // Row-major 4x4, translation in the last column.
    const m = values.subarray(o, o + 16);
    // Same Y reflection the meshes get: p -> (x, -y, z), basis conjugated.
    const eye = [m[3], -m[7], m[11]];
    // Camera looks down its local -Z (the row-2 basis vector), reflected.
    const fwd = [-m[2], m[6], -m[10]];
    const len = Math.hypot(...fwd) || 1;
    return { eye, forward: [fwd[0] / len, fwd[1] / len, fwd[2] / len] };
  };
  return { fovDegrees, frameCount, at };
}

/**
 * The "OC:01.00" cue track that the creation screen loads next to each
 * sequence. Fully decoded:
 *
 *   0x00  "OC:0" "1.00"
 *   0x08  u32 1, u32 -1, u32 6, u32 6, u32 -1
 *   0x1c  u32 record count
 *   0x28  records: [u32 frame][u32 actionId][u32 0]
 *
 * Frames are monotonic within the count and land inside the sequence; anything
 * past the count is padding. actionId indexes the per-race action table
 * (the "rthu"/"rtga" DAT), whose entries are numbered 4001+ for Hume male,
 * 0001+ for Galka, 8001+ for Tarutaru male.
 *
 * NOT yet decoded: the action bodies themselves, which are a variable-length
 * bytecode. Until that is cracked this parser is informational only.
 */
export function parseCreationCues(buf) {
  const u8 = new Uint8Array(buf);
  const d = new DataView(buf);
  if (u8.length < 40 || asciiAt(u8, 0, 4) !== 'OC:0') return null;
  const count = u32(d, 0x1c);
  if (!count || 40 + count * 12 > u8.length) return null;
  const events = [];
  for (let i = 0; i < count; i++) {
    const o = 40 + i * 12;
    events.push({ frame: u32(d, o), action: u32(d, o + 4) });
  }
  return { events };
}

/** Resolve a clip id to its body/head motion DATs for a race + face. */
export function creationClipPaths(race, face, clipId) {
  const clip = CREATION_CLIPS.find((c) => c.id === clipId);
  if (!clip || !race || !face) return null;
  // The sequence uses the retail-confirmed pair; the short clips hang off the
  // cluster base (which is not always the same file — see TaruM's seqBody).
  if (clip.offset === 0) {
    return { body: creationSequenceBody(race), head: face.base, equippedBody: !!race.pbBodyEquipped };
  }
  return {
    body: bumpDatIndex(race.bodyBase, clip.offset),
    head: bumpDatIndex(face.base, clip.offset),
    // Only the long sequence is authored against the equipped-body skeleton on
    // the races whose two body variants differ (see pbBodyEquipped).
    equippedBody: clip.offset === 0 && !!race.pbBodyEquipped,
  };
}

// ---------------------------------------------------------------------------
// Binary helpers
// ---------------------------------------------------------------------------

const i32 = (d, o) => (o >= 0 && o + 4 <= d.byteLength ? d.getInt32(o, true) : 0);
const u32 = (d, o) => (o >= 0 && o + 4 <= d.byteLength ? d.getUint32(o, true) : 0);
const f32 = (d, o) => (o >= 0 && o + 4 <= d.byteLength ? d.getFloat32(o, true) : 0);

function asciiAt(u8, ofs, len) {
  let s = '';
  const end = Math.min(ofs + len, u8.length);
  for (let i = ofs; i < end; i++) {
    const b = u8[i];
    s += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '\0';
  }
  return s;
}

// ---------------------------------------------------------------------------
// 3x4 matrices, row-vector convention: p' = p·M + T, world = local · parentWorld.
// Flat Float32Array(12): rows 0..2 are the basis rows, row 3 the translation.
// ---------------------------------------------------------------------------

/** rows = columns of the standard quaternion rotation matrix (row-vector form),
 *  each row pre-scaled by its axis scale (scale applies before rotation). */
function quatScaleTransToMat(q, s, t, out) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, yy = y * y2, zz = z * z2;
  const xy = x * y2, xz = x * z2, yz = y * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = (1 - yy - zz) * s[0]; out[1] = (xy + wz) * s[0]; out[2] = (xz - wy) * s[0];
  out[3] = (xy - wz) * s[1]; out[4] = (1 - xx - zz) * s[1]; out[5] = (yz + wx) * s[1];
  out[6] = (xz + wy) * s[2]; out[7] = (yz - wx) * s[2]; out[8] = (1 - xx - yy) * s[2];
  out[9] = t[0]; out[10] = t[1]; out[11] = t[2];
}

/** Conjugate by the creation Y reflection: m[r][c] *= s[r]*s[c], T *= s. */
function reflectY(m) {
  // signs (1,-1,1): flips sign wherever exactly one of row/col is Y.
  m[1] = -m[1]; m[3] = -m[3];
  m[5] = -m[5]; m[7] = -m[7];
  m[10] = -m[10];
}

/** c = a · b (apply a, then b). */
function mul43(a, b, c) {
  for (let r = 0; r < 4; r++) {
    const o = r * 3;
    const x = a[o], y = a[o + 1], z = a[o + 2];
    c[o] = x * b[0] + y * b[3] + z * b[6];
    c[o + 1] = x * b[1] + y * b[4] + z * b[7];
    c[o + 2] = x * b[2] + y * b[5] + z * b[8];
  }
  c[9] += b[9]; c[10] += b[10]; c[11] += b[11];
}

/** General affine inverse of a 3x4 (bind matrices can carry scale). */
function invert43(m, out) {
  const a = m[0], b = m[1], c = m[2];
  const d = m[3], e = m[4], f = m[5];
  const g = m[6], h = m[7], i = m[8];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C || 1e-12;
  const r = 1 / det;
  // inverse of the 3x3 block (row-vector: same adjugate-transpose dance)
  out[0] = A * r; out[3] = B * r; out[6] = C * r;
  out[1] = (c * h - b * i) * r; out[4] = (a * i - c * g) * r; out[7] = (b * g - a * h) * r;
  out[2] = (b * f - c * e) * r; out[5] = (c * d - a * f) * r; out[8] = (a * e - b * d) * r;
  const tx = m[9], ty = m[10], tz = m[11];
  out[9] = -(tx * out[0] + ty * out[3] + tz * out[6]);
  out[10] = -(tx * out[1] + ty * out[4] + tz * out[7]);
  out[11] = -(tx * out[2] + ty * out[5] + tz * out[8]);
}

const xformPoint = (m, x, y, z) => [
  x * m[0] + y * m[3] + z * m[6] + m[9],
  x * m[1] + y * m[4] + z * m[7] + m[10],
  x * m[2] + y * m[5] + z * m[8] + m[11],
];

const xformNormal = (m, x, y, z) => [
  x * m[0] + y * m[3] + z * m[6],
  x * m[1] + y * m[4] + z * m[7],
  x * m[2] + y * m[5] + z * m[8],
];

// ---------------------------------------------------------------------------
// RT/SHAPE geometry
// ---------------------------------------------------------------------------

function isShapeBlock(u8, d, ofs) {
  if (ofs < 0 || ofs + 0x60 > u8.length) return false;
  if (i32(d, ofs) !== 4) return false;
  if (u8[ofs + 8] !== 0x52 || u8[ofs + 9] !== 0x54) return false;   // "RT"
  return findShapeText(u8, ofs) >= 0;
}

function findShapeText(u8, shapeOfs) {
  const end = Math.min(shapeOfs + 256, u8.length - 6);
  for (let o = shapeOfs; o < end; o++) {
    if (u8[o] === 0x53 && u8[o + 1] === 0x48 && u8[o + 2] === 0x41
      && u8[o + 3] === 0x50 && u8[o + 4] === 0x45 && u8[o + 5] === 0x3a) return o;   // "SHAPE:"
  }
  return -1;
}

/** Parse every shape in a creation mesh DAT. Y is reflected here (verts and
 *  normals) so the model lands in the ordinary Y-down entity convention. */
function parseShapes(buf) {
  const u8 = new Uint8Array(buf);
  const d = new DataView(buf);
  const shapes = [];
  let shapeOfs = 0;
  while (shapeOfs + 0x60 < u8.length && isShapeBlock(u8, d, shapeOfs)) {
    const shape = parseShape(u8, d, shapeOfs);
    if (shape) shapes.push(shape);
    const blockSize = i32(d, shapeOfs + 4);
    // Next block starts a little past the declared size, 4-aligned.
    const rawEnd = shapeOfs + blockSize;
    let next = -1;
    const searchEnd = Math.min(rawEnd + 0x90, u8.length - 0x60);
    for (let o = (rawEnd + 0x20 + 3) & ~3; o <= searchEnd; o += 4) {
      if (isShapeBlock(u8, d, o)) { next = o; break; }
    }
    if (next <= shapeOfs) break;
    shapeOfs = next;
  }
  return shapes;
}

function parseShape(u8, d, shapeOfs) {
  const textOfs = findShapeText(u8, shapeOfs);
  if (textOfs < 0) return null;
  let textEnd = textOfs;
  while (textEnd < u8.length && u8[textEnd] !== 0) textEnd++;
  const text = asciiAt(u8, textOfs, textEnd - textOfs);
  const m = text.match(/SHAPE: TriStrip ver\.2, (\d+) tris, (\d+) codes, (\d+) verts/);
  if (!m) return null;
  const codeCount = +m[2];
  const vertCount = +m[3];
  if (vertCount <= 0 || codeCount <= 0) return null;

  // Position header: [vertCount, 3, ?, 3] within 128 bytes of the text end.
  let posHdr = -1;
  const searchStart = (textEnd + 3) & ~3;
  for (let o = searchStart; o <= Math.min(searchStart + 128, u8.length - 16); o += 4) {
    if (i32(d, o) === vertCount && i32(d, o + 4) === 3 && i32(d, o + 12) === 3) { posHdr = o; break; }
  }
  if (posHdr < 0) return null;

  const posOfs = posHdr + 16;
  const normalOfs = posOfs + vertCount * 12 + 8;
  const uvOfs = normalOfs + vertCount * 12 + 8;
  let codesOfs = uvOfs + vertCount * 8;
  if (codesOfs + 4 > u8.length) return null;
  if (i32(d, codesOfs) === codeCount) codesOfs += 4;
  if (codesOfs + codeCount * 4 > u8.length) return null;

  const pos = new Float32Array(vertCount * 3);
  const nrm = new Float32Array(vertCount * 3);
  const uv = new Float32Array(vertCount * 2);
  for (let v = 0; v < vertCount; v++) {
    pos[v * 3] = f32(d, posOfs + v * 12);
    pos[v * 3 + 1] = -f32(d, posOfs + v * 12 + 4);
    pos[v * 3 + 2] = f32(d, posOfs + v * 12 + 8);
    nrm[v * 3] = f32(d, normalOfs + v * 12);
    nrm[v * 3 + 1] = -f32(d, normalOfs + v * 12 + 4);
    nrm[v * 3 + 2] = f32(d, normalOfs + v * 12 + 8);
    uv[v * 2] = f32(d, uvOfs + v * 8);
    uv[v * 2 + 1] = f32(d, uvOfs + v * 8 + 4);
  }

  // Mixed draw-code stream: a negative command starts a strip of |cmd| vertex
  // indices; a non-negative multiple of three can introduce an explicit
  // triangle list; other non-negative values are state selectors and skipped.
  // Everything is emitted as plain triangles (winding is irrelevant — the
  // entity pass draws two-sided).
  const tris = [];
  for (let ci = 0; ci < codeCount;) {
    const cmd = i32(d, codesOfs + ci * 4);
    ci++;
    if (cmd >= 0) {
      if (cmd >= 3 && cmd % 3 === 0 && ci + cmd <= codeCount) {
        let valid = true;
        for (let k = 0; k < cmd; k++) {
          const vi = i32(d, codesOfs + (ci + k) * 4);
          if (vi < 0 || vi >= vertCount) { valid = false; break; }
        }
        if (valid) {
          for (let k = 0; k < cmd; k++) tris.push(i32(d, codesOfs + (ci + k) * 4));
          ci += cmd;
        }
      }
      continue;
    }
    const stripLen = -cmd;
    if (stripLen < 3 || ci + stripLen > codeCount) break;
    const strip = [];
    for (let k = 0; k < stripLen; k++, ci++) {
      const vi = i32(d, codesOfs + ci * 4);
      if (vi >= 0 && vi < vertCount) strip.push(vi);
    }
    for (let k = 2; k < strip.length; k++) tris.push(strip[k - 2], strip[k - 1], strip[k]);
  }
  if (tris.length < 3) return null;
  return { vertCount, pos, nrm, uv, tris: new Uint32Array(tris) };
}

// ---------------------------------------------------------------------------
// SQLE chunks in mesh DATs: type 11 = skeleton, type 21 = skin clusters
// ---------------------------------------------------------------------------

function findSqleChunks(buf) {
  const u8 = new Uint8Array(buf);
  const d = new DataView(buf);
  const out = [];
  for (let ofs = 0; ofs + 104 <= u8.length; ofs += 16) {
    if (u8[ofs] === 0x53 && u8[ofs + 1] === 0x51 && u8[ofs + 2] === 0x4c && u8[ofs + 3] === 0x45) {
      out.push({ ofs, type: d.getUint16(ofs + 10, true) });
    }
  }
  return out;
}

/** 64-byte bone records: bind TRS, five channel-group counts, parent index. */
function parseSqleSkeleton(buf) {
  const d = new DataView(buf);
  const chunk = findSqleChunks(buf).find((c) => c.type === 11);
  if (!chunk) return null;
  const boneCount = i32(d, chunk.ofs + 96);
  if (boneCount <= 0 || boneCount > 1024) return null;
  const rec = chunk.ofs + 100;
  if (rec + boneCount * 64 > buf.byteLength) return null;
  const bones = [];
  for (let b = 0; b < boneCount; b++) {
    const o = rec + b * 64;
    bones.push({
      trans: [f32(d, o), f32(d, o + 4), f32(d, o + 8)],
      quat: [f32(d, o + 12), f32(d, o + 16), f32(d, o + 20), f32(d, o + 24)],
      scale: [f32(d, o + 28), f32(d, o + 32), f32(d, o + 36)],
      counts: [i32(d, o + 40), i32(d, o + 44), i32(d, o + 48), i32(d, o + 52), i32(d, o + 56)],
      parent: i32(d, o + 60),
    });
  }
  return bones;
}

/**
 * Type-21 skin chunks, one per shape in file order. The declared vertex count
 * at +100 is unreliable (a 933-vert shape can declare 510), so the per-vertex
 * table is sized from the highest vertex index actually referenced.
 * Returns [shape][vertexIndex] -> [{bone, weight}].
 */
function parseSqleSkins(buf) {
  const d = new DataView(buf);
  const skins = [];
  for (const chunk of findSqleChunks(buf)) {
    if (chunk.type !== 21) continue;
    const clusterCount = i32(d, chunk.ofs + 96);
    const declared = i32(d, chunk.ofs + 100);
    if (clusterCount <= 0 || clusterCount > 1024 || declared <= 0 || declared > 1000000) continue;
    const clusters = [];
    let cursor = chunk.ofs + 104;
    let valid = true;
    let maxVert = -1;
    for (let c = 0; c < clusterCount; c++) {
      if (cursor + 8 > buf.byteLength) { valid = false; break; }
      const bone = i32(d, cursor);
      const count = i32(d, cursor + 4);
      cursor += 8;
      if (bone < 0 || count < 0 || count > 1000000 || cursor + count * 8 > buf.byteLength) { valid = false; break; }
      const idxOfs = cursor;
      const wOfs = cursor + count * 4;
      const entries = [];
      for (let k = 0; k < count; k++) {
        const vi = i32(d, idxOfs + k * 4);
        const w = f32(d, wOfs + k * 4);
        if (vi >= 0 && w > 0) { entries.push([vi, w]); if (vi > maxVert) maxVert = vi; }
      }
      clusters.push({ bone, entries });
      cursor += count * 8;
    }
    if (!valid) continue;
    const skin = Array.from({ length: maxVert + 1 }, () => []);
    for (const cl of clusters) {
      for (const [vi, w] of cl.entries) skin[vi].push({ bone: cl.bone, weight: w });
    }
    skins.push(skin);
  }
  return skins;
}

// ---------------------------------------------------------------------------
// DMB material / texture
// ---------------------------------------------------------------------------

function findDmbTextureBlock(u8, d) {
  if (u8.length < 0x100 || u8[0] !== 0x44 || u8[1] !== 0x4d || u8[2] !== 0x42 || u8[3] !== 0) return -1;
  let best = -1;
  let bestScore = -1;
  for (let ofs = 0x20; ofs + 0x460 < u8.length; ofs += 16) {
    const w = i32(d, ofs + 0x40);
    const h = i32(d, ofs + 0x44);
    const bpp = i32(d, ofs + 0x48);
    if (w < 16 || h < 16 || w > 2048 || h > 2048) continue;
    if (bpp !== 3 && bpp !== 4) continue;
    if (ofs + 0x60 + w * h * bpp > u8.length) continue;
    // Score = area + average brightness of a sample window, biggest wins —
    // DMB carries several plausible blocks and the real diffuse is the large
    // bright one.
    const pix = ofs + 0x60;
    const n = Math.min(w * h, 4096);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const p = pix + i * bpp;
      sum += u8[p] + u8[p + 1] + u8[p + 2];
    }
    const score = w * h + (n ? (sum / n) | 0 : 0);
    if (score > bestScore) { bestScore = score; best = ofs; }
  }
  return best;
}

/**
 * Per-shape material flags from the DMB's embedded names: geometry shapes are
 * "...shape.sqo" strings in shape order; a matching "<name>Shape_sort" entry
 * (or the literal alphaShape) marks it alpha-tested; the Hume male strapShape
 * needs the hard black color-key instead.
 */
function dmbShapeFlags(buf) {
  const u8 = new Uint8Array(buf);
  const sorted = [];
  const geometry = [];
  for (let ofs = 0; ofs < u8.length;) {
    if (u8[ofs] < 0x20 || u8[ofs] > 0x7e) { ofs++; continue; }
    const start = ofs;
    while (ofs < u8.length && u8[ofs] >= 0x20 && u8[ofs] <= 0x7e) ofs++;
    if (ofs >= u8.length || u8[ofs] !== 0 || ofs - start < 4) continue;
    let s = asciiAt(u8, start, ofs - start);
    const lower = s.toLowerCase();
    if (lower.endsWith('shape_sort')) {
      s = s.slice(0, -'_sort'.length);
      let i = s.length;
      while (i > 0 && /[A-Za-z0-9_]/.test(s[i - 1])) i--;
      sorted.push(s.slice(i).toLowerCase());
    } else if (lower.endsWith('shape.sqo')) {
      const slash = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\'));
      geometry.push(lower.slice(slash + 1, -'.sqo'.length));
    }
    ofs++;
  }
  return geometry.map((name) => ({
    alpha: sorted.includes(name) || name === 'alphashape',
    blackKey: name === 'strapshape',
  }));
}

/**
 * Decode the DMB diffuse into the up-to-three RGBA variants a creation piece
 * can bind: opaque (alpha forced solid), alpha-tested (DXT3-style nibble
 * expanded), and black-key (the body's exact black zero-alpha color key
 * punched out). Stored alpha is halved because the entity shader computes
 * 4 * vertexAlpha(0.5) * texAlpha — storing expanded/2 makes the shader's 0.5
 * opaque-pass threshold land exactly on DATura's alpha-test threshold.
 */
function buildDmbTextures(buf, prefix, isBody) {
  const u8 = new Uint8Array(buf);
  const d = new DataView(buf);
  const block = findDmbTextureBlock(u8, d);
  if (block < 0) return null;
  const w = i32(d, block + 0x40);
  const h = i32(d, block + 0x44);
  const bpp = i32(d, block + 0x48);
  const pix = block + 0x60;

  // Body color key: solid 3x3 patches of exact black with zero alpha, dilated
  // 2px so DXT3 edge dithering doesn't leave a dark rim. (Values below 16
  // collapse to the transparent zero nibble when encoded as DXT3.)
  let key = null;
  if (isBody && bpp > 3) {
    key = new Uint8Array(w * h);
    const isKeyPixel = (x, y) => {
      const p = pix + (y * w + x) * bpp;
      return u8[p + 3] < 16 && u8[p] <= 16 && u8[p + 1] <= 16 && u8[p + 2] <= 16;
    };
    const cores = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let solid = true;
        for (let py = y - 1; py <= y + 1 && solid; py++) {
          for (let px = x - 1; px <= x + 1; px++) {
            if (!isKeyPixel(px, py)) { solid = false; break; }
          }
        }
        if (solid) cores[y * w + x] = 1;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!isKeyPixel(x, y)) continue;
        outer:
        for (let py = Math.max(0, y - 2); py <= Math.min(h - 1, y + 2); py++) {
          for (let px = Math.max(0, x - 2); px <= Math.min(w - 1, x + 2); px++) {
            if (cores[py * w + px]) { key[y * w + x] = 1; break outer; }
          }
        }
      }
    }
  }

  const opaque = new Uint8Array(w * h * 4);
  const alpha = new Uint8Array(w * h * 4);
  const black = key ? new Uint8Array(w * h * 4) : null;
  for (let i = 0; i < w * h; i++) {
    const p = pix + i * bpp;
    // Straight RGB(A) — the doc's "BGR order" claim renders blue skin here.
    const r = u8[p], g = u8[p + 1], b = u8[p + 2];
    const o = i * 4;
    opaque[o] = r; opaque[o + 1] = g; opaque[o + 2] = b; opaque[o + 3] = 255;
    alpha[o] = r; alpha[o + 1] = g; alpha[o + 2] = b;
    // FFXI authors opacity in the lower half of the 4-bit range: expand the
    // nibble by ~1.875 before testing (nibble 8 = fully opaque).
    alpha[o + 3] = bpp > 3 ? Math.min(255, (u8[p + 3] >> 4) * 32) >> 1 : 128;
    if (black) {
      black[o] = r; black[o + 1] = g; black[o + 2] = b;
      black[o + 3] = key[i] ? 0 : 128;
    }
  }

  const tex = (suffix, data) => ({ name: `${prefix}_${suffix}`, width: w, height: h, format: 'rgba32', data });
  return {
    opaque: tex('op', opaque),
    alpha: tex('al', alpha),
    blackKey: black ? tex('bk', black) : null,
  };
}

// ---------------------------------------------------------------------------
// SQLE motion decode (FrameChannel v.4 / PBChannel v.3)
// ---------------------------------------------------------------------------

/**
 * Decode a motion DAT into frame-major scalar values:
 * value(frame, ch) = values[frame * channelCount + ch]. FrameChannel stores
 * plain floats as the file tail (exactly frameCount * channelCount — the
 * control words before them are NOT frame data). PBChannel stores per-channel
 * quantized bit streams of frameCount-1 samples; the final frame duplicates
 * frame zero so playback loops cleanly.
 */
export function parseSqleMotion(buf) {
  const u8 = new Uint8Array(buf);
  const d = new DataView(buf);
  if (u8.length < 0x74 || asciiAt(u8, 0, 4) !== 'SQLE') return null;
  const header = asciiAt(u8, 0, Math.min(200, u8.length)).replace(/\0/g, ' ');
  const m = header.match(/MOTION: ([^,]+), time=([\d.eE+-]+), size=(\d+), frames=(\d+)/);
  if (!m) return null;
  const kind = m[1].includes('PBChannel') ? 'pb' : m[1].includes('FrameChannel') ? 'frame' : null;
  const duration = parseFloat(m[2]);
  const channelCount = +m[3];
  const frameCount = +m[4];
  if (!kind || channelCount <= 0 || frameCount <= 0) return null;

  // FFXI runs these at a flat 30fps; the header's declared time is not the
  // playback rate. A PBChannel header states time = (frames-1)/30 (derives
  // 30.01) but a FrameChannel one states time = (frames-2)/60, which derives
  // ~61 and ran the walk and run clips at double speed. Pinning the rate also
  // stops it drifting per clip (Mithra's derived 31.2, others 30.5).
  const fps = 30;
  const info = {
    kind, channelCount, frameCount, fps,
    duration: frameCount / fps,
    values: null,
    headerDuration: duration,   // what the file claims, kept for reference
  };

  if (kind === 'frame') {
    const byteCount = frameCount * channelCount * 4;
    if (byteCount > u8.length) return null;
    const start = u8.length - byteCount;
    info.values = new Float32Array(frameCount * channelCount);
    for (let i = 0; i < info.values.length; i++) info.values[i] = d.getFloat32(start + i * 4, true);
    return info;
  }

  // PBChannel v.3: global fields at 0x60 mirror the ASCII header; records from
  // 0x74: [u32 payloadBytes][u32 bitsPerSample][f32 step][f32 base][payload].
  //
  // Samples are packed MOST-significant-bit first, and each is SIGN-MAGNITUDE:
  // the top bit is the sign, the rest the magnitude, so a sample is a signed
  // offset from `base` (which is the channel's rest value, not its minimum).
  // The doc describes LSB-first unsigned; that reads a smooth root track as a
  // curve that wraps at base + 2^bits*step, and leaves decoded quaternions
  // non-unit (mean |1-|q|| 0.035 vs 0.0002 here) — both fixed by this reading.
  // Verified on every race's body and head base pair.
  const samples = frameCount - 1;
  const values = new Float32Array(frameCount * channelCount);
  let ofs = 0x74;
  for (let ch = 0; ch < channelCount; ch++) {
    if (ofs + 16 > u8.length) return null;
    const payload = u32(d, ofs);
    const bits = u32(d, ofs + 4);
    const step = f32(d, ofs + 8);
    const base = f32(d, ofs + 12);
    const dataOfs = ofs + 16;
    if (bits === 0) {
      for (let f = 0; f < frameCount; f++) values[f * channelCount + ch] = base;
    } else if (bits <= 16) {
      // Observed widths are 0/2/4/8/16 (the doc's list omits the 2-bit channels
      // in the Elvaan female base pair); this read handles any width up to 16.
      // Padded copy so the 24-bit window never runs past the record.
      const padded = new Uint8Array(payload + 4);
      padded.set(u8.subarray(dataOfs, Math.min(dataOfs + payload, u8.length)));
      const signBit = 1 << (bits - 1);
      const magMask = signBit - 1;
      for (let sIdx = 0; sIdx < samples; sIdx++) {
        const bit = sIdx * bits;
        const byte = bit >> 3;
        const word = (padded[byte] << 16) | (padded[byte + 1] << 8) | padded[byte + 2];
        const code = (word >> (24 - (bit & 7) - bits)) & (signBit | magMask);
        const mag = code & magMask;
        values[sIdx * channelCount + ch] = base + (code & signBit ? -mag : mag) * step;
      }
      values[samples * channelCount + ch] = values[ch];   // loop frame = frame 0
    } else {
      return null;   // unknown bit width — refuse rather than desync the cursor
    }
    ofs += 16 + payload;
  }
  info.values = values;
  return info;
}

// ---------------------------------------------------------------------------
// Model assembly
// ---------------------------------------------------------------------------

const NEUTRAL_COLOR = 0x80808080;   // 0x80 diffuse = neutral in the entity shader

/**
 * Build a renderer-ready model from body + head mesh/material buffers.
 * The model rides the ordinary entity path with a single identity joint;
 * animation happens on the CPU (see CreationAnimator) because the combined
 * skeletons run to ~300 bones with up to eight influences per vertex —
 * far past the GPU palette.
 */
export function buildCreationModel(files, sourceName) {
  // files: [{ mesh: ArrayBuffer, mat: ArrayBuffer|null, isBody: bool }] — body first.
  const model = {
    kind: 'creation',
    sourceName,
    skeleton: { joints: [{ parent: -1, rot: [0, 0, 0, 1], trans: [0, 0, 0] }], references: [] },
    meshGroups: [],
    textures: new Map(),
    animations: [],
    schedules: [],
    info: null,
    creation: { bones: [], files: [], groups: [] },
  };

  // Combined skeleton: body bones first, head parents rebased after them.
  // A file's authored Y correction (see `headY`) shifts its root bone here and
  // its vertices below, exactly together, so bind pose and animation agree and
  // the inverse-bind transforms stay consistent.
  for (let fi = 0; fi < files.length; fi++) {
    const boneStart = model.creation.bones.length;
    const offsetY = files[fi].offsetY ?? 0;
    const bones = parseSqleSkeleton(files[fi].mesh) ?? [];
    for (const b of bones) {
      const parent = b.parent >= 0 ? b.parent + boneStart : -1;
      model.creation.bones.push({
        ...b,
        trans: parent < 0 && offsetY ? [b.trans[0], b.trans[1] - offsetY, b.trans[2]] : b.trans,
        fileIndex: fi,
        parent,
      });
    }
    model.creation.files.push({ boneStart, boneCount: bones.length, offsetY });
  }
  const bones = model.creation.bones;

  // Bind world matrices (Y-conjugated locals, world = local · parentWorld).
  const bindWorlds = bones.map(() => new Float32Array(12));
  const tmp = new Float32Array(12);
  for (let i = 0; i < bones.length; i++) {
    const b = bones[i];
    quatScaleTransToMat(b.quat, b.scale, b.trans, tmp);
    reflectY(tmp);
    if (b.parent >= 0 && b.parent < i) {
      mul43(tmp, bindWorlds[b.parent], bindWorlds[i]);
    } else {
      bindWorlds[i].set(tmp);
    }
  }
  const invBinds = bindWorlds.map((w) => {
    const inv = new Float32Array(12);
    invert43(w, inv);
    return inv;
  });
  model.creation.bindWorlds = bindWorlds;

  // Channel budget per file — a motion pair is only compatible when its
  // declared channel count matches this sum exactly.
  model.creation.channelSums = model.creation.files.map((f) => {
    let sum = 0;
    for (let i = f.boneStart; i < f.boneStart + f.boneCount; i++) {
      for (const c of bones[i].counts) sum += c;
    }
    return sum;
  });

  for (let fi = 0; fi < files.length; fi++) {
    const { mesh, mat, isBody } = files[fi];
    const prefix = `creation_${fi}`;
    const texSet = mat ? buildDmbTextures(mat, prefix, isBody) : null;
    const flags = mat ? dmbShapeFlags(mat) : [];
    if (texSet) {
      model.textures.set(texSet.opaque.name, texSet.opaque);
      model.textures.set(texSet.alpha.name, texSet.alpha);
      if (texSet.blackKey) model.textures.set(texSet.blackKey.name, texSet.blackKey);
    }

    const shapes = parseShapes(mesh);
    const skins = parseSqleSkins(mesh);
    const boneStart = model.creation.files[fi].boneStart;
    // Same authored shift applied to the root bone above (positions are
    // already Y-reflected here, so it goes on directly).
    const offsetY = model.creation.files[fi].offsetY;
    if (offsetY) for (const s of shapes) for (let v = 0; v < s.vertCount; v++) s.pos[v * 3 + 1] += offsetY;

    for (let si = 0; si < shapes.length; si++) {
      const shape = shapes[si];
      const skin = skins[si] ?? null;

      // Per-vertex skin table: influences sorted by weight, at most eight
      // kept, renormalized. Stored per influence: bone index, weight, the
      // WEIGHT-SCALED bind position in bone-local space, and the local
      // normal. Skinned pos = Σ (w·localPos)·W3x3 + w·W.trans.
      const inflStart = new Int32Array(shape.vertCount + 1);
      const inflBone = [];
      const inflWeight = [];
      const inflPos = [];
      const inflNrm = [];
      for (let v = 0; v < shape.vertCount; v++) {
        inflStart[v] = inflBone.length;
        const list = skin && v < skin.length ? skin[v] : null;
        if (!list || list.length === 0) continue;
        const sorted = [...list].sort((a, b) => b.weight - a.weight).slice(0, 8);
        let total = 0;
        for (const s of sorted) total += s.weight;
        if (total <= 1e-6) continue;
        const px = shape.pos[v * 3], py = shape.pos[v * 3 + 1], pz = shape.pos[v * 3 + 2];
        const nx = shape.nrm[v * 3], ny = shape.nrm[v * 3 + 1], nz = shape.nrm[v * 3 + 2];
        for (const s of sorted) {
          const bi = boneStart + s.bone;
          if (bi < 0 || bi >= bones.length) continue;
          const w = s.weight / total;
          const lp = xformPoint(invBinds[bi], px, py, pz);
          const ln = xformNormal(invBinds[bi], nx, ny, nz);
          const len = Math.hypot(ln[0], ln[1], ln[2]) || 1;
          inflBone.push(bi);
          inflWeight.push(w);
          inflPos.push(lp[0] * w, lp[1] * w, lp[2] * w);
          inflNrm.push(ln[0] / len, ln[1] / len, ln[2] / len);
        }
      }
      inflStart[shape.vertCount] = inflBone.length;

      // Renderer contract: one group per shape, one triangle-list piece.
      // Vertices bind to joint 0 (identity) so the GPU pass is a passthrough;
      // the animator rewrites batch positions/normals directly.
      const vertices = new Array(shape.vertCount);
      for (let v = 0; v < shape.vertCount; v++) {
        vertices[v] = {
          p0: [shape.pos[v * 3], shape.pos[v * 3 + 1], shape.pos[v * 3 + 2]],
          p1: [0, 0, 0],
          n0: [shape.nrm[v * 3], shape.nrm[v * 3 + 1], shape.nrm[v * 3 + 2]],
          n1: [0, 0, 0],
          w0: 1, w1: 0, joint0: 0, joint1: -1,
        };
      }
      const flag = flags[si] ?? { alpha: false, blackKey: false };
      const textureName = texSet
        ? (flag.blackKey && texSet.blackKey ? texSet.blackKey.name : flag.alpha ? texSet.alpha.name : texSet.opaque.name)
        : null;
      const corners = [];
      for (let k = 0; k < shape.tris.length; k++) {
        const vi = shape.tris[k];
        corners.push({ vi, u: shape.uv[vi * 2], v: shape.uv[vi * 2 + 1], color: NEUTRAL_COLOR });
      }
      const groupIndex = model.meshGroups.length;
      model.meshGroups.push({
        vertices,
        pieces: [{ corners, topology: 'triangles', textureName, dynamic: true, creationGroup: groupIndex }],
      });
      model.creation.groups.push({
        fileIndex: fi,
        vertCount: shape.vertCount,
        bindPos: shape.pos,
        bindNrm: shape.nrm,
        inflStart,
        inflBone: Int32Array.from(inflBone),
        inflWeight: Float32Array.from(inflWeight),
        inflPos: Float32Array.from(inflPos),
        inflNrm: Float32Array.from(inflNrm),
      });
    }
  }

  model.isRenderable = model.meshGroups.length > 0;
  return model;
}

// ---------------------------------------------------------------------------
// Animation driver
// ---------------------------------------------------------------------------

/**
 * Plays a matched body/head SQLE motion pair over the combined skeleton with
 * CPU skinning. Bound to the renderer's live batches; apply(frame) rewrites
 * each dynamic batch's interleaved vertex data and re-uploads it.
 *
 * Motion values are consumed in skeleton order: for every bone all five
 * channel groups advance a per-file cursor, and recognized groups (trans,
 * quat, scale) replace bind components. Skipping unknown groups would shift
 * every subsequent bone's channels.
 */
export class CreationAnimator {
  constructor(model, motions) {
    this.model = model;
    // One per file, aligned with model.creation.files. PB values are copied:
    // root rebase mutates them, and the parse cache is shared across models
    // whose bind roots can differ.
    this.motions = motions.map((mo) => (
      mo && mo.kind === 'pb' && mo.values ? { ...mo, values: mo.values.slice() } : mo
    ));
    this.gl = null;
    this.batches = [];
    this.lastFrame = -1;
    this.worlds = model.creation.bones.map(() => new Float32Array(12));
    this.local = new Float32Array(12);

    const sums = model.creation.channelSums;
    this.compatible = this.motions.length === sums.length && this.motions.every(
      (mo, i) => mo && mo.values && mo.channelCount === sums[i],
    );

    const timing = this.motions[0] ?? this.motions[1];
    this.frameCount = Math.max(1, timing?.frameCount ?? 1);
    this.fps = timing?.fps ?? 30;
    this.duration = timing?.duration ?? 0;
    // The body drives timing; a head clip of a different length (Tarutaru male:
    // 1624 head frames against 1315 body frames) is sampled by phase, exactly
    // as it would be scaled into the body's window.
    this.frameMap = this.motions.map((mo) => (
      !mo || mo.frameCount === this.frameCount
        ? null
        : (frame) => Math.min(
          mo.frameCount - 1,
          (this.frameCount > 1 ? frame / (this.frameCount - 1) : 0) * (mo.frameCount - 1),
        )
    ));
    // Duck-typed clip for the renderer's generic transport (advance, wrap,
    // scrub, frame readout) — no joint tracks; the driver does the posing.
    // `fps` is the clip's own rate: PB sequences run ~30fps but the
    // FrameChannel idles are ~61fps, so a fixed 30 would halve their speed.
    this.clip = {
      kind: 'creation', lengthInFrames: this.frameCount, fps: this.fps, jointTracks: new Map(),
    };
    // Frame window currently played (the whole clip until a segment is picked).
    this.rangeStart = 0;
    this.rangeCount = this.frameCount;
    // Must run before segmenting: the repaired frames are exactly the ones that
    // otherwise register as huge spikes of motion energy and split a segment.
    this.repairedFrames = this.compatible ? this.#repairQuaternions() : 0;
    this.segments = this.compatible ? this.#findSegments() : [];
    // Per-bone: does its OWN local rotation ever change? (A bone whose parent
    // moves still travels, which hides a bone that never rotates — so this is
    // measured on the bone's own quaternion, not its world position.)
    this.staticBones = this.compatible ? this.#findStaticBones() : null;
    this.movingBoneCount = this.staticBones
      ? this.staticBones.reduce((n, s) => n + (s ? 0 : 1), 0) : 0;

    // Head attachment (DATura's offsetWithBones "bone0001" -> body "bone0004").
    // A head PB track carries a constant positional bias against its body track
    // — measured over each race's whole sequence it is steady to within 0.2
    // units (Mithra +3.18 Z, Galka -1.72 Z, Elvaan male +0.64 Z), so it is an
    // authoring offset, not motion. Re-deriving the shift every frame removes
    // it without touching anything authored: bone translation is rigid anyway,
    // so only the head's position moves, never its rotation. Pinning to the
    // BIND offset rather than to zero keeps the genuine sag on Hume/Elvaan
    // female heads, whose head bone 1 binds ~0.56 below body bone 4 — the
    // residual DATura hand-corrected with its face-table Y offsets.
    this.attach = null;
    const files = model.creation.files;
    if (files.length === 2 && files[0].boneCount > 4 && files[1].boneCount > 1) {
      const bodyBone = files[0].boneStart + 4;
      const headBone = files[1].boneStart + 1;
      const bw = model.creation.bindWorlds;
      this.attach = {
        bodyBone,
        headBone,
        headStart: files[1].boneStart,
        bindDelta: [
          bw[bodyBone][9] - bw[headBone][9],
          bw[bodyBone][10] - bw[headBone][10],
          bw[bodyBone][11] - bw[headBone][11],
        ],
      };
    }

    if (this.compatible) this.#rebaseRoots();
  }

  /**
   * Drop the frames whose rotations are not rotations, and bridge the gaps.
   *
   * About 2% of the frames in a PB sequence decode to a quaternion that is
   * nowhere near unit length — |q| reaches 2.27 where it should be 1. This is
   * the data, not the decode: every other reading of the container was ruled
   * out against the |q| oracle (sign-magnitude at bit 15 beats two's complement
   * 4.7e-4 to 8.9e-2; a 15-bit magnitude beats 14- and 13-bit; the 16-bit
   * samples are byte aligned so the bit window cannot slip; and the record
   * chain lands exactly on the per-channel flag table at EOF). The clincher is
   * that body and head are SEPARATE files that go bad at the SAME frames —
   * 5x to 28x more often than chance — so the damage tracks moments in the
   * performance, not anything either file's decoder did.
   *
   * The FrameChannel clips, by contrast, hold |1-|q|| to 3.6e-8, which is what
   * makes 2.27 obviously junk rather than a tolerance to widen.
   *
   * Normalising junk still yields a pose, just an arbitrary one, and that is
   * the single-frame popping that reads as jitter. So treat those frames as
   * missing: nlerp across each bad run from the last good frame to the next.
   *
   * Returns the number of (bone, frame) rotations rebuilt.
   */
  #repairQuaternions() {
    // 5% off unit is far outside quantisation (97.9% of frames land within 1%)
    // and far inside the failures, so it separates them cleanly.
    const TOL = 0.05;
    const { bones } = this.model.creation;
    const cursors = [0, 0];
    let repaired = 0;
    for (const b of bones) {
      const mo = this.motions[b.fileIndex];
      const cursor = cursors[b.fileIndex];
      let span = 0;
      for (const c of b.counts) span += c;
      cursors[b.fileIndex] = cursor + span;
      if (!mo || mo.kind !== 'pb' || !mo.values || b.counts[1] < 4) continue;
      const qOfs = cursor + b.counts[0];
      const { values, channelCount, frameCount } = mo;

      const bad = new Uint8Array(frameCount);
      for (let f = 0; f < frameCount; f++) {
        const o = f * channelCount + qOfs;
        const len = Math.hypot(values[o], values[o + 1], values[o + 2], values[o + 3]);
        if (Math.abs(1 - len) > TOL) bad[f] = 1;
      }
      // Bad frames arrive in clusters split by one or two survivors (Mithra's
      // head bone 151 is out at 1456-1458, back for 1459, out again at 1460).
      // Bridging those separately restarts from a standstill each time, because
      // the neighbour that would supply the tangent is itself bad — stop-start
      // motion, which is the acceleration the eye reads as jitter. Close the
      // short holes so each cluster becomes one continuous bridge.
      for (let f = 0; f < frameCount; f++) {
        if (!bad[f]) continue;
        let end = f;
        while (end < frameCount && bad[end]) end++;
        let next = end;
        while (next < frameCount && !bad[next]) next++;
        if (next < frameCount && next - end <= 2) {
          for (let k = end; k < next; k++) bad[k] = 1;
        }
        f = end - 1;
      }
      for (let f = 0; f < frameCount;) {
        if (!bad[f]) { f++; continue; }
        let end = f;
        while (end < frameCount && bad[end]) end++;
        const prev = f - 1;                 // last good frame, or -1
        const next = end < frameCount ? end : -1;
        if (prev < 0 && next < 0) { f = end; continue; }   // whole track is junk
        // Normalised endpoints, hemisphere-aligned so the short arc is taken.
        const grab = (fr) => {
          const o = fr * channelCount + qOfs;
          const l = Math.hypot(values[o], values[o + 1], values[o + 2], values[o + 3]) || 1;
          return [values[o] / l, values[o + 1] / l, values[o + 2] / l, values[o + 3] / l];
        };
        const qa = grab(prev < 0 ? next : prev);
        const qb = grab(next < 0 ? prev : next);
        const align = (q, to) => {
          if (q[0] * to[0] + q[1] * to[1] + q[2] * to[2] + q[3] * to[3] < 0) {
            for (let k = 0; k < 4; k++) q[k] = -q[k];
          }
          return q;
        };
        align(qb, qa);
        // A straight line across the gap lands in the right place but at the
        // wrong SPEED, and the velocity step that makes at each join is itself a
        // pop — bridging Mithra linearly traded one spike for two (3.5 and 3.3
        // where there had been none). So match the velocity of the good frames
        // on either side with a cubic Hermite. Frames before the gap are already
        // repaired (this sweeps forward); a neighbour that is missing or still
        // bad just contributes a zero tangent on its side.
        const L = end - prev;
        const m0 = [0, 0, 0, 0];
        const m1 = [0, 0, 0, 0];
        if (prev > 0 && !bad[prev - 1]) {
          const before = align(grab(prev - 1), qa);
          for (let k = 0; k < 4; k++) m0[k] = (qa[k] - before[k]) * L;
        }
        if (next >= 0 && next + 1 < frameCount && !bad[next + 1]) {
          const beyond = align(grab(next + 1), qb);
          for (let k = 0; k < 4; k++) m1[k] = (beyond[k] - qb[k]) * L;
        }
        for (let fr = f; fr < end; fr++) {
          const t = (fr - prev) / L;                   // 0..1 across the gap
          const t2 = t * t;
          const t3 = t2 * t;
          const h00 = 2 * t3 - 3 * t2 + 1;
          const h10 = t3 - 2 * t2 + t;
          const h01 = -2 * t3 + 3 * t2;
          const h11 = t3 - t2;
          const o = fr * channelCount + qOfs;
          let l = 0;
          const q = [0, 0, 0, 0];
          for (let k = 0; k < 4; k++) {
            q[k] = h00 * qa[k] + h10 * m0[k] + h01 * qb[k] + h11 * m1[k];
            l += q[k] * q[k];
          }
          l = Math.sqrt(l) || 1;
          for (let k = 0; k < 4; k++) values[o + k] = q[k] / l;
          repaired++;
        }
        f = end;
      }

      // Second pass: single-frame spikes that are unit-length but still wrong —
      // the bone swings out and straight back (30 deg out, 25 back, 6 net).
      // Measured across all eight races, 58 frames detour like this against 284
      // that genuinely keep moving, so requiring the round trip to cost far more
      // than the net travel leaves real fast motion alone.
      const unit = (fr) => {
        const o = fr * channelCount + qOfs;
        const l = Math.hypot(values[o], values[o + 1], values[o + 2], values[o + 3]) || 1;
        return [values[o] / l, values[o + 1] / l, values[o + 2] / l, values[o + 3] / l];
      };
      const degrees = (p, q) => 2 * Math.acos(Math.min(1,
        Math.abs(p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3]))) * 180 / Math.PI;
      for (let fr = 1; fr < frameCount - 1; fr++) {
        const before = unit(fr - 1);
        const here = unit(fr);
        const stepIn = degrees(before, here);
        if (stepIn <= 30) continue;
        const after = unit(fr + 1);
        const stepOut = degrees(here, after);
        if (degrees(before, after) >= 0.5 * (stepIn + stepOut) - 15) continue;   // real move
        if (before[0] * after[0] + before[1] * after[1]
          + before[2] * after[2] + before[3] * after[3] < 0) {
          for (let k = 0; k < 4; k++) after[k] = -after[k];
        }
        const o = fr * channelCount + qOfs;
        let l = 0;
        const q = [0, 0, 0, 0];
        for (let k = 0; k < 4; k++) { q[k] = (before[k] + after[k]) * 0.5; l += q[k] * q[k]; }
        l = Math.sqrt(l) || 1;
        for (let k = 0; k < 4; k++) values[o + k] = q[k] / l;
        repaired++;
      }
    }
    return repaired;
  }

  /**
   * Split the clip into its authored poses.
   *
   * These files are not one continuous performance: the character holds a pose,
   * moves to the next, and holds again — Hume male is motionless for 13% of its
   * frames, including the first ~8s and last ~20s. Played end to end that reads
   * as one long rigid animation, so find the quiet stretches and expose the
   * moving parts as separate clips.
   *
   * Motion energy is measured in channel space (|Δvalue| per frame summed over
   * every channel), which needs no posing and stays O(frames × channels).
   */
  #findSegments() {
    const mo = this.motions[0];
    if (!mo?.values || this.frameCount < 30) return [];
    const { values, channelCount, frameCount } = mo;
    const energy = new Float64Array(frameCount);
    for (let f = 1; f < frameCount; f++) {
      let s = 0;
      const a = (f - 1) * channelCount;
      const b = f * channelCount;
      for (let c = 0; c < channelCount; c++) s += Math.abs(values[b + c] - values[a + c]);
      energy[f] = s;
    }
    // Box-smooth over ~1/6s so single-frame jitter doesn't split a segment.
    const win = Math.max(2, Math.round(this.fps / 6));
    const smooth = new Float64Array(frameCount);
    for (let f = 0; f < frameCount; f++) {
      let s = 0, n = 0;
      for (let k = Math.max(0, f - win); k <= Math.min(frameCount - 1, f + win); k++) { s += energy[k]; n++; }
      smooth[f] = s / n;
    }
    const sorted = [...smooth].filter((x) => x > 0).sort((a, b) => a - b);
    if (!sorted.length) return [];
    const median = sorted[Math.floor(sorted.length * 0.5)];
    const peak = sorted[Math.floor(sorted.length * 0.98)];
    if (peak <= median * 3) return [];      // continuous motion — nothing to split
    const quiet = Math.max(median * 0.6, peak * 0.02);
    const minHold = Math.round(this.fps * 0.6);   // a hold shorter than this isn't a boundary
    const minRun = Math.round(this.fps * 0.8);    // and a segment shorter than this is noise

    const out = [];
    let start = -1;
    let quietRun = 0;
    for (let f = 0; f < frameCount; f++) {
      const active = smooth[f] > quiet;
      if (active) {
        if (start < 0) start = Math.max(0, f - Math.round(this.fps * 0.2));
        quietRun = 0;
      } else if (start >= 0) {
        quietRun++;
        if (quietRun >= minHold) {
          const end = Math.min(frameCount - 1, f);
          if (end - start >= minRun) out.push({ start, count: end - start + 1 });
          start = -1;
          quietRun = 0;
        }
      }
    }
    if (start >= 0 && frameCount - 1 - start >= minRun) out.push({ start, count: frameCount - start });
    return out.length > 1 ? out : [];
  }

  /**
   * Flag every bone whose own local rotation is constant across the clip.
   * Sampled at FULL frame resolution — subsampling badly understates the range
   * (every 19th frame reported a 30 deg maximum where the true figure is 98).
   */
  #findStaticBones() {
    const { bones } = this.model.creation;
    const out = new Uint8Array(bones.length);
    const cursors = [0, 0];
    for (let i = 0; i < bones.length; i++) {
      const b = bones[i];
      const start = cursors[b.fileIndex];
      cursors[b.fileIndex] = start + b.counts.reduce((a, c) => a + c, 0);
      if (b.counts[1] !== 4) { out[i] = 1; continue; }   // no rotation channels
      const mo = this.motions[b.fileIndex];
      const qAt = start + b.counts[0];
      const q0 = [0, 1, 2, 3].map((k) => mo.values[qAt + k]);
      const n0 = Math.hypot(...q0) || 1;
      let moved = 0;
      for (let f = 1; f < mo.frameCount && !moved; f++) {
        const o = f * mo.channelCount + qAt;
        let dot = 0;
        for (let k = 0; k < 4; k++) dot += (q0[k] / n0) * mo.values[o + k];
        const n = Math.hypot(mo.values[o], mo.values[o+1], mo.values[o+2], mo.values[o+3]) || 1;
        // ~0.5 degrees
        if (Math.abs(dot / n) < 0.99999) moved = 1;
      }
      out[i] = moved ? 0 : 1;
    }
    return out;
  }

  /** Play a frame window (a segment), or the whole clip when count is null. */
  setRange(start = 0, count = null) {
    this.rangeStart = Math.max(0, Math.min(start, this.frameCount - 1));
    this.rangeCount = Math.max(1, Math.min(count ?? this.frameCount - this.rangeStart,
      this.frameCount - this.rangeStart));
    this.clip.lengthInFrames = this.rangeCount;
    this.lastFrame = -1e9;
  }

  /**
   * The PB presentation contains authored horizontal root travel that starts
   * tens of units from the origin. Rebase each file's root X/Z channels
   * relative to frame zero (Y stays — vertical movement is part of the
   * performance): displayed = decoded + bindRoot − decoded(frame 0).
   */
  #rebaseRoots() {
    const { bones, files } = this.model.creation;
    for (let fi = 0; fi < files.length; fi++) {
      const mo = this.motions[fi];
      if (!mo || mo.kind !== 'pb') continue;
      // Find the file's root bone and its translation channel offsets.
      let cursor = 0;
      let rootChan = -1;
      let root = null;
      for (let i = files[fi].boneStart; i < files[fi].boneStart + files[fi].boneCount; i++) {
        const b = bones[i];
        if (b.parent < 0) { rootChan = cursor; root = b; break; }
        for (const c of b.counts) cursor += c;
      }
      if (root === null || root.counts[0] < 3) continue;
      const { values, channelCount, frameCount } = mo;
      for (const axis of [0, 2]) {
        const ch = rootChan + axis;
        const delta = root.trans[axis] - values[ch];
        for (let f = 0; f < frameCount; f++) values[f * channelCount + ch] += delta;
      }
    }
  }

  /**
   * Axis-aligned bounds of the WHOLE performance, sparsely sampled. These
   * sequences travel — Mithra's covers ~18 units in Z — so framing the bind
   * pose alone lets the character walk out of shot mid-clip.
   */
  sequenceBounds(frameSamples = 32, vertStride = 5) {
    if (!this.compatible) return null;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const groups = this.model.creation.groups;
    for (let k = 0; k <= frameSamples; k++) {
      this.#computeWorlds(this.rangeStart + (k / frameSamples) * (this.rangeCount - 1));
      for (const g of groups) {
        const { inflStart, inflBone, inflWeight, inflPos, bindPos } = g;
        for (let v = 0; v < g.vertCount; v += vertStride) {
          const s = inflStart[v];
          const e = inflStart[v + 1];
          let px, py, pz;
          if (s === e) {
            px = bindPos[v * 3]; py = bindPos[v * 3 + 1]; pz = bindPos[v * 3 + 2];
          } else {
            px = 0; py = 0; pz = 0;
            for (let k2 = s; k2 < e; k2++) {
              const m = this.worlds[inflBone[k2]];
              const w = inflWeight[k2];
              const lx = inflPos[k2 * 3], ly = inflPos[k2 * 3 + 1], lz = inflPos[k2 * 3 + 2];
              px += lx * m[0] + ly * m[3] + lz * m[6] + w * m[9];
              py += lx * m[1] + ly * m[4] + lz * m[7] + w * m[10];
              pz += lx * m[2] + ly * m[5] + lz * m[8] + w * m[11];
            }
          }
          if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
          if (px < min[0]) min[0] = px; if (px > max[0]) max[0] = px;
          if (py < min[1]) min[1] = py; if (py > max[1]) max[1] = py;
          if (pz < min[2]) min[2] = pz; if (pz > max[2]) max[2] = pz;
        }
      }
    }
    this.lastFrame = -1e9;   // worlds now hold a sampled frame — force a repose
    return Number.isFinite(min[0]) ? { min, max } : null;
  }

  /** Attach to the renderer's freshly built batches and pose frame 0. */
  bind(renderer) {
    this.gl = renderer.gl;
    this.batches = [];
    for (const batch of renderer.batches) {
      if (batch.creationGroup == null) continue;
      if (!batch._bindData) batch._bindData = batch.data.slice();
      this.batches.push(batch);
    }
    this.lastFrame = -1;
    this.apply(0);
  }

  apply(frameFloat) {
    if (!this.compatible || !this.gl) return;
    // Fractional: the pose is interpolated between the two neighbouring stored
    // frames, so slow playback stays fluid instead of stepping through the
    // authored 30Hz samples one at a time. The incoming frame is relative to
    // the played window (see setRange).
    const local = Math.min(Math.max(frameFloat, 0), this.rangeCount - 1);
    const frame = Math.min(this.rangeStart + local, this.frameCount - 1);
    if (Math.abs(frame - this.lastFrame) < 1e-3) return;
    this.lastFrame = frame;
    this.#computeWorlds(frame);

    const groups = this.model.creation.groups;
    for (const batch of this.batches) {
      const g = groups[batch.creationGroup];
      if (!g) continue;
      this.#skinBatch(batch, g);
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, batch.vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, batch.data);
    }
  }

  #computeWorlds(frame) {
    const { bones } = this.model.creation;
    const cursors = [0, 0];
    const local = this.local;
    const trans = [0, 0, 0];
    const quat = [0, 0, 0, 1];
    const scale = [1, 1, 1];
    // Per source file: the two frames to blend and the weight between them.
    // A head clip of a different length is sampled at the same phase.
    const spans = this.motions.map((mo, fi) => {
      const src = this.frameMap[fi] ? this.frameMap[fi](frame) : frame;
      const a = Math.min(Math.max(Math.floor(src), 0), mo.frameCount - 1);
      const b = Math.min(a + 1, mo.frameCount - 1);
      return { a: a * mo.channelCount, b: b * mo.channelCount, t: src - a };
    });
    for (let i = 0; i < bones.length; i++) {
      const b = bones[i];
      const mo = this.motions[b.fileIndex];
      const span = spans[b.fileIndex];
      const values = mo.values;
      let cursor = cursors[b.fileIndex];

      trans[0] = b.trans[0]; trans[1] = b.trans[1]; trans[2] = b.trans[2];
      quat[0] = b.quat[0]; quat[1] = b.quat[1]; quat[2] = b.quat[2]; quat[3] = b.quat[3];
      scale[0] = b.scale[0]; scale[1] = b.scale[1]; scale[2] = b.scale[2];
      const groups = [trans, quat, scale];
      const caps = [3, 4, 3];
      // Quaternions blend as a unit, with a sign fix so the shorter arc wins;
      // translation and scale blend component-wise.
      let qa0 = 0, qa1 = 0, qa2 = 0, qa3 = 1, qb0 = 0, qb1 = 0, qb2 = 0, qb3 = 1;
      let animatedQuat = false;
      for (let g = 0; g < 5; g++) {
        const n = b.counts[g];
        for (let c = 0; c < n; c++) {
          if (g < 3 && c < caps[g]) {
            const va = values[span.a + cursor];
            const vb = values[span.b + cursor];
            if (g === 1) {
              if (c === 0) { qa0 = va; qb0 = vb; animatedQuat = true; }
              else if (c === 1) { qa1 = va; qb1 = vb; }
              else if (c === 2) { qa2 = va; qb2 = vb; }
              else { qa3 = va; qb3 = vb; }
            } else {
              groups[g][c] = va + (vb - va) * span.t;
            }
          }
          cursor++;
        }
      }
      cursors[b.fileIndex] = cursor;

      if (animatedQuat) {
        const t = span.t;
        const dot = qa0 * qb0 + qa1 * qb1 + qa2 * qb2 + qa3 * qb3;
        const s = dot < 0 ? -t : t;
        quat[0] = qa0 * (1 - t) + qb0 * s;
        quat[1] = qa1 * (1 - t) + qb1 * s;
        quat[2] = qa2 * (1 - t) + qb2 * s;
        quat[3] = qa3 * (1 - t) + qb3 * s;
      }

      // Normalize the quaternion; a near-zero one falls back to identity.
      const qLen = Math.hypot(quat[0], quat[1], quat[2], quat[3]);
      if (qLen > 1e-6) {
        quat[0] /= qLen; quat[1] /= qLen; quat[2] /= qLen; quat[3] /= qLen;
      } else {
        quat[0] = quat[1] = quat[2] = 0; quat[3] = 1;
      }

      quatScaleTransToMat(quat, scale, trans, local);
      reflectY(local);
      if (b.parent >= 0 && b.parent < i) {
        mul43(local, this.worlds[b.parent], this.worlds[i]);
      } else {
        this.worlds[i].set(local);
      }
    }

    // Head attachment: restore the bind-pose body4 -> head1 offset by shifting
    // every head-file bone. Pure translation, so skinning picks it up via the
    // weighted-translation term.
    const at = this.attach;
    if (at) {
      const bw = this.worlds[at.bodyBone];
      const hw = this.worlds[at.headBone];
      const dx = bw[9] - hw[9] - at.bindDelta[0];
      const dy = bw[10] - hw[10] - at.bindDelta[1];
      const dz = bw[11] - hw[11] - at.bindDelta[2];
      for (let i = at.headStart; i < bones.length; i++) {
        const m = this.worlds[i];
        m[9] += dx; m[10] += dy; m[11] += dz;
      }
    }
  }

  #skinBatch(batch, g) {
    const { data, corners } = batch;
    const worlds = this.worlds;
    const { inflStart, inflBone, inflWeight, inflPos, inflNrm, bindPos, bindNrm } = g;
    // Skin the shape's vertex pool once, then scatter to the batch corners.
    const n = g.vertCount;
    if (!g._pos || g._pos.length !== n * 3) {
      g._pos = new Float32Array(n * 3);
      g._nrm = new Float32Array(n * 3);
    }
    const outP = g._pos;
    const outN = g._nrm;
    for (let v = 0; v < n; v++) {
      const s = inflStart[v];
      const e = inflStart[v + 1];
      if (s === e) {
        // No influences: the vertex stays at bind (matches DATura's behavior).
        outP[v * 3] = bindPos[v * 3]; outP[v * 3 + 1] = bindPos[v * 3 + 1]; outP[v * 3 + 2] = bindPos[v * 3 + 2];
        outN[v * 3] = bindNrm[v * 3]; outN[v * 3 + 1] = bindNrm[v * 3 + 1]; outN[v * 3 + 2] = bindNrm[v * 3 + 2];
        continue;
      }
      let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0;
      for (let k = s; k < e; k++) {
        const m = worlds[inflBone[k]];
        const w = inflWeight[k];
        const lx = inflPos[k * 3], ly = inflPos[k * 3 + 1], lz = inflPos[k * 3 + 2];
        px += lx * m[0] + ly * m[3] + lz * m[6] + w * m[9];
        py += lx * m[1] + ly * m[4] + lz * m[7] + w * m[10];
        pz += lx * m[2] + ly * m[5] + lz * m[8] + w * m[11];
        const ax = inflNrm[k * 3], ay = inflNrm[k * 3 + 1], az = inflNrm[k * 3 + 2];
        nx += w * (ax * m[0] + ay * m[3] + az * m[6]);
        ny += w * (ax * m[1] + ay * m[4] + az * m[7]);
        nz += w * (ax * m[2] + ay * m[5] + az * m[8]);
      }
      if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) {
        px = bindPos[v * 3]; py = bindPos[v * 3 + 1]; pz = bindPos[v * 3 + 2];
        nx = bindNrm[v * 3]; ny = bindNrm[v * 3 + 1]; nz = bindNrm[v * 3 + 2];
      }
      outP[v * 3] = px; outP[v * 3 + 1] = py; outP[v * 3 + 2] = pz;
      outN[v * 3] = nx; outN[v * 3 + 1] = ny; outN[v * 3 + 2] = nz;
    }
    // Batch layout (renderer.buildBatch): stride 19 floats, p0 at 0, n0 at 6.
    for (let k = 0; k < corners.length; k++) {
      const vi = corners[k];
      const o = k * 19;
      data[o] = outP[vi * 3]; data[o + 1] = outP[vi * 3 + 1]; data[o + 2] = outP[vi * 3 + 2];
      data[o + 6] = outN[vi * 3]; data[o + 7] = outN[vi * 3 + 1]; data[o + 8] = outN[vi * 3 + 2];
    }
  }
}

/** Reset every creation batch to its bind-pose vertex data (A-pose). */
export function restoreCreationBind(renderer) {
  const gl = renderer?.gl;
  if (!gl) return;
  for (const batch of renderer.batches ?? []) {
    if (batch.creationGroup == null || !batch._bindData) continue;
    batch.data.set(batch._bindData);
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, batch.data);
  }
}
