import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { Combo } from './Combo.jsx';
import { NpcList } from './NpcList.jsx';
import { EffectPcStrip } from './EffectActorsPanel.jsx';
import { Tooltip } from './Tooltip.jsx';
import { DEFAULT_LIGHT, kelvinToRgb01, rgb01ToHex } from '../js/lightUtil.js';

// Where the editor was last dragged to — it unmounts on close, so the
// position lives in localStorage and the next open lands in the same place.
const POS_KEY = 'actorEditorPos';
function loadSavedPos() {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    // Keep it on screen if the window shrank since.
    return { x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - 200, 0)), y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - 120, 0)) };
  } catch {
    return null;
  }
}
function savePos(p) {
  try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch { /* quota */ }
}

/**
 * Draggable editor for one zone actor. Two columns: the picker (NPC list |
 * character composer | light form) on the left, the selected actor's options
 * — motion, frame, effect, gizmo — on the right.
 */
export function ActorEditorModal({
  actor, pc, onClose, onFocus, zIndex = 2100, initialPos = null,
  currentSet = null, onSaveSet = null,
  onRename, onKind, onSelectNpc, onMotion, onPlaying, onLoop,
  frameSink = null, onSeek, onFx,
  gizmoMode = 'move', onGizmoMode, onResetTransform, onLight,
}) {
  const panelRef = useRef(null);
  const dragState = useRef(null);
  const [pos, setPos] = useState(() => (
    initialPos && Number.isFinite(initialPos.x) && Number.isFinite(initialPos.y)
      ? { x: initialPos.x, y: initialPos.y }
      : loadSavedPos()
  ));
  const [name, setName] = useState(actor?.name ?? '');
  useEffect(() => { setName(actor?.name ?? ''); }, [actor?.id, actor?.name]);

  const motionItems = useMemo(() => {
    if (!actor) return [];
    const anims = actor.anims ?? [];
    const schedules = actor.schedules ?? [];
    const packs = actor.packs ?? [];
    return [
      { id: '', label: '— bind pose —' },
      ...anims.map((g) => ({
        id: `anim:${g.id}`,
        group: 'Animations',
        label: g.label ?? (g.id === 'btl' ? 'btl — battle stance'
          : g.id === 'idl' ? 'idl — idle'
            : g.id === 'std' ? 'std — stand'
              : g.id),
        badge: g.clip?.parts?.length,
      })),
      ...schedules.map((s) => ({
        id: `sched:${s.id}`,
        group: 'Schedules',
        label: s.id,
        badge: s.clipIds?.length > 1 ? s.clipIds.length : undefined,
      })),
      ...packs.map((p) => ({
        id: `pack:${p.path}`,
        group: 'Specials',
        label: `${(p.clips ?? []).join(', ') || '?'} — ${p.path.replace(/\.DAT$/i, '')}`,
      })),
    ];
  }, [actor?.anims, actor?.schedules, actor?.packs]);

  if (!actor) return null;

  const motionValue = actor.pack && actor.motion?.kind === 'anim' && (actor.packs ?? []).some((p) => p.path === actor.pack)
    ? `pack:${actor.pack}`
    : actor.motion ? `${actor.motion.kind}:${actor.motion.id}` : '';

  const startDrag = (e) => {
    onFocus?.();
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
  const endDrag = () => {
    if (dragState.current && pos) savePos(pos);
    dragState.current = null;
  };

  const style = pos
    ? { position: 'fixed', left: pos.x, top: pos.y, transform: 'none', zIndex }
    : { position: 'fixed', left: 'calc(50% - 40px)', top: '50%', transform: 'translate(-50%, -50%)', zIndex };

  const kind = actor.kind || 'npc';
  const fxOn = !!actor.fx;
  const fxAvailable = kind === 'npc';

  return (
    <div className={`zdef-modal datatable-modal actor-modal actor-editor-modal${kind === 'light' ? ' is-fit' : ''}`} ref={panelRef} style={style} onPointerDown={onFocus}>
      <div
        className="modal-header"
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
      >
        <span className="icon">{kind === 'pc' ? 'person' : kind === 'light' ? 'lightbulb' : 'pets'}</span>
        <input
          type="text"
          className="actor-name-input mono"
          value={name}
          spellCheck={false}
          aria-label="Actor name"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => { if (name.trim() && name !== actor.name) onRename?.(name.trim()); }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        />
        <span className="route-count mono">{actor.status === 'loading' ? 'loading…' : actor.label || ''}</span>
        {onSaveSet && (
          <Tooltip
            content={currentSet ? `Save actor set “${currentSet.name}”` : 'No actor set loaded — save the stage as a new set'}
            placement="bottom"
          >
            <button type="button" className="icon-btn modal-tool" onClick={onSaveSet} aria-label="Save actor set">
              <span className="icon">save</span>
            </button>
          </Tooltip>
        )}
        <Button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="Close">
          <span className="icon">close</span>
        </Button>
      </div>

      <div className="actor-modal-body">
        {/* Left: what the actor is. */}
        <div className="actor-col actor-col-pick">
          <div className="seg-tabs" role="tablist" aria-label="Actor type">
            {[['npc', 'NPC', 'pets'], ['pc', 'Character', 'person'], ['light', 'Lighting', 'lightbulb']].map(([id, label, icon]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={kind === id}
                className={`seg-tab${kind === id ? ' on' : ''}`}
                onClick={() => onKind?.(id)}
              >
                <span className="icon">{icon}</span>
                {label}
              </button>
            ))}
          </div>

          {kind === 'npc' && (
            <div className="fx-actor-npc plc-list-shell actor-npc-list">
              <NpcList onSelectEntry={onSelectNpc} selectedPath={actor.selectedPath || ''} />
            </div>
          )}
          {kind === 'pc' && (
            <div className="actor-pc">
              {pc?.races ? <EffectPcStrip pc={pc} gearsetsFirst /> : <div className="side-note">Loading character lists…</div>}
            </div>
          )}
          {kind === 'light' && <LightForm light={actor.light || DEFAULT_LIGHT} onChange={onLight} fields="type" />}
        </div>

        {/* Right: how it plays and where it sits. */}
        <div className="actor-col actor-col-opts">
          {kind === 'light' && <LightForm light={actor.light || DEFAULT_LIGHT} onChange={onLight} fields="settings" />}
          {kind !== 'light' && (
            <>
              <div className="actor-section">Animation</div>
              {kind === 'pc' && pc?.actionGroups?.length > 0 && (
                <>
                  <div className="pc-ctrl">
                    <label className="pc-ctrl-label">Category</label>
                    <Combo
                      value={pc.actionGroup}
                      items={pc.actionGroupItems}
                      onChange={pc.setActionGroup}
                    />
                  </div>
                  <div className="pc-ctrl">
                    <label className="pc-ctrl-label">Action</label>
                    <Combo
                      value={pc.action}
                      items={pc.actionEntries}
                      onChange={pc.setAction}
                      placeholder="— none —"
                    />
                  </div>
                </>
              )}
              <div className="actor-motion-row">
                <label className="pc-ctrl-label">Motion</label>
                <Combo
                  value={motionValue}
                  items={motionItems}
                  onChange={(id) => onMotion?.(id ?? '')}
                  className="actor-motion"
                />
                <Tooltip content={actor.playing ? 'Pause' : 'Play'} placement="top">
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={actor.playing ? 'Pause' : 'Play'}
                    disabled={!actor.motion}
                    onClick={() => onPlaying?.(!actor.playing)}
                  >
                    <span className="icon">{actor.playing ? 'pause' : 'play_arrow'}</span>
                  </button>
                </Tooltip>
                <Tooltip content={actor.loop ? 'Looping — click to play once' : 'Play once — click to loop'} placement="top">
                  <button
                    type="button"
                    className={`icon-btn${actor.loop ? ' on' : ''}`}
                    aria-label="Loop"
                    onClick={() => onLoop?.(!actor.loop)}
                  >
                    <span className="icon">{actor.loop ? 'repeat' : 'repeat_one'}</span>
                  </button>
                </Tooltip>
              </div>
              <FrameRow
                frameSink={frameSink}
                onSeek={onSeek}
                playing={!!actor.playing}
                onPause={() => onPlaying?.(false)}
              />
              {!actor.model && kind === 'npc' && (
                <div className="form-hint">Pick an NPC on the left to load its model and motions.</div>
              )}

              <div className="actor-section">Options</div>
              <div className="actor-opt-row">
                <label className="pc-ctrl-label">Play Effect</label>
                <div className="seg-tabs actor-seg" role="radiogroup" aria-label="Play effect">
                  {[[false, 'Off'], [true, 'On']].map(([on, text]) => (
                    <button
                      key={text}
                      type="button"
                      role="radio"
                      aria-checked={fxOn === on}
                      className={`seg-tab${fxOn === on ? ' on' : ''}`}
                      disabled={on && !fxAvailable}
                      onClick={() => onFx?.(on)}
                    >
                      {text}
                    </button>
                  ))}
                </div>
                <span className={`actor-fx-state mono${fxOn && actor.fxRoutine ? ' on' : ''}`}>
                  {!fxOn ? '' : actor.fxRoutine ? `routine ${actor.fxRoutine}` : actor.motion ? 'no effect for this motion' : 'pick a motion'}
                </span>
              </div>
              <div className="form-hint">
                {kind !== 'npc'
                  ? 'Effects come from an NPC\'s own model; characters have none here.'
                  : 'Plays the VFX the NPC\'s model ties to the selected motion (a Special\'s bundle, or the routine that names this clip), in step with the clip and re-fired at every loop.'}
              </div>
            </>
          )}

          <div className="actor-section">Transform</div>
          <div className="actor-transform-row">
            <div className="actor-pills" role="radiogroup" aria-label="Gizmo">
              {[['move', '1', 'Move', 'open_with'], ['rotate', '2', 'Rotate', 'rotate_right'], ['scale', '3', 'Scale', 'zoom_out_map']].map(([id, key, label, icon]) => (
                <Tooltip key={id} content={`${label} gizmo on this actor (key ${key})`} placement="top">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={gizmoMode === id}
                    className={`actor-pill${gizmoMode === id ? ' on' : ''}`}
                    onClick={() => onGizmoMode?.(id)}
                  >
                    <span className="icon">{icon}</span>
                    <span className="actor-pill-key mono">{key}</span>
                    {label}
                  </button>
                </Tooltip>
              ))}
            </div>
            <Tooltip content="Reset rotation and scale" placement="top">
              <button type="button" className="dbf-btn actor-reset" onClick={onResetTransform}>
                <span className="icon">restart_alt</span>
                Reset
              </button>
            </Tooltip>
          </div>
          <div className="actor-pos mono">
            x {actor.pos[0].toFixed(2)} &nbsp; y {actor.pos[1].toFixed(2)} &nbsp; z {actor.pos[2].toFixed(2)}
            &nbsp; · &nbsp; {(actor.scale ?? 1).toFixed(2)}×
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Frame scrubber for the actor's running clip. Uncontrolled, like the
 * Animation panel's: the render loop pushes the playhead through `frameSink`
 * and this writes the thumb straight to the DOM — 30 React updates a second
 * would rebuild the motion combo each time. Only the clip length is state.
 * Grabbing the thumb pauses the clip, so the frame you land on sticks.
 */
function FrameRow({ frameSink, onSeek, playing, onPause }) {
  const slider = useRef(null);
  const readout = useRef(null);
  const dragging = useRef(false);
  const [last, setLast] = useState(0);

  useEffect(() => {
    if (!frameSink) return undefined;
    frameSink.current = (frame, len) => {
      // lengthInFrames lands a hair under the whole number it means
      // (59.9999991 for a 60-frame clip); round before it reaches the scale.
      const end = Math.max(Math.round(len) - 1, 0);
      setLast((prev) => (prev === end ? prev : end));
      if (dragging.current || !slider.current) return;
      const f = Math.min(Math.floor(frame), end);
      slider.current.value = f;
      slider.current.style.setProperty('--fill', end > 0 ? `${(f / end) * 100}%` : '0%');
      if (readout.current) readout.current.textContent = `${f}/${end}`;
    };
    return () => { frameSink.current = null; };
  }, [frameSink]);

  const grab = () => {
    dragging.current = true;
    if (playing) onPause?.();
  };
  const drag = (e) => {
    dragging.current = true;
    const f = +e.target.value;
    onSeek?.(f);
    e.target.style.setProperty('--fill', last > 0 ? `${(f / last) * 100}%` : '0%');
    if (readout.current) readout.current.textContent = `${f}/${last}`;
  };
  const drop = () => { dragging.current = false; };

  return (
    <div className="actor-frame-row">
      <label className="pc-ctrl-label">Frame</label>
      <input
        ref={slider}
        type="range"
        className="vol-slider actor-frame-slider"
        min="0"
        max={last}
        defaultValue={0}
        disabled={last <= 0}
        aria-label="Animation frame"
        title="Drag to set the frame (pauses playback)"
        onPointerDown={grab}
        onInput={drag}
        onPointerUp={drop}
        onPointerCancel={drop}
        onBlur={drop}
      />
      <span ref={readout} className="mono pc-frame-num">0/0</span>
    </div>
  );
}

/** Point / ambient light settings: colour or temperature, intensity, radius. */
function LightForm({ light, onChange, fields = 'all' }) {
  const L = { ...DEFAULT_LIGHT, ...(light || {}) };
  const tempHex = rgb01ToHex(kelvinToRgb01(L.temperature));
  const seg = (value, items, onPick, label) => (
    <div className="seg-tabs actor-seg" role="radiogroup" aria-label={label}>
      {items.map(([id, text]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          className={`seg-tab${value === id ? ' on' : ''}`}
          onClick={() => onPick(id)}
        >
          {text}
        </button>
      ))}
    </div>
  );
  const typeBlock = (
    <div className="gfx-line">
      <label className="pc-ctrl-label">Type</label>
      {seg(L.type, [['point', 'Point'], ['spot', 'Spot'], ['ambient', 'Ambient']], (type) => onChange?.({ type }), 'Light type')}
    </div>
  );
  const settingsBlock = (
    <>
      <div className="gfx-line">
        <label className="pc-ctrl-label">Colour</label>
        {seg(L.useTemperature ? 'temp' : 'rgb', [['rgb', 'Colour'], ['temp', 'Temperature']], (m) => onChange?.({ useTemperature: m === 'temp' }), 'Colour mode')}
      </div>
      {L.useTemperature ? (
        <>
          <div className="gfx-line">
            <label className="pc-ctrl-label">Temperature &nbsp; • &nbsp; <strong>{L.temperature} K</strong></label>
            <span className="actor-light-swatch" style={{ background: tempHex }} />
          </div>
          <input
            type="range"
            min="1000"
            max="12000"
            step="100"
            value={L.temperature}
            onChange={(e) => onChange?.({ temperature: +e.target.value })}
            className="vol-slider gfx-slider"
            style={{ '--fill': `${((L.temperature - 1000) / 11000) * 100}%` }}
          />
        </>
      ) : (
        <div className="gfx-line">
          <label className="pc-ctrl-label">Light colour</label>
          <div className="gfx-ctrl">
            <input
              type="color"
              className="tool-pop-color"
              value={L.color}
              onChange={(e) => onChange?.({ color: e.target.value })}
              aria-label="Light colour"
            />
          </div>
        </div>
      )}
      <div className="gfx-line">
        <label className="pc-ctrl-label">Intensity &nbsp; • &nbsp; <strong>{Number(L.intensity).toFixed(2)}</strong></label>
      </div>
      <input
        type="range"
        min="0"
        max="4"
        step="0.05"
        value={L.intensity}
        onChange={(e) => onChange?.({ intensity: +e.target.value })}
        className="vol-slider gfx-slider"
        style={{ '--fill': `${(L.intensity / 4) * 100}%` }}
      />
      {L.type !== 'ambient' && (
        <>
          <div className="gfx-line">
            <label className="pc-ctrl-label">Radius &nbsp; • &nbsp; <strong>{Math.round(L.radius)}</strong></label>
          </div>
          <input
            type="range"
            min="1"
            max="150"
            step="1"
            value={L.radius}
            onChange={(e) => onChange?.({ radius: +e.target.value })}
            className="vol-slider gfx-slider"
            style={{ '--fill': `${((L.radius - 1) / 149) * 100}%` }}
          />
        </>
      )}
      {L.type === 'spot' && (
        <>
          <div className="gfx-line">
            <label className="pc-ctrl-label">Cone &nbsp; • &nbsp; <strong>{Math.round(L.cone ?? 35)}°</strong></label>
          </div>
          <input
            type="range"
            min="2"
            max="85"
            step="1"
            value={L.cone ?? 35}
            onChange={(e) => onChange?.({ cone: +e.target.value })}
            className="vol-slider gfx-slider"
            style={{ '--fill': `${(((L.cone ?? 35) - 2) / 83) * 100}%` }}
          />
        </>
      )}
      <div className="form-hint">
        {L.type === 'point'
          ? 'Lights the terrain, props and actors within the radius; the ring on the ground shows the reach. Move it with the gizmo (1).'
          : L.type === 'spot'
            ? 'A cone pointing straight down until you aim it with the rotate gizmo (2). The stub on the marker shows the aim; the ring shows the reach.'
            : 'Adds to the whole zone\'s ambient light.'}
        {' '}Lamps do not cast their own shadows.
      </div>
    </>
  );
  return (
    <div className="actor-light">
      {(fields === 'all' || fields === 'type') && typeBlock}
      {(fields === 'all' || fields === 'settings') && settingsBlock}
    </div>
  );
}
