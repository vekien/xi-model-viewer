import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Tooltip } from './Tooltip.jsx';
import {
  KEEP_LANE, LANES, LANE_BY_ID, opName, recipeLength, shiftLane, strikeFrame, withIds,
} from '../js/mixer.js';

// The mixer's working surface: the recipe as lanes on a frame timeline, the parts of
// the source under the cursor (solo / take), and the selected event's numbers.
// Everything here edits `recipe.events`; Play composes exactly that.

const TRACKS = [...LANES, KEEP_LANE];
const MIN_LEN = 120;

/** The sound id an event plays, recorded from the inspector (the pointer's name is
 *  not the id: Raging Rush's `8049` plays se018049, so no guessing from digits). */
const soundIdOf = (ev) => ev.sound ?? null;
const isSoundEvent = (ev) => ev.kind === 'sound' || ev.from === 'sound';
const SOUND_ROW = 26;   // px per sub-row of the docked sound lane

/** Overlapping sound blocks go into sub-rows, first fit, in start order. */
function soundRows(evs, endOf) {
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

/** Peak envelope as one path of vertical bars, drawn in a 96×20 box. */
function wavePath(peaks) {
  let d = '';
  for (let i = 0; i < peaks.length; i++) {
    const h = Math.max(0.6, peaks[i] * 9.5);
    d += `M${i + 0.5},${10 - h}V${10 + h}`;
  }
  return d;
}

function Timeline({ events, selectedIds, onSelect, onMoveMany, onShiftLane, onPreview, strike, playhead, minLen = 0, loopEnd = 0, big = false, getSoundPeaks = null, ghosts = null }) {
  const ghostSounds = ghosts?.sounds ?? [];
  const ghostGens = ghosts?.gens ?? [];
  // Overlapping blocks stack into sub-rows (first fit) so nothing hides another —
  // an effects lane can carry thirty generators on one tick. Each lane can be
  // collapsed back to one row from the chevron on its label; remembered.
  const [laneRowsOpen, setLaneRowsOpen] = useState(() => { try { return JSON.parse(localStorage.getItem('mixerLaneRows') || '{}'); } catch { return {}; } });
  const toggleLaneRows = (laneId) => setLaneRowsOpen((m) => {
    const next = { ...m, [laneId]: m[laneId] === false };
    try { localStorage.setItem('mixerLaneRows', JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  });
  // Sounds the linked shared routines (mdam, eis1, proc…) add: shown in the sound
  // lane as read-only ghosts so what plays is what the timeline shows. They move
  // with their link block (in the links lane) and go with it when it is muted.
  const ghostEvents = useMemo(() => (big ? ghostSounds.map((g, i) => ({
    _id: `ghost:${i}`, from: 'sound', kind: 'sound', op: 0x0a, ref: g.ref, start: g.start, sound: g.sound, ghost: true, via: g.via,
  })) : []), [ghostSounds, big]);
  // Generators a linked shared routine spawns: one hatched block per link in the
  // effects lane, spanning the window its generators emit over.
  const ghostGenEvents = useMemo(() => (big ? ghostGens.map((g, i) => ({
    _id: `ghostg:${i}`, from: 'vfx', kind: 'vfx', op: 0x02, ref: g.via, start: g.start, dur: Math.max(g.end - g.start, 4), ghost: true, via: g.via, count: g.count,
  })) : []), [ghostGens, big]);
  // Sound lengths (docked view only): sound id -> { seconds, peaks } | null.
  const [peaks, setPeaks] = useState(() => new Map());
  const pending = useRef(new Set());
  useEffect(() => {
    if (!big || !getSoundPeaks) return;
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
  }, [big, events, ghostEvents, peaks, getSoundPeaks]);
  const soundTicks = (ev) => (big ? Math.round((peaks.get(soundIdOf(ev))?.seconds ?? 0) * 60) : 0);
  const soundEnd = Math.max(0, ...[...events.filter(isSoundEvent), ...ghostEvents].map((e) => e.start + soundTicks(e)));

  const len = Math.max(MIN_LEN, recipeLength(events) + 20, soundEnd + 20, minLen);
  const railRef = useRef(null);
  const rootRef = useRef(null);
  const drag = useRef(null);
  const [marquee, setMarquee] = useState(null);   // root-relative px while rubber-banding

  const pxPerFrame = () => (railRef.current?.clientWidth ?? 300) / len;
  const frameAt = (clientX) => {
    const r = railRef.current?.getBoundingClientRect();
    return r?.width ? ((clientX - r.left) / r.width) * len : 0;
  };

  // A press on a block of the current selection drags the whole group; on any
  // other block it selects that block alone. Ctrl/shift toggles membership.
  const startDrag = (e, ev) => {
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
  // Empty rail: rubber-band a region. Blocks whose start lies inside it, on
  // every lane the band crosses, become the selection.
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
    if (d.kind === 'marquee') {
      const root = rootRef.current.getBoundingClientRect();
      setMarquee({ x0: d.p0.x, y0: d.p0.y, x1: e.clientX - root.left, y1: e.clientY - root.top });
      return;
    }
    const frames = Math.round((e.clientX - d.x0) / pxPerFrame());
    if (d.kind === 'block') {
      if (frames) d.moved = true;
      // Clamp the group as one so its spacing survives the left edge.
      const delta = Math.max(frames, -Math.min(...d.starts.map((s) => s.start0)));
      onMoveMany(d.starts.map((s) => ({ id: s.id, start: s.start0 + delta })));
    } else if (d.kind === 'lane') {
      const delta = frames - d.moved;
      if (delta) { onShiftLane(d.lane, delta); d.moved = frames; }
    }
  };
  const endDrag = (e) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'marquee') {
      setMarquee(null);
      const [x0, x1] = [Math.min(d.x0, e.clientX), Math.max(d.x0, e.clientX)];
      const [y0, y1] = [Math.min(d.y0, e.clientY), Math.max(d.y0, e.clientY)];
      const [f0, f1] = [frameAt(x0), frameAt(x1)];
      const hit = [];
      for (const row of rootRef.current.querySelectorAll('.mixer-track')) {
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
      if (d.inGroup) onSelect(d.ev._id, 'only');   // a plain click inside a group narrows to that block
      // A click (no drag) on a sound block auditions it.
      if (d.ev.kind === 'sound' || d.ev.from === 'sound') onPreview?.(d.ev);
    }
  };

  const ticks = [];
  const step = len > 600 ? 100 : len > 240 ? 50 : 30;
  for (let f = 0; f <= len; f += step) ticks.push(f);

  return (
    <div className="mixer-timeline" ref={rootRef} onPointerMove={onPointerMove} onPointerUp={endDrag}
      onPointerLeave={() => { if (drag.current?.kind !== 'marquee') drag.current = null; }}>
      <div className="mixer-ruler">
        <span className="mixer-track-label" />
        <div className="mixer-rail" ref={railRef}>
          {ticks.map((f) => (
            <span key={f} className="mixer-tick" style={{ left: `${(f / len) * 100}%` }}>{f}</span>
          ))}
          {loopEnd > 0 && loopEnd < len && (
            <Tooltip content="Loop restart — the motion/effect routine's end. Sounds after here keep ringing past the restart (one-shots aren't waited for), just like in game.">
              <span className="mixer-loop-label" style={{ left: `${(loopEnd / len) * 100}%` }}>⟲ loop</span>
            </Tooltip>
          )}
        </div>
      </div>
      {TRACKS.map((t) => {
        const own = events.filter((e) => e.from === t.id && e.kind !== 'keep');
        const laneEvents = t.id === 'keep' ? events.filter((e) => e.kind === 'keep')
          : t.id === 'sound' ? [...own, ...ghostEvents]
            : t.id === 'vfx' ? [...own, ...ghostGenEvents] : own;
        const waves = big && t.id === 'sound';
        // A block's footprint in ticks: its duration, or the minimum drawn width.
        const minTicks = len * 0.012;
        const endOf = (e) => e.start + (t.id === 'sound'
          ? (e.op === 0x1e ? 8 : Math.max(soundTicks(e), 8))
          : Math.max(e.dur || 0, minTicks));
        const rows = big ? soundRows(laneEvents, endOf) : { rowOf: new Map(), count: 1 };
        const stacked = big && rows.count > 1 && laneRowsOpen[t.id] !== false;
        const rowOf = (ev) => (stacked ? (rows.rowOf.get(ev._id) ?? 0) : 0);
        const railStyle = stacked ? { height: rows.count * SOUND_ROW + 6 } : undefined;
        return (
          <div className="mixer-track" key={t.id} data-lane={t.id}>
            <span className="mixer-track-labelcell">
              <Tooltip content={`Drag to shift the whole ${t.label.toLowerCase()} lane`}>
                <span className="mixer-track-label" style={{ color: t.color }}
                  onPointerDown={(e) => startLaneDrag(e, t.id)}>{t.label}</span>
              </Tooltip>
              {big && rows.count > 1 && (
                <Tooltip content={stacked ? `Collapse to one row (${rows.count} rows of overlapping blocks)` : `Expand overlapping blocks into ${rows.count} rows`}>
                  <button type="button" className="mixer-lane-toggle" onPointerDown={(e) => e.stopPropagation()} onClick={() => toggleLaneRows(t.id)}>
                    <span className="icon">{stacked ? 'unfold_less' : 'unfold_more'}</span>{rows.count}
                  </button>
                </Tooltip>
              )}
            </span>
            <div className="mixer-rail" onPointerDown={startMarquee} style={railStyle}>
              {strike != null && <span className="mixer-strike" style={{ left: `${(strike / len) * 100}%` }} />}
              {/* Loop restart point: the routine's own end. Sounds are fire-and-forget
                  one-shots, so a block drawn past here keeps ringing after the mix
                  restarts, exactly as in game — shade that zone and mark the line. */}
              {loopEnd > 0 && loopEnd < len && (
                <>
                  <span className="mixer-past-loop" style={{ left: `${(loopEnd / len) * 100}%`, width: `${((len - loopEnd) / len) * 100}%` }} />
                  <span className="mixer-loopend" style={{ left: `${(loopEnd / len) * 100}%` }} />
                </>
              )}
              {playhead != null && <span className="mixer-playhead" style={{ left: `${(Math.min(playhead, len) / len) * 100}%` }} />}
              {laneEvents.map((ev) => {
                const color = (t.id === 'keep' ? KEEP_LANE : LANE_BY_ID.get(ev.from) ?? KEEP_LANE).color;
                if (ev.ghost && t.id === 'vfx') {
                  const w = Math.max(1.2, ((ev.dur || 0) / len) * 100);
                  return (
                    <span key={ev._id} className="mixer-block ghost fx"
                      style={{ left: `${(ev.start / len) * 100}%`, width: `${w}%`, ...(stacked ? { top: 3 + rowOf(ev) * SOUND_ROW, height: SOUND_ROW - 4 } : {}) }}
                      title={`${ev.count} generator${ev.count === 1 ? '' : 's'} via shared routine ${ev.via} @${ev.start} — the game runs this from ROM/0/0.DAT; mute or move the ${ev.via} link to change it`}>
                      <span className="icon mixer-spk">link</span> {ev.via} · {ev.count} gen{ev.count === 1 ? '' : 's'}
                    </span>
                  );
                }
                if (waves && ev.ghost) {
                  const pk = peaks.get(soundIdOf(ev));
                  const ticks = soundTicks(ev);
                  const w = Math.max(2.4, (ticks / len) * 100);
                  const row = rowOf(ev);
                  return (
                    <span key={ev._id} className="mixer-block wave ghost"
                      style={{ left: `${(ev.start / len) * 100}%`, width: `${w}%`, top: 3 + row * SOUND_ROW, height: SOUND_ROW - 4 }}
                      title={`${ev.ref} via shared routine ${ev.via} @${ev.start}${pk ? ` · ${pk.seconds.toFixed(2)}s` : ''} — the game plays this from ROM/0/0.DAT; mute or move the ${ev.via} link to change it`}>
                      <span className="icon mixer-spk">link</span>
                      {pk?.peaks && (
                        <svg className="mixer-wave" viewBox="0 0 96 20" preserveAspectRatio="none">
                          <path d={wavePath(pk.peaks)} stroke="#0d1012" strokeWidth="0.9" fill="none" />
                        </svg>
                      )}
                      <span className="mixer-wave-label">{ev.via} · {ev.ref}</span>
                    </span>
                  );
                }
                if (waves && ev.op === 0x1e) {
                  // DampenGenerator: the cut that ends a sustained audio generator —
                  // a marker, not a sound of its own.
                  const row = rowOf(ev);
                  return (
                    <span key={ev._id}
                      className={`mixer-block${selectedIds.has(ev._id) ? ' on' : ''}${ev.enabled === false ? ' off' : ''}`}
                      style={{ left: `${(ev.start / len) * 100}%`, width: '2.4%', background: color, top: 3 + row * SOUND_ROW, height: SOUND_ROW - 4, opacity: 0.7 }}
                      onPointerDown={(e) => startDrag(e, ev)}
                      title={`Stop ${ev.ref} @${ev.start} — ends the sustained sound`}>
                      ■ stop {ev.ref}
                    </span>
                  );
                }
                if (waves) {
                  const pk = peaks.get(soundIdOf(ev));
                  const ticks = soundTicks(ev);
                  const w = Math.max(2.4, (ticks / len) * 100);
                  const row = rowOf(ev);
                  return (
                    <span key={ev._id}
                      className={`mixer-block wave${selectedIds.has(ev._id) ? ' on' : ''}${ev.enabled === false ? ' off' : ''}`}
                      style={{ left: `${(ev.start / len) * 100}%`, width: `${w}%`, background: color, top: 3 + row * SOUND_ROW, height: SOUND_ROW - 4 }}
                      onPointerDown={(e) => startDrag(e, ev)}
                      title={`${opName(ev.op)} ${ev.ref ?? ''} @${ev.start}${pk ? ` · ${pk.seconds.toFixed(2)}s` : ''}`}>
                      <span className="icon mixer-spk" title={ev.enabled === false ? 'Muted (M to unmute) · click to play' : 'Play this sound'}
                        onPointerDown={(e) => { e.stopPropagation(); onPreview?.(ev); }}>{ev.enabled === false ? 'volume_off' : 'volume_up'}</span>
                      {pk?.peaks && (
                        <svg className="mixer-wave" viewBox="0 0 96 20" preserveAspectRatio="none">
                          <path d={wavePath(pk.peaks)} stroke="#0d1012" strokeWidth="0.9" fill="none" />
                        </svg>
                      )}
                      <span className="mixer-wave-label">{ev.ref ?? opName(ev.op)}</span>
                    </span>
                  );
                }
                const w = Math.max(1.2, ((ev.dur || 0) / len) * 100);
                return (
                  <span key={ev._id}
                    className={`mixer-block${selectedIds.has(ev._id) ? ' on' : ''}${ev.enabled === false ? ' off' : ''}`}
                    style={{ left: `${(ev.start / len) * 100}%`, width: `${w}%`, background: color, ...(stacked ? { top: 3 + rowOf(ev) * SOUND_ROW, height: SOUND_ROW - 4 } : {}) }}
                    onPointerDown={(e) => startDrag(e, ev)}
                    title={`${opName(ev.op)} ${ev.ref ?? ''} @${ev.start}${ev.dur ? ` for ${ev.dur}` : ''}`}>
                    {ev.ref ?? opName(ev.op)}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
      {marquee && (
        <div className="mixer-marquee" style={{
          left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1),
          width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0),
        }} />
      )}
    </div>
  );
}

/** Play/pause plus a frame slider over the mix. Polls the stage's playhead while
 *  it runs; dragging seeks (which pauses). */
function Scrubber({ onSeek, getPlayhead, fallbackLen }) {
  const [head, setHead] = useState({ frame: 0, length: 0 });
  useEffect(() => {
    const id = setInterval(() => setHead(getPlayhead()), 50);
    return () => clearInterval(id);
  }, [getPlayhead]);
  const len = Math.max(1, Math.round(head.length || fallbackLen || 1));
  const frame = Math.min(len, Math.round(head.frame));
  const step = (d) => onSeek(Math.min(len, Math.max(0, frame + d)));
  return (
    <div className="mixer-scrub">
      <Tooltip content="Back one frame"><button type="button" className="icon-btn" onClick={() => step(-1)}><span className="icon">chevron_left</span></button></Tooltip>
      <input type="range" min={0} max={len} value={frame} className="mixer-scrub-range"
        onChange={(e) => { console.info('[mixer] seek', e.target.value); onSeek(Number(e.target.value)); }} />
      <Tooltip content="Forward one frame"><button type="button" className="icon-btn" onClick={() => step(1)}><span className="icon">chevron_right</span></button></Tooltip>
      <span className="mono mixer-scrub-num">{String(frame).padStart(3, '0')} / {len}</span>
    </div>
  );
}

function Num({ label, value, onChange, min = 0 }) {
  return (
    <label className="mixer-field">
      <span>{label}</span>
      <input type="number" min={min} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
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
        <Tooltip content={ev.enabled === false ? 'Include in the recipe' : 'Leave out of the recipe'}>
          <button type="button" className="icon-btn" onClick={() => onChange({ enabled: ev.enabled === false })}>
            <span className="icon">{ev.enabled === false ? 'visibility_off' : 'visibility'}</span>
          </button>
        </Tooltip>
        <Tooltip content="Remove">
          <button type="button" className="icon-btn" onClick={onRemove}><span className="icon">delete</span></button>
        </Tooltip>
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
function Parts({ lane, entry, info, events, onSolo, onPlaySound, onTake }) {
  if (!entry) return null;
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
      {lane === 'motion' && clipRows.map((c) => (
        <div className="mixer-part" key={`c${c.ref}${c.start}`}>
          <span className="mono">{c.ref}</span>
          <span className="mono-small">f{c.start}{c.dur ? ` · ${c.dur}` : ''}</span>
          <span className="mixer-part-note mono-small">{c.summary}</span>
        </div>
      ))}
      {lane !== 'sound' && genRows.map((g) => (
        <div className="mixer-part" key={`g${g.ref}${g.start ?? ''}`}>
          <Tooltip content="Play only this generator on the stage (Play mix brings the mix back)">
            <button type="button" className="icon-btn" onClick={() => onSolo(g.ref)}><span className="icon">play_arrow</span></button>
          </Tooltip>
          <span className="mono">{g.ref}</span>
          <span className="mono-small">{g.start != null ? `f${g.start}` : ''}{g.dur ? ` · ${g.dur}` : ''}{g.sound ? ` · ♪ ${g.sound}` : ''}</span>
          <label className="mixer-take">
            <input type="checkbox" checked={taken.has(g.ref)} onChange={(e) => onTake(lane, g.ref, e.target.checked)} />take
          </label>
        </div>
      ))}
      {lane === 'sound' && [...soundRows, ...audioRows].map((s) => (
        <div className="mixer-part" key={`s${s.ref}${s.start ?? ''}`}>
          <Tooltip content="Play this sound">
            <button type="button" className="icon-btn" onClick={() => onPlaySound(s)}><span className="icon">volume_up</span></button>
          </Tooltip>
          <span className="mono">{s.ref}</span>
          <span className="mono-small">{s.sound ?? (s.id != null ? `se${String(s.id).padStart(6, '0')}` : '')}{s.title ? ` · ${s.title}` : ''}{s.start != null ? ` · f${s.start}` : ''}</span>
          <label className="mixer-take">
            <input type="checkbox" checked={taken.has(s.ref)} onChange={(e) => onTake(lane, s.ref, e.target.checked)} />take
          </label>
        </div>
      ))}
    </div>
  );
}

/** One saved recipe in the organizer: open, rename (inline), duplicate, delete (two-step). */
function RecipeRow({ r, current, onStage, onOpen, onRename, onDuplicate, onDelete }) {
  const [mode, setMode] = useState(null);   // null | 'rename' | 'delete'
  const [draft, setDraft] = useState(r.name);
  const ref = useRef(null);
  useEffect(() => { if (mode === 'rename') { ref.current?.focus(); ref.current?.select?.(); } }, [mode]);
  const srcs = ['motion', 'vfx', 'sound'].map((l) => r.sources?.[l]?.name ?? r.sources?.[l]?.spec).filter(Boolean).join(' · ');
  const stop = (e) => { e.stopPropagation(); };
  return (
    <div className={`mixer-recipe-row${current ? ' on' : ''}${mode ? ' busy' : ''}`} onClick={() => !mode && onOpen(r.name)}
      title={current ? 'Open in the editor' : 'Click to open'}>
      <div className="mixer-recipe-main">
        {mode === 'rename'
          ? (
            <form className="mixer-save" onClick={stop} onSubmit={(e) => { e.preventDefault(); onRename(r.name, draft); setMode(null); }}>
              <input ref={ref} value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value.replace(/[^A-Za-z0-9_-]/g, '_'))}
                onKeyDown={(e) => { if (e.key === 'Escape') setMode(null); }} />
              <button type="submit" className="icon-btn"><span className="icon">check</span></button>
              <button type="button" className="icon-btn" onClick={() => setMode(null)}><span className="icon">close</span></button>
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
        {mode === 'delete'
          ? (
            <>
              <button type="button" className="mixer-chip danger" onClick={() => { onDelete(r.name); setMode(null); }}>delete {r.name}</button>
              <button type="button" className="mixer-chip" onClick={() => setMode(null)}>keep</button>
            </>
          )
          : (
            <>
              <Tooltip content="Rename"><button type="button" className="icon-btn" onClick={() => { setDraft(r.name); setMode('rename'); }}><span className="icon">edit</span></button></Tooltip>
              <Tooltip content="Duplicate"><button type="button" className="icon-btn" onClick={() => onDuplicate(r.name)}><span className="icon">content_copy</span></button></Tooltip>
              <Tooltip content="Delete"><button type="button" className="icon-btn" onClick={() => setMode('delete')}><span className="icon">delete</span></button></Tooltip>
            </>
          )}
      </span>
    </div>
  );
}

export function MixerPanel({
  recipe, onRecipe, lane, laneInfo, laneEntry,
  transport, onPlay, onStop, onPublish, onSaveAs, onOpen, onReset, recipes, busy, note,
  onDelete, onRename, onDuplicate, onShuffle, stageName,
  onPause, onResume, onSeek, getPlayhead, mixLoaded, mixDirty,
  onSolo, onPlaySound, onTake, viewerRace, onClose, getSoundPeaks, speed = 1, onSpeed, loop = true, onLoop, ghosts = null,
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

  // The timeline lives in a dock along the bottom of the stage (After Effects
  // style); the side panel is the recipe: name, save, publish, the organizer,
  // and the parts of the picked source. The dock collapses to its header for a
  // stage-only view and remembers its height.
  const [dockOpen, setDockOpen] = useState(() => { try { return localStorage.getItem('mixerDockOpen') !== '0'; } catch { return true; } });
  const [dockH, setDockH] = useState(() => { try { return Number(localStorage.getItem('mixerDockH')) || 300; } catch { return 300; } });
  const toggleDock = () => setDockOpen((o) => { try { localStorage.setItem('mixerDockOpen', o ? '0' : '1'); } catch { /* private mode */ } return !o; });
  // The picker (#tree) and the right-hand stacks reach the bottom of the window;
  // they stop above the dock (app.css: body.mixer-docked, --mixer-dock).
  useEffect(() => {
    document.body.classList.add('mixer-docked');
    document.documentElement.style.setProperty('--mixer-dock', `${dockOpen ? dockH : 40}px`);
    return () => document.body.classList.remove('mixer-docked');
  }, [dockOpen, dockH]);
  const startDockResize = (e) => {
    const h0 = dockH; const y0 = e.clientY;
    const clamp = (h) => Math.max(160, Math.min(window.innerHeight - 160, h));
    const move = (ev) => setDockH(clamp(h0 + (y0 - ev.clientY)));
    const up = (ev) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      try { localStorage.setItem('mixerDockH', String(clamp(h0 + (y0 - ev.clientY)))); } catch { /* private mode */ }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

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
  // Keyboard transport and editing. Capture phase + stopPropagation so the
  // Characters view's own Space toggle (App) does not also fire.
  const spaceAt = useRef(0);
  useEffect(() => {
    const typing = (t) => /^(input|select|textarea)$/i.test(t?.tagName) || t?.isContentEditable;
    const onKey = (e) => {
      if (typing(e.target)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        if (!selectedIds.size) return;
        e.preventDefault(); e.stopPropagation();
        duplicateMany(selectedIds);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size) {
        e.preventDefault(); e.stopPropagation();
        removeMany(selectedIds);
      } else if (e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.altKey && !e.metaKey && selectedIds.size) {
        e.preventDefault(); e.stopPropagation();
        toggleMute(selectedIds);
      } else if ((e.code === 'Space' || e.key === ' ') && !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault(); e.stopPropagation();
        e.target?.blur?.();   // a focused Play button would "click" again on keyup
        const now = performance.now();
        const twice = now - spaceAt.current < 400;
        spaceAt.current = twice ? 0 : now;
        if (twice) { if (mixLoaded) onSeek?.(0); return; }   // stop: rewound, paused at f0
        if (!mixLoaded) { if (!busy && events.length) onPlay?.(); return; }
        if (transport === 'playing') onPause?.(); else onResume?.();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
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
  const [shuffleKind, setShuffleKind] = useState('ws');
  const [overwrite, setOverwrite] = useState(null);
  const saveRef = useRef(null);
  useEffect(() => { if (saving) { saveRef.current?.focus(); saveRef.current?.select?.(); } }, [saving]);
  const beginSave = () => { setSaveName(recipe.name); setOverwrite(null); setSaving(true); };
  const commitSave = () => {
    const name = saveName.trim();
    if (!name) { setSaving(false); return; }
    if (name !== recipe.name && (recipes ?? []).some((r) => r.name === name) && overwrite !== name) { setOverwrite(name); return; }
    onSaveAs?.(name);
    setSaving(false);
    setOverwrite(null);
  };

  const statusNote = busy ? 'working…' : (mixLoaded && mixDirty ? 'edited · Play mix to hear the change' : (events.length ? note : 'pick a motion, effect or sound on the left to start'));

  const transportButtons = (
    <>
      {mixLoaded && transport === 'playing' && !mixDirty
        ? <button type="button" className="mixer-btn" onClick={onStop}><span className="icon">stop</span> Stop</button>
        : mixLoaded && !mixDirty && transport !== 'playing'
          // Paused, or a play-once mix that reached its end: run the same
          // composed mix again without a recompose.
          ? <button type="button" className="mixer-btn primary" onClick={onResume}><span className="icon">play_arrow</span> {transport === 'paused' ? 'Resume' : 'Play again'}</button>
          : <button type="button" className="mixer-btn primary" disabled={busy || !events.length} onClick={onPlay}><span className="icon">play_arrow</span> Play mix</button>}
      {mixLoaded && transport === 'playing' && mixDirty && (
        <Tooltip content="Stop the stale mix"><button type="button" className="icon-btn" onClick={onStop}><span className="icon">stop</span></button></Tooltip>
      )}
      {mixLoaded && transport === 'playing' && (
        <Tooltip content="Pause"><button type="button" className="icon-btn" onClick={onPause}><span className="icon">pause</span></button></Tooltip>
      )}
      {onLoop && (
        <Tooltip content={loop ? 'Looping: the mix restarts when it ends (click for play once)' : 'Play once: the mix parks at its end (click to loop)'}>
          <button type="button" className={`icon-btn${loop ? ' on' : ''}`} onClick={() => onLoop(!loop)}><span className="icon">{loop ? 'repeat' : 'repeat_one'}</span></button>
        </Tooltip>
      )}
      {onSpeed && (
        <Tooltip content="Playback speed of the stage (effect, sound and motion together)"><span>
          <select className="mixer-open" value={String(speed)} onChange={(e) => onSpeed(Number(e.target.value))}>
            {[0.1, 0.25, 0.5, 0.75, 1, 1.5, 2].map((v) => <option key={v} value={String(v)}>{v}×</option>)}
          </select>
        </span></Tooltip>
      )}
    </>
  );

  const dock = createPortal(
    <div id="mixer-dock" className={`panel${dockOpen ? '' : ' collapsed'}`} style={dockOpen ? { height: dockH } : undefined}>
      {dockOpen && <div className="mixer-dock-grip" onPointerDown={startDockResize} title="Drag to resize" />}
      <div className="details-header">
        <span className="icon">timeline</span>
        <span className="details-title">Timeline · {recipe.name}</span>
        <span className="mixer-dock-note">{statusNote}</span>
        <span className="sp" />
        {!dockOpen && transportButtons}
        <Tooltip content={dockOpen ? 'Collapse the timeline (stage only)' : 'Show the timeline'}>
          <button type="button" className="icon-btn" onClick={toggleDock}><span className="icon">{dockOpen ? 'expand_more' : 'expand_less'}</span></button>
        </Tooltip>
      </div>
      {dockOpen && (
        <>
          <div className="mixer-dock-body">
            <Timeline events={events} selectedIds={selectedIds} onSelect={select}
              onMoveMany={moveMany} onShiftLane={shift} strike={strike}
              onPreview={(ev) => onPlaySound?.({ id: ev.sound, ref: ev.ref })}
              playhead={mixLoaded ? head : null}
              minLen={getPlayhead ? getPlayhead().length : 0}
              loopEnd={mixLoaded && getPlayhead ? getPlayhead().length : 0}
              big getSoundPeaks={getSoundPeaks} ghosts={ghosts} />
            {selected && <EventEditor ev={selected} onChange={(p) => update(selected._id, p)} onRemove={() => remove(selected._id)} />}
          </div>
          <div className="mixer-dock-bar">
            {transportButtons}
            {onSeek && mixLoaded && transport !== 'stopped'
              ? <Scrubber onSeek={onSeek} getPlayhead={getPlayhead} fallbackLen={recipeLength(events)} />
              : <span className="sp" />}
            <span className="mono-small">strike f{strike}</span>
            {LANES.filter((l) => l.id !== 'motion').map((l) => (
              <button key={l.id} type="button" className="mixer-chip" onClick={() => snapLane(l.id)}>snap {l.label.toLowerCase()}</button>
            ))}
            <span className="mono-small">{viewerRace}</span>
          </div>
          <div className="mono-small mixer-keys">
            space pause / resume · space ×2 stop &amp; rewind · ctrl+D duplicate · del / backspace remove · M mute / unmute · click a sound block to hear it · drag on empty rail to select a region, ctrl+click adds · drag a block (or a selected group) to move it, a lane label to shift the lane
          </div>
        </>
      )}
    </div>,
    document.body,
  );

  return (
    <div id="mixer-stack">
      {dock}
      <div className="panel mixer-panel">
        <div className="details-header">
          <span className="icon">tune</span>
          <input className="mixer-name" value={recipe.name} spellCheck={false}
            onChange={(e) => onRecipe({ ...recipe, name: e.target.value.replace(/[^A-Za-z0-9_-]/g, '_') })} />
          <span className="sp" />
          <Tooltip content="Save the recipe (asks for a name)"><button type="button" className="icon-btn" onClick={beginSave}><span className="icon">save</span></button></Tooltip>
          <Tooltip content="Start over: clear every lane and put the character back to idle"><button type="button" className="icon-btn" onClick={onReset}><span className="icon">restart_alt</span></button></Tooltip>
          {onClose && <button type="button" className="icon-btn details-close" onClick={onClose}><span className="icon">close</span></button>}
        </div>

        {saving && (
          <form className="mixer-save" onSubmit={(e) => { e.preventDefault(); commitSave(); }}>
            <input ref={saveRef} value={saveName} spellCheck={false} placeholder="recipe name"
              onChange={(e) => { setSaveName(e.target.value.replace(/[^A-Za-z0-9_-]/g, '_')); setOverwrite(null); }}
              onKeyDown={(e) => { if (e.key === 'Escape') { setSaving(false); setOverwrite(null); } }} />
            {overwrite
              ? <button type="submit" className="mixer-chip danger">overwrite {overwrite}</button>
              : <button type="submit" className="mixer-btn primary">Save</button>}
            <button type="button" className="icon-btn" onClick={() => { setSaving(false); setOverwrite(null); }}><span className="icon">close</span></button>
          </form>
        )}

        <div className="mixer-transport">
          {onShuffle && (
            <>
              <Tooltip content="What the shuffled mix publishes as — its motion is drawn from this kind; effects and sound from anything"><span>
                <select className="mixer-open" value={shuffleKind} onChange={(e) => setShuffleKind(e.target.value)}>
                  <option value="ws">weapon skill</option>
                  <option value="ja">job ability</option>
                  <option value="spell">spell</option>
                </select>
              </span></Tooltip>
              <Tooltip content="Random motion of that kind + random effects + random sound, then play">
                <button type="button" className="mixer-btn" disabled={busy} onClick={() => onShuffle(shuffleKind)}><span className="icon">casino</span> Shuffle</button>
              </Tooltip>
            </>
          )}
          <span className="sp" />
          <button type="button" className="mixer-btn" disabled={busy || !events.length} onClick={onPublish}>Publish…</button>
        </div>

        <div className="fx-actor-sec-title">Recipes · {(recipes ?? []).length}</div>
        <div className="mixer-recipes">
          {!(recipes ?? []).length && <div className="side-note">No saved recipes yet — Save writes one into exports/ability/mixer.</div>}
          {(recipes ?? []).map((r) => (
            <RecipeRow key={r.name} r={r} current={r.name === recipe.name} onStage={r.name === stageName}
              onOpen={onOpen} onRename={onRename} onDuplicate={onDuplicate} onDelete={onDelete} />
          ))}
        </div>
      </div>

      <div className="panel mixer-parts-panel">
        <div className="details-header">
          <span className="icon">segment</span>
          <span className="details-title">Parts · {LANE_BY_ID.get(lane)?.label}</span>
        </div>
        <div className="mixer-parts-body">
          {!laneEntry && <div className="side-note">Pick a source for this lane to see what it is made of.</div>}
          <Parts lane={lane} entry={laneEntry} info={laneInfo} events={events}
            onSolo={onSolo} onPlaySound={onPlaySound} onTake={onTake} />
        </div>
      </div>
    </div>
  );
}
