import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { backend } from '../js/backend.js';
import { resolveWritableDat, rootKindForAbs } from '../js/gamePath.js';
import {
  getNote, loadNotes, notesFilePath, revealNotesFile, setNote,
  uiMenuSectionKey,
} from '../js/notes.js';

/**
 * Draggable table for a 0x30 UiMenu section — frame + child buttons.
 * Edit mode patches x/y/w/h + nav via `xi title menu` (xi-tools).
 * Free-text notepad per menu → %LOCALAPPDATA%\XiModelViewer\notes.json.
 */
export function UiMenuModal({
  menu,
  title = 'UiMenu',
  datPath = '',
  xiPath = '',
  settings = null,
  onClose,
  onFocus,
  onSaved,
  onCliLog,
  zIndex = 2120,
}) {
  const panelRef = useRef(null);
  const dragState = useRef(null);
  // After a successful Save, keep edit mode through the DAT reload.
  const keepEditingRef = useRef(false);
  const menuIdRef = useRef(null);
  // Unsaved notepad typing — never clobber while dirty (DAT reload used to wipe it).
  const notesDirtyRef = useRef(false);
  const [pos, setPos] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notesOpen, setNotesOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [notesTick, setNotesTick] = useState(0);
  const [notesSaving, setNotesSaving] = useState(false);
  /** { kind: 'pivot'|'hd'|'game'|null, path: string } — where this DAT is read/written */
  const [source, setSource] = useState(null);

  const baseRows = useMemo(() => menuToRows(menu), [menu]);
  const sectionKey = useMemo(() => uiMenuSectionKey(menu), [menu]);
  const menuIdentity = menu
    ? `${menu.offset ?? ''}:${menu.id ?? ''}:${menu.bareName ?? ''}`
    : '';

  useEffect(() => {
    let alive = true;
    setSource(null);
    if (!datPath) return undefined;
    (async () => {
      try {
        const path = await resolveWritableDat(datPath, settings, (p) => backend.fileExists(p));
        if (!alive) return;
        const kind = rootKindForAbs(path, settings);
        setSource({ kind, path });
      } catch {
        if (alive) setSource(null);
      }
    })();
    return () => { alive = false; };
  }, [
    datPath,
    settings?.pivotEnabled,
    settings?.hdEnabled,
    settings?.pivotPath,
    settings?.hdPath,
    settings?.gamePath,
  ]);

  useEffect(() => {
    const switched = menuIdRef.current != null && menuIdRef.current !== menuIdentity;
    menuIdRef.current = menuIdentity;

    if (keepEditingRef.current && !switched) {
      // DAT reloaded after our save — stay editing with fresh values as the new baseline.
      keepEditingRef.current = false;
      setDraft(menuToRows(menu).map((r) => ({ ...r })));
      setEditing(true);
      setErr('');
      return;
    }

    keepEditingRef.current = false;
    setEditing(false);
    setDraft(null);
    setErr('');
    if (switched) {
      notesDirtyRef.current = false;
      setNotesOpen(false);
    }
  }, [menu, menuIdentity]);

  // Warm notes cache once per section; do NOT bump notesTick on every menu object
  // refresh (that re-seeded the notepad and wiped unsaved typing after position Save).
  useEffect(() => {
    loadNotes().catch(() => {});
  }, [sectionKey]);

  // Re-seed notepad only when opening, switching section, or after Save notes —
  // and never while the user has unsaved keystrokes (notesDirtyRef).
  useEffect(() => {
    if (!notesOpen) return;
    if (notesDirtyRef.current) return;
    setNoteDraft(getNote(sectionKey));
  }, [notesOpen, sectionKey, notesTick]);

  if (!menu) return null;

  const rows = editing && draft ? draft : baseRows;
  const menuTag = (menu.id || '').trim() || guessTag(menu);
  const meta = [
    menu.name || menu.bareName || title,
    `${menu.elements?.length ?? 0} buttons`,
    menu.maybeType != null ? `type ${menu.maybeType}` : null,
  ].filter(Boolean).join(' · ');

  const startDrag = (e) => {
    onFocus?.();
    if (e.target.closest('button, input, a, [role="button"]')) return;
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

  const beginEdit = () => {
    setErr('');
    setDraft(baseRows.map((r) => ({ ...r })));
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft(null);
    setErr('');
  };

  const setCell = (rowIdx, key, raw) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = prev.slice();
      next[rowIdx] = { ...next[rowIdx], [key]: raw };
      return next;
    });
  };

  const save = async () => {
    setErr('');
    if (!datPath) {
      setErr('No DAT path — open Data Struct from a loaded DAT first.');
      return;
    }
    if (!xiPath?.trim()) {
      setErr('Set the xi-tools folder in Settings first.');
      return;
    }
    if (!menuTag) {
      setErr('Could not determine menu tag (4-char section id).');
      return;
    }

    let patches;
    try {
      patches = buildPatches(baseRows, draft, menuTag, datPath);
    } catch (e) {
      setErr(e.message || String(e));
      return;
    }
    if (!patches.length) {
      // Nothing to write — stay in edit mode with current draft.
      return;
    }

    setBusy(true);
    const chunks = [];
    try {
      // Write target: Pivot → HD → game (first existing file), same as load order.
      const writePath = await resolveWritableDat(
        datPath,
        settings,
        (p) => backend.fileExists(p),
      );
      const kind = rootKindForAbs(writePath, settings);
      const kindLabel = kind === 'pivot' ? 'pivot' : kind === 'hd' ? 'HD' : kind === 'game' ? 'game' : 'file';

      // Rebuild patches against the resolved write path (not the tree click path).
      const writePatches = patches.map((args) => {
        const copy = args.slice();
        // ['title','menu', datPath, ...]
        if (copy[0] === 'title' && copy[1] === 'menu' && copy.length >= 3) {
          copy[2] = writePath;
        }
        return copy;
      });

      chunks.push(`# write → ${kindLabel}\n# ${writePath}`);

      for (const args of writePatches) {
        const cmd = `xi ${args.map(shellQuote).join(' ')}`;
        try {
          const out = await backend.xiRun(args, xiPath);
          chunks.push(`$ ${cmd}\n${(out || '').trim() || '(ok, no output)'}`);
        } catch (e) {
          const msg = e?.message || String(e);
          chunks.push(`$ ${cmd}\n${msg}`);
          onCliLog?.({
            title: `xi title menu · ${menuTag} · failed`,
            text: chunks.join('\n\n'),
          });
          throw e;
        }
      }
      onCliLog?.({
        title: `xi title menu · ${menuTag} · ${writePatches.length} change${writePatches.length === 1 ? '' : 's'} · ${kindLabel}`,
        text: chunks.join('\n\n'),
      });
      // Reload DAT for baseline, but keep the editor open for the next tweak.
      keepEditingRef.current = true;
      await onSaved?.(writePath);
    } catch (e) {
      keepEditingRef.current = false;
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const style = pos
    ? {
      position: 'fixed', left: pos.x, top: pos.y, transform: 'none', zIndex,
      width: 'min(1000px, 96vw)', maxHeight: 'min(78vh, 620px)',
    }
    : {
      position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex,
      width: 'min(1000px, 96vw)', maxHeight: 'min(78vh, 620px)',
    };

  const canEdit = !!(datPath && xiPath?.trim() && menuTag);
  void notesTick;
  const sectionNote = getNote(sectionKey);

  const saveNotesPanel = async () => {
    setNotesSaving(true);
    setErr('');
    try {
      await setNote(sectionKey, noteDraft);
      notesDirtyRef.current = false;
      setNotesTick((n) => n + 1);
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setNotesSaving(false);
    }
  };

  const toggleNotes = () => {
    setNotesOpen((v) => {
      const next = !v;
      if (next) {
        // Opening: load disk unless mid-edit dirty draft already exists.
        if (!notesDirtyRef.current) {
          setNoteDraft(getNote(sectionKey));
        }
      }
      return next;
    });
  };

  const openNotesFile = async () => {
    try {
      await revealNotesFile();
    } catch (e) {
      setErr(e?.message || String(e));
    }
  };

  return (
    <div className="zdef-modal uimenu-modal" ref={panelRef} style={style} onPointerDown={onFocus}>
      <div
        className="modal-header"
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
      >
        <span className="icon">menu</span>
        <span className="modal-title mono">{title}</span>
        {sourceBadge(source) && (
          <span
            className={`uimenu-src-badge uimenu-src-${sourceBadge(source).cls}`}
            title={source?.path || ''}
          >
            {sourceBadge(source).label}
          </span>
        )}
        <span className="route-count mono">{meta}</span>
        <Button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="Close">
          <span className="icon">close</span>
        </Button>
      </div>

      <div className="uieg-toolbar uimenu-toolbar">
        <div className="uieg-meta mono-small">
          <span>0x30 UiMenu — hit boxes + keyboard/pad nav</span>
          <span>Nav = <b>ButtonID</b> targets (↑↓←→)</span>
          {menuTag && <span className="mono">tag <b>{menuTag}</b></span>}
        </div>
        <div className="uimenu-actions">
          <Button
            type="button"
            className={`uimenu-btn${notesOpen ? ' on' : ''}${sectionNote || notesDirtyRef.current ? ' has-note' : ''}`}
            onClick={toggleNotes}
            title="Free-text notes for this menu (AppData notes.json)"
          >
            Notes
          </Button>
          {!editing ? (
            <Button
              type="button"
              className="uimenu-btn"
              disabled={!canEdit || busy}
              title={!xiPath?.trim()
                ? 'Set xi-tools folder in Settings'
                : !datPath
                  ? 'No DAT path'
                  : 'Edit positions / size / nav'}
              onClick={beginEdit}
            >
              Edit
            </Button>
          ) : (
            <>
              <Button type="button" className="uimenu-btn" disabled={busy} onClick={cancelEdit}>
                Cancel
              </Button>
              <Button type="button" className="uimenu-btn active" disabled={busy} onClick={save}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
            </>
          )}
        </div>
      </div>

      {notesOpen && (
        <div className="uimenu-notes">
          <div className="uimenu-notes-head">
            <span className="uimenu-notes-title">Notes · {title}</span>
            <span className="uimenu-notes-path mono" title={notesFilePath() || ''}>
              {notesFilePath()
                ? notesFilePath().replace(/^.*[\\/]XiModelViewer[\\/]/i, '…/XiModelViewer/')
                : 'localStorage (no AppData yet)'}
            </span>
            <div className="uimenu-notes-actions">
              <Button type="button" className="uimenu-btn" onClick={openNotesFile} title="Open notes.json in Explorer">
                Open file
              </Button>
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
            placeholder={`Notes for ${title} — free text, one pad per menu…`}
            value={noteDraft}
            onChange={(e) => {
              notesDirtyRef.current = true;
              setNoteDraft(e.target.value);
            }}
          />
        </div>
      )}

      {err && (
        <div className="uimenu-err" role="alert">
          <span className="icon">error</span>
          <span>{err}</span>
        </div>
      )}

      <div className="zdef-table-wrap">
        <table className={`zdef-table${editing ? ' uimenu-editing' : ''}`}>
          <thead>
            <tr>
              <th className="mono">Role</th>
              <th className="mono">BtnID</th>
              <th className="mono">X</th>
              <th className="mono">Y</th>
              <th className="mono">W</th>
              <th className="mono">H</th>
              <th className="mono">↑ Up</th>
              <th className="mono">↓ Down</th>
              <th className="mono">← Left</th>
              <th className="mono">→ Right</th>
              <th className="mono">TextID</th>
              <th className="mono">Text NS</th>
              <th className="mono">Size</th>
              <th className="mono">Offset</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={14} className="zdef-empty">No elements</td>
              </tr>
            )}
            {rows.map((r, i) => (
              <tr key={`${r.offset}-${i}`}>
                <td className="mono">{r.role}</td>
                <td className="mono">{fmtNav(r.buttonId ?? r.index)}</td>
                {editing ? (
                  <>
                    <td><NumInput value={r.x} onChange={(v) => setCell(i, 'x', v)} /></td>
                    <td><NumInput value={r.y} onChange={(v) => setCell(i, 'y', v)} /></td>
                    <td><NumInput value={r.width} onChange={(v) => setCell(i, 'width', v)} /></td>
                    <td><NumInput value={r.height} onChange={(v) => setCell(i, 'height', v)} /></td>
                    <td><NumInput value={r.navU} onChange={(v) => setCell(i, 'navU', v)} /></td>
                    <td><NumInput value={r.navD} onChange={(v) => setCell(i, 'navD', v)} /></td>
                    <td><NumInput value={r.navL} onChange={(v) => setCell(i, 'navL', v)} /></td>
                    <td><NumInput value={r.navR} onChange={(v) => setCell(i, 'navR', v)} /></td>
                  </>
                ) : (
                  <>
                    <td className="mono">{r.x}</td>
                    <td className="mono">{r.y}</td>
                    <td className="mono">{r.width}</td>
                    <td className="mono">{r.height}</td>
                    <td className="mono">{fmtNav(r.navU)}</td>
                    <td className="mono">{fmtNav(r.navD)}</td>
                    <td className="mono">{fmtNav(r.navL)}</td>
                    <td className="mono">{fmtNav(r.navR)}</td>
                  </>
                )}
                <td className="mono">{r.titleId != null ? r.titleId : '—'}</td>
                <td className="mono">{r.textNs || '—'}</td>
                <td className="mono">{r.size}</td>
                <td className="mono">0x{(r.offset >>> 0).toString(16)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NumInput({ value, onChange }) {
  const display = value === '' || value == null ? '' : String(value);
  return (
    <input
      className="uimenu-num mono"
      type="text"
      inputMode="numeric"
      spellCheck={false}
      value={display}
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => e.target.select()}
    />
  );
}

function menuToRows(menu) {
  if (!menu) return [];
  return [
    {
      role: 'frame',
      elemIndex: null,
      offset: menu.frame?.offset,
      size: menu.frame?.size,
      buttonId: menu.frame?.buttonId ?? menu.frame?.index,
      x: menu.frame?.x,
      y: menu.frame?.y,
      width: menu.frame?.width,
      height: menu.frame?.height,
      navU: menu.frame?.navU ?? menu.frame?.prev,
      navD: menu.frame?.navD ?? menu.frame?.next,
      navL: menu.frame?.navL,
      navR: menu.frame?.navR,
      titleId: menu.frame?.titleId,
      textNs: menu.frame?.textNs,
    },
    ...(menu.elements || []).map((e, i) => ({
      role: `elem ${i}`,
      elemIndex: i,
      offset: e.offset,
      size: e.size,
      buttonId: e.buttonId ?? e.index,
      x: e.x,
      y: e.y,
      width: e.width,
      height: e.height,
      navU: e.navU ?? e.prev,
      navD: e.navD ?? e.next,
      navL: e.navL,
      navR: e.navR,
      titleId: e.titleId,
      textNs: e.textNs,
    })),
  ];
}

function guessTag(menu) {
  const bare = (menu?.bareName || '').replace(/\s+/g, '');
  if (bare.length >= 4 && /^[a-z0-9]{4}/i.test(bare)) return bare.slice(0, 4).toLowerCase();
  return '';
}

function parseI16(raw, label) {
  if (raw === '' || raw == null) throw new Error(`${label}: empty`);
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n)) throw new Error(`${label}: need integer (got ${raw})`);
  if (n < -32768 || n > 32767) throw new Error(`${label}: out of i16 range`);
  return n;
}

function parseI8(raw, label) {
  if (raw === '' || raw == null) throw new Error(`${label}: empty`);
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n)) throw new Error(`${label}: need integer (got ${raw})`);
  if (n < -128 || n > 127) throw new Error(`${label}: out of i8 range`);
  return n;
}

