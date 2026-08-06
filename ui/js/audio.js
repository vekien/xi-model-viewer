// FFXI audio (.bgw music / .spw sfx) parsing + decode — port of xi-tools
// xi_core.py, verified byte-exact against vgmstream. ADPCM + PCM decode here;
// ATRAC3 (an MDCT codec) can't be hand-decoded and is reported as unsupported.

const DATA_OFFSET = 0x30;
export const FMT_ADPCM = 0;
export const FMT_PCM = 1;
export const FMT_ATRAC3 = 3;

const FILTER0 = [0x0000, 0x00f0, 0x01cc, 0x0188, 0x01e8];
const FILTER1 = [0x0000, 0x0000, -0x00d0, -0x00dc, -0x00f0];

const FORMAT_NAME = { [FMT_ADPCM]: 'ADPCM', [FMT_PCM]: 'PCM', [FMT_ATRAC3]: 'ATRAC3' };

function ascii(bytes, start, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[start + i]);
  return s;
}

export function parseAudioHeader(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < DATA_OFFSET) throw new Error('file too small for an audio header');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let type, sampleFormat, size, body;
  if (ascii(bytes, 0, 8) === 'SeWave\0\0') {
    type = 'SeWave';
    size = dv.getInt32(8, true);
    sampleFormat = dv.getInt32(12, true);
    body = 0x10;
  } else if (ascii(bytes, 0, 12) === 'BGMStream\0\0\0') {
    type = 'BGMStream';
    sampleFormat = dv.getInt32(12, true);
    size = dv.getInt32(16, true);
    body = 0x14;
  } else if (ascii(bytes, 0, 6) === 'SeWave') {
    throw new Error('encrypted/variant SeWave (unsupported)');
  } else {
    throw new Error('unrecognised marker (not a .bgw/.spw)');
  }

  const id = dv.getInt32(body, true);
  const sampleBlocks = dv.getInt32(body + 4, true);
  const loopStart = dv.getInt32(body + 8, true);
  const srHigh = dv.getInt32(body + 12, true);
  const srLow = dv.getInt32(body + 16, true);
  const channels = bytes[body + 0x18 + 2];
  const blockSizeByte = bytes[body + 0x18 + 3];

  // The block_size byte lies on ~0.3% of files; derive true frame geometry from
  // the data the way vgmstream does, falling back to the byte only when unclean.
  let frameSize = blockSizeByte ? 1 + (blockSizeByte >> 1) : 0;
  const bodyBytes = size - DATA_OFFSET;
  const denom = sampleBlocks * channels;
  if (sampleFormat === FMT_ADPCM && denom > 0 && bodyBytes > 0 && bodyBytes % denom === 0) {
    const fs = bodyBytes / denom;
    if (fs >= 2) frameSize = fs;
  }
  const blockSamples = (frameSize - 1) * 2;

  return {
    type,
    sampleFormat,
    formatName: FORMAT_NAME[sampleFormat] ?? `fmt${sampleFormat}`,
    size,
    id,
    sampleBlocks,
    loopStart,
    looped: loopStart >= 0,
    sampleRate: srHigh + srLow,     // signed sum — deliberate obfuscation
    channels,
    frameSize,
    blockSamples,
    get totalFrames() {
      return sampleFormat === FMT_PCM
        ? Math.max(0, (size - DATA_OFFSET)) / (2 * Math.max(1, channels)) | 0
        : Math.max(0, sampleBlocks * blockSamples);   // blockSamples is only valid for ADPCM
    },
    /**
     * Where a looping sound restarts, in sample frames. Ambient weather beds
     * open with an intro (0.3-4s) that must play once and never again — looping
     * the whole buffer replays it every cycle, which is the audible blip.
     *
     * The unit differs by codec: ADPCM counts blocks, PCM counts frames. (The
     * xi-tools reference multiplies unconditionally, which overshoots the end
     * of the file on the handful of looped PCM sounds.) Anything that lands out
     * of range is treated as "no loop point" rather than trusted.
     */
    get loopStartFrame() {
      if (loopStart < 0) return 0;
      const frame = sampleFormat === FMT_ADPCM ? loopStart * blockSamples : loopStart;
      return frame > 0 && frame < this.totalFrames ? frame : 0;
    },
    get loopStartSec() {
      return this.sampleRate ? this.loopStartFrame / this.sampleRate : 0;
    },
    get durationSec() {
      return this.sampleRate ? this.totalFrames / this.sampleRate : 0;
    },
  };
}

