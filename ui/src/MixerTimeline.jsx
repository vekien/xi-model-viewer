import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Tooltip } from './Tooltip.jsx';
import { Combo } from './Combo.jsx';
import { CategoryInput } from './CategoryInput.jsx';
import { MixerHelpModal } from './MixerHelpModal.jsx';
import { KEEP_LANE, KEEP_PRESETS, LANES, LANE_BY_ID, MAX_ROW, STOCK_ANIM_RANGE, animBandRange, assignRows, clipBlend, dbConfirmOf, hasTrack, isChantPill, isGeneratorOp, isLinkOp, keepDoes, keepLabel, kindOf, opName, pillEnd, publishFolderRel, recipeLength, retailKeepSet, rowOfEvent, settleRows, showStepText, stageOf, stepTone, trackLabel } from '../js/mixer.js';
import { LOCAL_SERVER_TOO_OLD, describeServer } from '../js/localServer.js';

/** Drag type prefix shared with MixerList; the lane kind follows it. */
export const DRAG_TYPE = 'application/x-mixer-entry+';

const MIX_TYPES = [{ id: 'ws', label: 'WS' }, { id: 'ja', label: 'Ability' }, { id: 'spell', label: 'Spell' }];
const KIND_LABEL = { ws: 'Weapon Skill', ja: 'Job Ability', spell: 'Spell' };
// The letter a track label leads with — (M) Emote · bow, (E) Charm, (S) Enthunder.
const KIND_TAG = { motion: 'M', vfx: 'E', sound: 'S' };
/** A track's shown name: its kind tag and source (or the plain lane name when empty). */
const trackDisplay = (t, sources) => {
  if (t.kind === 'keep') return t.label;
  const src = sources?.[t.id]?.name;
  const tag = KIND_TAG[t.kind];
  return src && tag ? `(${tag}) ${src}` : t.label;
};
// The donor an insert clones when the server has no row with the mix's name (xi_db_apply
// DEFAULT_DONOR). Shown so the user knows what a new spell/ability/WS starts life as.
const DEFAULT_DONOR_LABEL = { spell: 'Cure', ja: 'Berserk', ws: 'Fast Blade' };
/** A job ability or spell references base motion (`ja:`/`spell:`); anything else — a
 *  weapon skill, an emote, a race's own motion — is baked per race and is WS only. */
const motionOkForKind = (spec, kind) => kind === 'ws' || /^(ja|spell):\d+/.test(String(spec ?? ''));

// The mixer's timeline as a floating window built from the Camera Sequencer's
// chrome (#camseq / .cseq-*): the same title bar, dragged by it; the same inset
// track with a seconds ruler, one lane per line, the red playhead you drag; the
// same round Play / Stop and frame readout in the bar. Blocks are pills on the
// lane's line. A track's pills sit in rows, and a pill stays in the row it is in
// (its event's `row`, mixer.js › Rows): dragging one along never moves another.
// A pill with no room — one that arrives, or one dropped onto another — takes the
// next row down, and the track grows a row for it. Dragged up or down, a pill
// changes row within its own track; the label's + adds a row, a row's − deletes
// it. Only the keep lane (locks, hits, links) still packs itself on every change.
// Everything here edits `events` through the callbacks; Play composes exactly that.

const POS_KEY = 'mixerSeqPos';
const SIZE_KEY = 'mixerSeqSize';
const FPS = 60;                       // routine ticks run at 60/s; the ruler reads seconds
const LANE_H = 25;                    // one lane line (see .cseq-lane)
const MIN_LANE_H = 10;                // a lane minimised to a thin line (see .mseq-lane.min)
const LOOP_LINK_PX = 6;               // the line joining a looping clip's pill to each repeat (see .mseq-loop-link)
const MIN_PILL_PX = 48;               // a pill is never narrower (see .mseq-pill)
const RULER_H = 22;
const MIN_W = 700;
const DEFAULT_W = 940;
const MIN_H = 200;
const maxH = () => Math.floor(window.innerHeight * 0.9);   // the window fits its content up to this (see #mixer-seq)
const MIN_LEN = 120;
const EMPTY_SET = new Set();
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const readJson = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

/** Ruler ticks in seconds, the sequencer's own spacing rule. */
function rulerTicks(totalFrames, fps, zoom = 1) {
  const dur = totalFrames / fps;
  const niches = Math.max(8, Math.round(8 * zoom));
  const step = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120].find((s) => s >= dur / niches) ?? 300;
  const out = [];
  for (let t = 0; t <= dur + 1e-3; t += step) out.push({ t, x: ((t * fps) / totalFrames) * 100 });
  return out;
}

/** The sound id an event plays, recorded from the inspector (the pointer's name is
 *  not the id: Raging Rush's `8049` plays se018049, so no guessing from digits). */
const soundIdOf = (ev) => ev.sound ?? null;
const isSoundEvent = (ev) => ev.kind === 'sound' || ev.from === 'sound';

/** Peak envelope as one path of vertical bars, one per bin, drawn in a bins×20 box. */
function wavePath(peaks) {
  let d = '';
  for (let i = 0; i < peaks.length; i++) {
    const h = Math.max(0.6, peaks[i] * 9.5);
    d += `M${i + 0.5},${10 - h}V${10 + h}`;
  }
  return d;
}

/** What the keep lane's + offers: its presets by group (Locks, Hits, Links, Retail set). */
const KEEP_PRESET_ITEMS = KEEP_PRESETS.map(({ id, group, label }) => ({ id, group, label }));
const RETAIL_TIP = {
  ws: 'Add the retail set of a weapon skill or job ability, as Fast Blade has it: the target held from frame 0 to the hit, magic and control held 90 ticks (to the hit when that is later), the hit at the strike line and the added effect 20 ticks after it. Only what the mix lacks is added.',
  spell: 'Add a spell’s retail set: the cast release at frame 0 (3C sh·· — the school from this mix’s cast motion, else name it in the block’s routine field), the target held to the hit, and the hit near the end. Everything after the release plays about a second later, in game and on the stage: it waits for it (the shaded band). Only what the mix lacks is added.',
};

/** What a hold's band says: how long its link holds the routine and what that does. */
function holdTip(h) {
  const what = `${h.op === 0x3c && /^sh/.test(h.ref ?? '') ? 'The cast release' : 'The waiting link'} to ${h.ref} at f${h.at}`;
  if (h.ticks == null) {
    const why = h.op === 0x3c
      ? 'it runs on the caster, so it needs a character on the stage to ask, and ROM/0/0.DAT read (Play mix reads it)'
      : 'ROM/0/0.DAT or its track’s source is not read yet (Play mix reads them)';
    return `How long ${what.charAt(0).toLowerCase()}${what.slice(1)} holds is not known yet: ${why}. Until ${h.ref} ends, everything after it waits.`;
  }
  const release = h.op === 0x3c && /^sh/.test(h.ref ?? '') ? ` ${h.ref} is the caster’s own release: the casting circle stops, the release burst and motion play, then 60 ticks of locks (wash).` : '';
  const more = h.late > h.ticks ? ` (${h.late} with the holds before it)` : '';
  return `${what} holds this routine ${h.ticks} ticks (${(h.ticks / FPS).toFixed(2)} s), until ${h.ref} has run.${release} Everything after it, on every track, plays ${h.ticks} ticks later in game than its frame here${more}; the stage plays it so, and the red cursor waits on f${h.at} meanwhile.`;
}

