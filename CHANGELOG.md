# Changelog

All notable changes to XI Model Viewer.

Releases and Windows builds: https://github.com/vekien/xi-model-viewer/releases

1.0.6, 1.0.7 and 1.0.11 were never released, so they have no entry here.

---

## [1.1.0] — 2026-09-01

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.12...v1.1.0)

### Animation
- Anim, Schedule and Skill are now a single **Motion** dropdown, grouped into
  Animations, Schedules and Specials, so it's clear what's playing
- New **Base** setting (None / Idle / Battle) plays your clip on top of a
  resting pose, blending in and out of it — so a loop reads as "rest, do the
  thing, rest". Off by default
- Fixed: after playing a skill pack, picking a normal animation replayed the
  pack's effects and sound over it
- NPC panel rows reordered to a more sensible order

### Camera and floor
- The floor no longer moves with the model. It used to shift with every
  animation, which looked like the camera was dropping through it
- Selecting another actor no longer throws away your camera angle. Turn it back
  on with Settings → Reframe camera on Actor Selection
- Outside of zones, the mouse wheel now zooms towards the centre instead of your
  cursor, so the model doesn't drift off-screen

### Camera Sequencer
- **Lock to Actor** now tracks the actor's hips, so jumps and steps stay in shot
- Scrubbing and stopping hand the camera back in whatever mode you were using,
  instead of leaving you in fly mode

### Scene and settings
- Settings → **Day Length** — how many real seconds an in-game day takes
  (default 60)
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
- NPCs can now play their **own visual effects**, with the Both / Mesh / VFX
  control and an effect volume slider
- Pick which effect plays from a new **Effect** dropdown. Previously a random
  one fired on every animation
- New **Skill** dropdown loads the animation packs a trust borrows, so you can
  play their special moves
- Fixed NPC textures being repainted when their effects loaded
- Fixed models hovering slightly above the floor

### Animation
- PC battle and weapon-skill animations now load their full-body packs, so
  they animate properly instead of only partly
- Bows and other ranged weapons now stay stowed unless the animation actually
  uses them, instead of hanging in view through every sword swing
- Fixed a one-frame jolt in the middle of weapon skills like Eagle Eye Shot

### Camera Sequencer
- **Lock to Actor** — keyframes record facing the actor, and playback keeps them
  in frame
- Effects and sound now play back with your shot, instead of it being silent
- Play always starts from the top, and rewinds the actor with it
- Reaching the end rewinds to the start
- Pressing Play at the end of a clip now rewinds instead of doing nothing
- Scrubbing gives you a normal orbit camera back
- Your work survives closing the panel — named sequences are still saved
  separately

### Scene
- Scene → **Flat Floor** — a plain coloured ground plane with a colour picker,
  kept separate from a loaded floor so switching loses nothing

### Browsing and viewers
- Fixed DAT Browser search getting stuck on "Building file index…" forever
- Gear sets now come from the list data, so new sets appear without an update.
  Adds Abjuration and the Mythic, Aeonic and Prime weapons, and merges Ebur,
  Furia and Ebon into one section
- Odds and ends in the weapon lists now group under a single "Other" heading
- Images are labelled UI, Cutscene or Map rather than everything being "Map"
- Texture and image viewers remember your background colour and support zoom
  and pan
- Skeleton animation and info rows can be inspected in Data Struct
- Ctrl + left mouse now pans

---

## [1.0.10] — 2026-08-30

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.9...v1.0.10)

### Zones
- **Region culling** (View → Region Culling) draws only what the zone says is
  visible from where you're standing
- Invisible collision blocks and duplicate distant copies are now hidden, fixing
  the flickering surfaces in Ru'Aun Gardens
- Fixed the wrong mesh being drawn in Dynamis and roughly 69 other zones
- Live Selection can now pick sub-area, unplaced and collision objects
- The ZoneDef list shows which sub-area an object belongs to

### Objects panel
- **Meshes / VFX / SFX tabs**, with sound effects playable straight from the list
- Objects grouped by kind — Sky, Water, Collision, Sub areas, Unplaced — with
  search

### Effects and camera
- Character and NPC pickers under Effects, so you can dress the actor without
  leaving the page
- Your loaded actor is kept when moving between views
- Better zone framing, and **F** now focuses whatever you have selected

### Settings and updates
- Settings split into **General** and **XI Tools** tabs
- More reliable update checks, with a clearer message when GitHub rate-limits you
- Update checks now work in browser mode
- Settings no longer reset themselves while you're typing in them
- Grid and axes moved to the toolbar only

### Lists
- **Search added to the NPC, Music and Sound Effects lists**, and every list
  search now looks and works the same
- Fixed HD installs breaking weapon-skill animations
- Data Struct gained click-through tables for effect and particle data

---

## [1.0.9] — 2026-08-29

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.8...v1.0.9)

### Update notifications
- The app now **checks for a new release on start** and shows a dismissable
  notice with a link. It never holds up startup, and stays silent if you're
  offline
- A download button showing the file size, and **File → Check for Updates** to
  look on demand
- Dismissing remembers the version, so it stays gone until the next release

### Effects on your character
- Effects now **play on a loaded character** rather than only an empty stage,
  attached to the right body parts
- **Show Character Animation** plays the caster's actual casting motion
- Effects are timed to fire on the release frame and blend back to idle
- Spells sit at the right height — Stone V on the floor, Fire and Thunder on
  the body
- Full **Play / Pause / Rewind / Loop** transport, replacing a single button
  that couldn't replay anything
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
- New **shadow light gizmo** for aiming the sun that casts your model's shadow;
  double-click to reset. It can aim behind the model too
