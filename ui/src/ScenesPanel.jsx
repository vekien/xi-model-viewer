import { useEffect, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { Tooltip } from './Tooltip.jsx';

const KIND_ICON = { npc: 'pets', pc: 'person', light: 'lightbulb' };

function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString(); } catch { return ''; }
}

/**
 * Zone Scenes panel (bottom-right strip › Scenes). Two views in one slot:
 *
 * - the scene list: every saved scene, New Scene, delete — clicking a scene
 *   puts its actors on the stage and drops into the actor view;
 * - the actor view: the open scene's actors (place NPCs / characters /
 *   lights, click a row to edit) with the scene's name and Save in the title.
 *
 * Mutually exclusive with the Objects panel — same slot on the right rail.
 */
export function ScenesPanel({
  scenes, current, view, dirty, zoneName,
  onNewScene, onOpenScene, onCloseScene, onDeleteScene, onBack, onSave, onRename,
  actors, placing, onAddActor, onCancelPlace, onEdit, onRemove, onToggleVisible,
  editingId, selectedId, liveSelection, onToggleLiveSelection, onClose,
}) {
  const liveToggle = (
    <Tooltip
      content={liveSelection
        ? 'Live Selection on — click an actor in the zone to select it (1 move · 2 rotate · 3 scale)'
        : 'Live Selection — click actors in the zone to select them'}
      placement="left"
    >
      <button
        type="button"
        className={`icon-btn plc-tool${liveSelection ? ' on' : ''}`}
        aria-pressed={!!liveSelection}
        aria-label="Live Selection"
        onClick={onToggleLiveSelection}
      >
        <span className="icon">arrow_selector_tool</span>
      </button>
    </Tooltip>
  );
  const closeBtn = (
    <Tooltip content="Close" placement="left">
      <Button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
        <span className="icon">close</span>
      </Button>
    </Tooltip>
  );

  if (view !== 'actors' || !current) {
    return (
      <div id="scenes" className="panel">
        <div className="plc-header">
          <span className="icon">theaters</span>
          <span className="plc-title">Scenes</span>
          <span className="plc-spacer" />
          {liveToggle}
          {closeBtn}
        </div>

        <div className="actors-toolbar">
          <Tooltip content="Start an empty scene and add actors to it" placement="top">
            <button type="button" className="dbf-btn primary actors-add" onClick={onNewScene}>
              <span className="icon">add</span>
              New Scene
            </button>
          </Tooltip>
        </div>

        <div className="plc-list-shell">
          <div className="plc-body actors-list scenes-list">
            {scenes.length === 0 && (
              <div className="side-note">No scenes yet. Create one and click where its actors should stand.</div>
            )}
            {scenes.map((s) => {
              const isCurrent = current?.id === s.id;
              const otherZone = !!(s.zone?.name && zoneName && s.zone.name !== zoneName);
              // The details left off the row live in its tip.
              const detail = [
                `${s.actors.length} actor${s.actors.length === 1 ? '' : 's'}`,
                s.zone?.name || '',
                s.savedAt ? fmtDate(s.savedAt) : '',
              ].filter(Boolean).join(' · ');
              const tip = isCurrent
                ? `On stage — ${detail}${dirty ? ' — unsaved changes' : ''}. Click to go back to its actors`
                : otherZone
                  ? `${detail} — saved in ${s.zone.name}, positions may not fit this zone. Click to put its actors on stage`
                  : `${detail}. Click to put its actors on stage`;
              return (
                <div key={s.id} className={`node scene-row${isCurrent ? ' selected' : ''}`}>
                  <Tooltip content={tip} placement="left">
                    <div className="row" onClick={() => onOpenScene(s)}>
                      <span className="kind icon">{isCurrent ? 'play_circle' : 'theaters'}</span>
                      <span className="actor-name">
                        {s.name}
                        {isCurrent && dirty && <span className="scene-dirty" aria-label="Unsaved changes">•</span>}
                      </span>
                      {isCurrent && (
                        <Tooltip
                          content={dirty
                            ? 'Close scene — take its actors off the stage. Unsaved changes will be lost'
                            : 'Close scene — take its actors off the stage'}
                          placement="left"
                        >
                          <button
                            type="button"
                            className="actor-btn"
                            aria-label="Close scene"
                            onClick={(e) => { e.stopPropagation(); onCloseScene(s); }}
                          >
                            <span className="icon">close</span>
                          </button>
                        </Tooltip>
                      )}
                      <Tooltip content="Delete scene" placement="left">
                        <button
                          type="button"
                          className="actor-btn danger"
                          aria-label="Delete scene"
                          onClick={(e) => { e.stopPropagation(); onDeleteScene(s); }}
                        >
                          <span className="icon">delete</span>
                        </button>
                      </Tooltip>
                    </div>
                  </Tooltip>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div id="scenes" className="panel">
      <div className="plc-header">
        <Tooltip content="Back to the scene list" placement="bottom">
          <button type="button" className="icon-btn scene-back" aria-label="Back to scenes" onClick={onBack}>
            <span className="icon">arrow_back</span>
          </button>
        </Tooltip>
        <SceneName name={current.name} onRename={onRename} />
        <span className="plc-count mono">{actors.length}</span>
        <Tooltip
          content={dirty ? `Save the actors on stage into “${current.name}” — there are unsaved changes` : `Save the actors on stage into “${current.name}”`}
          placement="left"
        >
          <button
            type="button"
            className={`icon-btn plc-tool scene-save${dirty ? ' dirty' : ''}`}
            aria-label="Save scene"
            onClick={onSave}
          >
            <span className="icon">save</span>
          </button>
        </Tooltip>
        {liveToggle}
        {closeBtn}
      </div>

      <div className="actors-toolbar">
        {placing ? (
          <div className="actors-placing" role="status">
            <span className="icon">ads_click</span>
            <span>
              {placing.lock
                ? `Click on the zone where the camera lock actor should ${placing.forId != null ? 'move to' : 'stand'}.`
                : placing.forId != null
                  ? 'Click on the zone where the actor should stand.'
                  : 'Click on the zone where you want the actor to appear.'}
            </span>
            <button type="button" className="dbf-btn" onClick={onCancelPlace}>Cancel</button>
          </div>
        ) : (
          <button type="button" className="dbf-btn primary actors-add" onClick={onAddActor}>
            <span className="icon">person_add</span>
            Add Actor
          </button>
        )}
      </div>

      <div className="plc-list-shell">
        <div className="plc-body actors-list">
          {actors.length === 0 && !placing && (
            <div className="side-note">No actors in this scene yet. Add one and click where it should stand.</div>
          )}
          {actors.map((a) => {
            const sub = a.status === 'loading' ? 'loading…'
              : a.status === 'error' ? 'failed'
                : a.label || (a.kind ? '' : (a.lockTarget ? 'camera lock' : 'placeholder'));
            return (
              <div key={a.id} className={`node actor-row${editingId === a.id || selectedId === a.id ? ' selected' : ''}${a.visible ? '' : ' actor-hidden'}`}>
                <div className="row" onClick={() => onEdit(a.id)}>
                  <span className="kind icon">{KIND_ICON[a.kind] || (a.lockTarget ? 'my_location' : 'person_outline')}</span>
                  <span className="actor-name">{a.name}</span>
                  {sub && <span className="mono-small actor-sub">{sub}</span>}
                  <Tooltip content={a.visible ? 'Hide actor' : 'Show actor'} placement="left">
                    <button
                      type="button"
                      className={`actor-btn${a.visible ? '' : ' off'}`}
                      aria-label={a.visible ? 'Hide actor' : 'Show actor'}
                      onClick={(e) => { e.stopPropagation(); onToggleVisible(a.id); }}
                    >
                      <span className="icon">{a.visible ? 'visibility' : 'visibility_off'}</span>
                    </button>
                  </Tooltip>
                  <Tooltip content="Remove actor" placement="left">
                    <button
                      type="button"
                      className="actor-btn danger"
                      aria-label="Remove actor"
                      onClick={(e) => { e.stopPropagation(); onRemove(a.id); }}
                    >
                      <span className="icon">delete</span>
                    </button>
                  </Tooltip>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The open scene's name, edited in place; commits on blur / Enter. */
function SceneName({ name, onRename }) {
  const [value, setValue] = useState(name);
  const revert = useRef(false);
  useEffect(() => { setValue(name); }, [name]);
  const commit = () => {
    const clean = value.trim();
    if (!revert.current && clean && clean !== name) onRename?.(clean);
    else setValue(name);
    revert.current = false;
  };
  return (
    <input
      type="text"
      className="actor-name-input scene-name-input"
      value={value}
      spellCheck={false}
      aria-label="Scene name"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') revert.current = true;
        if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
      }}
    />
  );
}
