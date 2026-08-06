import { useEffect, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { Combo } from './Combo.jsx';

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
          speed = 1, onSpeed, volume, onVolume } = anim ?? {};

  if (actionGroups.length === 0 && anims.length === 0 && schedules.length === 0) return null;

  return (
    <div id="animbar" className="panel">
      <div className="side-separator anim-title">
        <span className="icon">animation</span>
        Animation
      </div>
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
      {onAnimChange && (
        <Row label="Anim">
          <Combo
            value={currentAnim}
            items={[
              { id: '', label: '— bind pose —' },
              ...anims.map((g) => ({ id: g.id, label: g.label ?? g.id, badge: g.clip.parts?.length })),
            ]}
            onChange={onAnimChange}
          />
        </Row>
      )}
      {schedules.length > 0 && (
        <Row label="Schedule">
          <Combo
            value={currentSchedule}
            items={[
              { id: '', label: '— none —' },
              ...schedules.map((s) => ({
                id: s.id,
                label: s.id,
                badge: s.clipIds.length > 1 ? s.clipIds.length : undefined,
              })),
            ]}
            onChange={onScheduleChange}
          />
        </Row>
      )}
      {onTogglePlay && (
        <Row label="Playback">
          <Button className="pc-play" onClick={onTogglePlay}>
            <span className="icon fill">{playing ? 'stop' : 'play_arrow'}</span>
            <span>{playing ? 'Stop' : 'Play'}</span>
          </Button>
          <Button
            className="icon-btn pc-reset"
            title="Reset to frame 0 and 100% speed"
            onClick={() => { onSeek?.(0); onSpeed?.(1); }}
          >
            <span className="icon">restart_alt</span>
          </Button>
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
    </div>
  );
}