function buildPatches(origRows, draftRows, menuTag, datPath) {
  if (!draftRows) return [];
  const out = [];
  for (let i = 0; i < draftRows.length; i++) {
    const o = origRows[i];
    const d = draftRows[i];
    if (!o || !d) continue;

    const x = parseI16(d.x, `${d.role} X`);
    const y = parseI16(d.y, `${d.role} Y`);
    const w = parseI16(d.width, `${d.role} W`);
    const h = parseI16(d.height, `${d.role} H`);
    const hasNav = [o.navU, o.navD, o.navL, o.navR].some((v) => v != null);
    let nu; let nd; let nl; let nr;
    if (hasNav) {
      nu = parseI8(d.navU ?? -1, `${d.role} ↑`);
      nd = parseI8(d.navD ?? -1, `${d.role} ↓`);
      nl = parseI8(d.navL ?? -1, `${d.role} ←`);
      nr = parseI8(d.navR ?? -1, `${d.role} →`);
    }

    const changed = x !== o.x || y !== o.y || w !== o.width || h !== o.height
      || (hasNav && (nu !== o.navU || nd !== o.navD || nl !== o.navL || nr !== o.navR));
    if (!changed) continue;

    const args = ['title', 'menu', datPath, '--menu', menuTag];
    if (d.elemIndex != null) args.push('--elem', String(d.elemIndex));
    args.push('--x', String(x), '--y', String(y), '--w', String(w), '--h', String(h));
    if (hasNav) {
      args.push(
        '--nav-up', String(nu), '--nav-down', String(nd),
        '--nav-left', String(nl), '--nav-right', String(nr),
      );
    }
    out.push(args);
  }
  return out;
}

function fmtNav(v) {
  if (v == null) return '—';
  if (v === -1) return '−1';
  return String(v);
}

function shellQuote(s) {
  const t = String(s);
  if (/^[A-Za-z0-9_./:\\@%+=,-]+$/.test(t)) return t;
  return `"${t.replace(/"/g, '\\"')}"`;
}

function sourceBadge(source) {
  if (!source) return null;
  if (source.kind === 'pivot') return { label: 'PIVOT', cls: 'pivot' };
  if (source.kind === 'hd') return { label: 'HD', cls: 'hd' };
  if (source.kind === 'game') return { label: 'FFXI', cls: 'game' };
  return { label: 'FILE', cls: 'file' };
}

function clamp(p, panel) {
  const w = panel?.offsetWidth ?? 480;
  const h = panel?.offsetHeight ?? 320;
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}
