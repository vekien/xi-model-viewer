import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Tooltip } from './Tooltip.jsx';
import {
  addToken, findArg, pickableArgs, removeFlag, splitToken, tokenFlag,
} from './exportArgs.js';

// Tags-style entry for xi-tools CLI flags. Click in and the picker lists every
// arg the command takes (grouped, with its help text); typing filters it;
// Enter or a click commits the highlighted one as a chip.
//
// Args that need a value are a two-beat pick: choosing `--lod` writes
// "--lod " back into the field rather than committing, and the picker switches
// to that arg's suggested values — so the panel never has to survive a select.
// Anything typed that isn't in the catalog still commits, as an "unknown" chip,
// because xi grows flags faster than this list does.

const VALUE_RE = /^(--[a-z0-9][a-z0-9-]*)[\s=]+(.*)$/i;

function matches(hay, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const text = hay.toLowerCase();
  return q.split(/\s+/).every((t) => text.includes(t));
}

/**
 * How well `arg` answers `query`, high to low; 0 = no match. Name beats prose,
 * so "split" lands on --split-tex rather than --no-weld, whose help text
 * happens to mention "splitting".
 */
function score(arg, query) {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const flag = arg.flag.toLowerCase();
  const label = arg.label.toLowerCase();
  if (flag.replace(/^-+/, '').startsWith(q.replace(/^-+/, ''))) return 4;
  if (flag.includes(q)) return 3;
  if (label.includes(q)) return 2;
  return matches(`${arg.flag} ${arg.label} ${arg.hint ?? ''}`, q) ? 1 : 0;
}

/**
 * Rows for the panel. Unfiltered it keeps the catalog's grouping; searching
 * flattens it and sorts by relevance, because a group header between two hits
 * only gets in the way of arrowing to the one you meant.
 */
function argRows(args, query) {
  const q = query.trim();
  const hits = args.map((arg) => ({ arg, s: score(arg, q) })).filter((h) => h.s > 0);
  if (q) {
    return hits
      .sort((a, b) => b.s - a.s)
      .map(({ arg }) => ({ kind: 'arg', arg, key: arg.flag }));
  }
  const rows = [];
  let group = null;
  for (const { arg } of hits) {
    if (arg.group && arg.group !== group) rows.push({ kind: 'group', label: arg.group });
    group = arg.group;
    rows.push({ kind: 'arg', arg, key: arg.flag });
  }
  return rows;
}

function valueRows(arg, values, query) {
  return values
    .filter((v) => matches(`${v.value} ${v.label ?? ''}`, query))
    .map((v) => ({ kind: 'value', arg, value: String(v.value), label: v.label, key: `${arg.flag}=${v.value}` }));
}

/**
 * @param {string} type        catalog key — 'mesh' | 'zone' | 'anim' | 'fx' | 'music' | 'sfx'
 * @param {string[]} tokens    committed args, one whole `--flag value` per entry
 * @param {(next: string[]) => void} onChange
 * @param {Record<string, {value: string, label?: string}[]>} [dynamicValues]
 *        per-flag completions only the caller knows (the model's animation ids)
 */
