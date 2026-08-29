// FFXI per-character save files — <game>\USER\<id>\*.
//
// These are not sectioned resource DATs, so the section walker rejects them and
// they used to land on the "Not a sectioned resource DAT" card. Two of the
// formats are laid out plainly enough to read; the rest get a hex/strings view
// rather than an invented structure.
//
// Common 24-byte header, shared by most files in the folder:
//   u32  version/count   (1, 2, 4, 5 seen)
//   u32  character id    (same value across one character's files; 0 in some)
//   u8   digest[16]      (changes with content — a checksum or signature)
//
// Verified layouts:
//   mcr.dat, mcr<N>.dat  header + 20 macros x 380 bytes
//                        macro: u8 pad[4], char line[6][61], char title[10]
//   mcr.ttl, mcr_2.ttl   header + 20 book names x 16 bytes
//
// Everything else here (cnf.dat, gst, and the 4240-byte wr/bs/sk/ti/ca/cl/mb/
// sb/is/b2 family) is undocumented and deliberately left as bytes.

const HEADER_SIZE = 24;

export const MACRO_SLOTS = 20;
export const MACRO_STRIDE = 380;
export const MACRO_LINES = 6;
export const MACRO_LINE_SIZE = 61;
export const MACRO_TITLE_SIZE = 10;
export const MACRO_TITLE_OFFSET = 370;

const BOOKS_PER_TITLE_FILE = 20;
const TITLE_SIZE = 16;

/** Cap on bytes handed to the hex view — enough for any USER file whole. */
export const HEX_MAX = 8192;

/**
 * Does this path live in a character's USER folder?
 * `<anything>\USER\<id>\<file>` — the id is the client's 4-hex-char folder.
 */
