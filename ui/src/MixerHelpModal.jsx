import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@headlessui/react';
import { KEEP_LANE, LANE_BY_ID } from '../js/mixer.js';

// The keys the mixer answers to: Space is the app's transport key (App.jsx), the
// rest are the timeline's editing keys (MixerPanel.jsx).
const KEYS = [
  ['Space', 'Play or pause'],
  ['Space twice', 'Stop and rewind'],
  ['Ctrl + S', 'Save the mix'],
  ['Ctrl + A', 'Select every pill'],
  ['Ctrl + C', 'Copy the selection'],
  ['Ctrl + V', 'Paste at the red cursor'],
  ['Ctrl + D', 'Duplicate the selection'],
  ['Delete', 'Remove the selection'],
  ['M', 'Mute or unmute the selection'],
  ['Ctrl + click', 'Put a pill in or out of the selection'],
  ['Esc', 'Close this help'],
];

/** A key as the guide writes it inline: the About window's key chip, sized for a line of text. */
const K = ({ children }) => <kbd className="help-keys mhelp-kbd">{children}</kbd>;

/** A lane by its name, in the colour its pills are drawn in. */
function Lane({ id }) {
  const lane = id === 'keep' ? KEEP_LANE : LANE_BY_ID.get(id);
  return <span className="mhelp-lane" style={{ color: lane.color }}>{lane.label}</span>;
}

/** One card of the guide: the About window's controls box, a heading and a list. */
function Section({ icon, title, children }) {
  return (
    <section className="help-controls-group mhelp-section">
      <div className="help-controls-title mhelp-title"><span className="icon">{icon}</span>{title}</div>
      <ul className="mhelp-list">{children}</ul>
    </section>
  );
}

/**
 * The Ability Mixer's help: what the timeline window's (?) opens. The About
 * window's floating frame — backdrop-less, dragged by its header, × and Esc
 * close it — over a guide in three columns that scrolls on its own.
 *
 * It sits above the mixer's windows and the Data Struct windows, below the app's
 * own modals (5000), and the mixer's keys keep working while it is open.
 */
