# Changelog

All notable changes to XI Model Viewer.

Releases and Windows builds: https://github.com/vekien/xi-model-viewer/releases

## [1.0.8] — 2026-08-27

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.5...v1.0.8)

### Open a zone straight from another tool
- **`--zone` launch** — `xi-model-viewer.exe --zone "ROM/171/34.DAT"` starts the viewer already showing that zone, so a zone editor's Preview button, a shortcut or a shell can hand off to it
- **Minimal by default** — viewport plus the Zone panel (weather, time of day, fog, brightness, background, BGM/ambient volume) and nothing else; **`--full-ui`** opens the same zone in the whole app
- **`--weather`, `--time`, `--clock`** set the scene up front, and the window title becomes the zone name
- **Takes the path you have** — game-relative, a leveleditor `game/ROM/…` path, the DAT's absolute path (game or HD root), or a zone id; unlisted prototype DATs still open by path
- **A preview is a side trip** — it doesn't overwrite your last-opened DAT, doesn't change the page the full app restores to, and doesn't eat the first-launch About greeting. Launched before a game path was ever set, it asks for one and then opens your zone instead of the demo model
- Browser dev mode takes the same options as a query string (`?zone=…&time=18:00`)

### Title UI: inspect, edit, save
- **UiMenu (0x30) windows** — frame and child buttons as a draggable table: position, size and Up/Down/Left/Right nav
- **Edit and save back** — patch x/y/w/h and nav through `xi title menu` (xi-tools); the DAT reloads with edit mode intact so you can keep iterating
- **Writes land in the right root** — pivot (Ashita / override), HD, or game, resolved per DAT
- **UiElementGroup (0x31) inspector** — set header plus sprite layout rows (owner / parent / dest / src), same chrome as the menu window
- **Console output panel** — bottom-left dump of what `xi` actually printed, optional auto-close with a countdown
- **Settings** — xi-tools folder, setup helper, and toggles for the console panel

### Notes on anything
- **Free-text notes per DAT and per UiMenu**, stored in `%LOCALAPPDATA%\XiModelViewer\notes.json` — plain, portable, editable outside the app
- **File tree tooltips show the note**, so a folder of numbered DATs stops being anonymous
- Unsaved typing survives a DAT reload; optional close-on-save for the whole-DAT Notes window

### Images and sprites
- **Title / lobby packs read properly** — `lobb` packs (a few 0x20 textures plus one giant 0x31 layout blob) used to show a single broken set and hide the local textures; those textures are now surfaced and the blob is parsed into sprite rows
- **Sprite panel** under Images — every sprite in the layout, filtered to the atlas you have selected, searchable
- Bare 0x20 textures no set claims (logos, `wardrb`) are listed instead of dropped

### Data Struct
- **Bump maps (0x5D)** decode as height fields and preview as tangent-space normal maps
- **Routes (0x06)** open as a keyframe table — camera paths from scene DATs, with focal length shown as FOV
- **Companion tabs always there** — empty event / NPC / dialog DATs still get a tab, so the chrome stops collapsing as you switch
- **Dialog by event or as flat lines**, with search across both; NPC rows show record and target index
- Texture modals centre themselves

### Objects panel
- **Meshes and Visual Effects tabs** — the VFX catalog lists zone-owned effects and the weather folder each one sits under
- **Per-object and per-group visibility toggles**, with hidden and moved state marked on the row and reset on moved rows only
- Sky and water listed only when Toggle Skybox is on; unplaced objects always listed

### File browser
- **Pin favourites** — pinned files sit in a folder at the top and open without yanking the tree back to their original path
- Multiple top-level roots, each with its own label

### Zone list
- **Dev / XI Modified group** — the 22 custom ROM10/100 dev zones (405–426), named by matching each zone's placement signature against the prototype sources rather than slot order, which is how 407 turned out to be Character Creation
- **Sunny castle town and windmill town prototypes (403, 404)** added; stale 408/413 entries dropped
- **Group ordering fixed** — curated groups were pinned to the bottom by a hardcoded list, so a new group fell through to the ROM-number comparator and sorted next to ROM (base). Anything matching `ROM<n>` now sorts by number and everything else tails alphabetically, so a future group needs no code change

