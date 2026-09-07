# Changelog

All notable changes to XI Model Viewer.

Releases and Windows builds: https://github.com/vekien/xi-model-viewer/releases

1.0.6, 1.0.7 and 1.0.11 were never released, so they have no entry here.

---

## [Unreleased]

### Export
- **File › Batch Export** has **Music** and **Sound FX** tabs. Both decode to `.wav` in-app, the same way exporting a single track does — no xi-tools needed, only the Game path. Each narrows the same way its side panel's search does, and the default on both is everything: pick a **Sound folder** (one expansion, or all seven), and for sound effects a **Category** — the names Windower's SFXInfo gives each `seNNN` folder, counted, with the unnamed folders in one bucket rather than 370 separate entries — then a free-text **Filter** over track names, sound titles, ids and filenames. Naming an expansion, a folder or a category takes all of it. Files land under their own game folder (`…\sound2\win\music\data\`) so same-numbered sounds from different expansions don't collide, and **File names** chooses between the track's real name (`Ronfaure.wav`) and its game filename (`music101.wav`) — anything with no known name keeps its filename either way, and a repeat inside one folder is qualified with it rather than silently overwritten. The whole client is 224 tracks and ~11,900 sound effects; the folder scan behind the live count is done once and then filtered in memory
- **File › Export** now says so when it finishes: a banner with the file it wrote, where it went, and a button to open that folder. It matters most for meshes, animations and zones — those close the dialog the moment they start so the app stays usable while xi runs, and until now the only sign the run had landed was a status line that scrolled past. Successes fade after a few seconds; failures stay, with xi's own complaint, until dismissed. Batch Export gets the same summary in the dialog, which stays open
- A batch run of sounds can be stopped like any other — it checks between files

## [1.2.0] — 2026-09-07

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.1.7...v1.2.0)

### Zones
- **View › Toggle NPCs** stands the server's NPC placements on the loaded zone: every `npc_list` row for the zone, at its position and heading, drawn with its look — a unique model for standard NPCs, or the race skeleton plus the gear its look names for equipped ones (child races best-effort). NPCs a script keeps hidden, and doors / elevators / ships, are counted in the status bar but not drawn; an NPC whose model cannot be resolved stands as an orange marker. They are scenery: not selectable, not saved with scenes, and only drawn within 120 units of the camera. The placements come from `ui/public/lists/zone_npcs.json`, baked from CatsEyeXI's `sql/npc_list.sql` by `scripts/gen_zone_npcs.py`
- Fixed: the prototype town drew a second, motionless windmill wheel inside each turning one
- Fixed: windmill sails and wind vanes a zone generator spins are drawn double-sided, so the ones facing away no longer vanish as the wheel turns

### Graphics
- Graphics › **Enable LOD** — draw each object at the detail level the zone actually placed it at, which is what retail shows at range. It is off by default, and off is the better picture: a placement names one of three variants (`_l` / `_m` / `_h`) and the client swaps between them by camera distance, so a zone rarely places the high-detail copies at all — Bastok Markets places 7 of 47. With no distance switching of our own, honouring the placed name meant drawing the low one everywhere, and the low variants do not simply decimate, they drop geometry: `shp_cen_sun4_m` is a single-skinned awning with no underside, which disappears when you stand beneath it, where `_h` models both faces over the same bounds. Toggling swaps the meshes in place, with no zone reload
- Fixed: surfaces lying almost flat against one another flickered as the camera pulled back. Bastok's `auchatal` sits about a hundredth of a unit off `auc_stdl`, and the two fell into the same depth value from roughly 100 units away. Zones ask for a near plane ten times further out than the one they were being drawn with — depth precision is set by that plane — so the request is now honoured, which pushes the same collapse out past 300 units

### Camera Sequencer
- **Curve rows** — click the Camera Position or Camera Rotation lane label to graph that track underneath it: one line per channel (X / Y / Z, or yaw / pitch / roll) over a filled envelope of how fast the camera is moving or turning. The three channels share one scale but are each centred on their own midpoint, so a channel that barely moves reads as flat beside one that swings, rather than being rescaled to look just as busy. Sampled from the same sequence playback runs, so the graph is what the camera actually does — Curve and Linear rotation included
- Camera moves are smoother in two ways. The eye no longer changes speed abruptly at a key: the pace either side of a key is eased across it, so dragging the last keys further apart slows the shot down over the approach instead of dropping to the new speed within a single frame. And a turn now happens where it was keyed — the rotation spline used to settle every key's tangent from the whole track, so a turn late in a sequence had the camera drifting round long before the key that asked for it, and a channel that should have sat still between two equal keys wandered off and came back. Keys are still hit at their exact frames
- The **Lock to Actor** target draws as a sphere on a stalk, centred on the point the camera actually aims at rather than somewhere inside a placeholder box. Click it in the viewport to put the transform gizmo on it — it no longer needs the Scenes panel open to be selectable — and a viewport drag in a zone now orbits around it, so the view swings around the thing the shot is aimed at instead of tumbling off it
- Fixed: the sequencer panel could end up parked past the edge of the window after a resolution change or a UI Scale change, leaving no header to drag it back by. It now fits itself to the window on open, on resize, and whenever its own height changes

### Animation
- Picking a **Category**, **Action** or **Motion** now always starts that motion from frame 0 and plays it, with the action's effect routine fired on the same frame. Before, anything but a race change counted as a gear swap: the pick kept whatever clip was already running, at whatever frame it was on, and often stayed paused — and because the VFX only re-fires at the clip's loop point, a pick made mid-cycle showed the motion with no effect until it wrapped. Loading a character still follows Settings → Auto-play; only a deliberate pick overrides it
- An action now lands on its own motion instead of the race idle: **General › Fishing** opens on `fsh0`, Logging / Mining / Harvesting / Dancing / Bell Ringing on `em00`, Goldfish Scooping on `fsh0`, Chocobo on `cdam` — the first routine in each one's Motion list. A **Battle** entry leads with the stance it is named for, rather than whichever attack routine sorted first
- The test for "does this action have an idle (or a stance) of its own" now reads the clips its DATs actually ship, not everything its routines can reach. A tool routine ends by handing back to `idl`, and its refs resolve onto `btl` as well once the equipped weapon's battle pack is merged in — which is what had Fishing opening on the race idle
- Gear swaps are unchanged: they still carry the running motion at its current frame, and do not replay the effect
- Motion rows spell out the clips that can be named: `ded — death`, `cor — knocked out` and `std — raise` are one sequence (struck down, on the ground, raised), which is why `std` was mislabelled "stand". `idl`, `btl`, `wlk`, `run`, `mvb/mvl/mvr` and `jmp` are named too; every other id is left as it is

### Characters
- **Battle** stances are named after the weapons that actually use them, per race, read from every weapon DAT's own animation type. The old labels named Hume Male's weapons for everyone, and the races do not agree: a great katana is its own stance on Hume Male, shares the great sword's on Hume Female and Mithra, and is a separate one again on Galka. So "Battle: Great Katana" on a Hume Female was really the katana stance, and a great katana held in it came out one-handed. Every race's row now reads its own weapons — Hume Female lists **Great Sword / Great Katana**, Galka lists both separately, and Hume Male's own labels were wrong too (**Axe / Club** was "Club / Staff", **Great Axe / Scythe / Staff** was "Axe / Scythe", **Katana** was "Kunai"). Regenerate the table after a client update with `node scripts/gen_battle_stances.mjs`
- New **Battle: Unarmed** — the empty-hand stance every race has, which was never listed
- A race switch keeps the stance you were looking at by the weapon it names, not by its label or its slot in the list — neither of which means the same thing on the next race
- Fixed: picking the **Fishing** action with the Ranged slot empty froze the app on Hume Female and Mithra. Fishing draws whatever is in Ranged, and the empty-slot placeholder made the viewer hang the character's skeleton off its own hand — a loop the pose solver could never finish. An empty slot is now left alone, and no re-parenting can wedge the solver again

### Effects
- Fixed: **Show Character Animation** appeared to do nothing until the effect was reloaded. The cue list is baked when a routine is armed and the toggle did not re-arm it, so Play kept running the routine without the cast motion; it now re-arms the current schedule
- A character driven by a routine keeps pace with the effect's own **Speed** control rather than the Characters view's, so a cast and the spell it belongs to no longer run at different rates. It hands the clock back when the toggle goes off, when another model loads, and on leaving the Effects view

### NPCs
- Buffalo, Wivre, Red Raptor, Iron Giant and Byakko Companion were list separators with no model behind them, and now load like any other NPC. Noble Chocobo Companion, which has no model at all, is gone

### Settings
- Settings → **Weather Transition** — how long a weather change takes to cross-fade, in milliseconds (default 3330, the game's 3.33s). Sky colour, fog, lighting, both weathers' particles and the ambient bed all travel on it; 0 snaps straight over. Takes effect on the next weather change, no zone reload
- Settings → **Auto Enable Weather** (on by default) — a zone opens with its sky and weather running even if you turned them off in the last one. Loading an entity used to switch the preference off behind your back, entities having no sky, so every zone opened bare after a model view
- Checkboxes explain themselves on hover instead of carrying a line of text under each one, which takes the Zones tab down to about half its height

### Interface
- **The app's own colour picker.** Clicking a colour swatch now opens ours instead of the webview's: a saturation/value square, hue slider, hex field and R/G/B boxes, in the app's own chrome. The native one had to go because the eyedropper inside it is a dead button - Chromium draws it, but WebView2 implements nothing behind it - and there was no way to put a working one in its place. Right-click still clears the background to checkerboard in the texture and image viewers
- **A working eyedropper**, in the picker beside the hex field. Click it, move the cursor - a magnified loupe follows, showing the pixel under the crosshair and its hex code - then click to take that colour. It reads the whole desktop, not just the app window; right-click or Escape cancels. Browser dev mode falls back to the browser's own eyedropper

---

## [1.1.6] — 2026-09-04

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.1.5...v1.1.6)

### Scenes
- The Actors panel is now **Scenes** (Zone › Scenes / Hide Scenes). It lists every saved scene; **New Scene** starts an empty one, clicking a scene puts its actors on the stage and opens its actor list, and Save (in the panel title, or in an actor's editor) writes the stage back into it. Rename in place, close (take its actors off the stage) or delete from the list; a dot on the scene and a lit Save button mean unsaved changes. Existing actor sets carry over as scenes
- **Add to Camera Sequence** moved from the panel into the actor's editor, next to Save in its title bar
- The Scene popover (background & floor) is now **Viewport**, and the sequencer's weather track is labelled **Weather**, so "scene" only ever means a cast of actors

### Camera Sequencer
- **Actors on the timeline** — a new **Add to Camera Sequence** button in an actor's editor gives that actor two tracks of its own. **Actor** records where it stands at the playhead (position and rotation — move it with the gizmo and record again for a path, splined or straight like the camera), and **Anim** records the motion its editor is playing, so a take can walk an actor across the zone and switch it from "walk" to "idle" where you say. The route is drawn on the terrain in the actor's lane colour, Stop puts the actor back where it was, and actors come back to a saved sequence by name
- Sequenced actors' lanes select the actor when clicked; × drops it from the sequence
- Actors always walk straight lines between their keys; Curve now only shapes the camera path
- Timeline lanes are labelled in full (Camera Position, Camera Rotation, Animation) and an actor's Animation row lines up under its name
- Toolbar reshuffle: frame stepping, keyframe delete / clear and the Loop, Curve, Linear rotation, Lock to Actor, Hide UI and Snap toggles sit in the Length row; Place Lock Actor joins the record buttons below the timeline

---

## [1.1.0] — 2026-09-01

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.12...v1.1.0)

### Animation
- Anim, Schedule and Skill are now a single **Motion** dropdown, grouped into Animations, Schedules and Specials, so it's clear what's playing
- New **Base** setting (None / Idle / Battle) plays your clip on top of a resting pose, blending in and out of it — so a loop reads as "rest, do the thing, rest". Off by default
- Fixed: after playing a skill pack, picking a normal animation replayed the pack's effects and sound over it
- NPC panel rows reordered to a more sensible order

### Camera and floor
- The floor no longer moves with the model. It used to shift with every animation, which looked like the camera was dropping through it
- Selecting another actor no longer throws away your camera angle. Turn it back on with Settings → Reframe camera on Actor Selection
- Outside of zones, the mouse wheel now zooms towards the centre instead of your cursor, so the model doesn't drift off-screen

### Camera Sequencer
- **Lock to Actor** now tracks the actor's hips, so jumps and steps stay in shot
- Scrubbing and stopping hand the camera back in whatever mode you were using, instead of leaving you in fly mode

### Scene and settings
- Settings → **Day Length** — how many real seconds an in-game day takes (default 60)
- Weather and time controls now appear for any zone that has weather
- Navmesh can be loaded from your own folder (Settings → Navmesh Folder)
- Two new backgrounds: Clouds and Rhapsody
- Dropdowns no longer stretch the full height of the window
- Details panel texture list restyled
- Field of view moved to the top of the Graphics popover

### Fixes and cleanup
- Links now open properly on macOS and Linux, not just Windows
- Fixed a freeze when an animation had no frames
- Fixed sounds cutting each other off when a zone loaded several at once
- Settings no longer save half-way if browser storage is full
- Fixed a memory leak in the renderer, and sped up drawing when a filter is on
- Removed leftover hardcoded personal paths from the project
- Development builds no longer nag about updates on every launch
- Plenty of dead code removed and duplicated logic merged

---

## [1.0.12] — 2026-08-31

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.10...v1.0.12)

### NPCs
- NPCs can now play their **own visual effects**, with the Both / Mesh / VFX control and an effect volume slider
- Pick which effect plays from a new **Effect** dropdown. Previously a random one fired on every animation
- New **Skill** dropdown loads the animation packs a trust borrows, so you can play their special moves
- Fixed NPC textures being repainted when their effects loaded
- Fixed models hovering slightly above the floor

### Animation
- PC battle and weapon-skill animations now load their full-body packs, so they animate properly instead of only partly
- Bows and other ranged weapons now stay stowed unless the animation actually uses them, instead of hanging in view through every sword swing
- Fixed a one-frame jolt in the middle of weapon skills like Eagle Eye Shot

### Camera Sequencer
- **Lock to Actor** — keyframes record facing the actor, and playback keeps them in frame
- Effects and sound now play back with your shot, instead of it being silent
- Play always starts from the top, and rewinds the actor with it
- Reaching the end rewinds to the start
- Pressing Play at the end of a clip now rewinds instead of doing nothing
- Scrubbing gives you a normal orbit camera back
- Your work survives closing the panel — named sequences are still saved separately

### Scene
- Scene → **Flat Floor** — a plain coloured ground plane with a colour picker, kept separate from a loaded floor so switching loses nothing

### Browsing and viewers
- Fixed DAT Browser search getting stuck on "Building file index…" forever
- Gear sets now come from the list data, so new sets appear without an update. Adds Abjuration and the Mythic, Aeonic and Prime weapons, and merges Ebur, Furia and Ebon into one section
- Odds and ends in the weapon lists now group under a single "Other" heading
- Images are labelled UI, Cutscene or Map rather than everything being "Map"
- Texture and image viewers remember your background colour and support zoom and pan
- Skeleton animation and info rows can be inspected in Data Struct
- Ctrl + left mouse now pans

---

## [1.0.10] — 2026-08-30

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.9...v1.0.10)

### Zones
- **Region culling** (View → Region Culling) draws only what the zone says is visible from where you're standing
- Invisible collision blocks and duplicate distant copies are now hidden, fixing the flickering surfaces in Ru'Aun Gardens
- Fixed the wrong mesh being drawn in Dynamis and roughly 69 other zones
- Live Selection can now pick sub-area, unplaced and collision objects
- The ZoneDef list shows which sub-area an object belongs to

### Objects panel
- **Meshes / VFX / SFX tabs**, with sound effects playable straight from the list
- Objects grouped by kind — Sky, Water, Collision, Sub areas, Unplaced — with search

### Effects and camera
- Character and NPC pickers under Effects, so you can dress the actor without leaving the page
- Your loaded actor is kept when moving between views
- Better zone framing, and **F** now focuses whatever you have selected

### Settings and updates
- Settings split into **General** and **XI Tools** tabs
- More reliable update checks, with a clearer message when GitHub rate-limits you
- Update checks now work in browser mode
- Settings no longer reset themselves while you're typing in them
- Grid and axes moved to the toolbar only

### Lists
- **Search added to the NPC, Music and Sound Effects lists**, and every list search now looks and works the same
- Fixed HD installs breaking weapon-skill animations
- Data Struct gained click-through tables for effect and particle data

---

## [1.0.9] — 2026-08-29

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.8...v1.0.9)

### Update notifications
- The app now **checks for a new release on start** and shows a dismissable notice with a link. It never holds up startup, and stays silent if you're offline
- A download button showing the file size, and **File → Check for Updates** to look on demand
- Dismissing remembers the version, so it stays gone until the next release

### Effects on your character
- Effects now **play on a loaded character** rather than only an empty stage, attached to the right body parts
- **Show Character Animation** plays the caster's actual casting motion
- Effects are timed to fire on the release frame and blend back to idle
- Spells sit at the right height — Stone V on the floor, Fire and Thunder on the body
- Full **Play / Pause / Rewind / Loop** transport, replacing a single button that couldn't replay anything
- Leaving Effects keeps your actor and list selection
- Fixed particles appearing mirrored and upside down on the character
- Fixed the last part of a movement being skipped during schedules

### New effect types
- Heat haze and distortion effects now render, such as the Utsusemi shimmer
- Ring effects now render
- Fixed spell shells looking solid and over-bright

### Viewport
- **Scene → Background Image** — pick a backdrop for the viewport
- Backgrounds now fill the viewport instead of leaving bars down the sides
- The floor fades out in a circle rather than stopping at a hard edge
- **Scene → Floor Repeat** to tile the floor texture
- New **shadow light gizmo** for aiming the sun that casts your model's shadow; double-click to reset. It can aim behind the model too
- Fixed shadows being cut off by a hard diagonal line at higher sun angles
- Fixed the view slowly zooming itself in over time
- Orbiting after a pan no longer snaps the view back
- Fixed the orbit point sitting past small models, so orbiting swung around empty space

### Zones
- Fixed a generic house interior being drawn on Mhaura's dock, along with about 300 other wrong or duplicated objects across every zone *(reported by Crevox)*

### Data
- DAT Browser rows are **labelled by type** — Zone, Gear, Effect — so you can tell what a file is without opening it
- **Save files are readable** — macro books show as proper macro lists
- **Menu and system text (XISTRING)** is readable and searchable, with placeholders and plurals shown properly
- A draggable table viewer for spell and ability lists

### Interface
- Graphics settings moved from a full-screen modal to a toolbar popover
- A new Scene popover for background and floor
- The settings window was reworked, and Open notes file moved into it
- Tooltips unified and now appear above windows instead of behind them
- Your last effect is restored on start, and grid/axes settings are remembered

### Under the hood
- Background images no longer ship twice, saving 2.6 MB from the download
- Fixed duplicate blank entries appearing underneath real effects in the list

---

## [1.0.8] — 2026-08-27

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.5...v1.0.8)

### Open a zone straight from another tool
- **`--zone` launch** — `xi-model-viewer.exe --zone "ROM/171/34.DAT"` opens the viewer already showing that zone, so a zone editor's Preview button or a shortcut can hand off to it
- Opens **minimal by default** — just the viewport and the Zone panel. Use `--full-ui` for the whole app
- `--weather`, `--time` and `--clock` set the scene up front, and the window title becomes the zone name
- Takes whatever path you have — game-relative, absolute, or a zone id
- A preview is a side trip: it won't overwrite the session the full app returns to next time
- Browser dev mode takes the same options as a query string

### Title UI editing
- **Inspect UiMenu windows** — the frame and its buttons as a table of positions, sizes and navigation
- **Edit and save back to the DAT** through xi-tools, with the file reloading so you can keep iterating
- Changes are written to the right place — pivot, HD or game — worked out per file
- **UiElementGroup inspector** for sprite layouts
- A console panel showing what the tool actually did, with optional auto-close
- Settings for the xi-tools folder, a setup helper, and console toggles

### Notes
- **Write free-text notes on any DAT**, saved to a plain file you can edit outside the app
- **The file tree shows your note as a tooltip**, so a folder of numbered files stops being anonymous
- Unsaved typing survives reloading the file

### Images
- **Title and lobby image packs now load properly** — they used to show one broken set and hide everything else
- **New sprite panel** listing every sprite in a layout, filtered to the image you have selected, with search
- Loose textures that no set claimed (logos and similar) are now listed instead of dropped

### Data Struct
- **Bump maps** preview as normal maps
- **Routes** open as a keyframe table — camera paths from cutscene files
- Event, NPC and dialog tabs stay put even when empty, so the layout stops jumping around
- Dialog can be read by event or as flat lines, with search across both

### Objects panel
- **Meshes and Visual Effects tabs**, listing the zone's effects and which weather they belong to
- **Show and hide individual objects or whole groups**, with moved and hidden rows marked

### File browser and zones
- **Pin favourite files** — they sit in a folder at the top and open without yanking the tree back
- **New Dev / XI Modified zone group** covering the 22 custom dev zones, identified by matching their contents rather than guessing from slot order
- Two more prototype zones added, and stale entries removed
- Fixed zone groups sorting into the wrong place

### Prototype zones and the sequencer
- Better prototype rendering — two-sided doors, spinning windmills, and better choices between duplicate meshes
- **Time track in the Camera Sequencer** — change time of day across a shot, with smooth lighting that doesn't rebuild the scene

### Settings
- Game, HD and pivot paths all in one place
- Auto-switch to WASD flying when a zone loads

---

## [1.0.5] — 2026-08-19

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.4...v1.0.5)

### Zones
- **Data Struct understands the whole zone bundle** — mesh, events, dialog and NPCs together
- **ZoneDef browser** — a searchable, clickable table of everything placed in the zone
- **Particle preview in a window** so you can play generators without taking over the viewport
- **Live Selection** — click objects in the world and drag them on an XYZ gizmo, with undo
- **Fixed prototype zones showing bright green static** instead of their real textures
- Better handling of converted and patched zone files, so object lists stop coming out garbled
- **Pin favourite zones** to a folder at the top of the list
- FPS limit options

### Camera Sequencer
- Two-track timeline (Camera and Scene) — record keyframes, scrub, and drag several at once
- Snapping, curved paths, Space to play/pause, and zoom and pan on the timeline
- A compact transport bar and a **New** sequence button

### Fixes
- **Gear now picks the right race skeleton**, instead of occasionally putting male boots on a female model
- **Folders you collapse stay collapsed** rather than re-opening constantly
- **Show in Explorer works for paths with spaces**, instead of dumping you in Documents
- **The camera stays where you put it** when loading the next model
- Data Struct keeps every character slot listed when inspecting gear
- Auto-play idle is now off by default

---

## [1.0.4] — 2026-08-18

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.3...v1.0.4)

- **Inspect multi-file assets** in Data Struct, with dropdowns for characters and character creation
- **Gear pairs itself with the right skeleton**, and individual slots can be isolated
- **Clickable texture and skeleton rows**, with a floating skeleton tree
- **Play sound effects from the structure view**, click again to stop
- **Path links open in your file manager**, and jump into the File Browser
- Structure search, and a status bar split into left and right

---

## [1.0.3] — 2026-08-18

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.2...v1.0.3)

- **Character creation faces expanded to 8**, with A/B variants
- **Equipment no longer disappears** when reloading
- **Character creation animations play properly**, including their floor staging
- Fixed walking animations on Mithra and similar bodies
- Curated zone groups now sort after the ROM folders

---

## [1.0.2] — 2026-08-13

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.1...v1.0.2)

- **Open any DAT and get the right viewer** — zone, model, image, audio, effect or data — with path search and selection highlighting
- **Falls back to the structure inspector** with a clear message when a file can't be drawn
- **Pre-production zones now load**, so early maps come out far more complete
- More texture types decoded, and texture rows are clickable
- Data Struct toggle on the status bar, and WASD stays on for zones
- Fixed the release build looking in the wrong folder

---

## [1.0.1] — 2026-08-06

[Full changelog](https://github.com/vekien/xi-model-viewer/commits/v1.0.1)

- First public release of XI Model Viewer, under GNU GPL v3
- Refreshed app icons
