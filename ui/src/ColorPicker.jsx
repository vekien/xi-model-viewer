import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { hsvToRgb, parseHex, rgbToHsv, toHex } from '../js/color.js';
import { Tooltip } from './Tooltip.jsx';
import { EyeDropperButton } from './EyeDropperButton.jsx';
import { isPicking } from '../js/eyedropper.js';

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/**
 * A colour swatch that opens the app's own picker.
 *
 * Replaces `<input type="color">`: the native picker is drawn by the webview, and
 * under WebView2 its eyedropper is a dead button (see ui/js/eyedropper.js), which
 * left the working droplet stranded outside the popup. Ours carries the droplet
 * next to the hex field where it belongs.
 *
 * The button keeps whatever shape the caller gives it — `--swatch` carries the
 * current colour, so a class can paint it edge to edge, inset it, or ignore it and
 * show an icon instead.
 */
export function ColorSwatch({
  value,
  onChange,
  className = '',
  style,
  children,
  tooltip,
  placement,
  appendTo,
  title,
  disabled,
  ...rest
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <Tooltip content={tooltip} placement={placement} appendTo={appendTo} disabled={open}>
        <button
          type="button"
          ref={btn}
          className={`color-swatch${open ? ' open' : ''}${className ? ` ${className}` : ''}`}
          style={{ '--swatch': value || 'transparent', ...style }}
          aria-label={title ?? tooltip}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          {...rest}
        >
          {children}
        </button>
      </Tooltip>
      {open && (
        <ColorPopover anchor={btn} value={value} onChange={onChange} onClose={close} />
      )}
    </>
  );
}

function ColorPopover({ anchor, value, onChange, onClose }) {
  const pop = useRef(null);
  const sv = useRef(null);
  const hue = useRef(null);
  const [pos, setPos] = useState(null);
  const [hsv, setHsv] = useState(() => rgbToHsv(parseHex(value) ?? { r: 0, g: 0, b: 0 }));
  const [draft, setDraft] = useState(null);   // hex being typed; null = show the live value
  const emitted = useRef(null);

  const rgb = hsvToRgb(hsv);
  const hex = toHex(rgb);

  // Follow the value when something outside the popover changes it — but ignore the
  // echo of our own last emit, which would otherwise flatten hue on greys and black.
  useEffect(() => {
    if (!value || value.toLowerCase() === emitted.current) return;
    const next = parseHex(value);
    if (next) setHsv(rgbToHsv(next));
  }, [value]);

  const emit = useCallback((next) => {
    setHsv(next);
    const out = toHex(hsvToRgb(next));
    emitted.current = out;
    onChange?.(out);
  }, [onChange]);

  // Hue and saturation are undefined for black and for greys, so carry the ones the
  // popover already holds rather than letting a drag through black reset the wheel.
  const fromRgb = useCallback((next) => {
    if (!next) return;
    const n = rgbToHsv(next);
    if (n.v === 0) emit({ h: hsv.h, s: hsv.s, v: 0 });
    else if (n.s === 0) emit({ h: hsv.h, s: 0, v: n.v });
    else emit(n);
  }, [emit, hsv.h, hsv.s]);

  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const box = pop.current?.getBoundingClientRect();
      if (!a || !box) return;
      let left = a.left;
      let top = a.bottom + 6;
      if (left + box.width > window.innerWidth - 8) left = window.innerWidth - box.width - 8;
      if (top + box.height > window.innerHeight - 8) top = a.top - box.height - 6;
      setPos({ left: Math.max(8, left), top: Math.max(8, top) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor]);

  useEffect(() => {
    const onDown = (e) => {
      if (isPicking()) return;                          // the eyedropper's veil, not a click away
      if (pop.current?.contains(e.target)) return;
      if (anchor.current?.contains(e.target)) return;   // the trigger toggles itself
      onClose();
    };
    // Capture, so a modal that closes on Escape does not go with the popover. The
    // eyedropper listens on window and stops propagation, so a drag in progress
    // swallows its own Escape.
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, onClose]);

  // The popover portals to <body>, so every "close on outside pointerdown" handler in
  // the app would otherwise read a drag on the saturation square as a click away, and
  // shut the panel we are anchored to.
  const keepOpen = (e) => e.stopPropagation();

  const dragSv = (e) => {
    const r = sv.current.getBoundingClientRect();
    emit({
      h: hsv.h,
      s: clamp01((e.clientX - r.left) / r.width),
      v: 1 - clamp01((e.clientY - r.top) / r.height),
    });
  };

  const dragHue = (e) => {
    const r = hue.current.getBoundingClientRect();
    emit({ ...hsv, h: clamp01((e.clientX - r.left) / r.width) * 360 });
  };

  const grab = (move) => ({
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }
      move(e);
    },
    onPointerMove: (e) => { if (e.buttons & 1) move(e); },
  });

  const setChannel = (key, raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    fromRgb({ ...rgb, [key]: Math.max(0, Math.min(255, Math.round(n))) });
  };

  return createPortal(
    <div
      ref={pop}
      className="color-pop"
      role="dialog"
      aria-label="Colour picker"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      onPointerDown={keepOpen}
    >
      <div
        ref={sv}
        className="cp-sv"
        style={{ '--hue': `hsl(${hsv.h} 100% 50%)` }}
        {...grab(dragSv)}
      >
        <span
          className="cp-sv-thumb"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }}
        />
      </div>

      <div ref={hue} className="cp-hue" {...grab(dragHue)}>
        <span className="cp-hue-thumb" style={{ left: `${(hsv.h / 360) * 100}%` }} />
      </div>

      <div className="cp-row">
        <EyeDropperButton onPick={(picked) => fromRgb(parseHex(picked))} placement="top" />
        <span className="cp-chip" style={{ background: hex }} />
        <input
          type="text"
          className="cp-hex mono"
          value={draft ?? hex}
          spellCheck={false}
          aria-label="Hex colour"
          onChange={(e) => {
            setDraft(e.target.value);
            fromRgb(parseHex(e.target.value));
          }}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => { if (e.key === 'Enter') setDraft(null); }}
        />
      </div>

      <div className="cp-row cp-rgb">
        {['r', 'g', 'b'].map((k) => (
          <label key={k} className="cp-chan">
            <span>{k.toUpperCase()}</span>
            <input
              type="number"
              min="0"
              max="255"
              className="mono"
              value={rgb[k]}
              onChange={(e) => setChannel(k, e.target.value)}
            />
          </label>
        ))}
      </div>
    </div>,
    document.body,
  );
}
