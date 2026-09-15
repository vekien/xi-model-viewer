import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Tooltip } from './Tooltip.jsx';
import { Combo } from './Combo.jsx';
import { KEEP_LANE, LANES, LANE_BY_ID, kindOf, opName, recipeLength, trackLabel } from '../js/mixer.js';

// The mixer's timeline as a floating window built from the Camera Sequencer's
// chrome (#camseq / .cseq-*): the same title bar, dragged by it; the same inset
// track with a seconds ruler, one lane per line, the red playhead you drag; the
// same round Play / Stop and frame readout in the bar. Blocks are pills on the
// lane's line. Overlapping pills stack into sub-rows so nothing hides another.
// Everything here edits `events` through the callbacks; Play composes exactly that.

const POS_KEY = 'mixerSeqPos';
const SIZE_KEY = 'mixerSeqSize';
const FPS = 60;                       // routine ticks run at 60/s; the ruler reads seconds
const LANE_H = 25;                    // one lane line (see .cseq-lane)
const RULER_H = 22;
const MIN_W = 700;
const DEFAULT_W = 940;
const MIN_H = 200;
const MAX_H = 700;                    // the window fits its content up to this (see #mixer-seq)
const MIN_LEN = 120;
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

/** Overlapping blocks go into sub-rows, first fit, in start order. */
function stackRows(evs, endOf) {
  const rows = [];      // last end per row
  const rowOf = new Map();
  for (const ev of [...evs].sort((a, b) => a.start - b.start)) {
    let r = rows.findIndex((end) => end <= ev.start);
    if (r < 0) { r = rows.length; rows.push(0); }
    rows[r] = endOf(ev);
    rowOf.set(ev._id, r);
  }
  return { rowOf, count: Math.max(1, rows.length) };
}

/** Peak envelope as one path of vertical bars, one per bin, drawn in a bins×20 box. */
function wavePath(peaks) {
  let d = '';
  for (let i = 0; i < peaks.length; i++) {
    const h = Math.max(0.6, peaks[i] * 9.5);
    d += `M${i + 0.5},${10 - h}V${10 + h}`;
  }
  return d;
}

const HELP = [
  'Space plays or pauses the mix; Space twice stops and rewinds.',
  'Drag the red cursor, or the ruler, to scrub.',
  'Drag a pill to move it; drag a lane label to shift the whole lane.',
  'Drag on empty space to select a group; Ctrl-click adds to it.',
  'Ctrl+D duplicates the selection, Delete removes it, M mutes it.',
  'Click a sound pill’s speaker to hear it.',
];

