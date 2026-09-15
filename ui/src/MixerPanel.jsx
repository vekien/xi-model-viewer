import { useEffect, useMemo, useRef, useState } from 'react';
import { Checkbox, Field, Label } from '@headlessui/react';
import { Tooltip } from './Tooltip.jsx';
import { TimelineWindow } from './MixerTimeline.jsx';
import { Floating } from './Floating.jsx';
import { kindOf, opName, shiftLane, strikeFrame, trackLabel, withIds } from '../js/mixer.js';

// The mixer's side panel: the recipe (name, save, publish, the organizer), the parts
// of the picked source (solo / take), the selected event's numbers, and the state
// the timeline window (MixerTimeline.jsx) draws. Everything here edits
// `recipe.events`; Play composes exactly that.

const SHUFFLE_KINDS = [{ id: 'ws', label: 'WS' }, { id: 'ja', label: 'Ability' }, { id: 'spell', label: 'Spell' }];

/** The lines of a `dats build --dry-run` that name the slot and the DATs — the
 *  rest (the SQL, the command echo) stays in the console. */
function planExcerpt(text) {
  const lines = String(text ?? '').split('\n').filter((l) => /animation|file_id|-> ROM|occupied|Error/i.test(l));
  return (lines.length ? lines : String(text ?? '').split('\n').slice(-6)).slice(0, 12).join('\n');
}

function Num({ label, value, onChange, min = 0 }) {
  return (
    <label className="mixer-field">
      <span>{label}</span>
      {/* Whole frames only: the recipe schema rejects a fractional or negative dur. */}
      <input type="number" min={min} step={1} value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Math.max(min, Math.round(Number(e.target.value) || 0)))} />
    </label>
  );
}

function EventEditor({ ev, onChange, onRemove }) {
  if (!ev) return <div className="side-note">Select a block to edit its frames.</div>;
  const isClip = ev.op === 0x05;
  return (
    <div className="mixer-editor">
      <div className="mixer-editor-title">
        <span className="mono">{ev.ref ?? '—'}</span>
        <span className="mono-small">{opName(ev.op)} · {ev.from}</span>
        <span className="sp" />
        <div className="pc-tgroup">
        <Tooltip content={ev.enabled === false ? 'Include in the recipe' : 'Leave out of the recipe'}>
          <button type="button" className="pc-tbtn" onClick={() => onChange({ enabled: ev.enabled === false })}>
            <span className="icon">{ev.enabled === false ? 'visibility_off' : 'visibility'}</span>
          </button>
        </Tooltip>
        <Tooltip content="Remove">
          <button type="button" className="pc-tbtn" onClick={onRemove}><span className="icon">delete</span></button>
        </Tooltip>
        </div>
      </div>
      <div className="mixer-fields">
        <Num label="start frame" value={ev.start} onChange={(v) => onChange({ start: v ?? 0 })} />
        <Num label="duration" value={ev.dur} onChange={(v) => onChange({ dur: v })} />
        {isClip && (
          <>
            <Num label="blend in" value={ev.blend?.[0]} onChange={(v) => onChange({ blend: [v ?? 0, ev.blend?.[1] ?? 0] })} />
            <Num label="blend out" value={ev.blend?.[1]} onChange={(v) => onChange({ blend: [ev.blend?.[0] ?? 0, v ?? 0] })} />
            <Num label="loops (0 = ∞)" value={ev.loops} onChange={(v) => onChange({ loops: v })} />
          </>
        )}
      </div>
      {ev.label && <div className="mono-small mixer-editor-note">{ev.label}</div>}
    </div>
  );
}

