// Whole-UI zoom from Settings › Options. 1 = 100%, snapped to 5% steps.
export const UI_SCALE_MIN = 0.2;
export const UI_SCALE_MAX = 2;

export function clampUiScale(v) {
  if (v == null || v === '') return 1;
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.round(Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, n)) * 20) / 20;
}

// Slider position t ∈ [-100, 100] with 1× dead centre: the left half spans
// MIN..1, the right half 1..MAX, so the two sides have different gearing.
export function uiScaleToSlider(scale) {
  const s = clampUiScale(scale);
  return s < 1 ? ((s - 1) / (1 - UI_SCALE_MIN)) * 100 : ((s - 1) / (UI_SCALE_MAX - 1)) * 100;
}
export function sliderToUiScale(t) {
  const n = Math.min(100, Math.max(-100, Number(t) || 0));
  return clampUiScale(n < 0 ? 1 + (n / 100) * (1 - UI_SCALE_MIN) : 1 + (n / 100) * (UI_SCALE_MAX - 1));
}
