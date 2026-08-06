// FTABLE/VTABLE parsing for the Assets > Data view.
//
// The client resolves a file_id through a pair of tables (xi-tools
// xi/ftable/xi_core.py, xim FileTableManager):
//   FTABLE: u16 per id  — subdir = val >> 7, file = val & 0x7F
//   VTABLE: u8  per id  — ROM root the file lives under; 0 = unregistered
// giving ROM/<subdir>/<file>.DAT (vt 1) or ROM<vt>/<subdir>/<file>.DAT.
// Registration is gated by the VTABLE byte alone — ft_val 0 is a real entry
// (ROM/0/0.DAT), so it must not be treated as empty.
//
// The base pair sits at the game root (FTABLE.DAT/VTABLE.DAT); each expansion
// carries its own pair (ROM2/FTABLE2.DAT, …). One pair is viewed at a time —
// whichever the user clicked.

/**
 * Recognise a table DAT by filename. Returns null for anything else, otherwise
 * { kind: 'ftable'|'vtable', romIdx, siblingName } — sibling is the other half
 * of the pair, expected in the same directory.
 */
export function matchTablePath(path) {
  const name = String(path).split(/[\\/]/).pop()?.toUpperCase() ?? '';
  const m = name.match(/^(F|V)TABLE(\d*)\.DAT$/);
  if (!m) return null;
  const kind = m[1] === 'F' ? 'ftable' : 'vtable';
  const romIdx = m[2] ? parseInt(m[2], 10) : 1;
  const siblingName = `${m[1] === 'F' ? 'V' : 'F'}TABLE${m[2]}.DAT`;
  return { kind, romIdx, siblingName };
}

/**
 * Decode a table pair into the id → DAT listing.
 * Returns { capacity, registered, entries, romCounts }:
 *   entries   — [{ id, dat, rom, ftVal }] for every registered id
 *   romCounts — [{ rom, count }] census of which ROM root entries point into
 */
export function parseFileTable(ftBuf, vtBuf) {
  const ft = new Uint8Array(ftBuf instanceof ArrayBuffer ? ftBuf : ftBuf.buffer);
  const vt = new Uint8Array(vtBuf instanceof ArrayBuffer ? vtBuf : vtBuf.buffer);
  const capacity = Math.min(ft.byteLength >> 1, vt.byteLength);

  const entries = [];
  const romCounts = new Map();
  for (let id = 0; id < capacity; id++) {
    const rom = vt[id];
    if (rom === 0) continue;
    const ftVal = ft[id * 2] | (ft[id * 2 + 1] << 8);
    const subdir = ftVal >> 7;
    const file = ftVal & 0x7f;
    const root = rom === 1 ? 'ROM' : `ROM${rom}`;
    entries.push({ id, dat: `${root}/${subdir}/${file}.DAT`, rom, ftVal });
    romCounts.set(rom, (romCounts.get(rom) ?? 0) + 1);
  }

  return {
    capacity,
    registered: entries.length,
    entries,
    romCounts: [...romCounts.entries()]
      .map(([rom, count]) => ({ rom, count }))
      .sort((a, b) => a.rom - b.rom),
  };
}
