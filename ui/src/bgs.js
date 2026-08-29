/**
 * Viewport background images — drop a file in `ui/bgs/` and it appears in the
 * Scene dropdown; nothing else needs touching.
 *
 * Bundled through this glob rather than served from `public/`: Vite emits each
 * one under a content hash, so a changed image can't be served stale, and only
 * what's referenced ships. `public/bgs/` used to hold a second, byte-identical
 * copy that went out with every build and was never read — hence the size, and
 * the split-brain where the dropdown served bundled files while a page reload
 * served the public ones.
 */

const modules = import.meta.glob('../bgs/*.{png,jpg,jpeg,webp,gif}', {
  eager: true,
  query: '?url',
  import: 'default',
});

function fileName(path) {
  return (path.split(/[/\\]/).pop() || path);
}

function stem(name) {
  return name.replace(/\.[^.]+$/, '');
}

/** @type {{ id: string, label: string, url: string }[]} */
export const BG_IMAGES = Object.entries(modules)
  .map(([path, mod]) => {
    const name = fileName(path);
    const url = typeof mod === 'string' ? mod : (mod?.default ?? String(mod));
    return { id: name, label: stem(name), url };
  })
  .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

/**
 * Resolve a stored id (filename) → loadable URL, '' when there is no such
 * image. Every background now comes from the glob above, so an id that misses
 * is genuinely gone — the old `./bgs/<name>` fallback pointed at the deleted
 * public copy, and was already unreachable via normalizeBgId.
 */
export function resolveBgUrl(id) {
  if (!id || id === 'none') return '';
  const name = String(id).split(/[/\\]/).pop();
  return BG_IMAGES.find((b) => b.id === name)?.url ?? '';
}

export function normalizeBgId(stored) {
  if (!stored || stored === 'none') return 'none';
  const name = String(stored).split(/[/\\]/).pop();
  if (BG_IMAGES.some((b) => b.id === name)) return name;
  return 'none';
}
