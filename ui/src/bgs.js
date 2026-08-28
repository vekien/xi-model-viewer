/**
 * Viewport background images. Served from `public/bgs/` so URLs are stable
 * (`/bgs/ui_bg0.png`) without relying on Vite glob import shapes.
 */
const FILES = [
  'ui_bg0.png',
  'ui_bg1.png',
  'ui_bg2.png',
  'ui_bg3.png',
  'ui_bg4.png',
  'ui_bg5.png',
  'ui_bg6.png',
];

/** @type {{ id: string, label: string, url: string }[]} */
export const BG_IMAGES = FILES.map((file) => ({
  id: file,
  label: file.replace(/\.[^.]+$/, ''),
  url: `/bgs/${file}`,
}));