function clamp16(v) {
  return v > 0x7fff ? 0x7fff : v < -0x8000 ? -0x8000 : v;
}

/**
 * Decodes a .bgw/.spw buffer to interleaved Int16 PCM.
 * Returns { header, samples: Int16Array }. Throws on ATRAC3/unsupported.
 */
export function decodeAudio(buffer) {
  const bytes = new Uint8Array(buffer);
  const header = parseAudioHeader(buffer);
  const ch = header.channels;
  if (ch < 1 || ch > 6) throw new Error(`bad channel count ${ch}`);

  if (header.sampleFormat === FMT_PCM) {
    const end = header.size > DATA_OFFSET ? header.size : bytes.length;
    let len = end - DATA_OFFSET;
    len -= len % (2 * ch);
    const samples = new Int16Array(len / 2);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < samples.length; i++) samples[i] = dv.getInt16(DATA_OFFSET + i * 2, true);
    return { header, samples };
  }

  if (header.sampleFormat !== FMT_ADPCM) {
    throw new Error(`${header.formatName} needs vgmstream (only ADPCM/PCM decode natively)`);
  }

  const frameSize = header.frameSize;
  if (frameSize < 2) throw new Error(`invalid ADPCM frame size ${frameSize}`);
  const dataBytes = frameSize - 1;
  const nsamp = header.blockSamples;
  const inBlockLen = frameSize * ch;
  const availBlocks = Math.floor((bytes.length - DATA_OFFSET) / inBlockLen);
  const nblocks = Math.min(header.sampleBlocks, availBlocks);

  const out = new Int16Array(nblocks * nsamp * ch);
  const hist0 = new Int32Array(ch);
  const hist1 = new Int32Array(ch);

  let pos = DATA_OFFSET;
  let outBase = 0;
  for (let b = 0; b < nblocks; b++) {
    for (let c = 0; c < ch; c++) {
      const base = pos + c * frameSize;
      const hdr = bytes[base];
      const scale = (0x0c - (hdr & 0x0f)) & 0x1f;
      const index = hdr >> 4;
      if (index >= 5) continue;              // channel silent this block
      const flt0 = FILTER0[index];
      const flt1 = FILTER1[index];
      let h0 = hist0[c];
      let h1 = hist1[c];
      let outI = outBase + c;
      for (let s = 0; s < dataBytes; s++) {
        const sampleByte = bytes[base + 1 + s];
        for (let nibble = 0; nibble < 2; nibble++) {
          let v = (sampleByte >> (4 * nibble)) & 0x0f;
          if (v >= 8) v -= 16;
          // Arithmetic shift (floors toward -inf) — matches the game exactly.
          const temp = clamp16((v << scale) + ((h0 * flt0 + h1 * flt1) >> 8));
          h1 = h0;
          h0 = temp;
          out[outI] = temp;
          outI += ch;
        }
      }
      hist0[c] = h0;
      hist1[c] = h1;
    }
    outBase += nsamp * ch;
    pos += inBlockLen;
  }

  return { header, samples: out };
}

/**
 * Encodes interleaved Int16 PCM into a RIFF/WAVE (PCM16) byte array.
 */
export function encodeWav(samples, sampleRate, channels) {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };

  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);            // fmt chunk size
  dv.setUint16(20, 1, true);             // PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * 2, true);  // byte rate
  dv.setUint16(32, channels * 2, true);  // block align
  dv.setUint16(34, 16, true);            // bits per sample
  writeStr(36, 'data');
  dv.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) dv.setInt16(44 + i * 2, samples[i], true);

  return new Uint8Array(buffer);
}

/**
 * Produces WAV bytes for a .bgw/.spw buffer (ADPCM/PCM only — ATRAC3 must route
 * through vgmstream separately). Returns { header, wav: Uint8Array }.
 */
export function toWav(buffer) {
  const { header, samples } = decodeAudio(buffer);
  return { header, wav: encodeWav(samples, header.sampleRate || 44100, header.channels) };
}

/**
 * Decodes into a Web Audio AudioBuffer (deinterleaves + normalizes to float).
 */
export function toAudioBuffer(audioCtx, buffer) {
  const { header, samples } = decodeAudio(buffer);
  const ch = header.channels;
  const frames = samples.length / ch;
  const audioBuffer = audioCtx.createBuffer(ch, frames, header.sampleRate || 44100);
  for (let c = 0; c < ch; c++) {
    const out = audioBuffer.getChannelData(c);
    for (let i = 0; i < frames; i++) out[i] = samples[i * ch + c] / 32768;
  }
  return { header, audioBuffer };
}
