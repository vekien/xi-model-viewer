import { useEffect, useMemo, useRef, useState } from 'react';
import { Tooltip } from './Tooltip.jsx';
import { TimelineWindow } from './MixerTimeline.jsx';
import { Floating } from './Floating.jsx';
import { Combo } from './Combo.jsx';
import { CategoryInput } from './CategoryInput.jsx';
import { MixerLibrary, categoriesOf } from './MixerLibrary.jsx';
import { MixerGeneratorPanel } from './MixerGeneratorPanel.jsx';
import {
  KEEP_FAMILY_LABEL, MAX_ROW, SHARED_ROUTINES, clipBlend, deleteRow, editedGenerators, hasTrack, holdMarks, isBlockingOp, isGeneratorOp,
  isLinkOp, keepDoes, keepFamily, keepFields, keepHits, keepLabel, keepLooks, keepOp, keepSchool, keepVariants, keepWarnings, kindOf,
  linkHold, makeKeepEvents, opName, patchKeepEvent, recipeLength, resolveKeepRef, rowOfEvent, sharedNote, shiftLane, stageOf,
  strikeFrame, trackLabel, withIds,
} from '../js/mixer.js';
import { texturedGenerators } from '../js/mixerLive.js';

// Ctrl+C / Ctrl+V: the copied blocks with their spacing and tracks. Module
// level so a copy outlives a view switch and lands in another mix.
let clipboard = null;   // { items: [{ ...event sans _id, offset }], span, origin }

/** An event as a copy of itself: no id, and no row of its own — its original's row
 *  is only a wish (`rowHint`), so the copy lands beside it when there is room and
 *  in the first free row when there is not. */
const asCopy = ({ _id, row, rowHint, ...rest }) => (rowOfEvent({ row }) == null ? rest : { ...rest, rowHint: row });

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

function EventEditor({ ev, onChange, onRemove, onSolo, onEditGenerator, generatorOpen = false }) {
  if (!ev) return <div className="side-note">Select a block to edit its frames.</div>;
  const isClip = ev.op === 0x05;
  // The blend the clip plays with: its own override, else the source command's.
  const blend = clipBlend(ev);
  const isGen = isGeneratorOp(ev.op);
  const off = ev.enabled === false;
  // A cast's stage (Start, Middle, End…) leads the title, as it leads the pill's label.
  const stage = stageOf(ev);
  return (
    <div className={`mixer-editor${off ? ' off' : ''}`}>
      <div className="mixer-editor-title">
        <span className="mono">{stage ? `${stage} · ` : ''}{ev.ref ?? '—'}</span>
        <span className="mono-small">{opName(ev.op)} · {trackLabel(ev.from)}{off ? ' · disabled' : ''}</span>
        <span className="sp" />
        <Tooltip content="Remove from the timeline">
          <button type="button" className="pc-tbtn" aria-label="Remove" onClick={onRemove}><span className="icon">delete</span></button>
        </Tooltip>
      </div>
      <div className="mixer-fields">
        <div className="mixer-editor-acts">
          {isGen && onSolo && (
            <Tooltip content="Play just this generator, once" placement="top">
              <button type="button" className="cseq-btn mixer-preview-btn" onClick={onSolo}>Preview</button>
            </Tooltip>
          )}
          {isGen && onEditGenerator && (
            <Tooltip content="This generator's fields: timing, spawn, position, rotation, colour, texture, curves. An edit belongs to this mix, and Publish writes it into the mix's DAT" placement="top">
              <button type="button" className={`cseq-btn${generatorOpen ? ' on' : ''}`} onClick={onEditGenerator}>Edit generator</button>
            </Tooltip>
          )}
          <Tooltip content={off ? 'Put it back into the mix' : 'Stays on the timeline, left out of the mix'} placement="top">
            <button type="button" className="cseq-btn mixer-toggle-btn" onClick={() => onChange({ enabled: off })}>
              <span className={off ? 'mixer-toggle-alt' : undefined}>Disable</span>
              <span className={off ? undefined : 'mixer-toggle-alt'}>Re-Enable</span>
            </button>
          </Tooltip>
        </div>
        <Num label="start frame" value={ev.start} onChange={(v) => onChange({ start: v ?? 0 })} />
        <Num label="duration" value={ev.dur} onChange={(v) => onChange({ dur: v })} />
        {/* Rows count from 1 here, as the track shows them; the recipe counts from 0.
            The keep lane packs itself, so its blocks have no row to set. */}
        {ev.kind !== 'keep' && (
          <Num label="row" min={1} value={rowOfEvent(ev) == null ? undefined : ev.row + 1}
            onChange={(v) => v != null && onChange({ row: Math.min(MAX_ROW, v - 1) })} />
        )}
        {isClip && (
          <>
            <Num label="blend in (frames)" value={blend[0]} onChange={(v) => onChange({ blend: [v ?? 0, blend[1]] })} />
            <Num label="blend out (frames)" value={blend[1]} onChange={(v) => onChange({ blend: [blend[0], v ?? 0] })} />
            <Num label="loops (0 = ∞)" value={ev.loops} onChange={(v) => onChange({ loops: v })} />
          </>
        )}
      </div>
      {ev.label && <div className="mono-small mixer-editor-note">{ev.label}</div>}
    </div>
  );
}

