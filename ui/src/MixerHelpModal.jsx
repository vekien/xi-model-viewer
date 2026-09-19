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
 * close it — over a guide in two columns that scrolls on its own.
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
          A mix is a timeline of pills: motion, effects and sound picked from the game’s DATs, and the
          locks, hits and links that make it land in game. Play composes exactly what the timeline shows.
        </p>

        <div className="mhelp-cols">
          <Section icon="play_circle" title="Playing and scrubbing">
            <li><b>Play</b> composes the mix for the race on the stage and plays it. Until the next edit it pauses and resumes without composing again; <b>Stop</b> rewinds.</li>
            <li><K>Space</K> plays or pauses; pressed twice quickly, it stops and rewinds.</li>
            <li>Drag the <b>red cursor</b>, or the ruler, to scrub. The readout at the bottom right is the frame, the length and the time (60 frames a second), and the race on the stage.</li>
            <li><b>Speed</b> plays the stage slower or faster: effect, sound and motion together. <b>Loop</b> restarts the mix when it ends; off, it parks at its end.</li>
            <li>The dashed <b>loop</b> marker is where the mix restarts: after the last motion, effect or sound until you drag it. Double-click it to go back to auto. Sounds after it ring on past the restart, as in game.</li>
            <li>The <b>strike line</b> marks the first blow: the first flinch or weapon swing, else the first hit.</li>
            <li>The zoom buttons at the end of the toolbar widen the track up to 8×; it then scrolls sideways.</li>
          </Section>

          <Section icon="view_timeline" title="Pills and rows">
            <li>Drag a pill along to move it in time; the other pills stay where they are. <b>Snap</b> locks it onto the strike line, the loop end, frame 0 and other pills’ edges when it comes close.</li>
            <li>Drag a pill up or down to put it in another row of its track; below the last row makes a new one. A pill dropped onto another goes to the next row down with room for it.</li>
            <li>A pill never changes track: its clips, generators and sounds are read from that track’s source.</li>
            <li>The <b>+</b> by a track’s name adds an empty row. Point at the label for each row’s <b>−</b>: it deletes that row, its pills join the row above and the rows below move up.</li>
            <li>The fold button by a label, with the row count, puts the track on one line; folded, its pills drag in time only. <Lane id="keep" /> starts folded.</li>
            <li>A looping clip’s repeats are drawn faint, joined to its pill by a line, and nothing is placed on top of them. Its label says ×2, ×3… or ×∞.</li>
            <li>A clip’s blend in and out are the ramps at its ends. On the Motion and Effects tracks a solid pill starts a generator and an outlined one is anything else (a clip, a dampen, a link…). A sound pill shows its waveform, and the pills on <Lane id="keep" /> are solid grey. A pencil means this mix edits that generator, or replaces a texture it draws.</li>
            <li>Faint pills with a link mark are what a linked shared routine plays from ROM/0/0.DAT. A mix does not carry them: mute or move the link to change them.</li>
          </Section>

          <Section icon="ads_click" title="Selecting and editing">
            <li>Click a pill to select it; its fields open under the track: start frame, duration and row, and for a clip its blend in, blend out and loops (0 = ∞). A lock, hit or link has fields of its own.</li>
            <li>Drag on empty space to select a group. <K>Ctrl</K>-click puts a pill in or out of the selection, and <K>Ctrl</K>-drag adds a group; <K>Shift</K> works the same. <K>Ctrl + A</K> selects every pill.</li>
            <li><K>Ctrl + D</K> duplicates the selection right after itself; <K>Delete</K> removes it.</li>
            <li><K>M</K> mutes the selection: it stays on the timeline, left out of the mix, until <K>M</K> again. <b>Disable</b> in a pill’s fields does the same.</li>
            <li><K>Ctrl + C</K> copies the selection; <K>Ctrl + V</K> pastes it at the red cursor, on the same tracks. Before the mix has played, or with the cursor at frame 0, it lands right after the copied pills. A copy can go into another mix too.</li>
            <li>Click a sound pill, or its speaker, to hear it. <b>Preview</b> in an effects pill’s fields plays just that generator, once.</li>
          </Section>

          <Section icon="layers" title="Tracks">
            <li>A mix has <Lane id="motion" />, <Lane id="vfx" /> and <Lane id="sound" /> tracks, then <Lane id="keep" />. <b>Add Track</b> in the toolbar adds another of a kind.</li>
            <li>Click a track’s label to make it the active track: a pick from the list lands there. In the list a click previews a row, its <b>+</b> adds it to the active track, and a row can be dragged onto any track of its kind.</li>
            <li>A track’s label names its source, the DAT its pick came from. Its <b>×</b> clears the first track of a kind and removes any other.</li>
            <li>Drag a track’s label to shift the whole track in time.</li>
            <li>The align buttons in the bar shift the first Effects or Sound track so its first generator lands on the strike line.</li>
            <li>The dice picks a random motion for the Type, random effects and a random sound, then plays.</li>
          </Section>

          <Section icon="auto_awesome" title="Casts and stages">
            <li>On a job ability or spell the casts lead the Motion list. A cast comes as a pill per stage, in order: Start, Middle, End, each a clip of its own to move, loop or delete. Picking one sets the Type to match.</li>
            <li>A spell’s cast comes without its chant. The server plays the chant while the spell is cast (one of eight, by the spell’s group, spell_list.group), and the spell’s DAT runs once the cast finishes. A chant pill on a spell chants a second time and holds everything after it back.</li>
            <li>Open a spell’s row for the retail release instead: one waiting link, <code>3C sh··</code>, that plays the caster’s own release from its race’s files. The casting circle stops, the release burst and motion play, then 60 ticks of locks.</li>
            <li>A waiting link (<code>0x3B</code>, <code>0x3C</code>) holds the rest of the mix until the routine it runs ends. The shaded band after it, <b>holds N</b>, shows how long: the stage plays everything after it that much later, and the red cursor waits on the link’s frame meanwhile.</li>
            <li><b>holds ?</b> means the length is not known yet: a cast release needs a character on the stage, and ROM/0/0.DAT read (Play mix reads it).</li>
          </Section>

          <Section icon="lock" title="Locks · hits · links">
            <li>The last lane is what makes a mix land in game rather than what it shows. Its <b>+</b> adds a lock, hit or link at the red cursor (at the strike line before the mix has played), or copies a track source’s own locks and hits, which a pick leaves behind. What is added here belongs to no track: it stays when a track is cleared or picked again.</li>
            <li><b>Hit</b>: show the result now. The damage or heal number and its battle-log line appear here. Retail links the shared <code>mdam</code> after the last swing or flinch; with no hit the number still shows, but only when the routine ends.</li>
            <li><b>Added effect</b> (<code>proc</code>) plays the caster’s added-effect animation when the result has one, about 20 ticks after the hit in retail.</li>
            <li><b>Flinch</b> plays the target’s damage motion, as hard as the server says the hit was (this server sends none for spells); <b>Knockback</b> slides it back: at mode 0 by the server’s knockback, which this server sends for few actions; at any other mode by its own distance.</li>
            <li><b>Locks</b> hold part of an actor until they run out or the routine ends: the target’s status (it cannot fall or disengage before its number shows), every target’s (area), the caster’s, control (the player cannot act), magic, and turning. Retail ends the target and control locks at about the hit.</li>
            <li><b>Links</b> run another routine, from this mix’s DAT, the shared ROM/0/0.DAT or the caster’s race files. A link runs alongside; a waiting link holds the mix until its routine ends. Retail links <code>eis1</code> / <code>ei11</code> (the activation flash), <code>hwmg</code> (weapons away), <code>hwso</code> (instrument out), <code>stnm</code> (stop the charge circle) and <code>sh··</code> (the cast release).</li>
            <li><b>Add retail set</b> adds what retail has and the mix lacks. For a weapon skill or job ability: the target held to the hit, magic and control held 90 ticks (to the hit when that is later), the hit at the strike line and the added effect 20 ticks after it. For a spell: the cast release at frame 0, the target held to the hit, and the hit near the end.</li>
            <li>The <b>warning badge</b> counts what is off: no hit, a hit before the blow lands, a target lock that ends before the hit, a link the game cannot find. Click it for the list, and a warning to select its pills.</li>
          </Section>

          <Section icon="bubble_chart" title="Generators and textures">
            <li>Select an effects pill and press <b>Edit generator</b>: the Generator window shows every field of that generator by group (timing, spawn, position, rotation, colour, texture, curves and more). An edit belongs to this mix: the stage shows it, and Publish writes it into the mix’s DAT.</li>
            <li>An edited field has its own undo; <b>Revert all</b> puts the generator and its curves back as the source DAT holds them. The play button plays just this generator, once, with its edits.</li>
            <li><b>Curves</b> show their keys to edit when the track’s DAT holds the curve (a shared one of ROM/0/0.DAT cannot be edited). A curve is shared: every generator that names it plays the edited keys.</li>
            <li><b>Hue shift</b> turns every colour of the generator round the colour wheel: its colour fields, and its red, green and blue curves when their keys line up. A texture, and a mesh’s own vertex colours, keep their hue.</li>
            <li>Under <b>Texture &amp; mesh</b>, <b>Replace…</b> puts a PNG in a texture’s place, <b>Save PNG</b> saves the source’s texture to edit and pick back, and its undo goes back to the source’s. Every generator that draws the texture shows the replacement.</li>
            <li>Play mix and Publish put a replacement into the DAT as DXT3, each side a power of two from 4 to 256. A sprite sheet’s frames are cut from set places in the image, so a replacement must keep the original’s frame layout.</li>
            <li>A shared routine’s generators (the faint pills) are not carried by a mix, so they cannot be edited.</li>
          </Section>

          <Section icon="publish" title="Publishing">
            <li>The <b>Type</b> in the toolbar decides what the mix publishes as: WS, Ability or Spell. A weapon skill is built per race and takes any motion. A job ability or spell is one DAT for every race: the casts at the top of the Motion list always work, and any other motion is baked from one race’s copy, which is experimental (the strip above the track says so).</li>
            <li>The Type also decides which set <b>Add retail set</b> lays, and on a weapon skill the stage stands in its battle stance.</li>
            <li><b>Publish</b> builds the mix into the game folder now (<code>xi dats build</code>), or the pivot folder, and the console shows it as it runs. Restart the client to see it.</li>
            <li><b>Manage</b> holds the rest, kept for each mix name: <b>animation</b> is the slot number (blank: automatic), <b>start at</b> is where an automatic number starts looking, and <b>ROM10 folder</b> is where the DATs are written.</li>
            <li><b>Overwrite a taken slot</b> takes the slot even when its file ids already point at another DAT. <b>Use Pivot Folder</b> builds into the pivot folder (FFXI_PIVOT_DIR) instead of the game folder.</li>
            <li><b>Check</b> is a dry run with these choices: the slot it takes and where every DAT lands, nothing written. <b>Slots</b> lists every weapon-skill number and what holds it; click a free one to take it.</li>
            <li>The note under the fields gives the numbers the Type can take on any client, then the band the client plugin (cexislots) adds; <b>Settings › XI Tools › Custom animation bands</b> turns it on.</li>
          </Section>

          <Section icon="save" title="Saving mixes">
            <li><b>New</b> starts an empty mix. Name it, file it under a category if you like, and <b>Save</b> (<K>Ctrl + S</K>): over the saved mix of that name when there is one.</li>
            <li><b>Load</b> opens the Mixes panel: every saved mix by category, to open, rename, file, duplicate, delete, export or import. The bin in the toolbar deletes the saved mix with this name.</li>
          </Section>

          <section className="help-controls-group mhelp-section">
            <div className="help-controls-title mhelp-title"><span className="icon">keyboard</span>Keyboard</div>
            {KEYS.map(([keys, action]) => (
              <div className="help-key-row" key={keys}>
                <span className="help-keys">{keys}</span>
                <span className="help-action">{action}</span>
              </div>
            ))}
            <div className="mhelp-note">While you type in a field the keys are the field’s; Ctrl + S still saves.</div>
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