### Prototype zones and the Camera Sequencer
- **Better prototype rendering** — prefer the richer of duplicate meshes, planar two-sided doors, particle-owned mills with spinning `w_mill` companions, an unplaced toggle, and sky / enclosing shells skipped when casting shadows
- **Time track in the sequencer** — a 25px track with lerped time of day, a smooth time-only lighting path that doesn't rebuild the scene, and a rAF-driven day clock

### Settings
- **Game, HD and pivot paths** in one column
- **Auto-switch to WASD on zone load** (fly camera: WASD / QE / Shift / wheel)

## [1.0.5] — 2026-08-19

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.4...v1.0.5)

### Zones that actually work as a toolkit
- **Data Struct knows the whole zone bundle** — mesh, events, dialog, NPCs as related DATs
- **ZoneDef browser** — placements table you can open, search, and click through (including ParticleGenerators)
- **In-modal particle preview** — play generators without hijacking the main viewport; resize, grid, background colour
- **Live Selection** — click objects in the world, hover/select wireframes, drag a solid XYZ gizmo (in-memory moves, undo, reset on moved rows only)
- **Converted / prototype zones** — smarter 0x54 vs 0x64 placement stride so patched DATs don't shred object lists; **A1R5G5B5** palette decode so prototype textures stop looking like green static
- **Pin favourite zones** — hover → pin; pinned maps sit in a folder at the top of the list

### Camera Sequencer
- Two-track timeline (Camera + Scene), record at the playhead, scrub, multi-select + group drag
- Snap, path **Curve**, Space play/pause, compact transport bar, zoom + wheel pan on the timeline
- Fixed-height panel, width-only resize, **New** sequence; Tippy tooltips throughout

### Gear, files, and camera behaviour
- **Gear + race skeleton** resolved from FTABLE / gear tables first (fewer wrong-race skins)
- **Data Struct keeps every character slot** in the DAT dropdown when you inspect a piece
- **File tree collapse sticks** — folders don't re-expand every frame
- **Show in Explorer** fixed for paths with spaces (`Program Files (x86)`, etc.)
- **Camera stays put** after you've orbit/pan/zoomed when loading the next entity DAT
- Auto-play idle is **off by default** (still available in Settings)

### Quality of life
- Tippy-only tooltips for UI hover text
- Cleaner status/path flows around inspect ↔ 3D

## [1.0.4] — 2026-08-18

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.3...v1.0.4)

- **Multi-DAT Data Struct inspection** — dropdowns for characters and creation, RT/SHAPE/DMB/SQLE inspectors, structure search
- **Gear** — auto skeleton pairing and per-slot mesh isolation
- **Clickable texture and skeleton rows**, with a floating skeleton tree
- **SoundEffectPointer playback** — play a row once with a spinning icon, click to stop
- **Path links open in the OS file manager**, and path jumps land in the File Browser
- Status bar split into left/right pills; orbit controls restored after toggling the creation cinematic camera

## [1.0.3] — 2026-08-18

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.2...v1.0.3)

- **Character creation faces** — expanded to 8, with A/B DMB variants
- **Equipment mesh stays put** instead of dropping on reload
- **SQLE animation playback** — PB sequences play as authored absolute poses, including floor staging
- **Prefix-channel locomotion** on equip bodies such as Mithra
- Curated zone groups sort after ROM folders

## [1.0.2] — 2026-08-13

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.1...v1.0.2)

- **Smart-open DATs by type** — zone, model, image, audio, effect, data — with path search and selection highlight in the File Browser
- **Falls back to the structure inspector** with a clear notice when a file can't be drawn
- **Pre-production MZB zones parse** — multi-group meshes, 0x54 placements, strips, blank names — so maps like ROM/0/41 and 46 load more completely
- Additional texture types decoded; structure Texture rows are clickable
- Status-bar Data Struct toggle, and WASD stays on for zones opened from the browser
- Build fix: `beforeBuildCommand` no longer looks for `ui/ui`

## [1.0.1] — 2026-08-06

[Full changelog](https://github.com/vekien/xi-model-viewer/commits/v1.0.1)

- First public release of XI Model Viewer, under GNU GPL v3
- Refreshed app icons
