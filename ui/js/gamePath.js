/**
 * macOS / Linux host. Only there can a leading `/` mean "absolute" — on Windows
 * a path starts with a drive or `\\server`, and a leading slash is a stray
 * separator on a relative path, which normRel strips as it always has.
 */
const POSIX_HOST = typeof navigator !== 'undefined'
  && !/^win/i.test(navigator.platform || '')
  && !/windows/i.test(navigator.userAgent || '');

/**
 * A POSIX absolute path (`/Users/me/xi-tools/exports/…/mix.DAT`) on a
 * macOS/Linux host. The mixer's composed DATs live outside every game root,
 * and xi returns them like this.
 */
export const isPosixAbs = (p) => POSIX_HOST && /^\/(?![\\/])/.test(String(p || ''));

/** Absolute on this host: a drive (`C:\`), a UNC share, or POSIX-absolute. */
export const isAbsPath = (p) => {
  const s = String(p || '');
  return /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\') || isPosixAbs(s);
};

/**
 * Normalize a game-relative path to Windows-style separators. A POSIX absolute
 * path is returned as-is: stripping its leading `/` would turn it into a
 * relative path that gets joined onto the game folder.
 */
export const normRel = (rel) => (isPosixAbs(rel)
  ? String(rel)
  : String(rel || '').replace(/\//g, '\\').replace(/^[\\/]+/, ''));

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
  if (isAbsPath(r)) {
    const m = r.match(/(?:^|[\\/])((?:ROM\d*|sound\d*|maps)[\\/].+)$/i);
    if (m) r = normRel(m[1]);
  }
  // Still absolute and outside every root (a composed mixer DAT): read it as-is.
  // Joining it onto pivot/HD/game only builds paths that cannot exist.
  if (isPosixAbs(r)) return [r];
  const out = [];
  if (settings?.pivotEnabled && settings?.pivotPath) out.push(`${settings.pivotPath}\\${r}`);
  if (!opts.skipHd && settings?.hdEnabled && settings?.hdPath) out.push(`${settings.hdPath}\\${r}`);
  if (settings?.gamePath) out.push(`${settings.gamePath}\\${r}`);
  // Last resort: original absolute path (Open DAT outside roots)
  if (isAbsPath(normRel(relOrAbs))) {
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
