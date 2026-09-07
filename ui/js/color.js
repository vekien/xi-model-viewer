// Colour conversions for the picker (ui/src/ColorPicker.jsx).
//
// RGB channels are 0-255 integers, `h` is 0-360 and `s`/`v` are 0-1. HSV is what the
// picker stores: hue survives a drag down to black or in to grey, which it would not
// if the popover kept only the RGB triple.

/** Parse `#rgb` or `#rrggbb`, with or without the hash. Null if it is neither. */
export function parseHex(hex) {
  const s = String(hex ?? '').trim().replace(/^#/, '');
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(s)) return null;
  const full = s.length === 3 ? s.replace(/./g, (c) => c + c) : s;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function toHex({ r, g, b }) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function rgbToHsv({ r, g, b }) {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;

  let h = 0;
  if (d) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

export function hsvToRgb({ h, s, v }) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const seg = Math.floor(((h % 360) + 360) % 360 / 60);
  const [r, g, b] = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ][seg];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}
