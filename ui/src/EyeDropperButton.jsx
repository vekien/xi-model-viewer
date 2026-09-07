import { useState } from 'react';
import { Tooltip } from './Tooltip.jsx';
import { eyedropperKind, startScreenEyedropper } from '../js/eyedropper.js';

const HINT = {
  screen: 'Pick a colour — click, then click the pixel you want',
  native: 'Pick a colour from the screen',
};

/**
 * Droplet that samples a colour from the screen, for the colour picker's bottom row.
 * The droplet inside Chromium's own picker is inert under WebView2, so this drives
 * ours instead — see ui/js/eyedropper.js.
 *
 * Renders nothing where no eyedropper is available, rather than offering a dead
 * button of our own.
 */
export function EyeDropperButton({ onPick, className = '', tooltip, placement, appendTo, disabled }) {
  const kind = eyedropperKind();
  const [picking, setPicking] = useState(false);
  if (!kind) return null;

  const onClick = async (e) => {
    if (disabled || picking) return;
    e.stopPropagation();
    setPicking(true);

    if (kind === 'screen') {
      startScreenEyedropper({
        at: { x: e.clientX, y: e.clientY },
        onPick: (hex) => { setPicking(false); onPick?.(hex); },
        onCancel: () => setPicking(false),
      });
      return;
    }

    // Browser dev mode: the native API runs its own full-screen overlay.
    try {
      const res = await new window.EyeDropper().open();
      if (res?.sRGBHex) onPick?.(res.sRGBHex);
    } catch { /* dismissed with Escape */ }
    setPicking(false);
  };

  return (
    <Tooltip content={tooltip ?? HINT[kind]} placement={placement} appendTo={appendTo}>
      <button
        type="button"
        className={`eyedrop-btn${picking ? ' picking' : ''}${className ? ` ${className}` : ''}`}
        aria-label="Pick a colour from the screen"
        disabled={disabled}
        onClick={onClick}
      >
        <span className="icon">colorize</span>
      </button>
    </Tooltip>
  );
}