/** The parts of the source shown for `lane`: generators (solo / take), sounds (play / take), clips. */
function Parts({ lane, entry, info, events, onSolo, onPlaySound, onTake, playingSoundKey = null }) {
  if (!entry) return null;
  const kind = kindOf(lane);
  const taken = new Set(events.filter((e) => e.from === lane && e.enabled !== false).map((e) => e.ref));
  const gens = (info?.timeline ?? []).filter((e) => e.op === 0x02 && !e.detail?.sound);
  const genRows = gens.length ? gens.map((g) => ({ ref: g.ref, start: g.start, dur: g.dur }))
    : (entry.gens ?? []).map((g) => ({ ref: g }));
  const audioRows = (info?.timeline ?? []).filter((e) => e.op === 0x02 && e.detail?.sound)
    .map((g) => ({ ref: g.ref, start: g.start, sound: g.detail.sound.file, id: g.detail.sound.sound_id, title: g.detail.sound.title }));
  // One row per sound pointer: a skill often plays the same pointer twice (at the
  // source and at the target); `take` covers every command that names it.
  const soundRows = [];
  for (const s of (info?.timeline ?? []).filter((e) => e.kind === 'sound')) {
    if (soundRows.some((r) => r.ref === s.ref)) continue;
    soundRows.push({ ref: s.ref, start: s.start, id: s.detail?.sound?.sound_id, title: s.detail?.sound?.title });
  }
  const clipRows = (info?.timeline ?? []).filter((e) => e.op === 0x05)
    .map((c) => ({ ref: c.ref, start: c.start, dur: c.dur, summary: c.summary }));
  return (
    <div className="mixer-parts">
      <div className="fx-actor-sec-title">{entry.name} · {entry.spec}</div>
      {!info && <div className="side-note">Reading the timeline…</div>}
      {kind === 'motion' && clipRows.length > 0 && <div className="side-separator">Clips</div>}
      {kind === 'motion' && clipRows.map((c) => (
        <div className="mixer-part" key={`c${c.ref}${c.start}`}>
          <span className="mono">{c.ref}</span>
          <span className="mono-small">f{c.start}{c.dur ? ` · ${c.dur}` : ''}</span>
          <span className="mixer-part-note mono-small">{c.summary}</span>
        </div>
      ))}
      {kind !== 'sound' && genRows.length > 0 && <div className="side-separator">Generators</div>}
      {kind !== 'sound' && genRows.map((g) => (
        <div className="mixer-part" key={`g${g.ref}${g.start ?? ''}`}>
          <Tooltip content="Play only this generator on the stage (Play mix brings the mix back)">
            <button type="button" className="pc-tbtn" onClick={() => onSolo(g.ref)}><span className="icon">play_arrow</span></button>
          </Tooltip>
          <span className="mono">{g.ref}</span>
          <span className="mono-small">{g.start != null ? `f${g.start}` : ''}{g.dur ? ` · ${g.dur}` : ''}{g.sound ? ` · ♪ ${g.sound}` : ''}</span>
          <Field className="mixer-take">
            <Checkbox checked={taken.has(g.ref)} onChange={(v) => onTake(lane, g.ref, v)} className="checkbox">
              <span className="icon check-icon">check</span>
            </Checkbox>
            <Label>take</Label>
          </Field>
        </div>
      ))}
      {kind === 'sound' && (soundRows.length + audioRows.length) > 0 && <div className="side-separator">Sounds</div>}
      {kind === 'sound' && [...soundRows, ...audioRows].map((s) => (
        <div className="mixer-part" key={`s${s.ref}${s.start ?? ''}`}>
          <Tooltip content={playingSoundKey === `${s.ref}:${s.id}` ? 'Stop' : 'Play this sound'}>
            <button type="button" className={`pc-tbtn${playingSoundKey === `${s.ref}:${s.id}` ? ' on' : ''}`}
              aria-pressed={playingSoundKey === `${s.ref}:${s.id}` ? 'true' : 'false'} onClick={() => onPlaySound(s)}>
              <span className="icon">{playingSoundKey === `${s.ref}:${s.id}` ? 'stop' : 'volume_up'}</span>
            </button>
          </Tooltip>
          <span className="mono">{s.ref}</span>
          <span className="mono-small">{s.sound ?? (s.id != null ? `se${String(s.id).padStart(6, '0')}` : '')}{s.title ? ` · ${s.title}` : ''}{s.start != null ? ` · f${s.start}` : ''}</span>
          <Field className="mixer-take">
            <Checkbox checked={taken.has(s.ref)} onChange={(v) => onTake(lane, s.ref, v)} className="checkbox">
              <span className="icon check-icon">check</span>
            </Checkbox>
            <Label>take</Label>
          </Field>
        </div>
      ))}
    </div>
  );
}