/** A decimal operand (a flinch's weight, a knockback's distance): typed freely, kept as the
 *  float the command stores, so "1." or "0.0" stay on screen while they are typed. */
function Dec({ label, value, onChange }) {
  const show = (v) => (Number.isFinite(v) ? String(Number(v.toPrecision(6))) : '');
  const [text, setText] = useState(() => show(value));
  useEffect(() => {
    setText((t) => (Math.fround(parseFloat(t)) === Math.fround(value) ? t : show(value)));
  }, [value]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <label className="mixer-field">
      <span>{label}</span>
      <input type="text" inputMode="decimal" className="cseq-text mixer-num" value={text} spellCheck={false}
        onChange={(e) => {
          const t = e.target.value.replace(/[^0-9.-]/g, '');
          setText(t);
          const v = parseFloat(t);
          if (Number.isFinite(v)) onChange(v);
        }} />
    </label>
  );
}

const FLINCH_DIRECTIONS = [{ id: 0, label: 'by facing' }, { id: 1, label: 'front' }, { id: 2, label: 'back' }];
/** The routine field's badge for the shared routines retail links. */
const SHARED_BADGE = {
  mdam: 'hit', proc: 'added effect', eis1: 'flash', ei11: 'flash', hwmg: 'weapons away', hwso: 'instrument out',
  stnm: 'stop circle', wash: 'release locks', waso: 'release locks',
};
/** What the routine field offers, each with where it lives: the shared routines retail
 *  links, the caster's cast releases, the tracks' own routines, then the rest. */
