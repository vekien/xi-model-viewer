import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Field, Label } from '@headlessui/react';
import { Combo } from './Combo.jsx';
import { animDisplayName } from '../js/dat.js';
import { Tooltip } from './Tooltip.jsx';

/** Combo on a labelled panel row, matching the gear slots in the Characters panel. */
function Row({ label, children }) {
  return (
    <div className="pc-ctrl">
      <span className="pc-ctrl-label">{label}</span>
      {children}
    </div>
  );
}

/**
 * Scrub bar for the running clip.
 *
 * Deliberately uncontrolled: the render loop pushes the playhead in through
 * `frameSink` and this writes the thumb straight to the DOM, because routing 30
 * updates a second through React state would rebuild every combo's option list
 * on each one. Only the clip *length* is state — that changes when the clip does.
 */
function FrameScrubber({ frameSink, onSeek }) {
  const slider = useRef(null);
  const readout = useRef(null);
  const dragging = useRef(false);
  const [last, setLast] = useState(0);

  useEffect(() => {
    if (!frameSink) return undefined;
    frameSink.current = (frame, len) => {
      // lengthInFrames divides a frame count by the keyframe duration, so it
      // lands a hair under the whole number it means (59.99999910593034 for a
      // 60-frame clip). Round before it reaches the scale or the readout.
      const end = Math.max(Math.round(len) - 1, 0);
      setLast((prev) => (prev === end ? prev : end));   // same value: React bails out
      if (dragging.current || !slider.current) return;
      const f = Math.min(Math.floor(frame), end);       // the playhead reaches len before wrapping
      slider.current.value = f;
      slider.current.style.setProperty('--fill', end > 0 ? `${(f / end) * 100}%` : '0%');
      if (readout.current) readout.current.textContent = `${f}/${end}`;
    };
    return () => { frameSink.current = null; };
  }, [frameSink]);

  const drag = (e) => {
    dragging.current = true;
    const f = +e.target.value;
    onSeek?.(f);
    // The render-loop sink skips the readout while dragging, so write it here to
    // track the thumb in real time — otherwise the number sits frozen until drop.
    e.target.style.setProperty('--fill', last > 0 ? `${(f / last) * 100}%` : '0%');
    if (readout.current) readout.current.textContent = `${f}/${last}`;
  };
  const drop = () => { dragging.current = false; };

  return (
    <Row label="Frame">
      <input
        ref={slider}
        type="range"
        className="vol-slider pc-frame-slider"
        min="0"
        max={last}
        defaultValue={0}
        disabled={last <= 0}
        onInput={drag}
        onPointerUp={drop}
        onPointerCancel={drop}
        onBlur={drop}
      />
      <span ref={readout} className="mono pc-frame-num">0/0</span>
    </Row>
  );
}

/**
 * Playback panel (top right): clip and schedule pickers, transport, scrubber.
 *
 * Its own panel rather than a strip in the viewbar so the rows can carry labels
 * and the scrubber has somewhere to sit. `pc` is only wired up in the Characters
 * view — every other view drives a plain clip and gets no action pickers.
 */