- Fixed shadows being cut off by a hard diagonal line at higher sun angles
- Fixed the view slowly zooming itself in over time
- Orbiting after a pan no longer snaps the view back
- Fixed the orbit point sitting past small models, so orbiting swung around
  empty space

### Zones
- Fixed a generic house interior being drawn on Mhaura's dock, along with about
  300 other wrong or duplicated objects across every zone *(reported by Crevox)*

### Data
- DAT Browser rows are **labelled by type** — Zone, Gear, Effect — so you can
  tell what a file is without opening it
- **Save files are readable** — macro books show as proper macro lists
- **Menu and system text (XISTRING)** is readable and searchable, with
  placeholders and plurals shown properly
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
- **`--zone` launch** — `xi-model-viewer.exe --zone "ROM/171/34.DAT"` opens the
  viewer already showing that zone, so a zone editor's Preview button or a
  shortcut can hand off to it
- Opens **minimal by default** — just the viewport and the Zone panel. Use
  `--full-ui` for the whole app
- `--weather`, `--time` and `--clock` set the scene up front, and the window
  title becomes the zone name
- Takes whatever path you have — game-relative, absolute, or a zone id
- A preview is a side trip: it won't overwrite the session the full app returns
  to next time
- Browser dev mode takes the same options as a query string

### Title UI editing
- **Inspect UiMenu windows** — the frame and its buttons as a table of
  positions, sizes and navigation
- **Edit and save back to the DAT** through xi-tools, with the file reloading so
  you can keep iterating
- Changes are written to the right place — pivot, HD or game — worked out per file
- **UiElementGroup inspector** for sprite layouts
- A console panel showing what the tool actually did, with optional auto-close
- Settings for the xi-tools folder, a setup helper, and console toggles

### Notes
- **Write free-text notes on any DAT**, saved to a plain file you can edit
  outside the app
- **The file tree shows your note as a tooltip**, so a folder of numbered files
  stops being anonymous
- Unsaved typing survives reloading the file

### Images
- **Title and lobby image packs now load properly** — they used to show one
  broken set and hide everything else
- **New sprite panel** listing every sprite in a layout, filtered to the image
  you have selected, with search
- Loose textures that no set claimed (logos and similar) are now listed instead
  of dropped

### Data Struct
- **Bump maps** preview as normal maps
- **Routes** open as a keyframe table — camera paths from cutscene files
- Event, NPC and dialog tabs stay put even when empty, so the layout stops
  jumping around
- Dialog can be read by event or as flat lines, with search across both

### Objects panel
- **Meshes and Visual Effects tabs**, listing the zone's effects and which
  weather they belong to
- **Show and hide individual objects or whole groups**, with moved and hidden
  rows marked

### File browser and zones
- **Pin favourite files** — they sit in a folder at the top and open without
  yanking the tree back
- **New Dev / XI Modified zone group** covering the 22 custom dev zones,
  identified by matching their contents rather than guessing from slot order
- Two more prototype zones added, and stale entries removed
- Fixed zone groups sorting into the wrong place

### Prototype zones and the sequencer
- Better prototype rendering — two-sided doors, spinning windmills, and better
  choices between duplicate meshes
- **Time track in the Camera Sequencer** — change time of day across a shot, with
  smooth lighting that doesn't rebuild the scene

### Settings
- Game, HD and pivot paths all in one place
- Auto-switch to WASD flying when a zone loads

---

## [1.0.5] — 2026-08-19

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.4...v1.0.5)

### Zones
- **Data Struct understands the whole zone bundle** — mesh, events, dialog and
  NPCs together
- **ZoneDef browser** — a searchable, clickable table of everything placed in
  the zone
- **Particle preview in a window** so you can play generators without taking
  over the viewport
- **Live Selection** — click objects in the world and drag them on an XYZ gizmo,
  with undo
- **Fixed prototype zones showing bright green static** instead of their real
  textures
- Better handling of converted and patched zone files, so object lists stop
  coming out garbled
- **Pin favourite zones** to a folder at the top of the list
- FPS limit options

### Camera Sequencer
- Two-track timeline (Camera and Scene) — record keyframes, scrub, and drag
  several at once
- Snapping, curved paths, Space to play/pause, and zoom and pan on the timeline
- A compact transport bar and a **New** sequence button

### Fixes
- **Gear now picks the right race skeleton**, instead of occasionally putting
  male boots on a female model
- **Folders you collapse stay collapsed** rather than re-opening constantly
- **Show in Explorer works for paths with spaces**, instead of dumping you in
  Documents
- **The camera stays where you put it** when loading the next model
- Data Struct keeps every character slot listed when inspecting gear
- Auto-play idle is now off by default

---

## [1.0.4] — 2026-08-18

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.3...v1.0.4)

- **Inspect multi-file assets** in Data Struct, with dropdowns for characters
  and character creation
- **Gear pairs itself with the right skeleton**, and individual slots can be
  isolated
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

- **Open any DAT and get the right viewer** — zone, model, image, audio, effect
  or data — with path search and selection highlighting
- **Falls back to the structure inspector** with a clear message when a file
  can't be drawn
- **Pre-production zones now load**, so early maps come out far more complete
- More texture types decoded, and texture rows are clickable
- Data Struct toggle on the status bar, and WASD stays on for zones
- Fixed the release build looking in the wrong folder

---

## [1.0.1] — 2026-08-06

[Full changelog](https://github.com/vekien/xi-model-viewer/commits/v1.0.1)

- First public release of XI Model Viewer, under GNU GPL v3
- Refreshed app icons