function keepRefOptions(targets) {
  const out = new Map();
  const add = (value, badge) => {
    const had = out.get(value);
    if (!had) out.set(value, { value, badge });
    else if (!had.badge.includes(badge.split(' · ')[0])) had.badge += ` · ${badge}`;
  };
  const shared = targets?.shared ?? null;
  const actor = [...(targets?.actor ?? [])].sort();
  for (const ref of SHARED_ROUTINES) if (!shared || shared.has(ref)) add(ref, `shared · ${SHARED_BADGE[ref]}`);
  for (const id of actor.filter((id) => /^sh/.test(id))) add(id, 'actor · cast release');
  for (const [track, set] of targets?.tracks ?? []) for (const id of [...(set ?? [])].sort()) add(id, `track · ${trackLabel(track)}`);
  for (const id of actor.filter((id) => !/^sh/.test(id))) add(id, 'actor');
  for (const id of [...(shared ?? [])].sort()) add(id, 'shared');
  return [...out.values()];
}
/** The routine field's badge: where the game finds the routine for this op. */
function whereBadge(where) {
  if (where.where === 'track') return `track · ${trackLabel(where.track)}`;
  return { shared: 'shared', actor: 'actor', self: 'this mix', nowhere: 'nowhere', unknown: '?', none: 'no routine' }[where.where];
}
/** A waiting link's hold, as its badge says it: ticks (null while not known). */
function holdTip(ev, ticks) {
  if (ticks == null) return `How long ${ev.ref} runs is not known yet (no character on the stage, or a DAT not read): until it ends, everything after this link waits.`;
  if (!ticks) return `${ev.ref} ends at once, or the game does not find it: nothing waits.`;
  return `This routine stands still ${ticks} ticks (${(ticks / 60).toFixed(2)} s) while ${ev.ref} runs: everything after f${ev.start} plays that much later in game than its frame, and the stage plays it so. The timeline shades the hold.`;
}
function whereTip(where, ev, targets) {
  const blocking = ev.op === 0x3b || ev.op === 0x3c;
  switch (where.where) {
    case 'shared': return `In ROM/0/0.DAT, the game's shared routines${sharedNote(ev.ref) ? `: ${sharedNote(ev.ref)}` : ''}.`;
    case 'actor': return 'One of the caster\'s own routines (its race\'s files), as the character on the stage has them.';
    case 'track': return `A routine of ${trackLabel(where.track)}'s source: compose carries it into the mix, and the link goes with that track.`;
    case 'self': return 'This is the mix itself (compose writes it as main): the link starts it again every pass, and it never ends. Link another routine.';
    case 'none': return 'Name the routine to run: type it, or pick one — the shared routines retail links first, then the caster\'s cast releases, then the tracks\' own. Until it names one, it is left out of the mix.';
    case 'unknown': {
      const why = ev.op === 0x09 ? 'the target\'s own routines are not known here'
        : !targets?.shared ? 'ROM/0/0.DAT is not read yet (Play mix reads it)'
          : (ev.op === 0x57 || ev.op === 0x3c) && !targets?.actor ? 'there is no character on the stage to ask'
            : 'its track\'s source is not read yet';
      return `Not known yet: ${why}.`;
    }
    default: {
      const also = where.also === 'actor' ? ' It is one of the caster\'s own routines: "the caster\'s own, and wait (0x3C)" reaches it.'
        : where.also === 'shared' ? ' It is a shared routine: "alongside (0x03)" reaches it.'
          : where.also === 'track' ? ` It is a routine of ${trackLabel(where.track)}'s source: name it again here to link it from that track.` : '';
      return `Not found ${keepLooks(ev.op)}: the game ${blocking ? 'logs an error and goes on' : 'skips it'}.${also}`;
    }
  }
}

/**
 * The block editor for a lock, hit or link: its frames, which of its kind it is (the
 * variant swaps the op and its first byte together), a link's routine and where the
 * game finds it, a flinch's or knockback's operands, and what it does in game. Every
 * change goes through patchKeepEvent, so the command's bytes follow its fields.
 */
