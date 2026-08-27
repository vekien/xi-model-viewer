import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { Tooltip } from './Tooltip.jsx';
import {
  getNote, loadNotes, setNote,
  uiEgSectionKey,
} from '../js/notes.js';

/**
 * Draggable inspector for a 0x31 UiElementGroup — set header + sprite layout rows
 * (owner / parent / dest / src). Free-text notes per group (AppData notes.json).
 */
export function UiElementGroupModal({
  group, title = 'UiElementGroup', onClose, onFocus, zIndex = 2130,
}) {
  const panelRef = useRef(null);
  const dragState = useRef(null);
  const notesDirtyRef = useRef(false);
  const [pos, setPos] = useState(null);
  const [query, setQuery] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [notesOpen, setNotesOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [notesTick, setNotesTick] = useState(0);
  const [notesSaving, setNotesSaving] = useState(false);

  const sectionKey = useMemo(() => uiEgSectionKey(group), [group]);

  useEffect(() => {
    notesDirtyRef.current = false;
    setNotesOpen(false);
    loadNotes().catch(() => {});
  }, [sectionKey]);

  useEffect(() => {
    if (!notesOpen) return;
    if (notesDirtyRef.current) return;
    setNoteDraft(getNote(sectionKey));
  }, [notesOpen, sectionKey, notesTick]);

  if (!group) return null;

  const owners = group.owners || [];
  const sprites = group.sprites || [];

  const rows = useMemo(() => {
    let list = sprites;
    if (ownerFilter) {
      const o = ownerFilter.toLowerCase();
      list = list.filter((s) => (s.owner || '').toLowerCase() === o);
    }
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((s) => (
        (s.owner || '').toLowerCase().includes(q)
        || (s.header || '').toLowerCase().includes(q)
        || (s.parent || '').toLowerCase().includes(q)
        || `0x${(s.offset >>> 0).toString(16)}`.includes(q)
      ));
    }
    return list;
  }, [sprites, ownerFilter, query]);

  const meta = [
    group.setLabel || title,
    `${sprites.length} sprites`,
    group.textureRef ? `tex ${group.textureRef}` : null,
  ].filter(Boolean).join(' · ');

  void notesTick;
  const sectionNote = getNote(sectionKey);

  const startDrag = (e) => {
    onFocus?.();
    if (e.target.closest('button, input, a, select, textarea, [role="button"]')) return;
    const rect = panelRef.current.getBoundingClientRect();
    dragState.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDrag = (e) => {
    if (!dragState.current) return;
    setPos(clamp({
      x: e.clientX - dragState.current.dx,
      y: e.clientY - dragState.current.dy,
    }, panelRef.current));
  };
  const endDrag = () => { dragState.current = null; };

  const saveNotesPanel = async () => {
    setNotesSaving(true);
    try {
      await setNote(sectionKey, noteDraft);
      notesDirtyRef.current = false;
      setNotesTick((n) => n + 1);
    } finally {
      setNotesSaving(false);
    }
  };

  const toggleNotes = () => {
    setNotesOpen((v) => {
      const next = !v;
      if (next && !notesDirtyRef.current) setNoteDraft(getNote(sectionKey));
      return next;
    });
  };

  const style = pos
    ? {
      position: 'fixed', left: pos.x, top: pos.y, transform: 'none', zIndex,
      width: 'min(920px, 96vw)', maxHeight: 'min(78vh, 640px)',
    }
    : {
      position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex,
      width: 'min(920px, 96vw)', maxHeight: 'min(78vh, 640px)',
    };

  return (
    <div className="zdef-modal uieg-modal" ref={panelRef} style={style} onPointerDown={onFocus}>
      <div
        className="modal-header"
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
      >
        <span className="icon">widgets</span>
        <span className="modal-title mono">{title}</span>
        <span className="route-count mono">{meta}</span>
        <Button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="Close">
          <span className="icon">close</span>
        </Button>
      </div>

      <div className="uieg-toolbar uimenu-toolbar">
        <div className="uieg-meta mono-small">
          <span>set <b>{group.setLabel || '—'}</b></span>
          <span>texture ref <b>{group.textureRef || '—'}</b></span>
          <span>section <b>{group.id || '—'}</b> @0x{(group.offset >>> 0).toString(16)}</span>
        </div>
        <div className="uimenu-actions">
          <Button
            type="button"
            className={`uimenu-btn${notesOpen ? ' on' : ''}${sectionNote || notesDirtyRef.current ? ' has-note' : ''}`}
            onClick={toggleNotes}
            title="Free-text notes for this UiElementGroup"
          >
            Notes
          </Button>
        </div>
      </div>

      <div className="uieg-toolbar">
        <div className="uieg-filters">
          <select
            className="uieg-select mono"
            value={ownerFilter}
            onChange={(e) => setOwnerFilter(e.target.value)}
            title="Filter by atlas owner"
          >
            <option value="">All owners ({sprites.length})</option>
            {owners.map((o) => (
              <option key={o.name} value={o.name}>{o.name} ({o.count})</option>
            ))}
          </select>
          <input
            type="search"
            className="uieg-search mono"
            placeholder="Filter owner / header / offset…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
        </div>
      </div>

      {notesOpen && (
        <div className="uimenu-notes">
          <div className="uimenu-notes-head">
            <span className="uimenu-notes-title">Notes · {title}</span>
            <div className="uimenu-notes-actions">
              <Button
                type="button"
                className="uimenu-btn active"
                disabled={notesSaving}
                onClick={saveNotesPanel}
              >
                {notesSaving ? 'Saving…' : 'Save notes'}
              </Button>
            </div>
          </div>
          <textarea
            className="uimenu-notepad"
            spellCheck={false}
            rows={6}
            placeholder={`Notes for ${title} — free text for this UiElementGroup…`}
            value={noteDraft}
            onChange={(e) => {
              notesDirtyRef.current = true;
              setNoteDraft(e.target.value);
            }}
          />
        </div>
      )}

      <div className="zdef-table-wrap">
        <table className="zdef-table">
          <thead>
            <tr>
              <ThTip label="#" tip="Sprite index in this UiElementGroup (0-based)." />
              <ThTip
                label="Owner"
                tip="Texture atlas this sprite samples (e.g. titlwin). Filter by owner to list one atlas."
              />
              <ThTip label="Header" tip="Per-sprite header / name tag in the layout record." />
              <ThTip label="Parent" tip="Layout parent tag (e.g. menu). Not the same as UiMenu loby." />
              <ThTip
                label="Src W×H"
                tip="Source size on the texture: width × height of the crop in atlas pixels."
              />
              <ThTip
                label="Src XY"
                tip="Source top-left on the texture (atlas pixels, Y down). Example (0,304) = start 304px down from the top of the PNG — not screen position."
              />
              <ThTip
                label="Dest TL"
                tip="Destination top-left on screen (UI layout coords, Y down). Where the upper-left of the drawn quad sits on the title UI."
              />
              <ThTip
                label="Dest BR"
                tip="Destination bottom-right on screen. With Dest TL, defines the on-screen quad (move/scale without changing the texture crop)."
              />
              <ThTip label="Offset" tip="Byte offset of this sprite record in the DAT." />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="zdef-empty">No sprites match</td>
              </tr>
            )}
            {rows.map((s) => (
              <tr key={`${s.offset}-${s.index}`}>
                <td className="mono">{s.index}</td>
                <td className="mono"><b>{s.owner}</b></td>
                <td className="mono">{s.header}</td>
                <td className="mono">{s.parent || '—'}</td>
                <td className="mono">{s.src.w}×{s.src.h}</td>
                <td className="mono">({s.src.x},{s.src.y})</td>
                <td className="mono">({s.dest.x0},{s.dest.y0})</td>
                <td className="mono">({s.dest.x3},{s.dest.y3})</td>
                <td className="mono">0x{(s.offset >>> 0).toString(16)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="uieg-foot mono-small">
        Showing {rows.length.toLocaleString()} / {sprites.length.toLocaleString()} sprites
        {ownerFilter ? ` · owner “${ownerFilter}”` : ''}
      </div>
    </div>
  );
}

function ThTip({ label, tip }) {
  return (
    <th className="mono">
      <Tooltip content={tip} placement="top" delay={[200, 0]} maxWidth={320}>
        <span className="uieg-th-tip">{label}</span>
      </Tooltip>
    </th>
  );
}

function clamp(p, panel) {
  const w = panel?.offsetWidth ?? 480;
  const h = panel?.offsetHeight ?? 320;
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}