/** One saved recipe in the organizer: open, rename (inline), duplicate, delete (two-step). */
function RecipeRow({ r, current, onStage, onOpen, onRename, onDuplicate, onDelete }) {
  const [mode, setMode] = useState(null);   // null | 'rename'
  const [draft, setDraft] = useState(r.name);
  const ref = useRef(null);
  useEffect(() => { if (mode === 'rename') { ref.current?.focus(); ref.current?.select?.(); } }, [mode]);
  const srcs = ['motion', 'vfx', 'sound'].map((l) => r.sources?.[l]?.name ?? r.sources?.[l]?.spec).filter(Boolean).join(' · ');
  const stop = (e) => { e.stopPropagation(); };
  return (
    <div className={`mixer-recipe-row${current ? ' on' : ''}${mode ? ' busy' : ''}`} onClick={() => !mode && onOpen(r.name)}>
      <div className="mixer-recipe-main">
        {mode === 'rename'
          ? (
            <form className="mixer-save" onClick={stop} onSubmit={(e) => { e.preventDefault(); onRename(r.name, draft); setMode(null); }}>
              <input ref={ref} value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value.replace(/[^A-Za-z0-9_-]/g, '_'))}
                onKeyDown={(e) => { if (e.key === 'Escape') setMode(null); }} />
              <button type="submit" className="pc-tbtn"><span className="icon">check</span></button>
              <button type="button" className="pc-tbtn" onClick={() => setMode(null)}><span className="icon">close</span></button>
            </form>
          )
          : (
            <span className="mixer-recipe-name">
              {r.name}
              {onStage && <span className="mixer-recipe-badge">ON STAGE</span>}
            </span>
          )}
        <span className="mixer-recipe-src">{srcs || 'empty'}</span>
      </div>
      <span className="mixer-recipe-acts" onClick={stop}>
        <Tooltip content="Rename"><button type="button" className="pc-tbtn" onClick={() => { setDraft(r.name); setMode('rename'); }}><span className="icon">edit</span></button></Tooltip>
        <Tooltip content="Duplicate"><button type="button" className="pc-tbtn" onClick={() => onDuplicate(r.name)}><span className="icon">content_copy</span></button></Tooltip>
        {/* One click: a recipe is a small JSON file next to its compose output, cheap to recreate. */}
        <Tooltip content="Delete"><button type="button" className="pc-tbtn" onClick={() => onDelete(r.name)}><span className="icon">delete</span></button></Tooltip>
      </span>
    </div>
  );
}

