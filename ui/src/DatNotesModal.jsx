import { useEffect, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { Tooltip } from './Tooltip.jsx';
import {
  getNote, loadNotes, setNote,
} from '../js/notes.js';

/**
 * Free-text notepad for one DAT file (path-keyed).
 * Stored in %LOCALAPPDATA%\XiModelViewer\notes.json under key `dat:…`.
 */
export function DatNotesModal({
  noteKey,
  label = 'DAT',
  closeOnSave = false,
  onClose,
  onFocus,
  zIndex = 2200,
}) {
  const panelRef = useRef(null);
  const dragState = useRef(null);
  const [pos, setPos] = useState(null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setErr('');
    loadNotes().then(() => {
      if (!alive) return;
      setText(getNote(noteKey));
      setTick((n) => n + 1);
    });
    return () => { alive = false; };
  }, [noteKey]);

  if (!noteKey) return null;
  void tick;

  const startDrag = (e) => {
    onFocus?.();
    if (e.target.closest('button, input, textarea, a, [role="button"]')) return;
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

  const save = async () => {
    setSaving(true);
    setErr('');
    try {
      await setNote(noteKey, text);
      setTick((n) => n + 1);
      if (closeOnSave) onClose?.();
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const style = pos
    ? {
      position: 'fixed', left: pos.x, top: pos.y, transform: 'none', zIndex,
      width: 'min(480px, 94vw)', maxHeight: 'min(70vh, 520px)',
    }
    : {
      position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex,
      width: 'min(480px, 94vw)', maxHeight: 'min(70vh, 520px)',
    };

  return (
    <div className="zdef-modal dat-notes-modal" ref={panelRef} style={style} onPointerDown={onFocus}>
      <div
        className="modal-header"
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
      >
        <span className="icon">sticky_note_2</span>
        <span className="modal-title">Notes</span>
        <Tooltip content={label}>
          <span className="route-count mono">{label}</span>
        </Tooltip>
        <Button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="Close">
          <span className="icon">close</span>
        </Button>
      </div>

      <div className="dat-notes-toolbar">
        <div className="dat-notes-actions">
          <Button type="button" className="uimenu-btn active" disabled={saving} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      {err && (
        <div className="uimenu-err" role="alert">
          <span className="icon">error</span>
          <span>{err}</span>
        </div>
      )}

      <div className="dat-notes-body">
        <textarea
          className="dat-notes-pad"
          spellCheck={false}
          placeholder={`Notes for ${label}…`}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
    </div>
  );
}

function clamp(p, panel) {
  const w = panel?.offsetWidth ?? 400;
  const h = panel?.offsetHeight ?? 320;
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}