export function matchUserPath(path) {
  const p = String(path || '').replace(/\//g, '\\');
  const m = p.match(/\\USER\\([^\\]+)\\([^\\]+)$/i);
  if (!m) return null;
  return { charDir: m[1], name: m[2], lower: m[2].toLowerCase() };
}

/**
 * What each file in a USER folder is *for*. These are reported purposes from
 * the community's file list, not decoded layouts — the name tells you which
 * feature wrote the file, nothing about the bytes inside it. Only the macro
 * formats below are actually parsed.
 *
 * Two entries in the source list were adjusted against what the files contain:
 * cmb0-4.dat are 56 bytes and cannot hold a macro book (7,624 bytes), so they
 * are named without that claim; and `gst` is a file here, not a folder.
 */
const USER_FILE_PURPOSES = [
  [/^wr\.dat$/, 'Wardrobe 1 (gear set storage)'],
  [/^wr_([2-8])\.dat$/, (m) => `Wardrobe ${m[1]} (gear set storage)`],
  [/^cmb([0-4])\.dat$/, (m) => `Command book ${Number(m[1]) + 1}`],
  [/^is\.dat$/, 'Item set 1'],
  [/^is_(\d+)\.dat$/, (m) => `Item set ${m[1]}`],
  [/^es0\.dat$/, 'Equipment sets'],
  [/^es(\d+)\.dat$/, (m) => `Equipment sets ${m[1]}`],
  [/^acq\.dat$/, 'Acquaintances / friends list'],
  [/^sb\.dat$/, 'Spell book'],
  [/^sk\.dat$/, 'Skills / job points'],
  [/^mb\.dat$/, 'Mog bag / storage'],
  [/^cnf\.dat$/, 'Character config / settings'],
  [/^aucsort\.dat$/, 'Auction house sort preferences'],
  [/^bs\.dat$/, 'Bazaar settings'],
  [/^ffxiusr\.msg$/, 'Bazaar comment / user message'],
  [/^aix\.dat$/, 'Auction house index'],
  [/^eix\.dat$/, 'Equipment index'],
  [/^mix\.dat$/, 'Item index'],
  [/^moix\.dat$/, 'Mob index'],
  [/^b2\.dat$/, 'Misc character data (chat filters, calendar, …)'],
  [/^ca\.dat$/, 'Misc character data (chat filters, calendar, …)'],
  [/^cl\.dat$/, 'Misc character data (chat filters, calendar, …)'],
  [/^pec\.dat$/, 'Misc character data (chat filters, calendar, …)'],
  [/^ti\.dat$/, 'Misc character data (chat filters, calendar, …)'],
  [/^gst$/, 'Guest / temporary data'],
  [/^timestamp\.dat$/, 'Backup timestamp'],
  [/^mcr\.sys$/, 'Macro book selection'],
];

/**
 * Reported purpose of a USER file, or null when the name isn't in the list.
 * @param {string} name  bare filename, any case
 */
export function userFilePurpose(name) {
  const lower = String(name || '').toLowerCase();
  for (const [re, label] of USER_FILE_PURPOSES) {
    const m = lower.match(re);
    if (m) return typeof label === 'function' ? label(m) : label;
  }
  return null;
}

/** Reported purpose for a full path, when it points into a USER folder. */
export function userPathPurpose(path) {
  const hit = matchUserPath(path);
  return hit ? userFilePurpose(hit.name) : null;
}

/** Book number a macro file holds: mcr.dat = 1, mcr1.dat = 2, … */
function macroBookNumber(lower) {
  const m = lower.match(/^mcr(\d*)\.dat$/);
  if (!m) return null;
  return m[1] ? parseInt(m[1], 10) + 1 : 1;
}

/** First book named by a title file: mcr.ttl = 1, mcr_2.ttl = 21, … */
function titleBookBase(lower) {
  const m = lower.match(/^mcr(?:_(\d+))?\.ttl$/);
  if (!m) return null;
  const part = m[1] ? parseInt(m[1], 10) : 1;
  return (part - 1) * BOOKS_PER_TITLE_FILE + 1;
}

/**
 * The common header, when the file plausibly carries one. Files outside the
 * family (AUCSORT.DAT, the 4240-byte wr/bs/sk set) start with data that reads
 * as a nonsense version, so gate on that rather than reporting fields that are
 * really just the first bytes of some other layout.
 */
const MAX_PLAUSIBLE_VERSION = 16;

function readHeader(bytes, dv) {
  if (bytes.byteLength < HEADER_SIZE) return null;
  if (dv.getUint32(0, true) > MAX_PLAUSIBLE_VERSION) return null;
  let digest = '';
  for (let i = 8; i < 24; i++) digest += bytes[i].toString(16).padStart(2, '0');
  return {
    version: dv.getUint32(0, true),
    charId: dv.getUint32(4, true),
    digest,
  };
}

/**
 * Macro/title text: fixed-width, NUL-padded. Bytes outside printable ASCII are
 * shown as '·' — macro lines can carry auto-translate and Shift_JIS runs, and
 * guessing at those would misreport what the file holds. `raw` keeps the hex.
 */
function decodeFixed(bytes, start, size) {
  let end = start;
  while (end < start + size && bytes[end] !== 0) end++;
  let text = '';
  for (let i = start; i < end; i++) {
    const c = bytes[i];
    text += (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : '·';
  }
  let raw = '';
  for (let i = start; i < end; i++) raw += bytes[i].toString(16).padStart(2, '0');
  return { text, raw, length: end - start };
}

/** ASCII runs of `min`+ chars, for the hex view's side list. */
function findStrings(bytes, min = 4, limit = 200) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= bytes.length && out.length < limit; i++) {
    const ok = i < bytes.length && bytes[i] >= 0x20 && bytes[i] < 0x7f;
    if (ok && start < 0) start = i;
    else if (!ok && start >= 0) {
      if (i - start >= min) {
        out.push({ offset: start, text: String.fromCharCode(...bytes.subarray(start, i)) });
      }
      start = -1;
    }
  }
  return out;
}

