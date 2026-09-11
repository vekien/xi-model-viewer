import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A one-off pointer at something in the UI, shown after first-run setup.
 *
 * Portaled to <body> and fixed-positioned for the same reason the menus are:
 * the side panels are blurred, which makes each its own stacking context, and a
 * balloon parented inside one would be trapped under it.
 *
 * It follows the element it points at rather than hard-coding a spot, so a UI
 * scale change or a resized window can't leave it pointing at nothing. Clicking
 * the balloon dismisses it; so does clicking the thing it points at, which is
 * the whole idea.
 *
 * @param anchor  CSS selector for the element to point at.
 */
export function TutorialBalloon({ open, anchor, title, children, onClose }) {
  const [box, setBox] = useState(null);   // { left, top, arrow }

  const close = useCallback(() => onClose?.(), [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const el = document.querySelector(anchor);
    if (!el) return undefined;

    const measure = () => {
      const r = el.getBoundingClientRect();
      const width = 268;
      const left = Math.min(Math.max(r.left - 8, 8), Math.max(window.innerWidth - width - 8, 8));
      setBox({ left, top: r.bottom + 12, arrow: r.left + r.width / 2 - left });
    };
    measure();

    el.addEventListener('pointerdown', close);
    window.addEventListener('resize', measure);
    // The menubar reflows on a UI-scale change without the window resizing.
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    return () => {
      el.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', measure);
      ro.disconnect();
    };
  }, [open, anchor, close]);

  if (!open || !box) return null;

  return createPortal(
    <div
      className="tutorial-balloon"
      style={{ left: box.left, top: box.top }}
      role="status"
      onClick={close}
    >
      <span className="tutorial-arrow" style={{ left: box.arrow }} aria-hidden="true" />
      <div className="tutorial-head">
        <span className="icon">tips_and_updates</span>
        <strong>{title}</strong>
      </div>
      <div className="tutorial-text">{children}</div>
      <div className="tutorial-actions">
        <button type="button" className="tutorial-got-it" onClick={close}>Got it</button>
      </div>
    </div>,
    document.body,
  );
}