export function ArgsInput({ type, tokens, onChange, dynamicValues, placeholder = 'Add an argument…' }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Enter only picks a row the user actually aimed at — arrowed to, or narrowed
  // down by typing. Otherwise opening the panel and hitting Enter would add
  // whatever happened to be first.
  const [aimed, setAimed] = useState(false);
  const [flip, setFlip] = useState(false);
  const inputRef = useRef(null);
  const wrapRef = useRef(null);
  const menuRef = useRef(null);

  const args = useMemo(() => pickableArgs(type), [type]);

  // A query of "--flag " switches the panel to that flag's value suggestions.
  const pending = useMemo(() => {
    const m = query.match(VALUE_RE);
    if (!m) return null;
    const arg = findArg(type, m[1]);
    if (!arg || arg.kind === 'flag') return null;
    return { arg, rest: m[2] };
  }, [query, type]);

  const rows = useMemo(() => {
    if (!pending) return argRows(args, query);
    const vals = dynamicValues?.[pending.arg.flag] ?? pending.arg.values ?? [];
    return valueRows(pending.arg, vals, pending.rest);
  }, [args, dynamicValues, pending, query]);

  const pickable = useMemo(() => rows.filter((r) => r.kind !== 'group'), [rows]);
  const has = useMemo(() => new Set(tokens.map(tokenFlag)), [tokens]);
  const activeKey = pickable[active]?.key;

  useEffect(() => { setActive(0); setAimed(false); }, [query]);
  useEffect(() => { if (!open) setAimed(false); }, [open]);

  // Drop the panel upwards when the field sits too low for it to fit.
  useLayoutEffect(() => {
    if (!open) return;
    const box = wrapRef.current?.getBoundingClientRect();
    if (box) setFlip(window.innerHeight - box.bottom < 200 && box.top > 220);
  }, [open, rows.length]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector('.combo-option[data-focus]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeKey, open]);

  /** @returns false when the text isn't a usable arg yet (a bare `--anim`). */
  const commit = (text) => {
    const t = String(text ?? '').trim();
    if (!t) return true;
    const token = t.startsWith('-') ? t : `--${t.replace(/^-+/, '')}`;
    const { flag, value } = splitToken(token);
    // xi would just error out on `--anim` with nothing after it.
    if (!value && findArg(type, flag)?.kind === 'value') return false;
    onChange(addToken(type, tokens, token));
    setQuery('');
    setActive(0);
    return true;
  };

  const choose = (row) => {
    if (row.kind === 'value') {
      commit(`${row.arg.flag} ${row.value}`);
    } else if (row.arg.kind === 'flag') {
      // Already on the list → picking it again takes it off, so the panel
      // reads as the set of flags rather than an add-only menu.
      if (has.has(row.arg.flag)) onChange(removeFlag(tokens, row.arg.flag));
      else commit(row.arg.flag);
      setQuery('');
    } else {
      // Needs a value: hand the flag back to the field so the picker can offer
      // its values (or the user can just type one) before anything is committed.
      setQuery(`${row.arg.flag} ${row.arg.defaultHint ?? ''}`);
      setActive(0);
    }
    inputRef.current?.focus();
    setOpen(true);
  };

  /** Pop a chip back into the field so its value can be edited in place. */
  const editChip = (token) => {
    onChange(removeFlag(tokens, tokenFlag(token)));
    setQuery(token);
    setOpen(true);
    inputRef.current?.focus();
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (!pickable.length) return;
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + dir + pickable.length) % pickable.length);
      setAimed(true);
      return;
    }
    if (e.key === 'Enter' || (e.key === 'Tab' && query.trim() && pickable.length)) {
      if (e.key === 'Enter' && !query.trim() && !aimed) return;
      e.preventDefault();
      if (open && (aimed || query.trim()) && pickable[active]) choose(pickable[active]);
      else commit(query);
      return;
    }
    if (e.key === 'Escape') {
      // Only swallow it while there's something of our own to dismiss —
      // otherwise Escape should still close the dialog.
      if (!query && !open) return;
      e.preventDefault();
      e.stopPropagation();
      if (query) setQuery('');
      else setOpen(false);
      return;
    }
    if (e.key === 'Backspace' && !query && tokens.length) {
      e.preventDefault();
      editChip(tokens[tokens.length - 1]);
    }
  };

  return (
    <div
      className="args-field"
      ref={wrapRef}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget)) return;
        // Half-typed text would silently not be exported; keep it as a chip —
        // unless it can't be one yet, in which case drop it rather than leave
        // a stray fragment sitting in a field nobody is looking at.
        if (query.trim() && !commit(query)) setQuery('');
        setOpen(false);
      }}
    >
      <div
        className={`args-box${open ? ' open' : ''}`}
        onMouseDown={(e) => {
          if (e.target.closest('.arg-chip')) return;
          e.preventDefault();
          inputRef.current?.focus();
          setOpen(true);
        }}
      >
        {tokens.map((token) => {
          const { flag, value } = splitToken(token);
          const arg = findArg(type, flag);
          const tip = arg
            ? `${arg.label}${arg.hint ? ` — ${arg.hint}` : ''}`
            : 'Not a known flag for this command — it is passed to xi as typed.';
          return (
            <span key={token} className={`arg-chip${arg ? '' : ' unknown'}${arg?.managed ? ' managed' : ''}`}>
              <Tooltip content={`${tip}\n\nClick to edit.`}>
                <button type="button" className="arg-chip-text" onClick={() => editChip(token)}>
                  <span className="arg-chip-flag">{flag}</span>
                  {value && <span className="arg-chip-value">{value}</span>}
                </button>
              </Tooltip>
              <Tooltip content="Remove">
                <button
                  type="button"
                  className="arg-chip-x"
                  aria-label={`Remove ${flag}`}
                  onClick={() => { onChange(removeFlag(tokens, flag)); inputRef.current?.focus(); }}
                >
                  <span className="icon">close</span>
                </button>
              </Tooltip>
            </span>
          );
        })}
        <input
          ref={inputRef}
          className="args-entry"
          type="text"
          value={query}
          spellCheck={false}
          autoComplete="off"
          placeholder={tokens.length ? '' : placeholder}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
      </div>
      <span className="icon combo-chevron args-chevron">unfold_more</span>

      {open && (
        <div ref={menuRef} className={`combo-options args-menu${flip ? ' up' : ''}`}>
          {pending && (
            <div className="combo-back args-menu-head">
              <span className="icon">chevron_left</span>
              {pending.arg.flag} · {pending.arg.label}
            </div>
          )}
          {rows.length === 0 && (
            <div className="combo-empty">
              {pending
                ? `Type a value for ${pending.arg.flag}, then press Enter.`
                : query.trim()
                  ? `No match — Enter adds “${query.trim()}” as typed.`
                  : 'No arguments for this command.'}
            </div>
          )}
          {rows.map((row) => (
            row.kind === 'group'
              ? <div key={`g${row.label}`} className="combo-group">{row.label}</div>
              : (
                <div
                  key={row.key}
                  className="combo-option args-option"
                  data-focus={row.key === activeKey ? '' : undefined}
                  data-selected={row.kind === 'arg' && has.has(row.arg.flag) ? '' : undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => { setActive(pickable.findIndex((r) => r.key === row.key)); setAimed(true); }}
                  onClick={() => choose(row)}
                >
                  <span className="args-option-flag">
                    {row.kind === 'value' ? row.value : row.arg.flag}
                  </span>
                  <span className="args-option-text">
                    {row.kind === 'value' ? (row.label ?? '') : row.arg.label}
                  </span>
                  {row.kind === 'arg' && has.has(row.arg.flag) && (
                    <span className="icon args-option-on">check</span>
                  )}
                  {row.kind === 'arg' && !has.has(row.arg.flag) && row.arg.kind !== 'flag' && (
                    <span className="opt-badge">value</span>
                  )}
                </div>
              )
          ))}
          {!pending && rows.length > 0 && (
            <div className="args-menu-foot">
              {(rows.find((r) => r.key === activeKey)?.arg?.hint) || 'Enter to add · Backspace to edit the last'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
