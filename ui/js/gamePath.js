/** Normalize a game-relative path to Windows-style separators. */
export const normRel = (rel) => String(rel || '').replace(/\//g, '\\').replace(/^[\\/]+/, '');

/** ROM-relative key for equality (HD/game/pivot abs → same `rom\…` key). */
export function pathKey(path, settings) {
  return normRel(relFromAbs(path, settings)).toLowerCase();
}

/**
 * Absolute path candidates for a game-relative **or** absolute path.
 * Order when toggles are on: Pivot → HD → game install.
 * Absolute paths under a known root are rewritten to the same relative key
 * so pivot/HD overrides apply even when the tree click was under Game/HD.
 *
 * @param {{ skipHd?: boolean }} [opts]  Animation/schedule DATs must not use HD
 *   overrides (empty/stub packs break weapon skills and motion lists).
 */
export function gameCandidates(relOrAbs, settings, opts = {}) {
  let r = normRel(relOrAbs);
  // Absolute path under game/hd/pivot → strip to ROM\…
  const stripped = relFromAbs(r, settings);
  if (stripped && stripped !== r) r = normRel(stripped);
  // Absolute path that still looks like …\ROM\… even outside configured roots
  if (/^[a-zA-Z]:\\/.test(r) || r.startsWith('\\\\')) {
    const m = r.match(/(?:^|\\)((?:ROM\d*|sound\d*|maps)\\.+)$/i);
    if (m) r = m[1];
  }
  const out = [];
  if (settings?.pivotEnabled && settings?.pivotPath) out.push(`${settings.pivotPath}\\${r}`);
  if (!opts.skipHd && settings?.hdEnabled && settings?.hdPath) out.push(`${settings.hdPath}\\${r}`);
  if (settings?.gamePath) out.push(`${settings.gamePath}\\${r}`);
  // Last resort: original absolute path (Open DAT outside roots)
  if (/^[a-zA-Z]:\\/.test(normRel(relOrAbs)) || String(relOrAbs).startsWith('\\\\')) {
    const abs = normRel(relOrAbs);
    if (!out.some((p) => p.toLowerCase() === abs.toLowerCase())) out.push(abs);
  }
  return out;
}

/** Strip known install roots for display. */
export function relFromAbs(path, settings) {
  const p = String(path || '');
  for (const base of [settings?.pivotPath, settings?.hdPath, settings?.gamePath]) {
    if (base && p.toLowerCase().startsWith(base.toLowerCase())) {
      return p.slice(base.length).replace(/^[\\/]+/, '');
    }
  }
  return p;
}

/** Which configured root an absolute path lives under (if any). */
export function rootKindForAbs(path, settings) {
  const p = String(path || '').toLowerCase();
  if (settings?.pivotPath && p.startsWith(String(settings.pivotPath).toLowerCase())) return 'pivot';
  if (settings?.hdPath && p.startsWith(String(settings.hdPath).toLowerCase())) return 'hd';
  if (settings?.gamePath && p.startsWith(String(settings.gamePath).toLowerCase())) return 'game';
  return null;
}

/**
 * Path to **write** for a DAT, matching load order when the file exists:
 * Pivot (if on) → HD (if on) → game → original path.
 *
 * @param {string} path absolute or relative DAT path
 * @param {object} settings viewer settings
 * @param {(p: string) => Promise<boolean>} fileExists
 * @returns {Promise<string>}
 */
export async function resolveWritableDat(path, settings, fileExists) {
  if (!path) return path;
  const cands = gameCandidates(path, settings);
  if (!cands.length) return String(path).replace(/\//g, '\\');
  for (const c of cands) {
    try {
      if (c && await fileExists(c)) return c;
    } catch { /* try next */ }
  }
  // Nothing exists yet — prefer highest-priority root (first candidate).
  return cands[0];
}
