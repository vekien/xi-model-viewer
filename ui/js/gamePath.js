/** Normalize a game-relative path to Windows-style separators. */
export const normRel = (rel) => String(rel || '').replace(/\//g, '\\').replace(/^[\\/]+/, '');

/**
 * Absolute path candidates for a game-relative file. When HD is on, the HD
 * root is tried first; callers fall back to the vanilla install if missing.
 */
export function gameCandidates(rel, settings) {
  const r = normRel(rel);
  const out = [];
  if (settings?.hdEnabled && settings?.hdPath) out.push(`${settings.hdPath}\\${r}`);
  if (settings?.gamePath) out.push(`${settings.gamePath}\\${r}`);
  return out;
}

/** Strip gamePath or hdPath prefix for display. */
export function relFromAbs(path, settings) {
  const p = String(path || '');
  for (const base of [settings?.hdPath, settings?.gamePath]) {
    if (base && p.toLowerCase().startsWith(base.toLowerCase())) {
      return p.slice(base.length).replace(/^[\\/]+/, '');
    }
  }
  return p;
}