export function MixerHelpModal({ open, onClose, zIndex = 4000 }) {
  const [pos, setPos] = useState(null);
  const panelRef = useRef(null);
  const dragState = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (open) setPos(null);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const clampNow = () => setPos((p) => (p ? clamp(p, panelRef.current) : p));
    window.addEventListener('resize', clampNow);
    return () => window.removeEventListener('resize', clampNow);
  }, [open]);

  // Esc closes this window before anything behind it hears the key. It listens on
  // document in the capture phase: after every window capture listener, so the app's
  // Esc chain always decides first however often it re-registers, and still ahead of
  // the mixer's and the stage's own Esc. One the app's Esc chain has already used (it
  // closed a modal of its own) is left alone, and so is one pressed in a field or an
  // open drop-down list, which it closes first.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target;
      if (t?.isContentEditable || /^(input|textarea|select)$/i.test(t?.tagName ?? '')) return;
      if (t?.closest?.('[role="listbox"], [role="combobox"], [role="menu"], [aria-haspopup][aria-expanded="true"]')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closeRef.current?.();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);

  if (!open) return null;

  const startDrag = (e) => {
    if (e.target.closest('button, input, a, [role="button"]')) return;
    const rect = panelRef.current.getBoundingClientRect();
    dragState.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDrag = (e) => {
    if (!dragState.current) return;
    setPos(clamp({ x: e.clientX - dragState.current.dx, y: e.clientY - dragState.current.dy }, panelRef.current));
  };
  const endDrag = () => { dragState.current = null; };

  const style = pos
    ? { left: pos.x, top: pos.y, transform: 'none', zIndex }
    : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex };

  // A key pressed in here stays here: Space on the × closes the window rather
  // than playing the mix, and Delete never reaches the pills behind it.
  return createPortal(
    <div className="modal mixer-help-modal" ref={panelRef} style={style} role="dialog" aria-label="Ability Mixer help"
      onKeyDown={(e) => e.stopPropagation()}>
      <div
        className="modal-header"
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
      >
        <span className="icon">help</span>
        <span className="modal-title">Ability Mixer help</span>
        <Button className="icon-btn modal-close" aria-label="Close" onClick={onClose}>
          <span className="icon">close</span>
        </Button>
      </div>

      <div className="modal-body mhelp-body">
        <p className="mhelp-lead">
          A mix is a timeline of pills — motion, effects and sound from the game’s DATs, plus the locks,
          hits and links that make it land in game. Play shows exactly what the timeline holds.
        </p>

        <div className="mhelp-cols">
          <Section icon="play_circle" title="Play &amp; scrub">
            <li><b>Play</b> plays the mix, <b>Stop</b> rewinds. <K>Space</K> = play/pause, twice = stop.</li>
            <li>Drag the <b>red cursor</b> or ruler to scrub. <b>Speed</b> slows the stage; <b>Loop</b> repeats.</li>
            <li>Dashed <b>loop</b> mark = where it restarts (double-click for auto). <b>Strike line</b> = the first blow.</li>
            <li>Zoom buttons widen the track up to 8×.</li>
          </Section>

          <Section icon="view_timeline" title="Pills &amp; rows">
            <li>Drag a pill to move it; <b>Snap</b> catches the strike line, loop end and nearby pills.</li>
            <li>Drag up/down for another row. A track’s <b>+</b> adds a row, a row’s <b>−</b> removes it.</li>
            <li>A pill keeps its track. Looping repeats are faint (×2, ×3, ×∞).</li>
            <li>Fold (the count by a label) puts a track on one line. <Lane id="keep" /> starts folded.</li>
          </Section>

          <Section icon="ads_click" title="Select &amp; edit">
            <li>Click a pill to open its fields (start, duration, row, blend, loops).</li>
            <li>Drag empty space to box-select; <K>Ctrl</K>-click toggles one; <K>Ctrl + A</K> = all.</li>
            <li><K>Ctrl + D</K> duplicate · <K>Delete</K> remove · <K>M</K> mute · <K>Ctrl + C</K>/<K>V</K> copy/paste.</li>
            <li>Click a sound pill to hear it; <b>Preview</b> plays one generator.</li>
          </Section>

          <Section icon="layers" title="Tracks">
            <li><Lane id="motion" /> <Lane id="vfx" /> <Lane id="sound" />, then <Lane id="keep" />. <b>Add Track</b> adds another.</li>
            <li>Click a label to make it active; picks land there. Drag a label to shift the track in time.</li>
            <li>A label names its DAT source; <b>×</b> clears it. The dice randomises the mix.</li>
          </Section>

          <Section icon="auto_awesome" title="Casts &amp; stages">
            <li>Casts lead the Motion list: a pill per <b>Start · Middle · End</b>. Picking one sets the Type.</li>
            <li>A spell’s cast has no chant — the server chants by group; the DAT runs when the cast ends.</li>
            <li>Open a spell’s row for the <b>retail release</b> link instead.</li>
            <li>A waiting link (<code>0x3B/3C</code>) holds the mix until its routine ends; <b>holds N</b> shows how long.</li>
          </Section>

          <Section icon="lock" title="Locks · hits · links">
            <li>The last lane makes a mix land in game. Its <b>+</b> adds a lock, hit or link (or copies a source’s).</li>
            <li><b>Hit</b> shows the damage/heal number. <b>Flinch</b> / <b>Knockback</b> move the target.</li>
            <li><b>Locks</b> hold the target, caster, control, magic or turning until the routine ends.</li>
            <li><b>Links</b> run another routine (this DAT, ROM/0/0, or the caster’s race).</li>
            <li><b>Add retail set</b> fills in what retail has. The <b>badge</b> counts what’s off.</li>
          </Section>

          <Section icon="bubble_chart" title="Generators &amp; textures">
            <li>Effects pill → <b>Edit generator</b>: timing, spawn, colour, curves and more. Edits ship in the DAT.</li>
            <li>Every field has undo; <b>Revert all</b> restores the source. <b>Hue shift</b> rotates every colour.</li>
            <li><b>Replace…</b> swaps a texture for a PNG (DXT3, 4–256 px); <b>Save PNG</b> exports it.</li>
            <li>Shared-routine generators (faint pills) can’t be edited.</li>
          </Section>

          <Section icon="publish" title="Publishing">
            <li><b>Type</b> = WS, Ability or Spell. <b>Publish</b> builds into the game (or pivot) folder; restart the client.</li>
            <li><b>Manage</b>: <b>animation</b> slot (blank = auto), <b>start at</b>, <b>ROM10 folder</b>. <b>Check</b> = dry run; <b>Slots</b> lists WS numbers.</li>
            <li>Each Publish fills <code>projects\abilities\&lt;slug&gt;</code> (mix, SQL, DAT copies, placements). <b>Folder</b> opens it.</li>
            <li><b>Overwrite a taken slot</b> reuses a taken slot; <b>Use Pivot Folder</b> builds into the pivot folder.</li>
          </Section>

          <Section icon="dns" title="Local server switches">
            <li>Three per-mix switches for the server in <b>Settings › Local Server</b> (run on Check and Publish).</li>
            <li><b>Database Update</b> points the server row at the animation, or, when there’s none, inserts one cloned from a default donor (Cure / Berserk / Fast Blade) so it works until a dev edits it. Confirm a row this mix didn’t make.</li>
            <li><b>Client Menu Record</b> adds the menu entry at the same id, so players can pick it.</li>
            <li><b>Lua Stub</b> writes the server script (what it <i>does</i>), copied from the default donor. The DAT is only how it <i>looks</i>.</li>
          </Section>

          <Section icon="save" title="Saving mixes">
            <li><b>New</b> starts empty; <b>Save</b> (<K>Ctrl + S</K>) writes <code>&lt;Name&gt;.mix.json</code>.</li>
            <li><b>Load</b> opens the Mixes panel: open, rename, file, duplicate, delete, import/export.</li>
          </Section>

          <section className="help-controls-group mhelp-section">
            <div className="help-controls-title mhelp-title"><span className="icon">keyboard</span>Keyboard</div>
            {KEYS.map(([keys, action]) => (
              <div className="help-key-row" key={keys}>
                <span className="help-keys">{keys}</span>
                <span className="help-action">{action}</span>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function clamp(p, panel) {
  const w = panel?.offsetWidth ?? 820;
  const h = panel?.offsetHeight ?? 600;
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}
