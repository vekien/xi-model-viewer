import { useEffect, useRef } from 'react';

/**
 * Up/Down stepping for a clicked-into list.
 *
 * The container carries tabIndex=0, so clicking any row inside focuses it and
 * the arrows land here rather than scrolling the page. Clamped, no wrap —
 * holding Down settles on the last row instead of cycling back to the top.
 *
 * `items` must be the rows actually on screen, in display order; `index` is the
 * selected one (-1 when the selection is filtered out or nothing is picked).
 */
export function listArrowHandler(items, index, onPick) {
  return (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (!items.length) return;
    e.preventDefault();
    // Nothing selected yet: Down starts at the top, Up at the bottom.
    if (index < 0) { onPick(items[e.key === 'ArrowDown' ? 0 : items.length - 1]); return; }
    const next = Math.min(Math.max(index + (e.key === 'ArrowDown' ? 1 : -1), 0), items.length - 1);
    if (next !== index) onPick(items[next]);
  };
}

/**
 * Keeps the selected row in view.
 * @param {*} selected dependency key (changes → scroll)
 * @param {'nearest'|'center'|'start'|'end'} [block='nearest']
 */
export function useScrollIntoView(selected, block = 'nearest') {
  const ref = useRef(null);
  useEffect(() => {
    if (!selected) return undefined;
    // Wait a frame so expand/open state has committed DOM for the row.
    const id = requestAnimationFrame(() => {
      ref.current?.scrollIntoView({ block, inline: 'nearest' });
    });
    return () => cancelAnimationFrame(id);
  }, [selected, block]);
  return ref;
}
