import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// A text field that offers what is already in use — the export dialog's args
// field cut down to one value. Click in or type and the categories the saved
// mixes use drop down, narrowed by what is typed; arrows and Enter, or a click,
// take one; anything else stays as typed. The menu is portaled and fixed: the
// field sits in the timeline window, which clips its overflow. An option is its
// text, or `{ value, badge }` with a note drawn at the row's end (the keep lane's
// routine field says where each routine lives); typing matches either.

const MENU_H = 200;   // room the menu wants below the field before it flips above

export function CategoryInput({ value = '', onChange, options = [], placeholder = 'Category', className = '', maxLength = 40 }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);   // the arrowed row; -1 = none, so Enter never takes a stray first row
  const [box, setBox] = useState(null);       // where the field is while the menu is up
  // Opened by a click or focus, the menu lists every category — the field may
  // already hold one, and the point is to switch. Typing narrows it.
  const [typed, setTyped] = useState(false);
  const inputRef = useRef(null);
  const menuRef = useRef(null);

  const items = useMemo(() => options.map((o) => (typeof o === 'string' ? { value: o } : o)), [options]);
  const shown = useMemo(() => {
    const q = typed ? value.trim().toLowerCase() : '';
    return q ? items.filter((o) => `${o.value} ${o.badge ?? ''}`.toLowerCase().includes(q)) : items;
  }, [items, value, typed]);

  // Under the field, or above it when the field sits too low; follows a resize or a scroll.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = inputRef.current?.getBoundingClientRect();
      if (!r) return;
      const up = window.innerHeight - r.bottom < MENU_H && r.top > MENU_H;
      setBox({ left: r.left, width: r.width, top: r.bottom + 4, bottom: window.innerHeight - r.top + 4, up });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => { setActive(-1); }, [value, open]);
  useEffect(() => {
    if (!open || active < 0) return;
    menuRef.current?.querySelector('.combo-option[data-focus]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const pick = (opt) => {
    onChange?.(opt);
    setTyped(false);
    setOpen(false);
    inputRef.current?.focus();
  };
  const show = () => { setTyped(false); setOpen(true); };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (!shown.length) return;
      setActive((i) => {
        if (e.key === 'ArrowDown') return i < 0 || i >= shown.length - 1 ? 0 : i + 1;
        return i <= 0 ? shown.length - 1 : i - 1;
      });
      return;
    }
    if (e.key === 'Enter') {
      if (open && active >= 0 && shown[active] != null) { e.preventDefault(); pick(shown[active].value); }
      else setOpen(false);
      return;
    }
    if (e.key === 'Escape' && open) {
      // Ours to close; with no menu up, Escape belongs to whatever is around us.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  const menu = open && box && shown.length > 0 && createPortal(
    <div
      ref={menuRef}
      className="combo-options cat-menu"
      style={{ left: box.left, width: box.width, ...(box.up ? { bottom: box.bottom } : { top: box.top }) }}
      // A press on the menu must not blur the field, which would close the menu before the click lands.
      onMouseDown={(e) => e.preventDefault()}
    >
      {shown.map((opt, i) => (
        <div
          key={opt.value}
          className="combo-option"
          data-focus={i === active ? '' : undefined}
          data-selected={opt.value === value.trim() ? '' : undefined}
          onMouseEnter={() => setActive(i)}
          onClick={() => pick(opt.value)}
        >
          {opt.value}
          {opt.badge && <span className="opt-badge">{opt.badge}</span>}
        </div>
      ))}
    </div>,
    document.body,
  );

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        className={className}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        maxLength={maxLength}
        onChange={(e) => { onChange?.(e.target.value); setTyped(true); setOpen(true); }}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onMouseDown={show}
        onKeyDown={onKeyDown}
      />
      {menu || null}
    </>
  );
}
