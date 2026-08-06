// ByteReader — a direct counterpart to xim's xim.resource.ByteReader.
//
// The particle parsers are ported statement-for-statement, and several of them
// depend on read *order* to advance the cursor (the opcode handlers assert they
// consumed exactly the declared number of dwords). A cursor-based reader keeps
// those ports honest instead of forcing every field onto a hand-computed offset.

import { Vec3 } from '../particle/math.js';

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

export class ByteReader {
  constructor(bytes, dv, position = 0, name = '') {
    this.bytes = bytes;
    this.dv = dv;
    this.position = position;
    this.name = name;
  }

  /** Seek to `section.start + offset` (xim offsetFrom). */
  offsetFrom(section, offset = 0) { this.position = section.start + offset; return this; }

  /** Seek to `section.start + 0x10 + offset` (xim offsetFromDataStart). */
  offsetFromDataStart(section, offset = 0) { this.position = section.dataStart + offset; return this; }

  next8() { return this.bytes[this.position++]; }
  next16() { const v = this.dv.getUint16(this.position, true); this.position += 2; return v; }
  next16Signed() { const v = this.dv.getInt16(this.position, true); this.position += 2; return v; }
  next32() { const v = this.dv.getUint32(this.position, true); this.position += 4; return v; }
  next32Signed() { const v = this.dv.getInt32(this.position, true); this.position += 4; return v; }
  nextFloat() { const v = this.dv.getFloat32(this.position, true); this.position += 4; return v; }

  /** 4-byte RGBA as ints 0..255 (xim nextRGBA → ByteColor). */
  nextRGBA() {
    const b = this.bytes, p = this.position;
    this.position += 4;
    return [b[p], b[p + 1], b[p + 2], b[p + 3]];
  }

  /** 4-byte BGRA reordered to RGBA — particle/zone mesh vertex colours. */
  nextBGRA() {
    const b = this.bytes, p = this.position;
    this.position += 4;
    return [b[p + 2], b[p + 1], b[p], b[p + 3]];
  }

  nextVector3f() { return new Vec3(this.nextFloat(), this.nextFloat(), this.nextFloat()); }

  nextString(len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = this.bytes[this.position + i];
      if (c === 0) { s += '\0'; continue; }
      s += String.fromCharCode(c);
    }
    this.position += len;
    return s;
  }

  /** 4-byte DatId, trailing NUL/space stripped so it compares like a key. */
  nextDatId() { return this.nextString(4).replace(/\0+$/, '').trim(); }

  skip(n) { this.position += n; return this; }
}

/** Reinterpret a u32's bits as a float (opcode args arrive as raw dwords). */
export function bitsToFloat(u) { U32[0] = u >>> 0; return F32[0]; }
