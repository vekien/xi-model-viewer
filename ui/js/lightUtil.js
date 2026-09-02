/** Colour helpers for zone light-source actors. */

/** '#rrggbb' → [r, g, b] in 0..1. */
export function hexToRgb01(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return [1, 1, 1];
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function rgb01ToHex(rgb) {
  const c = (x) => Math.max(0, Math.min(255, Math.round(x * 255))).toString(16).padStart(2, '0');
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}

/**
 * Black-body colour for a temperature in Kelvin (Tanner Helland's fit),
 * 1000–40000 K, as [r, g, b] in 0..1.
 */
export function kelvinToRgb01(kelvin) {
  const t = Math.min(40000, Math.max(1000, Number(kelvin) || 6500)) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * ((t - 60) ** -0.1332047592);
    g = 288.1221695283 * ((t - 60) ** -0.0755148492);
    b = 255;
  }
  const c = (x) => Math.max(0, Math.min(255, x)) / 255;
  return [c(r), c(g), c(b)];
}

/** Effective [r, g, b] for a light definition (colour or temperature mode). */
export function lightRgb(light) {
  if (!light) return [1, 1, 1];
  return light.useTemperature ? kelvinToRgb01(light.temperature) : hexToRgb01(light.color);
}

export const DEFAULT_LIGHT = {
  type: 'point',           // 'point' | 'spot' | 'ambient'
  color: '#ffd8a8',
  temperature: 4500,
  useTemperature: false,
  intensity: 1.5,
  radius: 25,
  cone: 35,                // spot half-angle, degrees
};
