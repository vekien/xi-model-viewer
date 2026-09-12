# XI Model Viewer

A FFXI asset browser — **zones, NPCs & monsters, playable characters, spell
effects, textures, music, sound effects and raw DAT data** — in a **WebGL2**
viewport.

- One standalone ~38 MB exe. **Tauri 2**, not Electron.
- Embeds vgmstream, the baked asset lists and the viewport backgrounds — nothing to install.
- Skinning runs on the GPU: the vertex shader rotates pre-weighted joint-local
  positions by per-joint pose quaternions, so the CPU only evaluates the skeleton
  pose (one quat/trans/scale triplet per joint per frame).

<p align="center">
  <a href="https://github.com/vekien/xi-model-viewer/releases/latest/download/xi-model-viewer.exe">
    <img alt="Download xi-model-viewer.exe (Windows, latest release)" src="https://img.shields.io/badge/%E2%AC%87%20Download%20for%20Windows-xi--model--viewer.exe-2ea44f?style=for-the-badge&logo=windows&logoColor=white">
  </a>
  &nbsp;
  <a href="https://github.com/vekien/xi-model-viewer/releases/latest">
    <img alt="Latest release" src="https://img.shields.io/github/v/release/vekien/xi-model-viewer?style=for-the-badge&label=Latest&color=555">
  </a>
</p>

## Download