export function MixerPanel({
  recipe, onRecipe, lane, laneInfo, laneEntry,
  transport, onPlay, onStop, onPublish, publishPlan = null, onSaveAs, onOpen, onReset, recipes, busy, note, error = null, onDismissError,
  onDelete, onRename, onDuplicate, onShuffle, stageName,
  onPause, onResume, onSeek, getPlayhead, mixLoaded, mixDirty,
  onSolo, onPlaySound, onTake, viewerRace, onClose, getSoundPeaks, speed = 1, onSpeed, loop = true, onLoop, ghosts = null,
  panels = { mixer: true, parts: true, timeline: true }, onPanel,
  tracks = [], onActivateTrack, onAddTrack, onRemoveTrack,
  playingSoundKey = null,
  shuffleKind = 'ws', onShuffleKind, saveTick = 0,
}) {
  // Selection is a set: a marquee or ctrl-click builds a group that drags,
  // duplicates and deletes as one. The editor below shows a lone selection.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const select = (idOrIds, mode) => setSelectedIds((prev) => {
    const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
    if (mode === 'only' || mode === 'set') return new Set(ids);
    const next = new Set(prev);
    for (const id of ids) {
      if (mode === 'toggle' && next.has(id)) next.delete(id);
      else next.add(id);
    }
    return next;
  });
  const selectedId = selectedIds.size === 1 ? [...selectedIds][0] : null;

  // Three windows, each a glyph on the right rail (App.jsx): the timeline
  // (MixerTimeline.jsx, the Camera Sequencer's chrome), the recipe — name, save,
  // publish, the organizer — and the parts of the picked source. `panels` says
  // which are open; closing one tells the rail through onPanel.

  const [head, setHead] = useState(0);
  useEffect(() => {
    if (!getPlayhead) return undefined;
    const id = setInterval(() => setHead(getPlayhead().frame), 50);
    return () => clearInterval(id);
  }, [getPlayhead]);
  const events = recipe.events;
  const selected = events.find((e) => e._id === selectedId) ?? null;
  const strike = useMemo(() => strikeFrame(events), [events]);
  // Forget ids of events that are gone (removed, or a lane re-taken).
  useEffect(() => {
    const live = (id) => events.some((e) => e._id === id);
    if ([...selectedIds].every(live)) return;
    setSelectedIds((prev) => new Set([...prev].filter(live)));
  }, [events, selectedIds]);

  const update = (id, patch) => onRecipe({ ...recipe, events: events.map((e) => (e._id === id ? { ...e, ...patch } : e)) });
  const moveMany = (list) => {
    const by = new Map(list.map((m) => [m.id, m.start]));
    onRecipe({ ...recipe, events: events.map((e) => (by.has(e._id) ? { ...e, start: by.get(e._id) } : e)) });
  };
  const removeMany = (ids) => onRecipe({ ...recipe, events: events.filter((e) => !ids.has(e._id)) });
  /** M: mute (disable) or unmute the selection. A muted event stays on the timeline but is left out of the mix. */
  const toggleMute = (ids) => {
    const anyOn = events.some((e) => ids.has(e._id) && e.enabled !== false);
    onRecipe({ ...recipe, events: events.map((e) => (ids.has(e._id) ? { ...e, enabled: !anyOn } : e)) });
  };
  const remove = (id) => removeMany(new Set([id]));
  /** Ctrl+D: copies of the selection right after it, spacing kept, selected so they can be dragged. */
  const duplicateMany = (ids) => {
    const src = events.filter((e) => ids.has(e._id));
    if (!src.length) return;
    const first = Math.min(...src.map((e) => e.start));
    const last = Math.max(...src.map((e) => e.start + (e.dur || 0)));
    const gap = Math.max(last - first, 15);
    const copies = withIds(src.map(({ _id, ...rest }) => ({ ...rest, start: rest.start + gap })));
    onRecipe({ ...recipe, events: [...events, ...copies] });
    setSelectedIds(new Set(copies.map((c) => c._id)));
  };
  // Editing keys for the selection. Space is not handled here: the app has one
  // Space handler for whichever transport is on screen (App.jsx), and the mixer
  // is a branch of it — so it cannot double up with the Characters view's
  // toggle, and the Camera Sequencer's capture-phase handler still wins.
  useEffect(() => {
    const typing = (t) => /^(input|select|textarea)$/i.test(t?.tagName) || t?.isContentEditable;
    const onKey = (e) => {
      if (typing(e.target) || !selectedIds.size) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicateMany(selectedIds);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        removeMany(selectedIds);
      } else if (e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        toggleMute(selectedIds);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const shift = (laneId, delta) => onRecipe({ ...recipe, events: shiftLane(events, laneId === 'keep' ? 'keep' : laneId, delta) });
  const snapLane = (laneId) => {
    const own = events.filter((e) => e.from === laneId && e.op === 0x02);
    if (!own.length) return;
    const first = Math.min(...own.map((e) => e.start));
    onRecipe({ ...recipe, events: shiftLane(events, laneId, strike - first) });
  };

  // Save prompts for a name (prefilled). A different name that already exists
  // asks before overwriting; a new name writes a copy and leaves the old file.
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [overwrite, setOverwrite] = useState(null);
  const saveRef = useRef(null);
  useEffect(() => { if (saving) { saveRef.current?.focus(); saveRef.current?.select?.(); } }, [saving]);
  const beginSave = () => { setSaveName(recipe.name); setOverwrite(null); setSaving(true); };
  // The top-right bar's Save glyph asks for the name here, where the form lives.
  useEffect(() => { if (saveTick) beginSave(); }, [saveTick]);   // eslint-disable-line react-hooks/exhaustive-deps
  const commitSave = () => {
    const name = saveName.trim();
    if (!name) { setSaving(false); return; }
    if (name !== recipe.name && (recipes ?? []).some((r) => r.name === name) && overwrite !== name) { setOverwrite(name); return; }
    onSaveAs?.(name);
    setSaving(false);
    setOverwrite(null);
  };

  // A failed compose or pick outranks every other note until the next attempt.
  const failed = !busy && !!error;
  const statusNote = busy ? 'working…' : (mixLoaded && mixDirty ? 'edited · Play mix to hear the change' : (events.length ? note : 'pick a motion, effect or sound on the left to start'));

  // The window's Play/Pause is the sequencer's round glyph; its meaning is the
  // Animation panel's: compose and play, pause, resume, or play again.
  const armed = mixLoaded && !mixDirty;
  const playTip = armed ? (transport === 'playing' ? 'Pause the mix (Space)' : 'Run the composed mix again (no recompose)') : 'Compose the recipe for this race and play it';
  const onPlayPause = () => {
    if (!armed) return onPlay?.();
    return transport === 'playing' ? onPause?.() : onResume?.();
  };
  const timeline = (
    <TimelineWindow open={!!panels.timeline} onClose={() => onPanel?.('timeline', false)}
      recipeName={recipe.name} note={statusNote} failed={failed} error={error} onDismissError={onDismissError}
      events={events} selectedIds={selectedIds} onSelect={select} onMoveMany={moveMany} onShiftLane={shift}
      tracks={tracks} activeTrack={lane} sources={recipe.sources} onActivateTrack={onActivateTrack} onAddTrack={onAddTrack} onRemoveTrack={onRemoveTrack}
      onPreview={(ev) => onPlaySound?.({ id: ev.sound, ref: ev.ref })}
      strike={strike} playhead={mixLoaded ? head : null} mixLoaded={mixLoaded}
      minLen={getPlayhead ? getPlayhead().length : 0} loopEnd={mixLoaded && getPlayhead ? getPlayhead().length : 0}
      getSoundPeaks={getSoundPeaks} ghosts={ghosts}
      transport={armed ? transport : 'stopped'} canPlay={!busy && (armed || events.length > 0)} playTip={playTip}
      onPlayPause={onPlayPause} onStop={onStop} onSeek={onSeek}
      speed={speed} onSpeed={onSpeed} loop={loop} onLoop={onLoop}
      onSnapLane={snapLane} viewerRace={viewerRace}
      editor={selected ? <EventEditor ev={selected} onChange={(p) => update(selected._id, p)} onRemove={() => remove(selected._id)} /> : null} />
  );

  return (
    <>
      {timeline}
      <Floating id="mixer-main" open={!!panels.mixer} width={460} defaultPos={{ right: 400, top: 60 }}>
      <div className="panel mixer-panel">
        <div className="details-header">
          <span className="icon">tune</span>
          <span className="details-title">Recipes</span>
          <span className="sp" />
          <button type="button" className="pc-tbtn details-close" aria-label="Close" onClick={() => onPanel?.('mixer', false)}><span className="icon">close</span></button>
        </div>

        <div className="pc-ctrl">
          <span className="pc-ctrl-label">Recipe</span>
          <input type="text" className="mixer-name" value={recipe.name} spellCheck={false} aria-label="Recipe name"
            onChange={(e) => onRecipe({ ...recipe, name: e.target.value.replace(/[^A-Za-z0-9_-]/g, '_') })} />
        </div>
        {onShuffle && (
          <div className="pc-ctrl">
            <span className="pc-ctrl-label">Shuffle as</span>
            <div className="seg-tabs" role="tablist" aria-label="Shuffle kind">
              {SHUFFLE_KINDS.map((k) => (
                <button key={k.id} type="button" role="tab" aria-selected={shuffleKind === k.id}
                  className={`seg-tab${shuffleKind === k.id ? ' on' : ''}`} onClick={() => onShuffleKind?.(k.id)}>{k.label}</button>
              ))}
            </div>
          </div>
        )}

        {publishPlan && (
          <div className="mixer-publish">
            <div className="fx-actor-sec-title">Publish · {publishPlan.name}</div>
            <pre className="mono-small mixer-plan">{planExcerpt(publishPlan.text)}</pre>
            <div className="mixer-save">
              <span className="side-note mixer-publish-note">Writes the DAT(s) into ROM10 and registers their file ids (xi dats build). Full plan in the console.</span>
              <button type="button" className="mixer-chip danger" disabled={busy} onClick={() => onPublish?.('go')}>publish</button>
              <button type="button" className="mixer-chip" onClick={() => onPublish?.('cancel')}>cancel</button>
            </div>
          </div>
        )}

        {saving && (
          <form className="mixer-save" onSubmit={(e) => { e.preventDefault(); commitSave(); }}>
            <input ref={saveRef} value={saveName} spellCheck={false} placeholder="recipe name"
              onChange={(e) => { setSaveName(e.target.value.replace(/[^A-Za-z0-9_-]/g, '_')); setOverwrite(null); }}
              onKeyDown={(e) => { if (e.key === 'Escape') { setSaving(false); setOverwrite(null); } }} />
            {overwrite
              ? <button type="submit" className="mixer-chip danger">overwrite {overwrite}</button>
              : <Tooltip content="Save"><button type="submit" className="pc-tbtn" aria-label="Save"><span className="icon">check</span></button></Tooltip>}
            <Tooltip content="Cancel"><button type="button" className="pc-tbtn" aria-label="Cancel" onClick={() => { setSaving(false); setOverwrite(null); }}><span className="icon">close</span></button></Tooltip>
          </form>
        )}

        <div className="fx-actor-sec-title">Recipes · {(recipes ?? []).length}</div>
        <div className="mixer-recipes">
          {!(recipes ?? []).length && <div className="side-note">No saved recipes yet — Save writes one into exports/ability/mixer.</div>}
          {(recipes ?? []).map((r) => (
            <RecipeRow key={r.name} r={r} current={r.name === recipe.name} onStage={r.name === stageName}
              onOpen={onOpen} onRename={onRename} onDuplicate={onDuplicate} onDelete={onDelete} />
          ))}
        </div>
      </div>

      </Floating>
      <Floating id="mixer-parts" open={!!panels.parts} width={460} defaultPos={{ right: 400, top: 430 }}>
      <div className="panel mixer-parts-panel">
        <div className="details-header">
          <span className="icon">segment</span>
          <span className="details-title">Parts · {trackLabel(lane)}</span>
          <span className="sp" />
          <button type="button" className="pc-tbtn details-close" aria-label="Close" onClick={() => onPanel?.('parts', false)}><span className="icon">close</span></button>
        </div>
        <div className="mixer-parts-body">
          {!laneEntry && <div className="side-note">Pick a source for this lane to see what it is made of.</div>}
          <Parts lane={lane} entry={laneEntry} info={laneInfo} events={events}
            onSolo={onSolo} onPlaySound={onPlaySound} onTake={onTake} playingSoundKey={playingSoundKey} />
        </div>
      </div>
      </Floating>
    </>
  );
}
