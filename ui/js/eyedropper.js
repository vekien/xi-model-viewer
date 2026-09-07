// The app's own eyedropper.
//
// Chromium draws a droplet inside the native `<input type="color">` picker, but the
// picking itself is the embedder's job (`WebContentsViewDelegate::CreateEyeDropper`).
// WebView2 ships no eyedropper, so that button — and `window.EyeDropper` with it —
// silently do nothing. So we drive our own: click the droplet, move the cursor
// anywhere on screen with a magnified loupe following it, and click again to take the
// pixel under the crosshair.
//
// The committing click usually lands outside the page — over another window, or over
// the app's own WebGL canvas — so the Rust side (src-tauri/src/eyedropper.rs) reports
// the physical mouse state alongside the pixels and we watch that. A transparent veil
// over the window swallows the click when it does land on our own UI, so it cannot
// press whatever sits underneath.
//
// Browser dev mode has no screen access and defers to the real `EyeDropper` API,
// which Chrome does implement.

import { backend } from './backend.js';

/** Half-width of the sampled square, in screen pixels — 17x17 around the cursor. */
const RADIUS = 8;
/** Loupe magnification: one sampled pixel becomes this many CSS pixels. */
const ZOOM = 9;
/** Keep the loupe this far from the cursor so it never covers what we are sampling. */
const GAP = 28;

/**
 * How this build can pick a colour: `'screen'` (Tauri — anywhere on the desktop),
 * `'native'` (browser `EyeDropper`), or null when neither is available.
 */
export function eyedropperKind() {
  if (window.__TAURI__) return 'screen';
  if (typeof window.EyeDropper === 'function') return 'native';
  return null;
}

/** True while a pick is in progress — outside-click handlers should sit it out. */
export function isPicking() {
  return document.body.classList.contains('eyedrop-picking');
}

/**
 * Begin a click-to-pick session. `at` seeds where the loupe first appears (the client
 * coordinates of the click that started it). Returns a cancel function.
 */
export function startScreenEyedropper({ onPick, onCancel, at } = {}) {
  const loupe = makeLoupe();
  const veil = document.createElement('div');
  veil.className = 'eyedrop-veil';

  let pos = at ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  let hex = null;
  let timer = 0;
  let done = false;
  // The veil and the polling loop can both spot the committing click; whichever gets
  // there first owns it.
  let committing = false;
  // The click that opened the session may still be held; only start watching for the
  // committing one once the button has come back up.
  let armed = false;

  document.body.append(veil, loupe.el);
  document.body.classList.add('eyedrop-picking');

  const onMove = (e) => { pos = { x: e.clientX, y: e.clientY }; };
  const onVeilDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!armed) return;
    if (e.button === 0) commit();
    else cancel();
  };
  // Swallow everything else the click would otherwise set off underneath.
  const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };

  veil.addEventListener('pointermove', onMove);
  veil.addEventListener('pointerdown', onVeilDown, true);
  veil.addEventListener('pointerup', swallow, true);
  veil.addEventListener('click', swallow, true);
  veil.addEventListener('contextmenu', swallow, true);
  window.addEventListener('keydown', onKey, true);

  // One sample per tick, serialised on the IPC round trip so a slow grab throttles the
  // loop instead of queueing behind itself. A timer rather than rAF: the committing
  // click often happens with the cursor over another window, and rAF stops dead the
  // moment ours stops being visible, which would strand the session.
  const tick = async () => {
    if (done) return;
    let shot;
    try {
      shot = await backend.screenPick(RADIUS);
    } catch (err) {
      cancel(err);
      return;
    }
    if (done) return;

    hex = shot.hex;
    loupe.draw(shot, pos);

    if (shot.right || shot.escape) { cancel(); return; }
    if (!armed) armed = !shot.left;
    else if (shot.left) { commit(); return; }

    timer = setTimeout(tick, 16);
  };
  timer = setTimeout(tick, 16);

  function end() {
    done = true;
    clearTimeout(timer);
    veil.removeEventListener('pointermove', onMove);
    veil.removeEventListener('pointerdown', onVeilDown, true);
    veil.removeEventListener('pointerup', swallow, true);
    veil.removeEventListener('click', swallow, true);
    veil.removeEventListener('contextmenu', swallow, true);
    window.removeEventListener('keydown', onKey, true);
    veil.remove();
    loupe.el.remove();
    document.body.classList.remove('eyedrop-picking');
  }

  // Re-sample on commit rather than trusting the last frame: if the loop stalled (an
  // occluded window throttles rAF) the preview can lag the cursor.
  async function commit() {
    if (done || committing) return;
    committing = true;
    let final = hex;
    try {
      final = (await backend.screenPick(0)).hex;
    } catch { /* keep whatever the loupe last showed */ }
    end();
    if (final) onPick?.(final);
    else onCancel?.();
  }

  function cancel(err) {
    if (done) return;
    end();
    onCancel?.(err);
  }

  return cancel;
}

/** A magnified view of the sampled square, floating beside the cursor. */
function makeLoupe() {
  const el = document.createElement('div');
  el.className = 'eyedrop-loupe';
  const canvas = document.createElement('canvas');
  canvas.className = 'eyedrop-loupe-view';
  const label = document.createElement('div');
  label.className = 'eyedrop-loupe-hex mono';
  el.append(canvas, label);

  const ctx = canvas.getContext('2d');
  const buf = document.createElement('canvas');
  const bctx = buf.getContext('2d');
  let img = null;

  return {
    el,
    draw(shot, at) {
      const { size, pixels, hex } = shot;
      if (buf.width !== size) {
        buf.width = size;
        buf.height = size;
        img = bctx.createImageData(size, size);
      }
      const d = img.data;
      for (let i = 0; i < pixels.length; i++) {
        const p = pixels[i];
        d[i * 4] = (p >> 16) & 255;
        d[i * 4 + 1] = (p >> 8) & 255;
        d[i * 4 + 2] = p & 255;
        d[i * 4 + 3] = 255;
      }
      bctx.putImageData(img, 0, 0);

      const side = size * ZOOM;
      if (canvas.width !== side) {
        canvas.width = side;
        canvas.height = side;
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(buf, 0, 0, side, side);

      // Ring the centre cell — that is the pixel a click commits.
      const c = ((size - 1) / 2) * ZOOM;
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      ctx.strokeRect(c - 0.5, c - 0.5, ZOOM + 1, ZOOM + 1);
      ctx.strokeStyle = '#fff';
      ctx.strokeRect(c + 0.5, c + 0.5, ZOOM - 1, ZOOM - 1);

      label.textContent = hex.toUpperCase();
      el.style.setProperty('--pick', hex);
      place(el, at);
    },
  };
}

/** Park the loupe near the cursor, flipped and clamped to stay inside the window. */
function place(el, at) {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let x = at.x + GAP;
  let y = at.y + GAP;
  if (x + w > window.innerWidth) x = at.x - GAP - w;
  if (y + h > window.innerHeight) y = at.y - GAP - h;
  x = Math.max(4, Math.min(x, window.innerWidth - w - 4));
  y = Math.max(4, Math.min(y, window.innerHeight - h - 4));
  el.style.transform = `translate(${x}px, ${y}px)`;
}
