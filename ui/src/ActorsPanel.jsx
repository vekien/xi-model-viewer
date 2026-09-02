import { Button } from '@headlessui/react';
import { Tooltip } from './Tooltip.jsx';

const KIND_ICON = { npc: 'pets', pc: 'person', light: 'lightbulb' };

/**
 * Zone Actors panel (bottom-right strip › Actors): place NPCs / characters
 * on the terrain and keep a list of them. Clicking a row opens its editor.
 * Mutually exclusive with the Objects panel — same slot on the right rail.
 */
export function ActorsPanel({
  actors, placing, onAddActor, onCancelPlace, onEdit, onRemove, onToggleVisible,
  editingId, selectedId, liveSelection, onToggleLiveSelection, onManageSets, onClose,
}) {
  return (
    <div id="actors" className="panel">
      <div className="plc-header">
        <span className="icon">groups</span>
        <span className="plc-title">Actors</span>
        <span className="plc-count mono">{actors.length}</span>
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
        <Tooltip content="Close" placement="left">
          <Button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <span className="icon">close</span>
          </Button>
        </Tooltip>
      </div>

      <div className="actors-toolbar">
        {placing ? (
          <div className="actors-placing" role="status">
            <span className="icon">ads_click</span>
            <span>
              {placing.forId != null
                ? 'Click on the zone where the actor should stand.'
                : 'Click on the zone where you want the actor to appear.'}
            </span>
            <button type="button" className="dbf-btn" onClick={onCancelPlace}>Cancel</button>
          </div>
        ) : (
          <div className="actors-toolbar-row">
            <button type="button" className="dbf-btn primary actors-add" onClick={onAddActor}>
              <span className="icon">person_add</span>
              Add Actor
            </button>
            <Tooltip content="Save, load or delete sets of placed actors" placement="top">
              <button type="button" className="dbf-btn actors-sets-btn" onClick={onManageSets}>
                <span className="icon">folder_special</span>
                Manage Actor Sets
              </button>
            </Tooltip>
          </div>
        )}
      </div>

      <div className="plc-list-shell">
        <div className="plc-body actors-list">
          {actors.length === 0 && !placing && (
            <div className="side-note">No actors yet. Add one and click where it should stand.</div>
          )}
          {actors.map((a) => {
            const sub = a.status === 'loading' ? 'loading…'
              : a.status === 'error' ? 'failed'
                : a.label || (a.kind ? '' : 'placeholder');
            return (
              <div key={a.id} className={`node actor-row${editingId === a.id || selectedId === a.id ? ' selected' : ''}${a.visible ? '' : ' actor-hidden'}`}>
                <div className="row" onClick={() => onEdit(a.id)}>
                  <span className="kind icon">{KIND_ICON[a.kind] || 'person_outline'}</span>
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