function KeepEditor({ ev, onPatch, onRemove, targets }) {
  const off = ev.enabled === false;
  const f = keepFields(ev.raw) ?? {};
  const fam = keepFamily(ev.op);
  const variants = keepVariants(ev.op);
  const link = isLinkOp(ev.op);
  const flinch = fam === 'flinch';
  // A link's and a flinch's duration is never read; a lock's is how long it holds.
  const timed = !link && !flinch;
  const where = link ? resolveKeepRef(ev.op, ev.ref, targets, ev.from) : null;
  // A waiting link holds the rest of the mix for as long as its routine runs.
  const hold = link && isBlockingOp(ev.op) && ev.ref && where.where !== 'nowhere' ? linkHold(ev, targets) : 0;
  const refs = useMemo(() => keepRefOptions(targets), [targets]);
  const setField = (key, v) => onPatch({ fields: { [key]: v } });
  return (
    <div className={`mixer-editor mseq-keep-editor${off ? ' off' : ''}`}>
      <div className="mixer-editor-title">
        <span className="mono">{keepLabel(ev)}</span>
        <span className="mono-small">{opName(ev.op)} · {hasTrack(ev) ? trackLabel(ev.from) : 'added here'}{keepOp(ev.op) ? '' : ' · its bytes as they are'}{off ? ' · disabled' : ''}</span>
        <span className="sp" />
        <Tooltip content="Remove from the timeline">
          <button type="button" className="pc-tbtn" aria-label="Remove" onClick={onRemove}><span className="icon">delete</span></button>
        </Tooltip>
      </div>
      <div className="mixer-fields">
        <div className="mixer-editor-acts">
          <Tooltip content={off ? 'Put it back into the mix' : 'Stays on the timeline, left out of the mix'} placement="top">
            <button type="button" className="cseq-btn mixer-toggle-btn" onClick={() => onPatch({ enabled: off })}>
              <span className={off ? 'mixer-toggle-alt' : undefined}>Disable</span>
              <span className={off ? undefined : 'mixer-toggle-alt'}>Re-Enable</span>
            </button>
          </Tooltip>
        </div>
        <Num label="start frame" value={ev.start} onChange={(v) => onPatch({ start: v ?? 0 })} />
        {timed && <Num label="duration" value={ev.dur} onChange={(v) => onPatch({ dur: v })} />}
        {variants && (
          <label className="mixer-field mseq-keep-variant">
            <span>{KEEP_FAMILY_LABEL[fam]}</span>
            <div className="cseq-load">
              <Combo value={ev.op} items={variants} onChange={(op) => op != null && Number(op) !== ev.op && onPatch({ op: Number(op) })} />
            </div>
          </label>
        )}
        {link && (
          <label className="mixer-field mseq-keep-ref">
            <span>routine</span>
            <span className="mseq-keep-ref-row">
              <CategoryInput className="cseq-text mixer-num" value={ev.ref ?? ''} options={refs} maxLength={4} placeholder="name"
                onChange={(v) => onPatch({ ref: String(v ?? '').replace(/[^\x21-\x7e]/g, '').slice(0, 4) })} />
              <Tooltip content={whereTip(where, ev, targets)} placement="top">
                <span className={`mseq-keep-where ${where.where}`}>{whereBadge(where)}</span>
              </Tooltip>
              {hold !== 0 && (
                <Tooltip content={holdTip(ev, hold)} placement="top">
                  <span className={`mseq-keep-where hold${hold == null ? ' unknown' : ''}`}>holds {hold ?? '?'}</span>
                </Tooltip>
              )}
            </span>
          </label>
        )}
        {flinch && (
          <>
            <Dec label="weight" value={f.weight} onChange={(v) => setField('weight', v)} />
            <Dec label="speed" value={f.speed} onChange={(v) => setField('speed', v)} />
            <Num label="loops" value={f.loops} onChange={(v) => setField('loops', v ?? 0)} />
            <Dec label="blend in" value={f.blendIn} onChange={(v) => setField('blendIn', v)} />
            <Dec label="blend out" value={f.blendOut} onChange={(v) => setField('blendOut', v)} />
            <label className="mixer-field mseq-keep-variant">
              <span>direction</span>
              <div className="cseq-load">
                <Combo value={f.direction ?? 0} items={FLINCH_DIRECTIONS} onChange={(d) => d != null && setField('direction', Number(d))} />
              </div>
            </label>
          </>
        )}
        {ev.op === 0x5e && (
          <>
            <Num label="mode (0 = server's)" value={f.mode} onChange={(v) => setField('mode', v ?? 0)} />
            <Dec label="distance" value={f.distance} onChange={(v) => setField('distance', v)} />
          </>
        )}
      </div>
      <div className="mono-small mixer-editor-note">{keepDoes(ev)}</div>
    </div>
  );
}

