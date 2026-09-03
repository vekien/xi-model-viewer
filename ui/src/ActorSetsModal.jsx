import { useEffect, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { Tooltip } from './Tooltip.jsx';

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch { return ''; }
}

/**
 * Save / load / delete sets of placed actors. `current` is the set the
 * actors on stage came from (or were last saved as); saving again updates it.
 */
export function ActorSetsModal({
  sets, current, actorCount, zoneName, onSave, onLoad, onDelete, onClose, zIndex = 2160,
}) {
  const panelRef = useRef(null);
  const dragState = useRef(null);
  const [pos, setPos] = useState(null);
  const [name, setName] = useState(current?.name || (zoneName ? `${zoneName} actors` : 'Actor set'));
  useEffect(() => { if (current?.name) setName(current.name); }, [current?.id]);

  const startDrag = (e) => {
    if (e.target.closest('button, input, a, [role="button"]')) return;
    const rect = panelRef.current.getBoundingClientRect();
    dragState.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDrag = (e) => {
    if (!dragState.current) return;
    const w = panelRef.current?.offsetWidth ?? 460;
    const h = panelRef.current?.offsetHeight ?? 400;
    setPos({
      x: Math.min(Math.max(e.clientX - dragState.current.dx, 0), Math.max(window.innerWidth - w, 0)),
      y: Math.min(Math.max(e.clientY - dragState.current.dy, 0), Math.max(window.innerHeight - h, 0)),
    });
  };
  const endDrag = () => { dragState.current = null; };

  const style = pos
    ? { position: 'fixed', left: pos.x, top: pos.y, transform: 'none', zIndex }
    : { position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex };

  const canSave = actorCount > 0 && name.trim().length > 0;

  return (
    <div className="zdef-modal datatable-modal actor-modal actor-sets-modal" ref={panelRef} style={style}>
      <div className="modal-header" onPointerDown={startDrag} onPointerMove={onDrag} onPointerUp={endDrag}>
        <span className="icon">folder_special</span>
        <span className="modal-title">Actor Sets</span>
        <span className="route-count mono">{sets.length} saved</span>
        <Button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="Close">
          <span className="icon">close</span>
        </Button>
      </div>

      <div className="actor-modal-body">
        <div className="actor-section">Save the actors on stage</div>
        <div className="actor-sets-save">
          <input
            type="text"
            className="list-search"
            value={name}
            spellCheck={false}
            placeholder="Set name"
            aria-label="Set name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && canSave) onSave(name.trim(), current?.id ?? null); }}
          />
          {current ? (
            <>
              <Tooltip content={`Overwrite “${current.name}” with the ${actorCount} actor${actorCount === 1 ? '' : 's'} on stage`} placement="top">
                <button type="button" className="dbf-btn primary" disabled={!canSave} onClick={() => onSave(name.trim(), current.id)}>
                  <span className="icon">save</span>
                  Update
                </button>
              </Tooltip>
              <button type="button" className="dbf-btn" disabled={!canSave} onClick={() => onSave(name.trim(), null)}>
                Save New
              </button>
            </>
          ) : (
            <button type="button" className="dbf-btn primary" disabled={!canSave} onClick={() => onSave(name.trim(), null)}>
              <span className="icon">save</span>
              Save
            </button>
          )}
        </div>
        <div className="form-hint">
          {actorCount === 0
            ? 'Place some actors first.'
            : `${actorCount} actor${actorCount === 1 ? '' : 's'} on stage${zoneName ? ` in ${zoneName}` : ''}. Names, models, positions, rotation, scale and motion are kept.`}
        </div>

        <div className="actor-section">Saved sets</div>
        {sets.length === 0 && <div className="side-note">No saved sets yet.</div>}
        <div className="actor-sets-list">
          {sets.map((s) => (
            <div key={s.id} className={`actor-set-row${current?.id === s.id ? ' current' : ''}`}>
              <div className="actor-set-main">
                <div className="actor-set-name">
                  {s.name}
                  {current?.id === s.id && <span className="actor-set-badge">on stage</span>}
                </div>
                <div className="actor-set-meta mono">
                  {s.actors.length} actor{s.actors.length === 1 ? '' : 's'}
                  {s.zone?.name ? ` · ${s.zone.name}` : ''}
                  {s.savedAt ? ` · ${fmtDate(s.savedAt)}` : ''}
                </div>
              </div>
              <Tooltip content={s.zone?.name && zoneName && s.zone.name !== zoneName ? `Saved in ${s.zone.name} — positions may not fit this zone` : 'Replace the actors on stage with this set'} placement="top">
                <button type="button" className="dbf-btn" onClick={() => onLoad(s)}>
                  <span className="icon">download</span>
                  Load
                </button>
              </Tooltip>
              <Tooltip content="Delete this set" placement="top">
                <button type="button" className="actor-btn danger" aria-label="Delete set" onClick={() => onDelete(s)}>
                  <span className="icon">delete</span>
                </button>
              </Tooltip>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