function inspectMacroBook(bytes, dv, header, book, label) {
  const expected = HEADER_SIZE + MACRO_SLOTS * MACRO_STRIDE;
  if (bytes.byteLength !== expected) return null;
  const macros = [];
  for (let i = 0; i < MACRO_SLOTS; i++) {
    const off = HEADER_SIZE + i * MACRO_STRIDE;
    const title = decodeFixed(bytes, off + MACRO_TITLE_OFFSET, MACRO_TITLE_SIZE);
    const lines = [];
    for (let l = 0; l < MACRO_LINES; l++) {
      const line = decodeFixed(bytes, off + 4 + l * MACRO_LINE_SIZE, MACRO_LINE_SIZE);
      if (line.length) lines.push({ index: l, ...line });
    }
    macros.push({
      index: i,
      // The client's palette is the Ctrl bar then the Alt bar, keys 1-9 then 0.
      bar: i < 10 ? 'Ctrl' : 'Alt',
      key: String(((i % 10) + 1) % 10),
      offset: off,
      title: title.text,
      lines,
      empty: !title.length && !lines.length,
    });
  }
  return {
    kind: 'macros',
    label,
    book,
    header,
    macros,
    used: macros.filter((m) => !m.empty).length,
    fileSize: bytes.byteLength,
  };
}

function inspectMacroTitles(bytes, header, baseBook, label) {
  const expected = HEADER_SIZE + BOOKS_PER_TITLE_FILE * TITLE_SIZE;
  if (bytes.byteLength !== expected) return null;
  const titles = [];
  for (let i = 0; i < BOOKS_PER_TITLE_FILE; i++) {
    const off = HEADER_SIZE + i * TITLE_SIZE;
    const t = decodeFixed(bytes, off, TITLE_SIZE);
    titles.push({ book: baseBook + i, offset: off, name: t.text, empty: !t.length });
  }
  return {
    kind: 'macrotitles',
    label,
    header,
    titles,
    named: titles.filter((t) => !t.empty).length,
    fileSize: bytes.byteLength,
  };
}

/**
 * Bytes view for a file whose layout we don't know. Honest by design: the
 * header block is only offered when the file is long enough to carry one, and
 * it's labelled as the USER convention rather than as decoded meaning.
 */
export function inspectAsHex(bytes, { label, header = null, note = null } = {}) {
  const shown = bytes.byteLength > HEX_MAX ? bytes.subarray(0, HEX_MAX) : bytes;
  return {
    kind: 'hex',
    label,
    header,
    note,
    bytes: shown,
    shownBytes: shown.byteLength,
    strings: findStrings(bytes),
    fileSize: bytes.byteLength,
  };
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {string} path  used only to recognise the file by name
 * @returns {object|null} an inspector doc, or null when `path` isn't a USER file
 */
export function inspectUserDat(buffer, path) {
  const hit = matchUserPath(path);
  if (!hit) return null;
  const bytes = buffer instanceof Uint8Array
    ? buffer
    : new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = readHeader(bytes, dv);

  const book = macroBookNumber(hit.lower);
  if (book != null && header) {
    const doc = inspectMacroBook(bytes, dv, header, book, `Macro book ${book} — ${hit.name}`);
    if (doc) return { ...doc, charDir: hit.charDir };
  }

  const baseBook = titleBookBase(hit.lower);
  if (baseBook != null && header) {
    const doc = inspectMacroTitles(
      bytes, header, baseBook,
      `Macro book names ${baseBook}–${baseBook + BOOKS_PER_TITLE_FILE - 1} — ${hit.name}`,
    );
    if (doc) return { ...doc, charDir: hit.charDir };
  }

  const purpose = userFilePurpose(hit.name);
  return {
    ...inspectAsHex(bytes, {
      label: purpose ? `${purpose} — ${hit.name}` : `USER save — ${hit.name}`,
      header,
      note: purpose
        ? 'Purpose is from the known USER file list; the byte layout is not documented.'
        : 'Layout not documented. Showing the raw bytes and any ASCII runs.',
    }),
    purpose,
    charDir: hit.charDir,
  };
}