export function MixerPanel({
  recipe, onRecipe, onAssignRows, extraRows = null, onHoldRows, lane, laneInfo, laneEntry,
  transport, onPlay, onStop, onPublish, publishPlan = null, publishCfg = null, onPublishCfg, onCheckPublish,
  slots = null, onListSlots,
  onSaveAs, onOpen, onReset, recipes, busy, note, error = null, onDismissError,
  onDelete, onRename, onDuplicate, onImport, onExport, onSetCategory, onShuffle, stageName,
  onPause, onResume, onSeek, getPlayhead, mixLoaded, mixDirty,
  onSolo, onLaneSource, onSharedSource = null, onPlaySound, onTake, viewerRace, onClose, getSoundPeaks, speed = 1, onSpeed, loop = true, onLoop, ghosts = null,
  panels = { mixer: true, parts: true, timeline: true }, onPanel,
  tracks = [], onActivateTrack, onAddTrack, onRemoveTrack,
  playingSoundKey = null,
  kind = 'ws', onKind, onDropEntry, baseMotionSpecs = null, animBands = null,
  // Locks · hits · links: what a link can name (App's mixerLinkTargets, read at render
  // time: the same object while nothing it reads changes) and a track source's own copied in.
  linkTargets = null, onCopyKeep = null,
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

  // Two windows here, each a glyph on the right rail (App.jsx): the timeline
  // (MixerTimeline.jsx, the Camera Sequencer's chrome) with the mix's name,
  // category, Save and Load in its toolbar, and the Mixes panel (MixerLibrary.jsx)
  // that Load opens — the saved mixes by category. `panels` says which are open;
  // closing one tells the rail through onPanel.

  const [head, setHead] = useState(0);
  useEffect(() => {
    if (!getPlayhead) return undefined;
    const id = setInterval(() => setHead(getPlayhead().frame), 50);
    return () => clearInterval(id);
  }, [getPlayhead]);
  const events = recipe.events;
  const selected = events.find((e) => e._id === selectedId) ?? null;
  const strike = useMemo(() => strikeFrame(events), [events]);
  const targets = linkTargets?.() ?? null;
  const keepWarns = useMemo(() => keepWarnings(events, { targets }), [events, targets]);
  // Where the mix's waiting links hold it, for the timeline's shading.
  const holds = useMemo(() => holdMarks(events, targets), [events, targets]);
  // The Generator window shows one generator of one track: the block Edit generator
  // was pressed on, then whichever generator block is selected while it is open.
  const [genTarget, setGenTarget] = useState(null);   // { lane, ref }
  const selectedGen = selected && isGeneratorOp(selected.op) && selected.ref ? selected : null;
  useEffect(() => {
    if (!panels.generator || !selectedGen) return;
    setGenTarget((t) => (t?.lane === selectedGen.from && t?.ref === selectedGen.ref ? t : { lane: selectedGen.from, ref: selectedGen.ref }));
  }, [panels.generator, selectedGen?.from, selectedGen?.ref]);   // eslint-disable-line react-hooks/exhaustive-deps
  const editGenerator = (ev) => { setGenTarget({ lane: ev.from, ref: ev.ref }); onPanel?.('generator', true); };
  // The block the window's Preview plays: the selected one when it is that generator, else the first that fires it.
  const genEvent = genTarget
    ? (selectedGen?.from === genTarget.lane && selectedGen?.ref === genTarget.ref ? selectedGen
      : events.find((e) => e.from === genTarget.lane && e.ref === genTarget.ref && isGeneratorOp(e.op)) ?? null)
    : null;
  const editedGens = useMemo(() => editedGenerators(recipe), [recipe.generators]);   // eslint-disable-line react-hooks/exhaustive-deps
  // The generators that draw a replaced texture: which ones is in each track's source DAT.
  const [texturedGens, setTexturedGens] = useState(null);
  useEffect(() => {
    const lanes = [...new Set((recipe.textures ?? []).map((t) => t.lane))];
    if (!lanes.length || !onLaneSource) { setTexturedGens(null); return undefined; }
    let live = true;
    Promise.all(lanes.map((l) => onLaneSource(l).then((d) => [l, d], () => [l, null]))).then((pairs) => {
      if (live) setTexturedGens(texturedGenerators(recipe, new Map(pairs.filter(([, d]) => d))));
    });
    return () => { live = false; };
  }, [recipe.textures, recipe.generators, recipe.sources, onLaneSource]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Forget ids of events that are gone (removed, or a lane re-taken).
  useEffect(() => {
    const live = (id) => events.some((e) => e._id === id);
    if ([...selectedIds].every(live)) return;
    setSelectedIds((prev) => new Set([...prev].filter(live)));
  }, [events, selectedIds]);

  const update = (id, patch) => onRecipe({ ...recipe, events: events.map((e) => (e._id === id ? { ...e, ...patch } : e)) });
  /** One event swapped for its edited self (a keep edit can drop keys: a link's track, an emptied ref). */
  const replace = (id, next) => onRecipe({ ...recipe, events: events.map((e) => (e._id === id ? next : e)) });
  /**
   * The keep lane's + : a preset's commands at `frame`, selected — a cast release still
   * waiting for its routine alone, so the editor shows its routine field. A target lock
   * reaches the mix's first hit; a retail set lays its hit at the strike line, never
   * before the last flinch or swing starts (a spell's near the end), and brings only
   * what the mix lacks.
   */
  const addKeep = (presetId, frame) => {
    const len = recipeLength(events);
    const lastBlow = Math.max(0, ...events.filter((e) => e.enabled !== false && (e.op === 0x25 || e.op === 0x21 || e.op === 0x2c)).map((e) => e.start));
    const fresh = makeKeepEvents(presetId, frame, {
      hit: keepHits(events)[0]?.start ?? null,
      strike: Math.max(strike > 0 ? strike : Math.max(30, Math.round(len * 0.6)), lastBlow),
      end: len, school: keepSchool(events), events,
    });
    if (!fresh.length) return;
    // A waiting link goes first on its frame, as retail has it (and releasePick lays it):
    // compose writes a tie in the recipe's order, and the link holds what follows it.
    // Everything else goes after, so a lock added onto a link's frame stays held.
    const waits = fresh.filter((e) => isBlockingOp(e.op));
    onRecipe({ ...recipe, events: [...waits, ...events, ...fresh.filter((e) => !isBlockingOp(e.op))] });
    const unnamed = fresh.find((e) => isLinkOp(e.op) && !e.ref);
    setSelectedIds(new Set(unnamed ? [unnamed._id] : fresh.map((e) => e._id)));
  };
  /** Copy locks & hits from a track's source (App): the copies come back selected. */
  const copyKeep = async (track) => {
    const ids = await onCopyKeep?.(track);
    if (ids?.length) setSelectedIds(new Set(ids));
  };
  /** Blocks moved on the timeline: a new start each, and the row of its track when
   *  it was dragged up or down. A block never changes track: its generators, clips
   *  and sounds are read from that track's source DAT. */
  const moveMany = (list) => {
    const by = new Map(list.map((m) => [m.id, m]));
    onRecipe({ ...recipe, events: events.map((e) => {
      const m = by.get(e._id);
      if (!m) return e;
      return { ...e, ...(m.start != null ? { start: m.start } : null), ...(m.row != null ? { row: m.row } : null) };
    }) });
  };
  /** A row of a track deleted (never its first): its pills join the row above and the
   *  rows below move up. A row the label's + holds open goes the same way. `drawn`
   *  is where the timeline shows the pills it has not filed into a row yet
   *  ([{ id, row }]): they count as being there. */
  const removeRow = (track, row, drawn = []) => {
    const at = new Map(drawn.map((m) => [m.id, m.row]));
    const filed = at.size ? events.map((e) => (at.has(e._id) && rowOfEvent(e) == null ? { ...e, row: at.get(e._id) } : e)) : events;
    const next = deleteRow(filed, track, row);
    if (next !== events) onRecipe({ ...recipe, events: next });
    if ((extraRows?.[track] ?? 0) > row) onHoldRows?.(track, extraRows[track] - 1);
  };
  const removeMany = (ids) => onRecipe({ ...recipe, events: events.filter((e) => !ids.has(e._id)) });
  /** M: mute (disable) or unmute the selection. A muted event stays on the timeline but is left out of the mix. */
  const toggleMute = (ids) => {
    const anyOn = events.some((e) => ids.has(e._id) && e.enabled !== false);
    onRecipe({ ...recipe, events: events.map((e) => (ids.has(e._id) ? { ...e, enabled: !anyOn } : e)) });
  };
  const remove = (id) => removeMany(new Set([id]));
  /** Ctrl+C: the selection, spacing kept, ready for Ctrl+V. */
  const copyMany = (ids) => {
    const src = events.filter((e) => ids.has(e._id));
    if (!src.length) return;
    const first = Math.min(...src.map((e) => e.start));
    const last = Math.max(...src.map((e) => e.start + (e.dur || 0)));
    clipboard = {
      items: src.map((e) => ({ ...asCopy(e), offset: e.start - first })),
      span: Math.max(last - first, 15),
      origin: first,
    };
  };
  /** Ctrl+V: the copies at `frame`, on their own tracks (a track gone since the
   *  copy falls back to its kind's first), selected so they can be dragged. */
  const pasteAt = (frame) => {
    if (!clipboard?.items.length) return;
    const known = new Set(tracks.map((t) => t.id));
    const at = Math.max(0, Math.round(frame));
    // A lock, hit or link added by hand has no track and gets none.
    const copies = withIds(clipboard.items.map(({ offset, from, ...rest }) => ({
      ...rest,
      start: at + offset,
      ...(hasTrack({ from }) ? { from: known.has(from) ? from : kindOf(from) } : null),
    })));
    onRecipe({ ...recipe, events: [...events, ...copies] });
    setSelectedIds(new Set(copies.map((c) => c._id)));
  };
  /** Ctrl+D: copies of the selection right after it, spacing kept, selected so they can be dragged. */
  const duplicateMany = (ids) => {
    const src = events.filter((e) => ids.has(e._id));
    if (!src.length) return;
    const first = Math.min(...src.map((e) => e.start));
    const last = Math.max(...src.map((e) => e.start + (e.dur || 0)));
    const gap = Math.max(last - first, 15);
    const copies = withIds(src.map((e) => ({ ...asCopy(e), start: e.start + gap })));
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
      // Ctrl+V: at the red cursor; with nothing scrubbed (frame 0) right after
      // the copied group instead, where Ctrl+D would put it.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && !e.shiftKey && !e.altKey && !typing(e.target)) {
        if (!clipboard) return;
        e.preventDefault();
        pasteAt(mixLoaded && head > 0 ? head : clipboard.origin + clipboard.span);
        return;
      }
      if (typing(e.target) || !selectedIds.size) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        copyMany(selectedIds);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
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
  const categories = useMemo(() => categoriesOf(recipes ?? []), [recipes]);
  // A seek moves the stage now, or once the mix is armed: read the playhead back
  // straight after rather than on the next poll, so the cursor does not flick back.
  const seek = (frame) => {
    const read = () => { if (getPlayhead) setHead(getPlayhead().frame); };
    const done = onSeek?.(frame);
    read();
    Promise.resolve(done).then(read);
  };
  // The stage is the timeline's only while the composed mix is on it: a list
  // preview is not the mix, so its playhead, length and seeks stay out.
  const stageLen = mixLoaded && getPlayhead ? getPlayhead().length : 0;
  const timeline = (
    <TimelineWindow open={!!panels.timeline} onClose={() => onPanel?.('timeline', false)}
      recipeName={recipe.name} note={statusNote} failed={failed} error={error} onDismissError={onDismissError}
      events={events} selectedIds={selectedIds} onSelect={select} onMoveMany={moveMany} onShiftLane={shift}
      onAssignRows={onAssignRows} extraRows={extraRows} onAddRow={onHoldRows} onDeleteRow={removeRow}
      tracks={tracks} activeTrack={lane} sources={recipe.sources} onActivateTrack={onActivateTrack} onAddTrack={onAddTrack} onRemoveTrack={onRemoveTrack}
      onPreview={(ev) => onPlaySound?.({ id: ev.sound, ref: ev.ref })}
      strike={strike} playhead={mixLoaded ? head : null} mixLoaded={mixLoaded}
      minLen={stageLen}
      loopEnd={Number.isFinite(recipe.total) && recipe.total > 0 ? recipe.total : stageLen}
      loopSet={Number.isFinite(recipe.total) && recipe.total > 0}
      onLoopEnd={(f) => { const { total, ...rest } = recipe; onRecipe?.(f ? { ...recipe, total: f } : rest); }}
      getSoundPeaks={getSoundPeaks} ghosts={ghosts} editedGens={editedGens} texturedGens={texturedGens}
      transport={armed ? transport : 'stopped'} canPlay={!busy && (armed || events.length > 0)} playTip={playTip}
      onPlayPause={onPlayPause} onStop={onStop} onSeek={seek}
      speed={speed} onSpeed={onSpeed} loop={loop} onLoop={onLoop}
      onSnapLane={snapLane} viewerRace={viewerRace}
      name={recipe.name} onName={(n) => onRecipe({ ...recipe, name: n })} onNew={onReset}
      category={recipe.category ?? ''} onCategory={(c) => onRecipe({ ...recipe, category: c })} categories={categories}
      onSave={() => recipe.name.trim() && onSaveAs?.(recipe.name.trim())} saved={recipes ?? []} onDelete={onDelete}
      onLoad={() => onPanel?.('library')} loadOpen={!!panels.library}
      publishPlan={publishPlan} onPublish={onPublish} busy={busy}
      publishCfg={publishCfg} onPublishCfg={onPublishCfg} onCheckPublish={onCheckPublish}
      slots={slots} onListSlots={onListSlots}
      kind={kind} onKind={onKind} baseMotionSpecs={baseMotionSpecs} animBands={animBands} onRandomise={onShuffle ? () => onShuffle(kind) : null}
      canPublish={!busy && events.length > 0}
      onDropEntry={onDropEntry}
      keepWarns={keepWarns} onAddKeep={addKeep} onCopyKeep={onCopyKeep ? copyKeep : null} holds={holds}
      editor={!selected ? null : selected.kind === 'keep'
        ? <KeepEditor key={selected._id} ev={selected} targets={targets} onRemove={() => remove(selected._id)}
          onPatch={(p) => replace(selected._id, patchKeepEvent(selected, p, targets))} />
        : <EventEditor ev={selected} onChange={(p) => update(selected._id, p)} onRemove={() => remove(selected._id)}
          onSolo={onSolo ? () => onSolo(selected.ref, selected.from, selected.dur) : null}
          onEditGenerator={onLaneSource && selected.ref ? () => editGenerator(selected) : null}
          generatorOpen={!!panels.generator && genTarget?.lane === selected.from && genTarget?.ref === selected.ref} />} />
  );

  return (
    <>
      {timeline}
      <Floating id="mixer-library" open={!!panels.library} width={360} defaultPos={{ right: 68, top: 60 }}>
        <MixerLibrary recipes={recipes ?? []} current={recipe.name} stageName={stageName}
          onOpen={onOpen} onRename={onRename} onSetCategory={onSetCategory} onDuplicate={onDuplicate} onDelete={onDelete}
          onImport={onImport} onExport={onExport}
          onClose={() => onPanel?.('library', false)} />
      </Floating>
      <Floating id="mixer-generator" open={!!panels.generator} width={440} defaultPos={{ right: 68, top: 60 }}>
        <MixerGeneratorPanel recipe={recipe} onRecipe={onRecipe} target={genTarget} onLaneSource={onLaneSource} onSharedSource={onSharedSource}
          onPreview={onSolo && genTarget ? () => onSolo(genTarget.ref, genTarget.lane, genEvent?.dur ?? 0) : null}
          onClose={() => onPanel?.('generator', false)} />
      </Floating>
    </>
  );
}
