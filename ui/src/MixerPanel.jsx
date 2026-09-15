import { useEffect, useMemo, useRef, useState } from 'react';
import { Tooltip } from './Tooltip.jsx';
import { TimelineWindow } from './MixerTimeline.jsx';
import { Floating } from './Floating.jsx';
import { kindOf, opName, shiftLane, strikeFrame, trackLabel, withIds } from '../js/mixer.js';

// The mixer's side panel: the recipe (name, save, publish, the organizer), the parts
// of the picked source (solo / take), the selected event's numbers, and the state
// the timeline window (MixerTimeline.jsx) draws. Everything here edits
// `recipe.events`; Play composes exactly that.

function Num({ label, value, onChange, min = 0 }) {
  return (
    <label className="mixer-field">
      <span>{label}</span>
      {/* Whole frames only: the recipe schema rejects a fractional or negative dur.
          A plain text field (numeric keypad on touch), not a number spinner. */}
      <input type="text" inputMode="numeric" className="cseq-text mixer-num" value={value ?? ''} spellCheck={false}
        onChange={(e) => { const digits = e.target.value.replace(/[^0-9]/g, ''); onChange(digits === '' ? undefined : Math.max(min, Number(digits))); }} />
    </label>
  );
}

function EventEditor({ ev, onChange, onRemove, onSolo }) {
  if (!ev) return <div className="side-note">Select a block to edit its frames.</div>;
  const isClip = ev.op === 0x05;
  const isGen = ev.op === 0x02 || ev.op === 0x3f;
  const off = ev.enabled === false;
  return (
    <div className={`mixer-editor${off ? ' off' : ''}`}>
      <div className="mixer-editor-title">
        <span className="mono">{ev.ref ?? '—'}</span>
        <span className="mono-small">{opName(ev.op)} · {trackLabel(ev.from)}{off ? ' · disabled' : ''}</span>
        <span className="sp" />
        <div className="pc-tgroup">
        {isGen && onSolo && (
          <Tooltip content="Play just this generator, looping, until the next Play mix">
            <button type="button" className="pc-tbtn" aria-label="Play this generator" onClick={onSolo}>
              <span className="icon">play_circle</span>
            </button>
          </Tooltip>
        )}
        <Tooltip content={off ? 'Enable: back into the mix' : 'Disable: stays on the timeline, left out of the mix'}>
          <button type="button" className={`pc-tbtn${off ? ' on' : ''}`} aria-label={off ? 'Enable' : 'Disable'} onClick={() => onChange({ enabled: off })}>
            <span className="icon">{off ? 'visibility_off' : 'visibility'}</span>
          </button>
        </Tooltip>
        <Tooltip content="Remove from the timeline">
          <button type="button" className="pc-tbtn" aria-label="Remove" onClick={onRemove}><span className="icon">delete</span></button>
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

export function MixerPanel({
  recipe, onRecipe, lane, laneInfo, laneEntry,
  transport, onPlay, onStop, onPublish, publishPlan = null, onSaveAs, onOpen, onReset, recipes, busy, note, error = null, onDismissError,
  onDelete, onRename, onDuplicate, onShuffle, stageName,
  onPause, onResume, onSeek, getPlayhead, mixLoaded, mixDirty,
  onSolo, onPlaySound, onTake, viewerRace, onClose, getSoundPeaks, speed = 1, onSpeed, loop = true, onLoop, ghosts = null,
  panels = { mixer: true, parts: true, timeline: true }, onPanel,
  tracks = [], onActivateTrack, onAddTrack, onRemoveTrack,
  playingSoundKey = null,
  shuffleKind = 'ws', onShuffleKind, onDropEntry,
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
      // Ctrl+S / Alt+S: the Timeline row's Save, from anywhere in the view —
      // the name field included, so typing a name and pressing Ctrl+S works.
      if ((e.ctrlKey || e.metaKey || e.altKey) && e.key.toLowerCase() === 's' && !e.shiftKey) {
        e.preventDefault();
        if (recipe.name.trim()) onSaveAs?.(recipe.name.trim());
        return;
      }
      // Ctrl+A: every block on every track, rather than the page's text.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !e.shiftKey && !e.altKey && !typing(e.target)) {
        e.preventDefault();
        setSelectedIds(new Set(events.map((ev) => ev._id)));
        return;
      }
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
      minLen={getPlayhead ? getPlayhead().length : 0}
      loopEnd={Number.isFinite(recipe.total) && recipe.total > 0 ? recipe.total : (getPlayhead ? getPlayhead().length : 0)}
      loopSet={Number.isFinite(recipe.total) && recipe.total > 0}
      onLoopEnd={(f) => { const { total, ...rest } = recipe; onRecipe?.(f ? { ...recipe, total: f } : rest); }}
      getSoundPeaks={getSoundPeaks} ghosts={ghosts}
      transport={armed ? transport : 'stopped'} canPlay={!busy && (armed || events.length > 0)} playTip={playTip}
      onPlayPause={onPlayPause} onStop={onStop} onSeek={onSeek}
      speed={speed} onSpeed={onSpeed} loop={loop} onLoop={onLoop}
      onSnapLane={snapLane} viewerRace={viewerRace}
      name={recipe.name} onName={(n) => onRecipe({ ...recipe, name: n })} onNew={onReset}
      onSave={() => recipe.name.trim() && onSaveAs?.(recipe.name.trim())} saved={recipes ?? []} onOpen={onOpen} onDelete={onDelete}
      publishPlan={publishPlan} onPublish={onPublish} busy={busy}
      shuffleKind={shuffleKind} onShuffleKind={onShuffle ? onShuffleKind : null} onRandomise={onShuffle ? () => onShuffle(shuffleKind) : null}
      canPublish={!busy && events.length > 0 && !publishPlan}
      onDropEntry={onDropEntry}
      editor={selected ? <EventEditor ev={selected} onChange={(p) => update(selected._id, p)} onRemove={() => remove(selected._id)}
        onSolo={onSolo ? () => onSolo(selected.ref, selected.from, selected.dur) : null} /> : null} />
  );

  return (
    <>
      {timeline}
    </>
  );
}