- **Windows:** [Download xi-model-viewer.exe](https://github.com/vekien/xi-model-viewer/releases/latest/download/xi-model-viewer.exe)
- **Linux:** [Latest release](https://github.com/vekien/xi-model-viewer/releases/latest) (`.deb` / `.AppImage`, see [LINUX.md](LINUX.md))
- [All releases](https://github.com/vekien/xi-model-viewer/releases)

## Features

### Zones

- Load any zone with its full geometry, textures and collision.
- Time of day and weather — rain, snow, fog, auroras — with a cross-faded transition.
- Zone BGM and ambient sound effects play with it; adjustable brightness and scene background.
- Object browser groups every placement by kind (sky, water, collision, sub-areas, unplaced), with per-object and per-group visibility, plus the zone's VFX and sound groups.
- **Live Selection** — click an object in the world, drag it on an XYZ gizmo, undo.
- **Enable LOD** — draw objects at the detail level the zone actually placed them at.
- **Toggle NPCs** — stand the server's NPC placements (from CatsEyeXI's `npc_list`) on the zone, each at its position and heading, wearing its look.

### NPCs & monsters

- Categorised tree of every entity model in the client.
- One **Motion** picker covers animations, schedules and the skill packs a trust borrows.
- Scrub the timeline frame by frame; playback speed 10–200 %.
- Play the entity's own VFX routines, with their own volume.
- Inspect the bone hierarchy in a skeleton overlay.
- **Base** (Idle / Battle) lays a clip over a resting pose — blend in, play, blend back.

### Characters

- Compose a PC from race, face, gear and weapons.
- Gear grouped by set — Artifact, Relic, Empyrean, Ebur · Furia · Ebon, Abjuration, Mythic, Aeonic, Prime.
- Equipped weapons play their weapon-skill animations; ranged weapons stay stowed until the action draws them.
- Battle stances named per race, read from each weapon DAT's own animation type.
- The 40-character look string is generated and copyable.
- **(WIP) Character Creation** — the character-creation screen's high-poly models: 8 faces per race, A/B texture variants, with or without initial equipment.

### Effects

- Search and play any spell or ability VFX — magic, job abilities, summons, weapon skills.
- Play it on an empty stage, or on a loaded character or NPC, attached to the joints the DAT names.
- The caster's own cast animation plays with it, on the effect's clock.
- Play / Pause / Rewind / Loop transport, playback speed, and the effect's sound.

### Camera & sequencer

- WASD fly camera with roll (Alt+Q / Alt+E), fly speed in steps of 5, render-distance slider.
- **View › Toggle Orthographic** — orthographic projection, for flat elevation and isometric views with no perspective. Orbit, pan, zoom and WASD all keep working; in ortho W/S zoom, since a dolly along the view axis draws the same picture.
- Multi-track keyframe timeline: camera position, camera rotation, weather, time of day.
- Spline or linear paths, with eased timing through keys so shots don't change pace at a keyframe.
- **Curve rows** — click a camera lane to graph its channels underneath it.
- **Lock to Actor** keeps a moving subject framed by tracking the pelvis.
- **Actor tracks** — record where an actor stands and which motion it plays, so a take can walk it across the zone and switch it from walk to idle on cue.
- Effects and sound play back with the take; sequences save by name.

### Scenes

- Named casts of actors on a zone — open one and its whole cast appears.
- Place NPCs, composed characters and lights on the terrain with a click-to-place ground trace.
- Move / rotate / scale gizmo (1 / 2 / 3, Esc to deselect, F to frame), Ctrl+C / Ctrl+V to duplicate.
- Each actor runs its own motion, schedule, effect routines and frame scrubber, and casts sun shadows.
- Point, spot and ambient lights take colour or temperature, intensity and radius.

### Database

- The client's record DATs as searchable, sortable tables: items (decoded stats, jobs, slots, icons), quests, missions, key items, titles, spells, abilities and the other d_msg string tables.
- English or Japanese.
- Advanced filters — a rule builder, or an SQL-ish query string such as `str > 20 and int > 20`.
- CSV / JSON export.
- One-click `xi mv database` bake so tables load instantly instead of parsing 20 MB DATs.
- **Settings → DAT Database** updates and imports the baked tables; File → Export saves the open table.

### Data — the DAT inspector

- Walk any DAT's section tree: folders, resource types, header peeks (texture size and format, joint counts, sound ids) — no payload dumps. Textures open in a viewer on click.
- FTABLE/VTABLE pairs render as a searchable file-id → DAT table whose rows jump to the named DAT.
- Gear model ids browsable per race and slot; monster and NPC model ids resolved from the same tables.
- Bump maps preview as normal maps; routes open as keyframe tables.
- XISTRING menu strings and `USER\` macro books get real layouts; spell and ability tables open in a draggable inspector.
- Environment, ZoneInteractions and a ZoneMesh preview cover the zone-side records.
- **Notes** — free text on any DAT, kept in a plain, editable `%LOCALAPPDATA%\XiModelViewer\notes.json`, shown as a tooltip in the file tree.

### Title UI editing

- Inspect UiMenu (0x30) windows and UiElementGroup (0x31) sets as tables.
- Patch position, size and nav, and **save back to the DAT** through the xi-tools CLI.
- Writes land in the right root (pivot / HD / game), resolved per DAT.

### Images

- Browse every UI, map and cutscene texture DAT, with a filter, per-set list, zoom and pan.
- **Sprite panel** lists every sprite in a title/lobby layout, filtered to the selected atlas.

### Music & Sound FX

- Play any BGW/SPW track, decoded by an embedded vgmstream.
- Live waveform visualiser, seek bar and loop info.

### Export

- glTF / FBX model export via the xi-tools CLI, with a part picker and Mesh / Animation tabs.
- **Batch Export** for models, animations and zones, plus **Music** and **Sound FX** tabs that decode straight to `.wav` in-app — no xi-tools needed, just the game path.
- Sounds export under their own game folder, so same-numbered tracks from different expansions don't collide; filenames can be the real track name or the game's.
- A banner reports what was written and where, with a button to open the folder.

### Viewport

- Background images, a flat floor with a colour picker, floor repeat and a radial edge fade.
- Trackball gizmo aims the sun that casts the model's shadow.
- Overlays: wireframe, unlit, skeleton, collision, navmesh, skybox, sound markers, axes, grid.
- HD and PIVOT DAT roots toggle live.
- Shadow, render and effects distance, field of view, FPS limit and render resolution.

### Throughout

- Type-to-filter dropdowns and search on every asset list, with arrow-key navigation.
- Pin favourites in the zone, NPC, character and DAT lists.
- Reveal any DAT in the system file manager.
- Built-in colour picker with a working desktop eyedropper and a magnified loupe.
- `--zone` opens a single zone chrome-free, for another tool's Preview button — see [Zone preview launch](SETUP.md#zone-preview-launch).

## Screenshots

Place NPCs, characters and lights in a zone and light the scene at dusk:

![Orcish Warchief and a Hume in West Ronfaure at dusk, lit by a placed lamp](ss/17.png)

Zones render with weather and time-of-day; the object browser lists every placement:

![Qufim Island at night, auroras overhead](ss/1.png)

![Lower Jeuno in daylight](ss/6.png)

NPCs and monsters play their animations, with a frame scrubber and speed control:

![Mamool Ja mid-animation](ss/2.png)

![Provenance Watcher](ss/5.png)

Compose a character from gear and weapons, and preview weapon-skill animations:

![Hume Female character with katana weapon skill](ss/3.png)

Browse textures, and play music / sound effects with a waveform visualiser:

![Cutscene concept-art image viewer](ss/4.png)

![Music player with waveform](ss/7.png)

![Sound-effect player](ss/8.png)

Play any spell or ability effect on its own stage:

![Haste spell effect](ss/15.png)

![Behemoth's Meteor filling the stage](ss/16.png)

Inspect any DAT's structure — folders, sections and what lives in each — and
browse the FTABLE/VTABLE file-id → DAT mapping:

![Entity DAT structure with animations, textures and meshes](ss/12.png)

![Zone DAT structure: weather folders, sound pointers, generators](ss/13.png)

![File table: every file id resolved to its DAT path](ss/11.png)

![Gear model ids per race and slot](ss/14.png)

Browse the client's record DATs as tables — items with decoded stats, jobs and
icons, quests, missions and the string tables — with filters and CSV / JSON export:

![Database: the armor table with decoded stats and an item detail card](ss/18.png)

---

Want to build it yourself or tinker with the code? See [SETUP.md](SETUP.md).
