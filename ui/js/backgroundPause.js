/**
 * Graphics > Pause When Unfocused: the draw loops skip their frames while
 * another window has focus, so a viewer left open behind another app stops
 * heating the GPU. WebView2 only throttles a minimised window — one left
 * visible behind something else, or on a second monitor, redraws at the full
 * refresh rate.
 *
 * Pointing at the window still wakes it for a moment, so a hover or a
 * wheel-zoom on a second monitor redraws without clicking in first, and a
 * resize repaints the cleared canvas.
 */

const WAKE_MS = 1000;

let enabled = false;
let wakeUntil = 0;

const wake = () => { wakeUntil = performance.now() + WAKE_MS; };
for (const type of ['pointermove', 'pointerdown', 'wheel', 'resize']) {
  window.addEventListener(type, wake, { capture: true, passive: true });
}

export function setPauseWhenUnfocused(on) {
  enabled = !!on;
}

/** True when a draw loop should skip this frame. */
export function renderPaused(now = performance.now()) {
  return enabled && now > wakeUntil && !document.hasFocus();
}