export function TimelineWindow({
  open, onClose,
  recipeName, note, failed, error, onDismissError,
  events, selectedIds, onSelect, onMoveMany, onShiftLane, onPreview,
  tracks = [], activeTrack = 'motion', sources = {}, onActivateTrack, onAddTrack, onRemoveTrack,
  strike, playhead, mixLoaded, loopEnd = 0, minLen = 0,
  getSoundPeaks = null, ghosts = null,
  transport, canPlay, playTip, onPlayPause, onStop, onSeek,
  speed, onSpeed, loop, onLoop, onSnapLane, viewerRace,
  editor = null,
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

  const startDrag = (e) => {
    if (e.target.closest('button, input, select, a, [role="button"], .cseq-resize, .mseq-resize-v')) return;
    const rect = panelRef.current.getBoundingClientRect();
    if (!pos) setPos({ x: rect.left, y: rect.top });
    panelDrag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPanelDrag = (e) => {
    if (!panelDrag.current) return;
    const el = panelRef.current;
    const w = el?.offsetWidth ?? size.w;
    const h = el?.offsetHeight ?? MIN_H;
    setPos({
      x: clamp(e.clientX - panelDrag.current.dx, 0, Math.max(window.innerWidth - w, 0)),
      y: clamp(e.clientY - panelDrag.current.dy, 0, Math.max(window.innerHeight - h, 0)),
    });
  };
  const endDrag = () => { panelDrag.current = null; };

  // Height fits the content (up to MAX_H, see #mixer-seq). The bottom edge can
  // only pull the window shorter than that — the body then scrolls — never open
  // a gap below the bar; dragging back down past the content lets it go auto.
  const headerRef = useRef(null);
  const bodyRef = useRef(null);
  const naturalH = () => (headerRef.current?.offsetHeight ?? 0) + (bodyRef.current?.scrollHeight ?? 0);
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
    if (r.axis === 'w') {
      setSize((s) => ({ ...s, w: clamp(Math.round(r.w0 + (e.clientX - r.x0)), MIN_W, Math.max(MIN_W, window.innerWidth - 16)) }));
    } else {
      const cap = Math.min(naturalH(), MAX_H, window.innerHeight - 16);
      const h = Math.round(r.h0 + (e.clientY - r.y0));
      setSize((s) => ({ ...s, h: h >= cap ? null : Math.max(MIN_H, h) }));
    }
  };
  const endResize = () => { resizeRef.current = null; };
  // Content that shrank below a remembered height would leave a gap: let go of it.
  useEffect(() => {
    if (!size.h || !open) return;
    if (size.h >= naturalH()) setSize((s) => ({ ...s, h: null }));
  });

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

  const len = Math.max(MIN_LEN, recipeLength(events) + 20, soundEnd + 20, minLen);
  const ticks = rulerTicks(len, FPS, zoom);

  // Each lane's stacking is remembered (collapse from the glyph by the label).
  const [laneRowsOpen, setLaneRowsOpen] = useState(() => readJson('mixerLaneRows') ?? {});
  const toggleLaneRows = (laneId, open) => setLaneRowsOpen((m) => {
    const next = { ...m, [laneId]: open };
    writeJson('mixerLaneRows', next);
    return next;
  });

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
    const own = events.filter((e) => e.from === t.id && e.kind !== 'keep');
    const laneEvents = t.kind === 'keep' ? events.filter((e) => e.kind === 'keep')
      : t.kind === 'sound' && t.first ? [...own, ...ghostEvents]
        : t.kind === 'vfx' && t.first ? [...own, ...ghostGenEvents] : own;
    const minTicks = len * 0.012;
    const endOf = (e) => e.start + (t.kind === 'sound'
      ? (e.op === 0x1e ? 8 : Math.max(soundTicks(e), 8))
      : Math.max(e.dur || 0, minTicks));
    const rows = stackRows(laneEvents, endOf);
    // Overlaps stack open by default; the keep lane (locks, hits, links) starts
    // collapsed — it is bookkeeping, not the mix — until its glyph opens it.
    const stacked = rows.count > 1 && (laneRowsOpen[t.id] ?? (t.kind !== 'keep'));
    return { t, laneEvents, rows, stacked, height: (stacked ? rows.count : 1) * LANE_H };
  });
  const trackH = RULER_H + lanes.reduce((a, l) => a + l.height, 0);

  // ── Pointer work on the track: scrub, block drag, lane shift, marquee ──────
  const trackRef = useRef(null);
  const rootRef = useRef(null);
  const drag = useRef(null);
  const [marquee, setMarquee] = useState(null);   // root-relative px while rubber-banding

  const trackWidth = () => trackRef.current?.clientWidth ?? 300;
  const pxPerFrame = () => trackWidth() / len;
  const frameAt = (clientX) => {
    const r = trackRef.current?.getBoundingClientRect();
    return r?.width ? clamp(((clientX - r.left) / r.width) * len, 0, len) : 0;
  };

  const scrubTo = (clientX) => onSeek?.(Math.round(frameAt(clientX)));
  const startScrub = (e) => {
    e.stopPropagation();
    drag.current = { kind: 'scrub' };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    scrubTo(e.clientX);
  };
  const startDragBlock = (e, ev) => {
    e.stopPropagation();
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    if (additive) { onSelect(ev._id, 'toggle'); return; }
    const inGroup = selectedIds.has(ev._id);
    const ids = inGroup ? selectedIds : new Set([ev._id]);
    if (!inGroup) onSelect(ev._id, 'only');
    const starts = events.filter((x) => ids.has(x._id)).map((x) => ({ id: x._id, start0: x.start }));
    drag.current = { kind: 'block', x0: e.clientX, ev, starts, moved: false, inGroup };
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
    if (d.kind === 'marquee') {
      const root = rootRef.current.getBoundingClientRect();
      setMarquee({ x0: d.p0.x, y0: d.p0.y, x1: e.clientX - root.left, y1: e.clientY - root.top });
      return;
    }
    const frames = Math.round((e.clientX - d.x0) / pxPerFrame());
    if (d.kind === 'block') {
      if (frames) d.moved = true;
      const delta = Math.max(frames, -Math.min(...d.starts.map((s) => s.start0)));
      onMoveMany(d.starts.map((s) => ({ id: s.id, start: s.start0 + delta })));
    } else if (d.kind === 'lane') {
      const delta = frames - d.moved;
      if (delta) { onShiftLane(d.lane, delta); d.moved = frames; }
    }
  };
  const endPointer = (e) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'marquee') {
      setMarquee(null);
      const [x0, x1] = [Math.min(d.x0, e.clientX), Math.max(d.x0, e.clientX)];
      const [y0, y1] = [Math.min(d.y0, e.clientY), Math.max(d.y0, e.clientY)];
      const [f0, f1] = [frameAt(x0), frameAt(x1)];
      const hit = [];
      for (const row of rootRef.current.querySelectorAll('.mseq-lane')) {
        const r = row.getBoundingClientRect();
        if (r.bottom < y0 || r.top > y1) continue;
        const laneId = row.dataset.lane;
        for (const ev of events) {
          const inLane = laneId === 'keep' ? ev.kind === 'keep' : (ev.from === laneId && ev.kind !== 'keep');
          if (inLane && ev.start >= f0 && ev.start <= f1) hit.push(ev._id);
        }
      }
      onSelect(hit, d.additive ? 'add' : 'set');
      return;
    }
    if (d.kind === 'block' && !d.moved) {
      if (d.inGroup) onSelect(d.ev._id, 'only');
      if (isSoundEvent(d.ev)) onPreview?.(d.ev);
    }
  };

  // ── Pills ───────────────────────────────────────────────────────────────────
  const x = (f) => `${(f / len) * 100}%`;
  const pill = (ev, lane) => {
    const { t, rows, stacked } = lane;
    const row = stacked ? (rows.rowOf.get(ev._id) ?? 0) : 0;
    const top = row * LANE_H + LANE_H / 2;
    const color = (t.kind === 'keep' ? KEEP_LANE : LANE_BY_ID.get(kindOf(ev.from)) ?? KEEP_LANE).color;
    const state = `${selectedIds.has(ev._id) ? ' on' : ''}${ev.enabled === false ? ' off' : ''}`;
    if (ev.ghost && t.kind === 'vfx') {
      return (
        <Tooltip key={ev._id} content={`${ev.count} generator${ev.count === 1 ? '' : 's'} via shared routine ${ev.via} @${ev.start} — the game runs this from ROM/0/0.DAT; mute or move the ${ev.via} link to change it`}>
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
    if (t.kind === 'sound') {
      const pk = peaks.get(soundIdOf(ev));
      return (
        <Tooltip key={ev._id} content={`${opName(ev.op)} ${ev.ref ?? ''} @${ev.start}${pk ? ` · ${pk.seconds.toFixed(2)}s` : ''} · click the speaker to hear it${ev.enabled === false ? ' · muted (M to unmute)' : ''}`}>
          <span className={`mseq-pill wave${state}`} style={{ left: x(ev.start), width: `${Math.max(2.4, (soundTicks(ev) / len) * 100)}%`, background: color, top }}
            onPointerDown={(e) => startDragBlock(e, ev)}>
            <span className="icon mseq-spk" role="button" aria-label="Play this sound"
              onPointerDown={(e) => { e.stopPropagation(); onPreview?.(ev); }}>{ev.enabled === false ? 'volume_off' : 'volume_up'}</span>
            {pk?.peaks && <svg className="mseq-wave" viewBox={`0 0 ${pk.peaks.length} 20`} preserveAspectRatio="none"><path d={wavePath(pk.peaks)} stroke="#fff" strokeWidth="0.75" strokeOpacity="0.9" fill="none" /></svg>}
            <span className="mseq-wave-label">{ev.ref ?? opName(ev.op)}</span>
          </span>
        </Tooltip>
      );
    }
    return (
      <Tooltip key={ev._id} content={`${opName(ev.op)} ${ev.ref ?? ''} @${ev.start}${ev.dur ? ` for ${ev.dur}` : ''}`}>
        <span className={`mseq-pill${state}`} style={{ left: x(ev.start), width: `${Math.max(1.2, ((ev.dur || 0) / len) * 100)}%`, background: color, top }}
          onPointerDown={(e) => startDragBlock(e, ev)}>{ev.ref ?? opName(ev.op)}</span>
      </Tooltip>
    );
  };

  const shown = clamp(Math.round(playhead ?? 0), 0, len);
  const playing = transport === 'playing';
  const style = {
    width: size.w,
    ...(size.h ? { height: size.h } : null),
    ...(pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : null),
  };

  if (!open) return null;
  return createPortal(
    <div id="mixer-seq" className="panel" ref={panelRef} style={style}>
      <div className="cseq-header" ref={headerRef} onPointerDown={startDrag} onPointerMove={onPanelDrag} onPointerUp={endDrag}>
        <span className="icon">timeline</span>
        <span className="cseq-title">Timeline</span>
        <span className="mono mseq-name">{recipeName}</span>
        <span className={`mseq-note${failed ? ' is-failed' : ''}`}>{failed ? error?.title : note}</span>
        <Tooltip content="Close (the Ability Mixer panel's timeline glyph brings it back)" placement="left">
          <button type="button" className="icon-btn cseq-close" onClick={onClose} aria-label="Close">
            <span className="icon">close</span>
          </button>
        </Tooltip>
      </div>

      <div className="cseq-body" ref={bodyRef}>
        {failed && (
          <div className="form-error mseq-error" role="alert">
            <span className="icon">error</span>
            <span><b>{error.title}</b>{error.text}</span>
            <Tooltip content="Dismiss">
              <button type="button" className="pc-tbtn" aria-label="Dismiss" onClick={onDismissError}><span className="icon">close</span></button>
            </Tooltip>
          </div>
        )}

        {/* Above the track, the sequencer's settings row: add a track on the left, zoom on the right */}
        <div className="cseq-row cseq-settings mseq-toolbar">
          <span className="cseq-label">Add track</span>
          <div className="cseq-load mseq-add-track">
            <Combo value="" items={LANES.map((l) => ({ id: l.id, label: l.label, color: l.color }))} placeholder="Motion, Effects, Sound…"
              onChange={(kind) => kind && onAddTrack?.(kind)} />
          </div>
          <div className="cseq-bar-group cseq-zoom">
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

        {/* The inset track: labels on the left, the scrolling ruler and lanes on the right */}
        <div className="cseq-tl mseq-tl" style={{ height: trackH + 8 }} ref={rootRef} onPointerMove={onPointerMove} onPointerUp={endPointer} onPointerCancel={endPointer}>
          <div className="cseq-tl-labels">
            <div className="cseq-tl-spacer" />
            {lanes.map(({ t, rows, stacked, height }) => (
              <div key={t.id}
                className={`cseq-tl-label mseq-label${t.kind === 'keep' ? '' : ' track'}${t.id === activeTrack ? ' active' : ''}`}
                style={{ height, color: t.color }}
                onClick={() => t.kind !== 'keep' && onActivateTrack?.(t.id)}>
                <Tooltip content={t.kind === 'keep' ? 'Drag to shift the lane'
                  : `${sources[t.id]?.name ? `${sources[t.id].name} · ` : ''}click: a pick lands on this track · drag: shift it`}>
                  <span className="mseq-label-text" onPointerDown={(e) => startLaneDrag(e, t.id)}>
                    {t.label}
                    {sources[t.id]?.name && <i className="mseq-label-src">{sources[t.id].name}</i>}
                  </span>
                </Tooltip>
                {rows.count > 1 && (
                  <Tooltip content={stacked ? `Collapse to one row (${rows.count} rows of overlapping pills)` : `Expand overlapping pills into ${rows.count} rows`}>
                    <button type="button" className="mseq-rows" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); toggleLaneRows(t.id, !stacked); }}>
                      <span className="icon">{stacked ? 'unfold_less' : 'unfold_more'}</span>{rows.count}
                    </button>
                  </Tooltip>
                )}
                {t.kind !== 'keep' && (sources[t.id] || !t.first) && (
                  <Tooltip content={t.first ? 'Clear this track' : 'Remove this track'}>
                    <button type="button" className="mseq-x" aria-label="Remove" onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); onRemoveTrack?.(t.id); }}><span className="icon">close</span></button>
                  </Tooltip>
                )}
              </div>
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
                <div key={lane.t.id} className="cseq-lane mseq-lane" data-lane={lane.t.id} style={{ height: lane.height }} onPointerDown={startMarquee}>
                  {lane.laneEvents.map((ev) => pill(ev, lane))}
                </div>
              ))}
              {/* Strike (first hit), loop end and the shaded run past it, then the playhead */}
              {strike != null && <span className="mseq-strike" style={{ left: x(strike) }} />}
              {loopEnd > 0 && loopEnd < len && (
                <>
                  <span className="mseq-past-loop" style={{ left: x(loopEnd), width: `${((len - loopEnd) / len) * 100}%` }} />
                  <Tooltip content="Loop restart — the motion/effect routine's end. Sounds after here keep ringing past the restart (one-shots aren't waited for), just like in game.">
                    <span className="mseq-loopend" style={{ left: x(loopEnd) }}><i>⟲ loop</i></span>
                  </Tooltip>
                </>
              )}
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

          <div className="cseq-bar-group cseq-toggles">
            {onSpeed && (
              <Tooltip content="Playback speed of the stage (effect, sound and motion together)" placement="top">
                <span className="mseq-speed">
                  <input type="range" className="vol-slider pc-frame-slider" min="10" max="200" step="5"
                    value={Math.round(speed * 100)} style={{ '--fill': `${((Math.round(speed * 100) - 10) / 190) * 100}%` }}
                    onInput={(e) => onSpeed(+e.target.value / 100)} />
                  <span className="mono pc-frame-num">{Math.round(speed * 100)}%</span>
                </span>
              </Tooltip>
            )}
            {onLoop && (
              <Tooltip content="Loop: the mix restarts when it ends (off: it parks at its end)" placement="top">
                <label className="switch cseq-switch">
                  <input type="checkbox" checked={!!loop} onChange={(e) => onLoop(e.target.checked)} />
                  <span className="track" />
                  <span className="cseq-switch-label">Loop</span>
                </label>
              </Tooltip>
            )}
          </div>

          <div className="cseq-bar-sep" />

          <div className="cseq-bar-group">
            {LANES.filter((l) => l.id !== 'motion').map((l) => (
              <Tooltip key={l.id} content={`Snap the ${l.label.toLowerCase()} lane to the strike frame (its first generator lands on f${strike})`} placement="top">
                <button type="button" className="icon-btn cseq-icon" aria-label={`Snap ${l.label}`} style={{ color: l.color }} onClick={() => onSnapLane(l.id)}>
                  <span className="icon">align_horizontal_left</span>
                </button>
              </Tooltip>
            ))}
            <Tooltip content={<div className="mseq-help">{HELP.map((h) => <div key={h}>{h}</div>)}</div>} placement="top" interactive>
              <button type="button" className="icon-btn cseq-icon" aria-label="Help">
                <span className="icon">help</span>
              </button>
            </Tooltip>
          </div>

          <span className="cseq-frame mono">
            <b>{shown}</b>
            <span className="cseq-frame-dim"> / {len}</span>
            <span className="cseq-frame-s">{(shown / FPS).toFixed(2)}s</span>
            {viewerRace && <span className="cseq-frame-dim mseq-race"> · {viewerRace}</span>}
          </span>
        </div>
      </div>

      <div className="cseq-resize" onPointerDown={startResize('w')} onPointerMove={onResizeMove} onPointerUp={endResize} onPointerCancel={endResize} />
      <div className="mseq-resize-v" onPointerDown={startResize('h')} onPointerMove={onResizeMove} onPointerUp={endResize} onPointerCancel={endResize}
        onDoubleClick={() => setSize((s) => ({ ...s, h: null }))} />
    </div>,
    document.body,
  );
}