export function TimelineWindow({
  open, onClose,
  recipeName, note, failed, error, onDismissError,
  events, selectedIds, onSelect, onMoveMany, onShiftLane, onPreview,
  onAssignRows, extraRows = null, onAddRow, onDeleteRow,
  tracks = [], activeTrack = 'motion', sources = {}, onActivateTrack, onAddTrack, onRemoveTrack,
  strike, playhead, mixLoaded, loopEnd = 0, minLen = 0, loopSet = false, onLoopEnd,
  getSoundPeaks = null, ghosts = null, editedGens = null, texturedGens = null,
  transport, canPlay, playTip, onPlayPause, onStop, onSeek,
  speed, onSpeed, loop, onLoop, onSnapLane, viewerRace,
  // The saved-mix row (the Camera Sequencer's New / name / Save / Load / Delete,
  // plus the category the Mixes panel files it under; Load opens that panel),
  // the publish plan, and the shuffle kind.
  name = '', onName, onNew, onSave, saved = [], onDelete,
  category = '', onCategory, categories = [], onLoad, loadOpen = false,
  publishPlan = null, onPublish, busy = false,
  publishCfg = null, onPublishCfg, onCheckPublish, onOpenSlots, slotsOpen = false, onOpenPublishFolder,
  // Manage's server switches: the local server as `xi server check --no-db --no-binary` saw it
  // (null | { loading } | { error } | xi.server-check.v1), Settings › Local Server, a Confirm
  // of a row this mix did not make (id, and whether it came from a Publish), and a counter
  // that opens Manage when it moves (a Publish that needs that Confirm).
  serverInfo = null, onOpenLocalServer = null, onConfirmDbRow = null, manageOpenTick = 0,
  kind = 'ws', onKind, onRandomise, canPublish = false, baseMotionSpecs = null, animBands = null,
  onDropEntry,
  // Locks · hits · links: add a preset at a frame, copy a track source's own, and
  // what is off about them (mixer.js keepWarnings); where its waiting links hold the
  // mix (mixer.js holdMarks).
  keepWarns = [], onAddKeep = null, onCopyKeep = null, holds = [],
  editor = null,
  // Global window stacking: zIndex the app hands it, and a click anywhere raises it.
  zIndex = 28, onFocus = null,
}) {
  // ── Window: position, size, drag, resize (the sequencer's pattern) ──────────
  const [pos, setPos] = useState(() => readJson(POS_KEY));
  const [size, setSize] = useState(() => {
    const s = readJson(SIZE_KEY);
    return { w: clamp(Math.round(s?.w ?? DEFAULT_W), MIN_W, 2400), h: s?.h ? Math.max(MIN_H, Math.round(s.h)) : null };
  });
  const panelRef = useRef(null);
  const panelDrag = useRef(null);
  const resizeRef = useRef(null);
  useEffect(() => { if (pos) writeJson(POS_KEY, pos); }, [pos]);
  useEffect(() => { writeJson(SIZE_KEY, size); }, [size]);

  // The drag listens on the window for its lifetime rather than trusting pointer
  // capture on the header: the canvas and the modals capture and swallow pointer
  // events of their own, and a stolen capture left a drag dead after one step.
  const startDrag = (e) => {
    if (e.button !== 0 || docked) return;   // docked is pinned; nothing to drag
    if (e.target.closest('button, input, select, a, [role="button"], .cseq-resize, .mseq-resize-v')) return;
    const el = panelRef.current;
    const rect = el.getBoundingClientRect();
    if (!pos) setPos({ x: rect.left, y: rect.top });
    const d = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    panelDrag.current = d;
    e.preventDefault();
    const move = (ev) => {
      if (panelDrag.current !== d) return;
      if (ev.buttons === 0) { end(); return; }
      const w = el.offsetWidth || size.w;
      const h = el.offsetHeight || MIN_H;
      setPos({
        x: clamp(ev.clientX - d.dx, 0, Math.max(window.innerWidth - w, 0)),
        y: clamp(ev.clientY - d.dy, 0, Math.max(window.innerHeight - h, 0)),
      });
    };
    const end = () => {
      if (panelDrag.current === d) panelDrag.current = null;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      window.removeEventListener('blur', end);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
    window.addEventListener('blur', end);
  };

  // Height fits the content (up to MAX_H, see #mixer-seq). The bottom edge can
  // only pull the window shorter than that — the body then scrolls — never open
  // a gap below the bar; dragging back down past the content lets it go auto.
  const headerRef = useRef(null);
  const bodyRef = useRef(null);
  // The track area shrinks to fit the window and scrolls on its own, so its
  // hidden part is added back: what the window would need to show it all.
  const naturalH = () => (headerRef.current?.offsetHeight ?? 0) + (bodyRef.current?.scrollHeight ?? 0)
    + Math.max(0, (rootRef.current?.scrollHeight ?? 0) - (rootRef.current?.clientHeight ?? 0));
  const startResize = (axis) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = panelRef.current.getBoundingClientRect();
    if (!pos) setPos({ x: rect.left, y: rect.top });
    resizeRef.current = { axis, x0: e.clientX, y0: e.clientY, w0: rect.width, h0: rect.height };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e) => {
    const r = resizeRef.current;
    if (!r) return;
    // 'w' the right edge, 'h' the bottom edge, 'wh' the bottom-right corner (both).
    const next = {};
    if (r.axis === 'w' || r.axis === 'wh') {
      next.w = clamp(Math.round(r.w0 + (e.clientX - r.x0)), MIN_W, Math.max(MIN_W, window.innerWidth - 16));
    }
    if (r.axis === 'h' || r.axis === 'wh') {
      const cap = Math.min(naturalH(), maxH());
      const h = Math.round(r.h0 + (e.clientY - r.y0));
      next.h = h >= cap ? null : Math.max(MIN_H, h);
    }
    if (r.axis === 'ht') {   // docked: the top edge — dragging up grows it
      next.h = clamp(Math.round(r.h0 - (e.clientY - r.y0)), MIN_H, maxH());
    }
    setSize((s) => ({ ...s, ...next }));
  };
  const endResize = () => { resizeRef.current = null; };
  // Content that shrank below a remembered height would leave a gap: let go of it.
  // Not while docked — there the height is deliberate (the top-edge grip), and
  // nulling it snapped the window back to its default.
  useEffect(() => {
    if (!size.h || !open || docked) return;
    if (size.h >= naturalH()) setSize((s) => ({ ...s, h: null }));
  });
  // The main window shrinking takes the timeline down with it (90% of its height at most).
  useEffect(() => {
    const onResize = () => setSize((s) => (s.h && s.h > maxH() ? { ...s, h: maxH() } : s));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Keep the window reachable after a resolution change.
  useEffect(() => {
    if (!pos) return;
    const el = panelRef.current;
    const w = el?.offsetWidth ?? size.w;
    const h = el?.offsetHeight ?? MIN_H;
    const x = clamp(pos.x, 0, Math.max(window.innerWidth - w, 0));
    const y = clamp(pos.y, 0, Math.max(window.innerHeight - h, 0));
    if (x !== pos.x || y !== pos.y) setPos({ x, y });
  }, [pos, size.w]);

  // ── Track content ───────────────────────────────────────────────────────────
  const [zoom, setZoom] = useState(1);
  const ghostEvents = useMemo(() => (ghosts?.sounds ?? []).map((g, i) => ({
    _id: `ghost:${i}`, from: 'sound', kind: 'sound', op: 0x0a, ref: g.ref, start: g.start, sound: g.sound, ghost: true, via: g.via,
  })), [ghosts]);
  const ghostGenEvents = useMemo(() => (ghosts?.gens ?? []).map((g, i) => ({
    _id: `ghostg:${i}`, from: 'vfx', kind: 'vfx', op: 0x02, ref: g.via, start: g.start, dur: Math.max(g.end - g.start, 4), ghost: true, via: g.via, count: g.count,
  })), [ghosts]);

  // Sound lengths: sound id -> { seconds, peaks } | null.
  const [peaks, setPeaks] = useState(() => new Map());
  const pending = useRef(new Set());
  useEffect(() => {
    if (!getSoundPeaks) return;
    for (const ev of [...events, ...ghostEvents]) {
      if (!isSoundEvent(ev)) continue;
      const id = soundIdOf(ev);
      if (id == null || peaks.has(id) || pending.current.has(id)) continue;
      pending.current.add(id);
      Promise.resolve(getSoundPeaks(id)).catch(() => null).then((res) => {
        pending.current.delete(id);
        setPeaks((m) => new Map(m).set(id, res ?? null));
      });
    }
  }, [events, ghostEvents, peaks, getSoundPeaks]);
  const soundTicks = (ev) => Math.round((peaks.get(soundIdOf(ev))?.seconds ?? 0) * FPS);
  const soundEnd = Math.max(0, ...[...events.filter(isSoundEvent), ...ghostEvents].map((e) => e.start + soundTicks(e)));

  // Whole ticks: the armed routine's end can be fractional (a loop point from a clip length at 30fps).
  // A little past the armed routine's end too, so a loop marker sitting there stays on the ruler.
  // And past every hold's band.
  const holdEnd = Math.max(0, ...holds.map((h) => h.at + (h.ticks ?? 0)));
  const len = Math.ceil(Math.max(MIN_LEN, recipeLength(events) + 20, soundEnd + 20, minLen + 20, holdEnd + 20));
  const ticks = rulerTicks(len, FPS, zoom);
  // The track's width in px (measured below): a short block's pill still takes
  // MIN_PILL_PX (and never under 1.2% of the track), so that much of its row counts
  // as used.
  const [trackPx, setTrackPx] = useState(0);
  const minTicks = Math.max(len * 0.012, trackPx ? (MIN_PILL_PX / trackPx) * len : 0);

  // The rows every lane had when a pill drag began, lane id → count, held until the
  // drop: a lane growing or shrinking mid-drag would move the lanes under the pointer.
  const [rowHold, setRowHold] = useState(null);

  // Each lane's stacking is remembered (collapse from the glyph by the label).
  const [laneRowsOpen, setLaneRowsOpen] = useState(() => readJson('mixerLaneRows') ?? {});
  const toggleLaneRows = (laneId, open) => setLaneRowsOpen((m) => {
    const next = { ...m, [laneId]: open };
    writeJson('mixerLaneRows', next);
    return next;
  });
  // A lane collapsed all the way to a thin line — only a coloured mark where each
  // block plays, super compact. Remembered per lane, like the row stacking above.
  const [laneMin, setLaneMin] = useState(() => readJson('mixerLaneMin') ?? {});
  const toggleLaneMin = (laneId, min) => setLaneMin((m) => {
    const next = { ...m, [laneId]: min };
    writeJson('mixerLaneMin', next);
    return next;
  });

  // A keep pill is at least as wide as its label ("Lock target 0-80", "Hit · mdam"):
  // most are instants, and its label is all it shows. 10px mono is about 6px a character.
  const keepPx = (ev) => Math.round(keepLabel(ev).length * 6 + 18);
  const keepTicks = (ev) => (trackPx ? (keepPx(ev) / trackPx) * len : 0);

  // One lane per track, in kind order, then the keep lane. Ghosts from the linked
  // shared routines draw on the first track of their kind.
  const laneDefs = [
    ...tracks.map((t) => ({
      ...LANE_BY_ID.get(t.kind), id: t.id, kind: t.kind, label: trackLabel(t.id),
      first: tracks.find((x) => x.kind === t.kind)?.id === t.id,
      last: [...tracks].reverse().find((x) => x.kind === t.kind)?.id === t.id,
    })),
    { ...KEEP_LANE, kind: 'keep', first: true, last: true },
  ];
  const lanes = laneDefs.map((t) => {
    const keep = t.kind === 'keep';
    const own = events.filter((e) => (keep ? e.kind === 'keep' : e.from === t.id && e.kind !== 'keep'));
    const laneEvents = t.kind === 'sound' && t.first ? [...own, ...ghostEvents]
      : t.kind === 'vfx' && t.first ? [...own, ...ghostGenEvents] : own;
    // What a pill holds of its row: the length it draws at, and a looping clip's repeats.
    const endOf = (e) => pillEnd(e, Math.max(minTicks, keep ? keepTicks(e) : 0, t.kind === 'sound'
      ? (e.op === 0x1e ? 8 : Math.max(soundTicks(e), 8))
      : (e.dur || 0)));
    // A track's pills keep the row they hold. One with no row yet (an older mix, a
    // fresh pick, a paste) is fitted around them, and so are the shared routines'
    // ghosts, which never get a row of their own. The keep lane packs the same way,
    // and holds a row a drag gives one of its locks, hits or links.
    const rows = assignRows(laneEvents, endOf);
    // Rows the label's + holds open count as well.
    const count = rowHold?.get(t.id) ?? Math.max(rows.count, keep ? 0 : Math.min(MAX_ROW + 1, extraRows?.[t.id] ?? 0));
    // The rows the mix itself spans: its own pills (as drawn) and the + hold. A row
    // below them that only a shared routine's ghosts took is not the mix's to delete.
    const ownRows = keep ? 1 : Math.max(1, Math.min(MAX_ROW + 1, extraRows?.[t.id] ?? 0),
      ...own.map((e) => (rows.rowOf.get(e._id) ?? 0) + 1));
    // Rows show by default; the keep lane (locks, hits, links) starts collapsed —
    // it is bookkeeping, not the mix — until its glyph opens it.
    const rowsOpen = laneRowsOpen[t.id] ?? !keep;
    const stacked = count > 1 && rowsOpen;
    // Collapsed, every pill draws on the one line and drags in time only.
    const collapsed = count > 1 && !rowsOpen;
    // Minimised: the lane is a thin strip of marks (not the keep lane — it is bookkeeping).
    const min = !keep && (laneMin[t.id] ?? false);
    return { t, own, laneEvents, rows, endOf, count, ownRows, rowsOpen, stacked, collapsed, min, height: min ? MIN_LANE_H : (stacked ? count : 1) * LANE_H };
  });
  const trackH = RULER_H + lanes.reduce((a, l) => a + l.height, 0);

  // ── Pointer work on the track: scrub, block drag, lane shift, marquee ──────
  const trackRef = useRef(null);
  const rootRef = useRef(null);
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setTrackPx(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);
  const drag = useRef(null);
  // Pills that carry no row are filed into the rows drawn for them, once; from then
  // on nothing re-packs. That waits for what the packing reads — the track's width
  // and every sound's length — and for a pill drag to end. Every sound counts, on
  // any track: `len`, and so every pill's minimum width in ticks, reads them all
  // (every sound track and the shared routines' ghosts). While any length is still
  // missing every track keeps packing itself, until a pill of it is dragged
  // (startDragBlock files it as drawn).
  const soundKnown = (e) => (soundIdOf(e) == null ? (isLinkOp(e.op) || e.op === 0x1e) : peaks.has(soundIdOf(e)));
  const looseRows = (ready) => lanes.flatMap((lane) => {
    if (!ready(lane)) return [];
    return lane.own.filter((e) => rowOfEvent(e) == null && lane.rows.rowOf.get(e._id) <= MAX_ROW)
      .map((e) => ({ id: e._id, row: lane.rows.rowOf.get(e._id) }));
  });
  // A ghost with no sound id is ignored: nothing backfills one. A sound track's own
  // event with none may still be waiting for Open to backfill it.
  const lenSettled = !getSoundPeaks || (
    [...events.filter(isSoundEvent), ...ghostEvents].every((e) => soundIdOf(e) == null || peaks.has(soundIdOf(e)))
    && lanes.every((l) => l.t.kind !== 'sound' || l.own.every(soundKnown)));
  useEffect(() => {
    if (!onAssignRows || !trackPx || !lenSettled || drag.current?.kind === 'block') return;
    const list = looseRows(() => true);
    if (list.length) onAssignRows(list);
  });
  const [marquee, setMarquee] = useState(null);   // root-relative px while rubber-banding
  const [loopDrag, setLoopDrag] = useState(null); // loop marker mid-drag, in frames
  // A row dragged off the left list. Its drag type carries the lane kind
  // (`application/x-mixer-entry+motion`), which is all a dragover may read,
  // so a motion can only land on a motion track.
  const [dropLane, setDropLane] = useState(null);
  // A pill dragged onto another lane: that lane lights up; below the last lane
  // of its kind, the last lane shows a bar — the drop makes a new track there.
  // The window's two tabs: Details (the mix's Type, name and the Publish/Manage
  // settings) and Timeline (the track and its transport). Persisted, defaulting to
  // the Timeline — the working surface. The old Manage panel lives on Details now.
  const [tab, setTab] = useState(() => (readJson('mixerSeqTab') === 'details' ? 'details' : 'timeline'));
  const switchTab = (t) => { setTab(t); writeJson('mixerSeqTab', t); };
  // Minimise: collapse everything but the header bar. Persisted, like the tab.
  const [collapsed, setCollapsed] = useState(() => readJson('mixerSeqCollapsed') === true);
  const toggleCollapsed = () => setCollapsed((v) => { writeJson('mixerSeqCollapsed', !v); return !v; });
  // Dock: pin the window across the bottom of the app, full width. Persisted. The
  // top edge then resizes the height (the bottom is against the app's edge).
  const [docked, setDocked] = useState(() => readJson('mixerSeqDocked') === true);
  const toggleDocked = () => setDocked((v) => { writeJson('mixerSeqDocked', !v); return !v; });
  // A Publish that needs a Confirm shows its row in Manage, which is on the Details
  // tab — jump there when the tick moves, not on mount: the panel remounts whenever
  // the mixer view comes back, and the tick App kept from an old Publish must not.
  const seenManageTick = useRef(manageOpenTick);
  useEffect(() => {
    if (manageOpenTick === seenManageTick.current) return;
    seenManageTick.current = manageOpenTick;
    if (manageOpenTick) switchTab('details');
  }, [manageOpenTick]);
  // The Help window (the bar's ?) goes with the timeline: closing the timeline closes it.
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => { if (!open) setHelpOpen(false); }, [open]);
  // The transport bar's playback-options popover (speed, loop, snap, snaps, randomise).
  const [barMenu, setBarMenu] = useState(false);
  useEffect(() => {
    if (!barMenu) return undefined;
    const close = () => setBarMenu(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [barMenu]);
  // Locks · hits · links: the strip under the track, opened by the lane's + ('add': its
  // presets drop straight away) or its warning badge ('open').
  const [keepMenu, setKeepMenu] = useState(null);
  // Where an added command lands: the red cursor once the mix is on the stage, else the strike line, else 0.
  const keepAt = Math.max(0, Math.round(playhead ?? strike ?? 0));
  const keepRetail = retailKeepSet(kind);
  const keepNoHit = keepWarns.some((w) => w.noHit);
  const openKeepRows = () => { if (!(laneRowsOpen.keep ?? false)) toggleLaneRows('keep', true); };
  const addKeep = (id) => {
    if (!id || !onAddKeep) return;
    onAddKeep(id, keepAt);
    openKeepRows();
  };
  const copyKeep = (track) => {
    if (!track || !onCopyKeep) return;
    onCopyKeep(track);
    openKeepRows();
  };
  const keepCopyItems = tracks.filter((tr) => sources[tr.id]?.spec)
    .map((tr) => ({ id: tr.id, label: `${trackLabel(tr.id)} · ${sources[tr.id].name ?? sources[tr.id].spec}` }));
  const dragTypeFor = (t) => `${DRAG_TYPE}${t.kind}`;
  const dragFits = (e, t) => t.kind !== 'keep' && Array.from(e.dataTransfer?.types ?? []).includes(dragTypeFor(t));
  const dragOverLane = (e, t) => {
    if (!onDropEntry || !dragFits(e, t)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (dropLane !== t.id) setDropLane(t.id);
  };
  const dropOnLane = (e, t) => {
    setDropLane(null);
    if (!onDropEntry || !dragFits(e, t)) return;
    e.preventDefault();
    let entry;
    try { entry = JSON.parse(e.dataTransfer.getData(dragTypeFor(t))); } catch { return; }
    onDropEntry(entry, t.id, Math.round(frameAt(e.clientX)));
  };
  // Snap (on by default): a dragged block locks onto the strike line, the
  // loop end, frame 0 and the edges of the other blocks once within reach.
  const [snap, setSnap] = useState(() => readJson('mixerSnap') ?? true);
  const toggleSnap = (on) => { setSnap(on); writeJson('mixerSnap', on); };
  const SNAP_PX = 8;

  const trackWidth = () => trackRef.current?.clientWidth ?? 300;
  const pxPerFrame = () => trackWidth() / len;
  const frameAt = (clientX) => {
    const r = trackRef.current?.getBoundingClientRect();
    return r?.width ? clamp(((clientX - r.left) / r.width) * len, 0, len) : 0;
  };

  // Where the cursor was put, drawn until the stage has caught up: a scrub on a
  // stopped timeline may be waiting for the mix to compose.
  const [scrubAt, setScrubAt] = useState(null);
  useEffect(() => { if (!busy && drag.current?.kind !== 'scrub') setScrubAt(null); }, [busy]);
  const scrubTo = (clientX) => {
    const f = Math.round(frameAt(clientX));
    setScrubAt(f);
    onSeek?.(f);
  };
  const startScrub = (e) => {
    e.stopPropagation();
    drag.current = { kind: 'scrub' };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    scrubTo(e.clientX);
  };
  // The loop marker: drag sets the recipe's `total` (committed on release,
  // one edit rather than one per pixel); double-click clears it back to auto.
  const startLoopDrag = (e) => {
    if (!onLoopEnd) return;
    e.stopPropagation();
    drag.current = { kind: 'loop' };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setLoopDrag(Math.round(frameAt(e.clientX)));
  };
  const startDragBlock = (e, ev) => {
    e.stopPropagation();
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    if (additive) { onSelect(ev._id, 'toggle'); return; }
    const inGroup = selectedIds.has(ev._id);
    const ids = inGroup ? selectedIds : new Set([ev._id]);
    if (!inGroup) onSelect(ev._id, 'only');
    // Each dragged pill's row, where its lane shows its rows: a collapsed lane drags
    // in time only (its rows are hidden on one line).
    const laneOf = new Map(lanes.flatMap((lane) => lane.own.map((x) => [x._id, lane])));
    const starts = events.filter((x) => ids.has(x._id)).map((x) => {
      const lane = laneOf.get(x._id);
      const rowed = !!lane && !lane.collapsed;
      return { id: x._id, start0: x.start, row0: rowed ? (lane.rows.rowOf.get(x._id) ?? 0) : null, rows: lane?.count ?? 1, lane: lane?.t.id };
    });
    // The group moves between rows as one: up until its top pill is in the first
    // row, down until its lowest is one past its track's last — a fresh row.
    const rowed = starts.filter((s) => s.row0 != null);
    const rowLo = rowed.length ? -Math.min(...rowed.map((s) => s.row0)) : 0;
    const rowHi = rowed.length ? Math.max(0, Math.min(...rowed.map((s) => Math.min(s.rows, MAX_ROW) - s.row0))) : 0;
    drag.current = { kind: 'block', x0: e.clientX, y0: e.clientY, ev, starts, rowLo, rowHi, last: null, moved: false, inGroup };
    setRowHold(new Map(lanes.map((lane) => [lane.t.id, lane.count])));
    // Whatever in these lanes has no row yet gets the one it is drawn in, so the
    // drag moves the dragged pills and nothing else.
    const dragged = new Set(starts.map((s) => s.lane));
    const loose = onAssignRows ? looseRows((lane) => dragged.has(lane.t.id)) : [];
    if (loose.length) onAssignRows(loose);
    e.target.setPointerCapture?.(e.pointerId);
  };
  const startLaneDrag = (e, laneId) => {
    drag.current = { kind: 'lane', x0: e.clientX, lane: laneId, moved: 0 };
    e.target.setPointerCapture?.(e.pointerId);
  };
  const startMarquee = (e) => {
    if (e.target !== e.currentTarget) return;
    const root = rootRef.current.getBoundingClientRect();
    const p0 = { x: e.clientX - root.left, y: e.clientY - root.top };
    drag.current = { kind: 'marquee', x0: e.clientX, y0: e.clientY, p0, additive: e.ctrlKey || e.metaKey || e.shiftKey };
    setMarquee({ x0: p0.x, y0: p0.y, x1: p0.x, y1: p0.y });
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'scrub') { scrubTo(e.clientX); return; }
    if (d.kind === 'loop') { setLoopDrag(Math.max(1, Math.round(frameAt(e.clientX)))); return; }
    if (d.kind === 'marquee') {
      const root = rootRef.current.getBoundingClientRect();
      setMarquee({ x0: d.p0.x, y0: d.p0.y, x1: e.clientX - root.left, y1: e.clientY - root.top });
      return;
    }
    const frames = Math.round((e.clientX - d.x0) / pxPerFrame());
    if (d.kind === 'block') {
      // Up or down is a whole row at a time, within the pill's own track.
      const dRow = clamp(Math.round((e.clientY - d.y0) / LANE_H), d.rowLo, d.rowHi);
      if (frames || dRow || Math.abs(e.clientY - d.y0) > 6) d.moved = true;
      let delta = Math.max(frames, -Math.min(...d.starts.map((s) => s.start0)));
      if (snap) {
        // Nearest target to the grabbed block's start or end wins; the whole
        // group shifts by the same correction so it keeps its shape.
        const moving = new Set(d.starts.map((s) => s.id));
        const targets = [0, strike, loopEnd]
          .concat(events.filter((x) => !moving.has(x._id)).flatMap((x) => [x.start, x.start + (x.dur || 0)]))
          .filter((t) => typeof t === 'number' && t >= 0);
        const reach = SNAP_PX / pxPerFrame();
        const start = d.starts.find((s) => s.id === d.ev._id)?.start0 ?? d.ev.start;
        const edges = [start + delta, start + delta + (d.ev.dur || 0)];
        let best = null;
        for (const edge of edges) {
          for (const t of targets) {
            const off = t - edge;
            if (Math.abs(off) <= reach && (best === null || Math.abs(off) < Math.abs(best))) best = off;
          }
        }
        if (best) delta = Math.max(delta + Math.round(best), -Math.min(...d.starts.map((s) => s.start0)));
      }
      d.last = d.starts.map((s) => ({ id: s.id, start: s.start0 + delta, ...(s.row0 != null ? { row: s.row0 + dRow } : null) }));
      onMoveMany(d.last);
    } else if (d.kind === 'lane') {
      const delta = frames - d.moved;
      if (delta) { onShiftLane(d.lane, delta); d.moved = frames; }
    }
  };
  // A drop. A dragged pill let go on top of another pill of its row goes to the
  // first row below with room for it (a fresh one when none has); what it landed
  // on stays put. The whole group is written again with it, so the drop does not
  // lean on the last move having been rendered.
  const settleDrop = (d) => {
    if (!d.last) return;
    const at = new Map(d.last.map((m) => [m.id, m]));
    const settled = new Map();
    for (const lane of lanes) {
      if (!lane.own.some((x) => at.has(x._id))) continue;
      const now = lane.own.map((x) => ({ ...x, start: at.get(x._id)?.start ?? x.start, row: at.get(x._id)?.row ?? lane.rows.rowOf.get(x._id) ?? 0 }));
      for (const [id, row] of settleRows(now, new Set(at.keys()), lane.endOf)) settled.set(id, row);
    }
    if (settled.size) onMoveMany(d.last.map((m) => (settled.has(m.id) ? { ...m, row: settled.get(m.id) } : m)));
    // A one-row lane remembered as collapsed would hide the row this drop may have made.
    for (const id of new Set(d.starts.filter((s) => s.row0 != null).map((s) => s.lane))) {
      if (laneRowsOpen[id] === false) toggleLaneRows(id, true);
    }
  };
  const endPointer = (e) => {
    const d = drag.current;
    drag.current = null;
    if (rowHold) setRowHold(null);
    if (!d) return;
    if (d.kind === 'scrub') {
      if (!busy) setScrubAt(null);
      return;
    }
    if (d.kind === 'loop') {
      setLoopDrag(null);
      onLoopEnd?.(Math.max(1, Math.round(frameAt(e.clientX))));
      return;
    }
    if (d.kind === 'marquee') {
      setMarquee(null);
      const [x0, x1] = [Math.min(d.x0, e.clientX), Math.max(d.x0, e.clientX)];
      const [y0, y1] = [Math.min(d.y0, e.clientY), Math.max(d.y0, e.clientY)];
      const [f0, f1] = [frameAt(x0), frameAt(x1)];
      const hit = [];
      for (const el of rootRef.current.querySelectorAll('.mseq-lane')) {
        const r = el.getBoundingClientRect();
        if (r.bottom < y0 || r.top > y1) continue;
        const lane = lanes.find((l) => l.t.id === el.dataset.lane);
        for (const ev of lane?.own ?? []) {
          // Only the rows the rectangle reaches: a pill's row is LANE_H of its lane.
          const top = r.top + (lane.collapsed ? 0 : (lane.rows.rowOf.get(ev._id) ?? 0)) * LANE_H;
          if (top + LANE_H < y0 || top > y1) continue;
          if (ev.start >= f0 && ev.start <= f1) hit.push(ev._id);
        }
      }
      onSelect(hit, d.additive ? 'add' : 'set');
      return;
    }
    if (d.kind === 'block' && d.moved) settleDrop(d);
    if (d.kind === 'block' && !d.moved) {
      if (d.inGroup) onSelect(d.ev._id, 'only');
      if (isSoundEvent(d.ev)) onPreview?.(d.ev);
    }
    // A block moves in time and between the rows of its own track: it never changes
    // track, since its generators, clips and sounds are read from that track's
    // source DAT (a Barrage generator nudged onto a Charm track broke compose).
  };

  // ── Pills ───────────────────────────────────────────────────────────────────
  const x = (f) => `${(f / len) * 100}%`;
  const pill = (ev, lane) => {
    const { t, rows, collapsed } = lane;
    const row = collapsed ? 0 : (rows.rowOf.get(ev._id) ?? 0);
    const top = row * LANE_H + LANE_H / 2;
    const color = (t.kind === 'keep' ? KEEP_LANE : LANE_BY_ID.get(kindOf(ev.from)) ?? KEEP_LANE).color;
    const state = `${selectedIds.has(ev._id) ? ' on' : ''}${ev.enabled === false ? ' off' : ''}`;
    // The mix edits this generator, or replaces a texture it draws (the Generator window): its pill says so.
    const genKey = !ev.ghost && isGeneratorOp(ev.op) && ev.ref ? `${ev.from}:${ev.ref}` : null;
    const genEdited = !!genKey && !!editedGens?.has(genKey);
    const texEdited = !!genKey && !!texturedGens?.has(genKey);
    const edited = genEdited || texEdited;
    const editNote = `${genEdited ? ' · generator edited in this mix' : ''}${texEdited ? ' · a texture it draws is replaced in this mix' : ''}`;
    if (ev.ghost && t.kind === 'vfx') {
      return (
        <Tooltip key={ev._id} content={`${ev.count} generator${ev.count === 1 ? '' : 's'} via shared routine ${ev.via} @${ev.start} — the game runs this from ROM/0/0.DAT; mute or move the ${ev.via} link to change it. A mix does not carry these generators, so they cannot be edited`}>
          <span className="mseq-pill ghost fx" style={{ left: x(ev.start), width: `${Math.max(1.2, ((ev.dur || 0) / len) * 100)}%`, top }}>
            <span className="icon mseq-spk">link</span>{ev.via} · {ev.count} gen{ev.count === 1 ? '' : 's'}
          </span>
        </Tooltip>
      );
    }
    if (t.kind === 'sound' && ev.ghost) {
      const pk = peaks.get(soundIdOf(ev));
      return (
        <Tooltip key={ev._id} content={`${ev.ref} via shared routine ${ev.via} @${ev.start}${pk ? ` · ${pk.seconds.toFixed(2)}s` : ''} — the game plays this from ROM/0/0.DAT; mute or move the ${ev.via} link to change it`}>
          <span className="mseq-pill wave ghost" style={{ left: x(ev.start), width: `${Math.max(2.4, (soundTicks(ev) / len) * 100)}%`, top }}>
            <span className="icon mseq-spk">link</span>
            {pk?.peaks && <svg className="mseq-wave" viewBox={`0 0 ${pk.peaks.length} 20`} preserveAspectRatio="none"><path d={wavePath(pk.peaks)} stroke="#fff" strokeWidth="0.75" strokeOpacity="0.9" fill="none" /></svg>}
            <span className="mseq-wave-label">{ev.via} · {ev.ref}</span>
          </span>
        </Tooltip>
      );
    }
    if (t.kind === 'sound' && ev.op === 0x1e) {
      return (
        <Tooltip key={ev._id} content={`Stop ${ev.ref} @${ev.start} — ends the sustained sound`}>
          <span className={`mseq-pill${state}`} style={{ left: x(ev.start), width: '2.4%', background: color, top, opacity: 0.7 }}
            onPointerDown={(e) => startDragBlock(e, ev)}>■ stop {ev.ref}</span>
        </Tooltip>
      );
    }
    if (t.kind === 'sound' && !isLinkOp(ev.op)) {
      const pk = peaks.get(soundIdOf(ev));
      return (
        <Tooltip key={ev._id} content={`${opName(ev.op)} ${ev.ref ?? ''} @${ev.start}${pk ? ` · ${pk.seconds.toFixed(2)}s` : ''} · click the speaker to hear it${editNote}${ev.enabled === false ? ' · muted (M to unmute)' : ''}`}>
          <span className={`mseq-pill wave${state}`} style={{ left: x(ev.start), width: `${Math.max(2.4, (soundTicks(ev) / len) * 100)}%`, background: color, top }}
            onPointerDown={(e) => startDragBlock(e, ev)}>
            <span className="icon mseq-spk" role="button" aria-label="Play this sound"
              onPointerDown={(e) => { e.stopPropagation(); onPreview?.(ev); }}>{ev.enabled === false ? 'volume_off' : 'volume_up'}</span>
            {pk?.peaks && <svg className="mseq-wave" viewBox={`0 0 ${pk.peaks.length} 20`} preserveAspectRatio="none"><path d={wavePath(pk.peaks)} stroke="#fff" strokeWidth="0.75" strokeOpacity="0.9" fill="none" /></svg>}
            <span className="mseq-wave-label">{edited && <span className="icon mseq-edited" aria-hidden="true">edit</span>}{ev.ref ?? opName(ev.op)}</span>
          </span>
        </Tooltip>
      );
    }
    // A block that starts no generator (a dampen, link, clip…) is the outlined twin of
    // the solid generator pills around it. The keep lane holds no generators to tell apart.
    const nogen = t.kind !== 'keep' && !isGeneratorOp(ev.op);
    // A clip's blend windows as ramps: up from the left edge over the blend in,
    // down to the right edge over the blend out, the part still blending shaded.
    const blend = ev.op === 0x05 && ev.dur > 0 ? clipBlend(ev) : [0, 0];
    const ramp = (v) => clamp((v / ev.dur) * 100, 0, 100);
    // Loop repeats: a clip with loops ≠ 1 plays again each cycle — draw the extra plays
    // as faint ghost pills (N−1 of them; 0 = ∞, filled to the loop end) so the timeline
    // shows how long the motion sustains. Ghosts tile at the true `dur`, one play each,
    // since in game every play lasts exactly that. A short clip's pill, forced to
    // MIN_PILL_PX, draws over its first repeats; its row holds the longer of the two
    // (pillEnd), so nothing is placed over either.
    // A short line joins the pill to each repeat in turn: they are one clip.
    const clipLoops = ev.op === 0x05 ? (ev.loops ?? 1) : 1;
    const cycle = ev.dur || 0;
    const ghosts = [];
    if (clipLoops !== 1 && cycle > 0) {
      const endF = clipLoops === 0 ? Math.max(loopEnd || 0, ev.start + cycle, len) : ev.start + clipLoops * cycle;
      for (let i = 1; ev.start + i * cycle < endF - 1 && i <= 32; i++) ghosts.push(ev.start + i * cycle);
    }
    const pillWidth = `${Math.max(1.2, (cycle / len) * 100)}%`;
    const ghostWidth = `${(cycle / len) * 100}%`;
    // A cast's stage (Start, Middle, End…) leads the label. On a spell the chant is the
    // server's: it picks one of eight by the spell's group and the client plays it from
    // the race files from cast start to finish, before the spell's own DAT runs — so a
    // chant pill is a second chant, and every other stage starts at the finish.
    const stage = stageOf(ev);
    const stageNote = !stage || kind !== 'spell' ? ''
      : isChantPill(ev)
        ? ' — the chant is the server’s, not the mix’s: it plays one of eight by the spell’s group (spell_list.group) for the whole cast, before this DAT runs. Here it chants a second time once the cast is done and holds everything after it back; a spell pick leaves it out. Fine on a job ability or weapon skill.'
        : ' — the chant before it is the server’s (spell_list.group): this DAT, and this pill, start when the cast finishes.';
    // A lock, hit or link says what it is and what it does in game; one added here has no track.
    const isKeep = t.kind === 'keep';
    const tip = isKeep
      ? `${keepLabel(ev)} @${ev.start}${ev.dur ? ` for ${ev.dur}` : ''} · ${hasTrack(ev) ? `from ${trackLabel(ev.from)}` : 'added here'}${ev.enabled === false ? ' · muted (M to unmute)' : ''} — ${keepDoes(ev)}`
      : `${stage ? `${stage} · ` : ''}${opName(ev.op)} ${ev.ref ?? ''} @${ev.start}${ev.dur ? ` for ${ev.dur}` : ''}${clipLoops !== 1 ? ` · loops ${clipLoops === 0 ? '∞' : clipLoops}` : ''}${blend[0] || blend[1] ? ` · blend in ${blend[0]} / out ${blend[1]} frames` : ''}${editNote}${stageNote}`;
    const mainPill = (
      <Tooltip key={ev._id} content={tip}>
        <span className={`mseq-pill${nogen ? ' nogen' : ''}${state}`}
          style={{ left: x(ev.start), width: pillWidth, top, ...(nogen ? { '--pill': color } : { background: color }), ...(isKeep ? { minWidth: keepPx(ev) } : null) }}
          onPointerDown={(e) => startDragBlock(e, ev)}>
          {(blend[0] > 0 || blend[1] > 0) && (
            <svg className="mseq-blend" viewBox="0 0 100 16" preserveAspectRatio="none" aria-hidden="true">
              {blend[0] > 0 && <path className="mseq-blend-shade" d={`M0,0 L${ramp(blend[0])},0 L0,16 Z`} />}
              {blend[0] > 0 && <line className="mseq-blend-line" x1="0" y1="16" x2={ramp(blend[0])} y2="0" />}
              {blend[1] > 0 && <path className="mseq-blend-shade" d={`M${100 - ramp(blend[1])},0 L100,0 L100,16 Z`} />}
              {blend[1] > 0 && <line className="mseq-blend-line" x1={100 - ramp(blend[1])} y1="0" x2="100" y2="16" />}
            </svg>
          )}
          {edited && <span className="icon mseq-edited" aria-hidden="true">edit</span>}
          <span className="mseq-pill-label">{isKeep ? keepLabel(ev) : <>{stage ? `${stage} · ` : ''}{ev.ref ? ev.ref.replace(/\?$/, '') : opName(ev.op)}{clipLoops !== 1 ? ` ×${clipLoops === 0 ? '∞' : clipLoops}` : ''}</>}</span>
        </span>
      </Tooltip>
    );
    if (!ghosts.length) return mainPill;
    return (
      <Fragment key={ev._id}>
        {mainPill}
        {ghosts.map((g, i) => (
          <Fragment key={`${ev._id}:loop:${i}`}>
            {/* A forever loop has no last repeat: its last link fades out. */}
            <span className={`mseq-loop-link${clipLoops === 0 && i === ghosts.length - 1 ? ' fade' : ''}`}
              style={{ left: x(g), top, '--pill': color }} aria-hidden="true" />
            <span className="mseq-pill mseq-loop-ghost"
              style={{ left: `calc(${x(g)} + ${LOOP_LINK_PX}px)`, width: `calc(${ghostWidth} - ${LOOP_LINK_PX}px)`, top, '--pill': color }} aria-hidden="true" />
          </Fragment>
        ))}
      </Fragment>
    );
  };

  // On a job ability or spell, a source that is neither a `ja:`/`spell:` id nor a base-pool
  // clip is BAKED from one race's copy into the single DAT. That is experimental — no retail
  // spell carries caster clips, and the client's PlayClip finds a wildcard ref only among the
  // actor's loaded motions — so the strip warns rather than blocking with a red track.
  const badTracks = EMPTY_SET;
  const bakedTracks = kind === 'ws' ? EMPTY_SET
    : new Set(Object.entries(sources).filter(([id, s]) => kindOf(id) === 'motion' && s?.spec
      && !motionOkForKind(s.spec, kind) && !baseMotionSpecs?.has?.(s.spec)).map(([id]) => id));
  const shown = clamp(Math.round(scrubAt ?? playhead ?? 0), 0, len);
  const playing = transport === 'playing';
  const style = docked ? {
    zIndex,
    left: 0, right: 0, bottom: 0, top: 'auto', width: 'auto', maxWidth: '100%',
    ...(collapsed ? null : { height: size.h || 340 }),
  } : {
    width: size.w,
    zIndex,
    ...(size.h && !collapsed ? { height: size.h } : null),
    ...(pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : null),
  };

  if (!open) return null;
  return createPortal(
    <div id="mixer-seq" className={`panel${collapsed ? ' is-collapsed' : ''}${docked ? ' is-docked' : ''}`} ref={panelRef} style={style} onPointerDownCapture={onFocus ?? undefined}>
      <div className="cseq-header" ref={headerRef} onPointerDown={startDrag}>
        <span className="icon">timeline</span>
        <div className="settings-tabs mseq-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'details'}
            className={`settings-tab${tab === 'details' ? ' on' : ''}`} onClick={() => switchTab('details')}>
            <span className="icon">tune</span>Details
          </button>
          <button type="button" role="tab" aria-selected={tab === 'timeline'}
            className={`settings-tab${tab === 'timeline' ? ' on' : ''}`} onClick={() => switchTab('timeline')}>
            <span className="icon">timeline</span>Timeline
          </button>
        </div>
        <span className="sp" />
        <span className="mono mseq-name">{recipeName}</span>
        {onPublish && (
          <Tooltip content={publishCfg?.pivot
            ? 'Publish: build this mix into the pivot folder (FFXI_PIVOT_DIR) now (xi dats build --pivot) — the console shows it as it runs'
            : 'Publish: build this mix into the game folder now (xi dats build) — the console shows it as it runs'} placement="bottom">
            <button type="button" className="cseq-btn mseq-publish-btn" disabled={!canPublish} onClick={() => onPublish()}>
              <span className="icon">publish</span>Publish
            </button>
          </Tooltip>
        )}
        <Tooltip content={docked ? 'Float the mixer' : 'Dock to the bottom of the app'} placement="bottom">
          <button type="button" className="icon-btn cseq-close cseq-min" onClick={toggleDocked} aria-label={docked ? 'Float' : 'Dock to bottom'}>
            <span className="icon">{docked ? 'open_in_full' : 'vertical_align_bottom'}</span>
          </button>
        </Tooltip>
        <Tooltip content={collapsed ? 'Expand the mixer' : 'Minimise to the title bar'} placement="bottom">
          <button type="button" className="icon-btn cseq-close cseq-min" onClick={toggleCollapsed} aria-label={collapsed ? 'Expand' : 'Minimise'} aria-expanded={!collapsed}>
            <span className="icon">{collapsed ? 'expand_more' : 'expand_less'}</span>
          </button>
        </Tooltip>
        <button type="button" className="icon-btn cseq-close" onClick={onClose} aria-label="Close">
          <span className="icon">close</span>
        </button>
      </div>

      <div className="cseq-body" ref={bodyRef}>
        {busy && (
          <div className="mseq-loading" role="status" aria-live="polite">
            <span className="icon mseq-loading-spin">progress_activity</span>
            <span>Loading Assets…</span>
          </div>
        )}
        {failed && (
          <div className="form-error mseq-error" role="alert">
            <span className="icon">error</span>
            <span><b>{error.title}</b>{error.text}</span>
            <Tooltip content="Dismiss">
              <button type="button" className="pc-tbtn" aria-label="Dismiss" onClick={onDismissError}><span className="icon">close</span></button>
            </Tooltip>
          </div>
        )}

        {tab === 'details' && (
          <div className="mseq-tab-body mseq-details">
          <div className="cseq-row cseq-settings mseq-toolbar mseq-toolbar-details">
            {/* The mix Type: what it publishes as. Every Type lists every motion; on Ability /
                Spell the base casts lead the list and any other motion is baked (experimental). */}
            <Tooltip content="Type: what this mix publishes as. A weapon skill is built per race and takes any motion. A job ability or spell is one DAT for every race: the casts at the top of the Motion list always work, and any other motion is baked from one race's copy, which is experimental." placement="top">
              <div className="cseq-load mseq-type">
                <Combo value={kind} items={MIX_TYPES} onChange={(k) => k && onKind?.(k)} />
              </div>
            </Tooltip>
            <div className="cseq-bar-sep" />
            <Tooltip content="Start a new empty mix" placement="top">
              <button type="button" className="cseq-btn" onClick={onNew}>New</button>
            </Tooltip>
            <input
              type="text"
              className="cseq-text mseq-mix-name"
              placeholder="Mix name"
              value={name}
              spellCheck={false}
              onChange={(e) => onName?.(e.target.value.replace(/[^A-Za-z0-9_-]/g, '_'))}
            />
            {/* Where the Mixes panel files it; the categories already in use drop down as you type. */}
            <CategoryInput className="cseq-text mseq-mix-cat" value={category} onChange={onCategory} options={categories} placeholder="Category" />
            <Tooltip content={saved.some((r) => r.name === name.trim()) ? 'Save over the mix with this name (Ctrl+S)' : 'Save under this name (Ctrl+S)'} placement="top">
              <button type="button" className="cseq-btn" disabled={!name.trim() || busy} onClick={onSave}>Save</button>
            </Tooltip>
            {/* Load opens the Mixes panel — every saved mix by category — rather than one long list of names. */}
            <button type="button" className={`cseq-btn mseq-load-btn${loadOpen ? ' on' : ''}`} onClick={onLoad}>Load</button>
            <Tooltip content="Delete the saved mix with this name" placement="top">
              <button
                type="button"
                className="icon-btn cseq-icon cseq-del"
                aria-label="Delete saved mix"
                disabled={!saved.some((r) => r.name === name.trim())}
                onClick={() => onDelete?.(name.trim())}
              >
                <span className="icon">delete</span>
              </button>
            </Tooltip>
          </div>
          {publishCfg && (
          <div className="mixer-editor mseq-manage">
            <div className="mixer-editor-title">
              <span className="mono">Publish · {recipeName}</span>
              <span className="sp" />
              <Tooltip content={canPublish ? 'Check: a dry run with these choices — the slot it takes, where every DAT lands and what the Local server switches would do. No DAT or server change is written; the mix it checked is kept as check.<Name>.mix.json in the publish folder.' : 'Pick a motion, effect or sound first'} placement="top">
                <button type="button" className="cseq-btn" disabled={!canPublish || !onCheckPublish} onClick={() => onCheckPublish()}>Check</button>
              </Tooltip>
              {onOpenSlots && (
                <Tooltip content="Slots: every weapon-skill number in the game or pivot folder — 264–271, then the plugin band 0–255 — and what holds each, in its own window. Click a free one to take it." placement="top">
                  <button type="button" className={`cseq-btn${slotsOpen ? ' on' : ''}`} disabled={busy} onClick={() => onOpenSlots()}>Slots</button>
                </Tooltip>
              )}
              {onOpenPublishFolder && (
                <Tooltip content={`Folder: open this mix’s publish folder — the mix it published, the server SQL, what ran against the database, and a copy of every DAT it placed (${publishFolderRel(recipeName)})`} placement="top">
                  <button type="button" className="cseq-btn" onClick={onOpenPublishFolder}>
                    <span className="icon">folder_open</span>Folder
                  </button>
                </Tooltip>
              )}
            </div>
            {/* What it publishes as is the toolbar's Type (`kind`), not a choice of its own here. */}
            <div className="mixer-fields">
              <label className="mixer-field">
                <span>animation</span>
                <input type="text" inputMode="numeric" className="cseq-text mixer-num" placeholder="auto" spellCheck={false}
                  value={publishCfg.animation ?? ''} onChange={(e) => onPublishCfg({ animation: e.target.value.replace(/[^0-9]/g, '') })} />
              </label>
              <label className="mixer-field">
                <span>start at</span>
                <Tooltip content="Where an automatic number starts: Publish takes the first free one at or above this (272 goes straight to the plugin band). Blank = the first free number of all. Check shows the one it lands on." placement="top">
                  <input type="text" inputMode="numeric" className="cseq-text mixer-num" placeholder="first free" spellCheck={false}
                    disabled={!!publishCfg.animation}
                    value={publishCfg.from ?? ''} onChange={(e) => onPublishCfg({ from: e.target.value.replace(/[^0-9]/g, '') })} />
                </Tooltip>
              </label>
              <label className="mixer-field">
                <span>ROM10 folder</span>
                <input type="text" inputMode="numeric" className="cseq-text mixer-num" spellCheck={false}
                  value={publishCfg.subdir ?? ''} onChange={(e) => onPublishCfg({ subdir: e.target.value.replace(/[^0-9]/g, '') })} />
              </label>
            </div>
            {/* Overwrite and pivot: one line under the fields (the server switches have their own, below). */}
            <div className="mseq-manage-opts">
              <Tooltip content="Take the animation slot even when its file ids already point at another DAT (xi dats build --force)" placement="top">
                <label className="switch cseq-switch mseq-manage-force">
                  <input type="checkbox" checked={!!publishCfg.force} onChange={(e) => onPublishCfg({ force: e.target.checked })} />
                  <span className="track" />
                  <span className="cseq-switch-label">Overwrite a taken slot</span>
                </label>
              </Tooltip>
              <Tooltip content="Build into the pivot folder (FFXI_PIVOT_DIR) instead of the game folder (FFXI_DIR) — xi dats build --pivot. Check looks there too." placement="top">
                <label className="switch cseq-switch mseq-manage-pivot">
                  <input type="checkbox" checked={!!publishCfg.pivot} onChange={(e) => onPublishCfg({ pivot: e.target.checked })} />
                  <span className="track" />
                  <span className="cseq-switch-label">Use Pivot Folder</span>
                </label>
              </Tooltip>
            </div>
            {/* The numbers Publish can hand out for this kind: what any client loads, then the
                plugin band when Settings › XI Tools says the client runs one (cexislots).
                `kind` is the Type as shown: the one picked, else what the mix reads as. */}
            {(() => {
              const stock = STOCK_ANIM_RANGE[kind];
              if (!stock) return null;
              const band = animBandRange(kind, animBands);
              return (
                <div className="mono-small mseq-band-note">
                  {KIND_LABEL[kind]} numbers: {stock[0]}–{stock[1]} on any client
                  {band
                    ? <> · then <b>{band[0]}–{band[1]}</b> with the client plugin (cexislots)</>
                    : <> · custom bands are off — Settings › XI Tools › Custom animation bands adds more with cexislots</>}
                </div>
              );
            })()}
            {kind === 'spell' && (
              <div className="mono-small mseq-band-note">The chant is the server’s, not this mix’s: it plays one of eight by the spell’s group (spell_list.group) while the spell is cast, and this DAT runs when the cast finishes.</div>
            )}
            {/* Local server: what the build does on the server once the DATs are placed
                (xi dats build --apply-db / --menu-record / --lua-stub), on Check and Publish
                alike. Per mix, like everything here; off after an import, rename or duplicate. */}
            <div className="mseq-manage-opts mseq-manage-server">
              <span className="mseq-manage-group">Local server</span>
              <Tooltip content="Database Update: once the DATs are placed, point the local server’s row named after this mix at its animation, or, if there is none, insert one cloned from a default donor (spell → Cure, ability → Berserk, weapon skill → Fast Blade) so it plays and works until a dev sets its real stats. A row this mix didn’t create is only changed after you confirm it once. Server: Settings › Local Server. Restart the map server afterwards. (xi dats build --apply-db)" placement="top">
                <label className="switch cseq-switch">
                  <input type="checkbox" checked={!!publishCfg.db} onChange={(e) => onPublishCfg({ db: e.target.checked })} />
                  <span className="track" />
                  <span className="cseq-switch-label">Database Update</span>
                </label>
              </Tooltip>
              <Tooltip content="Client Menu Record: place the game’s menu entry (the spell or command record and its name) at the same id as the server row, so players can use it from the menu. Only a blank retail row is used, never a named one. Use Pivot Folder when your client runs PIVOT. Restart the game afterwards. (--menu-record)" placement="top">
                <label className="switch cseq-switch">
                  <input type="checkbox" checked={!!publishCfg.menu} onChange={(e) => onPublishCfg({ menu: e.target.checked })} />
                  <span className="track" />
                  <span className="cseq-switch-label">Client Menu Record</span>
                </label>
              </Tooltip>
              <Tooltip content="Lua Stub: write the server script for a new spell, ability or weapon skill into the server folder (Settings › Local Server). The script is what it does in game — damage, cost, effect — taken from the default donor’s script (Cure / Berserk / Fast Blade); this mix’s DAT is only how it looks. Only for a row this mix created; a stub you’ve edited is never overwritten. (--lua-stub)" placement="top">
                <label className="switch cseq-switch">
                  <input type="checkbox" checked={!!publishCfg.lua} onChange={(e) => onPublishCfg({ lua: e.target.checked })} />
                  <span className="track" />
                  <span className="cseq-switch-label">Lua Stub</span>
                </label>
              </Tooltip>
            </div>
            {(publishCfg.db || publishCfg.menu || publishCfg.lua) && (() => {
              const { db, menu, lua } = publishCfg;
              const settingsLink = onOpenLocalServer
                ? <button type="button" className="mseq-link" onClick={() => onOpenLocalServer()}>Settings › Local Server</button>
                : 'Settings › Local Server';
              const info = serverInfo && !serverInfo.loading && !serverInfo.error ? serverInfo : null;
              let hint;
              if (!serverInfo || serverInfo.loading) hint = <>Checking the local server…</>;
              else if (serverInfo.error) {
                hint = serverInfo.error === LOCAL_SERVER_TOO_OLD || /No such command/.test(serverInfo.error)
                  ? <>{LOCAL_SERVER_TOO_OLD}</>
                  : <>Couldn’t check the local server: {serverInfo.error} · {settingsLink}</>;
              } else if (!describeServer(info)) hint = <>No database configured — {settingsLink}</>;
              else {
                hint = (
                  <>
                    → {describeServer(info)}
                    {lua && !info.serverDirValid && <> · Lua Stub needs the Server folder — {settingsLink}</>}
                  </>
                );
              }
              const wsState = info?.weaponSkills?.source?.state;
              return (
                <>
                  <div className="mixer-fields mseq-server-fields">
                    {(db || menu) && (
                      <label className="mixer-field">
                        <span>server id</span>
                        <Tooltip content="The server id for a new row, and for its menu record. Blank: the highest id that is blank in the client and free on the server; one typed here must be one of those. A row this mix already made keeps its id. (--server-id)" placement="top">
                          <input type="text" inputMode="numeric" className="cseq-text mixer-num" placeholder="auto" spellCheck={false} autoComplete="off"
                            value={publishCfg.serverId ?? ''} onChange={(e) => onPublishCfg({ serverId: e.target.value.replace(/[^0-9]/g, '') })} />
                        </Tooltip>
                      </label>
                    )}
                    {menu && (
                      <label className="mixer-field mseq-field-wide">
                        <span>menu name</span>
                        <Tooltip content="What the menu shows (EN and JP). Blank: the mix name. Up to 39 characters for an ability or weapon skill, 99 for a spell. Apostrophes are fine; line breaks are not. (--menu-name)" placement="top">
                          <input type="text" className="cseq-text mixer-num" placeholder={String(recipeName ?? '').replace(/_/g, ' ')} spellCheck={false} autoComplete="off"
                            value={publishCfg.menuName ?? ''} onChange={(e) => onPublishCfg({ menuName: e.target.value })} />
                        </Tooltip>
                      </label>
                    )}
                  </div>
                  <div className="mono-small mseq-band-note mseq-server-hint">{hint}</div>
                  {db && (
                    <div className="mono-small mseq-band-note">
                      Updates the server row named after this mix. If there is none, it inserts one cloned from <b>{DEFAULT_DONOR_LABEL[kind]}</b> so it plays and works — a dev edits its real stats afterwards.
                    </div>
                  )}
                  {kind === 'ws' && db && info && wsState !== 'widened' && (
                    <div className="mono-small mseq-band-note">Weapon-skill animations above 255 need the C++ patch first ({settingsLink} › Weapon skills: apply it, run the SQL, rebuild xi_map); until then Publish leaves the database alone for them.</div>
                  )}
                  {kind === 'ws' && menu && !db && (
                    <div className="mono-small mseq-band-note">A weapon-skill menu record needs Database Update (a weapon_skills row at the same id).</div>
                  )}
                  {lua && !db && (
                    <div className="mono-small mseq-band-note">Lua Stub writes a script only for a row this mix created — turn on Database Update.</div>
                  )}
                  {kind === 'ja' && db && (
                    <div className="mono-small mseq-band-note">A newly inserted job ability goes live for {DEFAULT_DONOR_LABEL.ja}’s job and level, and shares its recast timer, until a dev edits it.</div>
                  )}
                </>
              );
            })()}
            {publishPlan && (
              <div className="mseq-plan-wrap">
                {publishPlan.animation != null && (
                  <div className="mono-small">{publishPlan.kind} animation <b>{publishPlan.animation}</b> · {publishPlan.files.length} DAT{publishPlan.files.length === 1 ? '' : 's'}{publishPlan.server ? ` · server: ${publishPlan.server}` : ''}</div>
                )}
                {/* The server steps, coloured by what happened: ok, a warning (needs-confirm, skip,
                    kept), or refused / error. Quoted names read unescaped. */}
                {[['db', 'Database'], ['menu', 'Menu'], ['lua', 'Lua']].map(([k, label]) => {
                  const step = publishPlan[k];
                  if (!step) return null;
                  return (
                    <div key={k} className={`mono-small mseq-plan-step ${stepTone(step.op)}`}>
                      <b>{label}</b> {step.would ? 'would ' : ''}{step.op} {showStepText(step.text)}
                    </div>
                  );
                })}
                {onConfirmDbRow && dbConfirmOf(publishPlan) && (() => {
                  // A row this mix didn't make: one that would change (needs-confirm), or one
                  // that already has the animation while its menu record waits on it.
                  const { id, name, unchanged } = dbConfirmOf(publishPlan);
                  const after = publishPlan.fromPublish;
                  const why = unchanged
                    ? `This row wasn’t made by this mix, but it already has this animation — nothing on the server changes. Confirming makes '${name ?? '?'}' this mix’s row, so its menu record can go at #${id}. Asked once.`
                    : `This row wasn’t made by this mix — confirming changes it for every caster of '${name ?? '?'}' after the map server restarts. Asked once: later publishes update it without asking.`;
                  return (
                    <div className="mseq-plan-confirm">
                      <Tooltip content={`${why}${after ? ' This publishes again straight away.' : ' This runs Check again.'}`} placement="top">
                        <button type="button" className="cseq-btn" disabled={busy} onClick={() => onConfirmDbRow(id, !!after)}>
                          {after ? `Confirm #${id} '${name ?? '?'}' and publish` : `Confirm #${id} '${name ?? '?'}'`}
                        </button>
                      </Tooltip>
                    </div>
                  );
                })()}
                {publishPlan.warnings?.length > 0 && (
                  <pre className="mono-small mseq-plan-warn">{publishPlan.warnings.join('\n')}</pre>
                )}
                {!publishPlan.ok && (
                  <pre className="mono-small mseq-plan-err">{(publishPlan.errors.length ? publishPlan.errors : String(publishPlan.text ?? '').trim().split(/\r?\n/).filter(Boolean).slice(-6)).join('\n')}</pre>
                )}
                {publishPlan.files.length > 0 && (
                  <table className="mseq-plan">
                    <thead><tr><th>file id</th><th>race</th><th>role</th><th>lands in</th><th>slot today</th></tr></thead>
                    <tbody>
                      {publishPlan.files.map((f) => (
                        <tr key={`${f.fileId}:${f.role}`}>
                          <td>{f.fileId}</td><td>{f.race ?? '—'}</td><td>{f.role}</td><td>{f.target}</td>
                          <td className={f.occupiedBy ? 'warn' : 'dim'}>{f.occupiedBy ? `taken · ${f.occupiedBy}` : f.placeholder ? `free · placeholder ${f.placeholder}` : 'free'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
          )}
          </div>
        )}

        {tab === 'timeline' && (
          <>
        {/* The inset track: labels on the left, the scrolling ruler and lanes on the right */}
        {bakedTracks.size > 0 && (
          <div className="mseq-motion-warn">
            <span className="icon">science</span>
            <span>Experimental: this motion would be baked from one race's copy into the {KIND_LABEL[kind]}'s single DAT — not verified in game, it may not play. For a unique motion the proven route is Type WS (per-race DATs; cexislots adds slots 272–527). Base-pool casts at the top of the list always work.</span>
          </div>
        )}
        <div className="cseq-tl mseq-tl" style={{ height: trackH + 8 }} ref={rootRef} onPointerMove={onPointerMove} onPointerUp={endPointer} onPointerCancel={endPointer}>
          <div className="cseq-tl-labels">
            <div className="cseq-tl-spacer">
              {/* A compact twin of the toolbar's Add Track, right by the lanes. */}
              <Combo className="mseq-add-track-mini" value=""
                items={LANES.map((l) => ({ id: l.id, label: l.label, color: l.color }))}
                placeholder="Add Track" onChange={(k) => k && onAddTrack?.(k)} />
            </div>
            {lanes.map(({ t, count, ownRows, rowsOpen, stacked, min, height }) => (
              min ? (
              <div key={t.id} className={`cseq-tl-label mseq-label mseq-label-min${t.id === activeTrack ? ' active' : ''}`}
                style={{ height, color: t.color }}
                title={`${t.label} — collapsed to a line; click to expand`}
                onClick={(e) => { e.stopPropagation(); toggleLaneMin(t.id, false); }}>
                <span className="mseq-min-name">{t.label}</span>
              </div>
              ) : (
              <div key={t.id}
                className={`cseq-tl-label mseq-label${t.kind === 'keep' ? '' : ' track'}${t.id === activeTrack ? ' active' : ''}${badTracks.has(t.id) ? ' bad' : ''}`}
                style={{ height, color: t.color }}
                onClick={() => t.kind !== 'keep' && onActivateTrack?.(t.id)}>
                {/* The lane's own controls keep to its first row; each further row has its delete beside it. */}
                <div className="mseq-label-head">
                  <Tooltip content={t.kind === 'keep' ? 'The mix’s commands (locks, hits, links)'
                    : `${sources[t.id]?.name ? `${sources[t.id].name} · ` : ''}click: a pick lands on this track`}>
                    <span className="mseq-label-text">
                      {trackDisplay(t, sources)}
                    </span>
                  </Tooltip>
                  {count > 1 && (
                    <Tooltip content={stacked ? `Collapse to one row (${count} rows)` : `Show all ${count} rows — while collapsed, pills drag in time only`}>
                      <button type="button" className="mseq-rows" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); toggleLaneRows(t.id, !stacked); }}>
                        <span className="icon">{stacked ? 'unfold_less' : 'unfold_more'}</span>{count}
                      </button>
                    </Tooltip>
                  )}
                  {t.kind === 'keep' && keepWarns.length > 0 && (
                    <Tooltip interactive placement="right" content={(
                      <div className="mseq-help mseq-keep-tip">
                        {keepWarns.map((w, i) => <div key={i}>{w.text}</div>)}
                        {keepNoHit && onAddKeep && (
                          <button type="button" className="cseq-btn mseq-keep-retail" onClick={() => addKeep(keepRetail)}>Add retail set</button>
                        )}
                      </div>
                    )}>
                      <button type="button" className="mseq-keep-warn" aria-label={`${keepWarns.length} to look at in the locks, hits and links`}
                        onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setKeepMenu((m) => m ?? 'open'); }}>
                        <span className="icon">warning</span>{keepWarns.length}
                      </button>
                    </Tooltip>
                  )}
                  {t.kind === 'keep' && onAddKeep && (
                    <Tooltip content={`Add a lock, a hit or a link at f${keepAt}${playhead != null ? ' (the red cursor)' : ' (the strike line)'}, or copy a track source's own`}>
                      <button type="button" className={`mseq-add${keepMenu ? ' on' : ''}`} aria-label="Add a lock, hit or link" onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); setKeepMenu((m) => (m === 'add' ? null : 'add')); }}><span className="icon">add</span></button>
                    </Tooltip>
                  )}
                  {t.kind !== 'keep' && onAddRow && (
                    <Tooltip content="Add an empty row to this track, to drag pills down into">
                      <button type="button" className="mseq-add" aria-label="Add a row" disabled={count > MAX_ROW} onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); onAddRow(t.id, count + 1); if (!rowsOpen) toggleLaneRows(t.id, true); }}><span className="icon">add</span></button>
                    </Tooltip>
                  )}
                  {t.kind !== 'keep' && (
                    <Tooltip content="Collapse this lane to a thin line">
                      <button type="button" className="mseq-min-btn" aria-label="Collapse lane" onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); toggleLaneMin(t.id, true); }}><span className="icon">remove</span></button>
                    </Tooltip>
                  )}
                  {t.kind !== 'keep' && (sources[t.id] || !t.first) && (
                    <Tooltip content={t.first ? 'Clear this track' : 'Remove this track'}>
                      <button type="button" className="mseq-x" aria-label="Remove" onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); onRemoveTrack?.(t.id); }}><span className="icon">close</span></button>
                    </Tooltip>
                  )}
                </div>
                {t.kind !== 'keep' && stacked && onDeleteRow && Array.from({ length: Math.min(count, ownRows) - 1 }, (_, i) => i + 1).map((r) => (
                  <Tooltip key={r} content={`Delete row ${r + 1}: its pills join row ${r}, and the rows below move up`}>
                    <button type="button" className="mseq-x mseq-row-x" aria-label={`Delete row ${r + 1}`} style={{ top: r * LANE_H + (LANE_H - 16) / 2 }}
                      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onDeleteRow(t.id, r, looseRows((lane) => lane.t.id === t.id)); }}><span className="icon">remove</span></button>
                  </Tooltip>
                ))}
              </div>
              )
            ))}
          </div>
          <div className="cseq-tl-scroll">
            <div className="cseq-tl-track mseq-track" ref={trackRef} style={{ width: `${zoom * 100}%`, height: trackH }}>
              <div className="cseq-ruler mseq-ruler" onPointerDown={startScrub}>
                {ticks.map((t) => (
                  <span className="cseq-tick" key={t.t} style={{ left: `${t.x}%` }}>
                    <i />
                    <span>{t.t < 10 ? t.t.toFixed(1) : t.t.toFixed(0)}s</span>
                  </span>
                ))}
              </div>
              {lanes.map((lane) => (
                <div key={lane.t.id} className={`cseq-lane mseq-lane${lane.min ? ' min' : ''}${lane.stacked ? ' rows' : ''}${!lane.collapsed && lane.rows.count > lane.count ? ' grow' : ''}${dropLane === lane.t.id ? ' drop-ok' : ''}${badTracks.has(lane.t.id) ? ' bad' : ''}`} data-lane={lane.t.id} style={{ height: lane.height }} onPointerDown={startMarquee}
                  onDragOver={(e) => dragOverLane(e, lane.t)} onDragLeave={() => { if (dropLane === lane.t.id) setDropLane(null); }} onDrop={(e) => dropOnLane(e, lane.t)}>
                  {lane.min
                    ? lane.laneEvents.map((ev) => (
                        <span key={ev._id} className="mseq-min-mark"
                          style={{ left: x(ev.start), width: `${Math.max(0.4, ((lane.endOf(ev) - ev.start) / len) * 100)}%`, background: lane.t.color }} />
                      ))
                    : lane.laneEvents.map((ev) => pill(ev, lane))}
                </div>
              ))}
              {/* Each waiting link's hold: from its frame, as long as the routine it runs. The
                  label sits in the band's right end on the keep lane, or past the link's pill
                  when that covers the band. */}
              {holds.map((h) => {
                const w = h.ticks != null ? (h.ticks / len) * 100 : 0;
                const link = events.find((e) => e._id === h.id);
                const bandPx = (trackPx * w) / 100;
                const pillPx = link ? keepPx(link) : 0;
                const inside = bandPx >= pillPx + 60;
                return (
                  <span key={`hold:${h.id}`} className={`mseq-hold${h.ticks == null ? ' unknown' : ''}`} style={{ left: x(h.at), width: `${w}%` }}>
                    <Tooltip content={holdTip(h)}>
                      <i style={inside ? undefined : { left: Math.max(bandPx, pillPx) + 4, right: 'auto' }}>{h.ticks == null ? 'holds ?' : `holds ${h.ticks}`}</i>
                    </Tooltip>
                  </span>
                );
              })}
              {/* Strike (first hit), loop end and the shaded run past it, then the playhead */}
              {strike != null && <span className="mseq-strike" style={{ left: x(strike) }} />}
              {(loopDrag ?? loopEnd) > 0 && (loopDrag ?? loopEnd) < len && (() => {
                const at = loopDrag ?? loopEnd;
                return (
                  <>
                    <span className="mseq-past-loop" style={{ left: x(at), width: `${((len - at) / len) * 100}%` }} />
                    <Tooltip content={`Loop restart${loopSet ? ' (set on this recipe)' : ' (auto: after the last motion, effect or sound)'} — drag to move it, double-click to go back to auto. Sounds after here keep ringing past the restart, just like in game.`}>
                      <span
                        className={`mseq-loopend${loopSet ? ' set' : ''}${onLoopEnd ? ' grab' : ''}`}
                        style={{ left: x(at) }}
                        onPointerDown={startLoopDrag}
                        onDoubleClick={() => onLoopEnd?.(null)}
                      ><i>⟲ loop{loopSet ? ` ${Math.round(at)}` : ''}</i></span>
                    </Tooltip>
                  </>
                );
              })()}
              <div className={`cseq-playhead mseq-playhead${mixLoaded ? '' : ' idle'}`} style={{ left: x(shown) }}>
                <span className="mseq-head" onPointerDown={startScrub} title="Drag to scrub" />
              </div>
            </div>
          </div>
          {marquee && (
            <div className="mixer-marquee" style={{
              left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1),
              width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0),
            }} />
          )}
        </div>

        {/* Locks · hits · links: add a preset, copy a source's own, and what is off about them. */}
        {keepMenu && (
          <div className="mixer-editor mseq-keep">
            <div className="mixer-editor-title">
              <span className="mono">Commands</span>
              <span className="mono-small">what is added here belongs to no track: it stays when a track is cleared or picked again</span>
              <span className="sp" />
              <button type="button" className="pc-tbtn" aria-label="Close" onClick={() => setKeepMenu(null)}><span className="icon">close</span></button>
            </div>
            <div className="mixer-fields">
              {onAddKeep && (
                <label className="mixer-field mseq-keep-pick">
                  <span>add at f{keepAt}</span>
                  <div className="cseq-load">
                    {/* Keyed by how the strip opened: the + remounts it, and its list drops at once. */}
                    <Combo key={keepMenu} value="" items={KEEP_PRESET_ITEMS} groupByType autoOpen={keepMenu === 'add'}
                      placeholder="A lock, hit or link…" onChange={addKeep} />
                  </div>
                </label>
              )}
              {onCopyKeep && keepCopyItems.length > 0 && (
                <label className="mixer-field mseq-keep-pick">
                  <span>copy locks &amp; hits from</span>
                  <Tooltip content="A track's source keeps its locks, flinches and hits (mdam, proc) to itself: a pick leaves them behind, and without a hit the damage number waits for the routine's end. This copies them into the mix as commands of its own, with their bytes." placement="top">
                    <div className="cseq-load">
                      <Combo value="" items={keepCopyItems} placeholder="A track's source…" onChange={copyKeep} />
                    </div>
                  </Tooltip>
                </label>
              )}
              {onAddKeep && (
                <div className="mixer-editor-acts">
                  <Tooltip content={RETAIL_TIP[keepRetail === 'retail-spell' ? 'spell' : 'ws']} placement="top">
                    <button type="button" className="cseq-btn" onClick={() => addKeep(keepRetail)}>Add retail set</button>
                  </Tooltip>
                </div>
              )}
            </div>
            {keepWarns.length > 0 ? (
              <ul className="mseq-keep-warns">
                {keepWarns.map((w, i) => (
                  <li key={i} className={w.ids.length ? 'go' : undefined} onClick={w.ids.length ? () => onSelect(w.ids, 'set') : undefined}>
                    <span className="icon">warning</span><span>{w.text}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mono-small mixer-editor-note">{events.length ? 'Nothing to look at: the mix has its hit, and no lock or link is out of place.' : 'Pick a motion, effect or sound first; a lock or hit can go in on its own too.'}</div>
            )}
          </div>
        )}

        {editor}

        {/* The bar: transport | speed · loop | snap | help · zoom | frame */}
        <div className="cseq-bar">
          <div className="cseq-bar-group">
            <Tooltip content={playTip} placement="top">
              <button type="button" className={`cseq-play${playing ? ' playing' : ''}`} disabled={!canPlay} onClick={onPlayPause}>
                <span className="icon fill">{playing ? 'pause' : 'play_arrow'}</span>
              </button>
            </Tooltip>
            <Tooltip content="Stop and rewind" placement="top">
              <button type="button" className="cseq-stop" disabled={!mixLoaded} onClick={onStop}>
                <span className="icon fill">stop</span>
              </button>
            </Tooltip>
          </div>

          <div className="cseq-bar-sep" />

          {/* Playback options tucked into a popover: speed, loop, snap, the lane snaps and randomise. */}
          <div className="cseq-bar-group mseq-bar-settings">
            <Tooltip content="Playback options — speed, loop, snap and randomise" placement="top">
              <button type="button" className={`icon-btn cseq-icon${barMenu ? ' on' : ''}`} aria-label="Playback options" aria-expanded={barMenu}
                onPointerDown={(e) => e.stopPropagation()} onClick={() => setBarMenu((v) => !v)}>
                <span className="icon">tune</span>
              </button>
            </Tooltip>
            {barMenu && (
              <div className="mseq-bar-menu" onPointerDown={(e) => e.stopPropagation()}>
                {onSpeed && (
                  <div className="mseq-bar-item mseq-bar-speed">
                    <span className="mseq-bar-label">Playback speed</span>
                    <span className="mseq-speed">
                      <input type="range" className="vol-slider pc-frame-slider" min="10" max="200" step="5"
                        value={Math.round(speed * 100)} style={{ '--fill': `${((Math.round(speed * 100) - 10) / 190) * 100}%` }}
                        onInput={(e) => onSpeed(+e.target.value / 100)} />
                      <span className="mono pc-frame-num">{Math.round(speed * 100)}%</span>
                    </span>
                  </div>
                )}
                {onLoop && (
                  <div className="mseq-bar-item">
                    <label className="switch cseq-switch">
                      <input type="checkbox" checked={!!loop} onChange={(e) => onLoop(e.target.checked)} />
                      <span className="track" />
                      <span className="cseq-switch-label">Loop</span>
                    </label>
                  </div>
                )}
                <div className="mseq-bar-item">
                  <label className="switch cseq-switch">
                    <input type="checkbox" checked={snap} onChange={(e) => toggleSnap(e.target.checked)} />
                    <span className="track" />
                    <span className="cseq-switch-label">Snap</span>
                  </label>
                </div>
                {onSnapLane && LANES.filter((l) => l.id !== 'motion').map((l) => (
                  <button key={l.id} type="button" className="cseq-btn mseq-bar-btn"
                    onClick={() => onSnapLane(l.id)}>
                    <span className="icon" style={{ color: l.color }}>align_horizontal_left</span>Snap {l.label}
                  </button>
                ))}
                {onRandomise && (
                  <button type="button" className="cseq-btn mseq-bar-btn" onClick={() => { onRandomise(); setBarMenu(false); }}>
                    <span className="icon">casino</span>Randomise
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="cseq-bar-sep" />

          <div className="cseq-bar-group">
            <Tooltip content="Help: how the mixer works, and its keys" placement="top">
              <button type="button" className={`icon-btn cseq-icon mseq-help-btn${helpOpen ? ' on' : ''}`} aria-label="Help" aria-expanded={helpOpen}
                onClick={() => setHelpOpen((v) => !v)}>
                <span className="icon">help</span>
              </button>
            </Tooltip>
          </div>

          <span className="cseq-frame mono">
            <b>{shown}</b>
            <span className="cseq-frame-dim"> / {len}</span>
            <span className="cseq-frame-s">{(shown / FPS).toFixed(2)}s</span>
          </span>
          <div className="cseq-bar-group cseq-zoom mseq-zoom-bar">
            <Tooltip content="Zoom out" placement="top">
              <button type="button" className="icon-btn cseq-icon" aria-label="Zoom out" disabled={zoom <= MIN_ZOOM} onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 2))}>
                <span className="icon">zoom_out</span>
              </button>
            </Tooltip>
            <Tooltip content="Zoom in" placement="top">
              <button type="button" className="icon-btn cseq-icon" aria-label="Zoom in" disabled={zoom >= MAX_ZOOM} onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 2))}>
                <span className="icon">zoom_in</span>
              </button>
            </Tooltip>
          </div>
        </div>
          </>
        )}
      </div>

      <div className="cseq-resize" onPointerDown={startResize('w')} onPointerMove={onResizeMove} onPointerUp={endResize} onPointerCancel={endResize} />
      <div className="mseq-resize-v" onPointerDown={startResize('h')} onPointerMove={onResizeMove} onPointerUp={endResize} onPointerCancel={endResize}
        onDoubleClick={() => setSize((s) => ({ ...s, h: null }))} />
      {/* Bottom-right corner: width and height together (the .fx-modal-resize grip). */}
      <div className="mseq-resize-c" onPointerDown={startResize('wh')} onPointerMove={onResizeMove} onPointerUp={endResize} onPointerCancel={endResize} />
      {/* Docked: the bottom is pinned to the app, so the top edge sets the height. */}
      {docked && <div className="mseq-dock-resize" onPointerDown={startResize('ht')} onPointerMove={onResizeMove} onPointerUp={endResize} onPointerCancel={endResize} />}
      {/* Portalled on its own, so none of this window's clipping or stacking holds it. */}
      <MixerHelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>,
    document.body,
  );
}