export function AnimationPanel({ pc, anim }) {
  const { actionGroups = [], actionGroup, setActionGroup,
          actionEntries = [], action, setAction } = pc ?? {};
  const { anims = [], currentAnim = '', onAnimChange,
          schedules = [], currentSchedule = '', onScheduleChange,
          playing, onTogglePlay, frameSink, onSeek,
          transport = 'playing', onPlay, onPause, onStop,
          loop = true, onLoop,
          charAnim = false, onCharAnim, charAnimEnabled = true,
          attachFx = true, onAttachFx, attachFxEnabled = true,
          fxMode = 'mesh', onFxMode, onReset,
          fxRoutines, fxRoutine = '', onFxRoutine,
          animPacks, animPack = '', onAnimPack,
          baseAnim = 'none', onBaseAnim,
          speed = 1, onSpeed, volume, onVolume } = anim ?? {};

  if (actionGroups.length === 0 && anims.length === 0 && schedules.length === 0) return null;

  // One list for everything that can be played, so it is obvious which is
  // running. Ids are prefixed because a schedule and a clip can share a name.
  const motionItems = [
    { id: '', label: '— bind pose —' },
    ...anims.map((g) => ({
      id: `anim:${g.id}`,
      group: 'Animations',
      // btl is the battle-stance clip (not a Schedule). Schedules are
      // ati0/atb0/… attack routines that *reference* anim layers.
      label: g.label
        ?? (g.id === 'btl' ? 'btl — battle stance'
          : g.id === 'idl' ? 'idl — idle'
            : g.id === 'std' ? 'std — stand'
              : g.id),
      badge: g.clip.parts?.length,
    })),
    ...schedules.map((s2) => ({
      id: `sched:${s2.id}`,
      group: 'Schedules',
      label: s2.id,
      badge: s2.clipIds.length > 1 ? s2.clipIds.length : undefined,
    })),
    ...(animPacks ?? []).map((p) => ({
      id: `pack:${p.path}`,
      group: 'Specials',
      // The clip ids are the only names these carry; a set repeats them
      // (Iroha's six packs use four between them), so the DAT has to be shown
      // too for the rows to be tellable apart.
      label: `${(p.clips ?? []).join(', ') || '?'} — ${p.path.replace(/\.DAT$/i, '')}`,
    })),
  ];

  // A Special loads its pack AND selects the pack's clip, so while that clip is
  // the one playing it is the Special that is really selected — show that row
  // rather than the clip it happens to have put in the Animations group.
  const packEntry = animPack ? (animPacks ?? []).find((p) => p.path === animPack) : null;
  const packIsPlaying = !!packEntry && !currentSchedule
    && (packEntry.clips ?? []).some((c) => animDisplayName(c) === currentAnim);
  const motionValue = packIsPlaying ? `pack:${animPack}`
    : currentSchedule ? `sched:${currentSchedule}`
      : currentAnim ? `anim:${currentAnim}`
        : '';

  const onMotion = (id) => {
    if (!id) { onAnimChange?.(''); return; }
    const [kind, ...rest] = String(id).split(':');
    const key = rest.join(':');
    if (kind === 'sched') onScheduleChange?.(key);
    else if (kind === 'pack') onAnimPack?.(key);
    else onAnimChange?.(key);
  };

  return (
    <div id="animbar" className="panel">
      <div className="panel-title">
        <span className="icon">animation</span>
        Animation
      </div>
      {onFxMode && (
        <Row label="Show">
          <div className="seg-tabs" role="tablist" aria-label="Mesh and VFX">
            {[['both', 'Both'], ['mesh', 'Mesh'], ['vfx', 'VFX']].map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={fxMode === id}
                className={`seg-tab${fxMode === id ? ' on' : ''}`}
                onClick={() => onFxMode(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </Row>
      )}
      {actionGroups.length > 0 && (
        <>
          <Row label="Category">
            <Combo
              value={actionGroup}
              items={actionGroups.map((g) => ({ id: g, label: g }))}
              onChange={setActionGroup}
            />
          </Row>
          <Row label="Action">
            <Combo value={action} items={actionEntries} onChange={setAction} placeholder="— none —" />
          </Row>
        </>
      )}
      {(onAnimChange || schedules.length > 0 || animPacks?.length > 0) && (
        <Row label="Motion">
          <Combo
            value={motionValue}
            items={motionItems}
            onChange={onMotion}
          />
        </Row>
      )}
      {onFxMode && fxMode !== 'mesh' && fxRoutines?.length > 0 && (
        <Row label="Effect">
          <Combo
            value={fxRoutine}
            items={[
              { id: '', label: '— none —' },
              ...fxRoutines.map((id) => ({ id, label: id })),
            ]}
            onChange={onFxRoutine}
            placeholder="— none —"
          />
        </Row>
      )}
      {/* Effects: Play/Pause + bare stop / rewind / loop glyphs. */}
      {onPlay && (
        <Row label="Playback">
          <Button
            className="pc-play"
            onClick={transport === 'playing' ? onPause : onPlay}
          >
            <span className="icon fill">{transport === 'playing' ? 'pause' : 'play_arrow'}</span>
            <span>{transport === 'playing' ? 'Pause' : 'Play'}</span>
          </Button>
          <div className="pc-tgroup">
            {onStop && (
              <Tooltip content="Stop">
                <Button
                  className="pc-tbtn"
                  disabled={transport === 'stopped'}
                  aria-label="Stop"
                  onClick={onStop}
                >
                  {/* stop_circle reads cleaner than the bare square at this size */}
                  <span className="icon">stop_circle</span>
                </Button>
              </Tooltip>
            )}
            <Tooltip content="Reset">
              <Button
                className="pc-tbtn"
                aria-label="Reset"
                // onReset owns the whole restart when the caller has more to do
                // than rewind — a character-paired effect has to be cut off the
                // stage and re-fired, not left running over a rewound clip.
                onClick={() => { if (onReset) onReset(); else { onSeek?.(0); onSpeed?.(1); } }}
              >
                <span className="icon">replay</span>
              </Button>
            </Tooltip>
            {onLoop && (
              <Tooltip content={loop ? 'Loop on' : 'Loop off'}>
                <Button
                  className={`pc-tbtn${loop ? ' on' : ''}`}
                  aria-label="Loop"
                  aria-pressed={loop ? 'true' : 'false'}
                  onClick={() => onLoop(!loop)}
                >
                  <span className="icon">repeat</span>
                </Button>
              </Tooltip>
            )}
          </div>
        </Row>
      )}
      {!onPlay && onTogglePlay && (
        <Row label="Playback">
          <Button className="pc-play" onClick={onTogglePlay}>
            <span className="icon fill">{playing ? 'stop' : 'play_arrow'}</span>
            <span>{playing ? 'Stop' : 'Play'}</span>
          </Button>
          <Tooltip content="Reset to frame 0 and 100% speed">
            <Button
              className="icon-btn pc-reset"
              onClick={() => { onSeek?.(0); onSpeed?.(1); }}
            >
              <span className="icon">restart_alt</span>
            </Button>
          </Tooltip>
        </Row>
      )}

      {frameSink && <FrameScrubber frameSink={frameSink} onSeek={onSeek} />}
      {onSpeed && (
        <Row label="Speed">
          <input
            type="range"
            className="vol-slider pc-frame-slider"
            min="10" max="200" step="5"
            value={Math.round(speed * 100)}
            style={{ '--fill': `${((Math.round(speed * 100) - 10) / 190) * 100}%` }}
            onInput={(e) => onSpeed(+e.target.value / 100)}
          />
          <span className="mono pc-frame-num">{Math.round(speed * 100)}%</span>
        </Row>
      )}
      {onVolume && (
        <Row label="Volume">
          <input
            type="range"
            className="vol-slider pc-frame-slider"
            min="0" max="100" step="1"
            value={Math.round(volume * 100)}
            style={{ '--fill': `${Math.round(volume * 100)}%` }}
            onInput={(e) => onVolume(+e.target.value / 100)}
          />
          <span className="mono pc-frame-num">
            {volume > 0 ? `${Math.round(volume * 100)}%` : 'muted'}
          </span>
        </Row>
      )}
      {onBaseAnim && (
        <Row label="Base">
          <div className="seg-tabs" role="tablist" aria-label="Base animation">
            {[['none', 'None'], ['idl', 'Idle'], ['btl', 'Battle']].map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={baseAnim === id}
                className={`seg-tab${baseAnim === id ? ' on' : ''}`}
                onClick={() => onBaseAnim(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </Row>
      )}

      {onAttachFx && (
        <Field
          className={`pc-ctrl pc-charanim${attachFxEnabled ? '' : ' is-disabled'}`}
          disabled={!attachFxEnabled}
        >
          <Checkbox
            checked={!!attachFx && !!attachFxEnabled}
            onChange={onAttachFx}
            className="checkbox"
            disabled={!attachFxEnabled}
          >
            <span className="icon check-icon">check</span>
          </Checkbox>
          <Label className="pc-charanim-label">Attach FX to Character</Label>
        </Field>
      )}
      {onCharAnim && (
        <Field
          className={`pc-ctrl pc-charanim${charAnimEnabled ? '' : ' is-disabled'}`}
          disabled={!charAnimEnabled}
        >
          <Checkbox
            checked={!!charAnim && !!charAnimEnabled}
            onChange={onCharAnim}
            className="checkbox"
            disabled={!charAnimEnabled}
          >
            <span className="icon check-icon">check</span>
          </Checkbox>
          <Label className="pc-charanim-label">Show Character Animation</Label>
        </Field>
      )}

    </div>
  );
}
