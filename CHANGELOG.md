# Changelog

All notable changes to XI Model Viewer.

Releases and Windows builds: https://github.com/vekien/xi-model-viewer/releases

Version numbers follow the tags that were actually published — 1.0.6, 1.0.7 and
1.0.11 were never released, so they have no entry here.

---

## [1.1.0] — 2026-09-01

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.12...v1.1.0)

### One Motion picker instead of three
- **Anim, Schedule and Skill are now a single Motion dropdown**, grouped into
  Animations / Schedules / Specials, so it is always obvious which one is
  playing. Ids carry an internal prefix because a schedule and a clip can share
  a name; a Special stays the shown selection while its own clip runs, rather
  than flipping over to the entry it added under Animations
- **NPC panel rows reordered** to Show, Motion, Effect, Playback, Frame, Speed,
  Volume, Base
- **Fixed: a Special left its routine armed.** After playing a skill pack,
  picking a plain animation kept the pack's routine live, so Play re-fired its
  VFX and sound over an unrelated clip. The routine is now armed only while the
  pack's own clip is selected, and switching away takes it off the stage too

### Base Anim — play an action over a resting pose
- **Base (None / Idle / Battle)** plays a resting clip underneath and lays your
  selection over it as a montage: blend in, play through, blend back, rest
  again. A loop reads as "rest, do the thing, rest" rather than a clip cutting
  to itself
- Built on the existing schedule machinery rather than a second system — a
  schedule clip is already "segments over a base clip blending back out", so the
  only missing piece was `transIn` in `pose.js`, the mirror of the existing
  `transOut`. Measured on `at0` over `idl` with 6-frame blends, the pose is exact
  on the base at both ends
- A schedule keeps its own command sequencing; only the command that finishes
  last hands back to the base, so a routine reads as one action instead of
  sagging between commands
- **None is the default**, so existing behaviour is unchanged unless you ask for
  a base

### The floor stays put, and so does the camera
Two long-standing complaints, both mis-attributed to the camera at first —
per-frame traces showed `camera.eye` byte-identical across every gesture, so the
search moved elsewhere.

- **The floor is fixed at Y = 0.** It used to be placed at the model's feet and
  re-placed whenever the pose changed; frame-0 sole height varies by up to 0.14
  between clips on one model (`bf0` −0.135 vs `idl` 0.009), so it jumped on
  every pick and could rise past a low camera — which reads as the camera
  dropping through the floor. A floor is scenery now, and nothing moves it
- **Selecting another actor no longer re-frames the camera**, throwing away the
  shot you just composed. Settings → **Reframe camera on Actor Selection**, off
  by default. The first actor of a session is still framed, since there is no
  view to preserve then
- **Off a zone, the wheel zooms on the orbit centre** rather than the cursor. A
  zone is a place you navigate; everything else is one subject already centred,
  and cursor-anchored zoom drags it off centre

### Camera Sequencer
- **Lock to Actor now aims at bone0002 (the pelvis)** — the actor's centre of
  mass — so a leap or a step stays framed. The rest-pose bounds centre would let
  them walk out of shot; it stays as the fallback for anything without a
  skeleton, such as a bare effect
- **Scrubbing and stopping hand the camera back in the mode you drive in** —
  fly with WASD on, orbit otherwise. Only playback needs fly mode, and being
  stranded in it meant the next drag behaved as the sequence left it rather than
  as you set it

### Scene, settings and dropdowns
- **Settings → Day Length** — real seconds per in-game day for the day/night
  cycle, default 60. Junk input saves as the default rather than blocking. The
  button's tooltip is now "Auto Play Day/Night cycle"
- **Weather and time controls no longer require a 0x2F sky dome** — any zone
  that declares weather gets them
- **Navmesh loads from Settings → Navmesh Folder** before falling back to the
  bundled copy
- **Combo dropdowns cap at 340px again.** Headless UI's anchor writes an inline
  `max-height` of the whole viewport, the same override the `max-width` rule
  already worked around. Group headers are no longer sticky either — pinned at
  the top, one blocked the panel's highlight gradient and drew as a flat band,
  so the same header read as two different styles
- **Details panel texture list restyled** as rows
- **New background images** — Clouds and Rhapsody, plus the `Basic*` renames.
  Picked up by the glob in `bgs.js`, so adding one needs no code change
- Field of view moved above the divider in the Graphics popover

### Code review pass — paths, platforms, races and cleanup
**No machine-specific paths left in the tree:**
- Dropped the hardcoded `D:\xidata` AltanaListener vgmstream fallback. vgmstream
  is already embedded via `include_bytes!` and extracted to the user cache, so
  the chain is env → co-located → embedded → PATH → None
- The `xi` CLI shim resolves from `USERPROFILE`/`HOME` instead of a literal
  `C:\Users\Josh\.local\bin\xi.exe`, matching `find_xi` on the Rust side
- `bake-*.mjs` now require `--src` rather than defaulting to a personal path

**Correctness:**
- **`open_url` was Windows-only** despite shipping macOS and Linux bundles; it
  now has the same `#[cfg]` branches `reveal_path` already had
- **A zero-length clip froze the model.** `animFrame %= 0` is NaN, which then
  fed `evaluate()` every frame. `setAnimation` and `seekTo` already guarded
  against it; the render loop did not
- **Concurrent sound decodes clobbered each other.** `decode_vgmstream` named its
  temp file per process, not per call — and Tauri runs sync commands on a thread
  pool, so a zone load decoding several sounds at once collided. Same fix in
  `serve.py`
- **Bumping `VGM_VERSION` now forces a re-extract.** The per-file skip was keyed
  on byte length alone, so a same-size replacement was never rewritten
- **Settings save is one `try` block.** Seventeen bare `setItem` calls meant a
  quota error could persist `gamePath` but not `xiPath`, tearing settings in half
- **`XI_DATA_DIR` meant two different things** — `main.rs` appended
  `XiModelViewer`, `tools.rs` used it bare, so setting it split `notes.json` from
  the xi-tools install. `tools.rs` now matches `main.rs`

**Renderer:**
- **Added `Renderer.dispose()`.** Nothing freed the GL objects on teardown, so
  every HMR cycle leaked buffers, VAOs, textures and FBOs. It deliberately does
  not call `loseContext()`: the canvas outlives the renderer and a lost context
  stays lost, which would break the next mount
- **Cached the normalised source path per batch.** `_sourceIn` ran
  `toLowerCase` + `replace` + a regex for every batch in every draw pass whenever
  a filter was set
- **Collapsed `setMeshSourceFilter` and `setHiddenSources`**, which were
  identical, so filter keys and batch keys cannot drift apart

**Dedup and dead code:**
- One `github.rs` for the release-fetch algorithm that had three copies, two of
  them in this crate under different constant names — with offline tests
- Extracted the diverged `:ensure_rc` from `Start.bat`/`Build.bat` into
  `scripts/ensure_rc.bat`
- Deleted `buildSolidGizmoMesh`, `projectRayOnAxis`, `unclaimedTextures`, a stray
  `console.log` and a dead double-allocation in the skeleton overlay

**`dev/` removed, dev server tightened:**
- `xi mv update` in xi-tools replaces every baker, so the bake scripts and their
  JSON are gone. `serve.py` moves to `scripts/` (it is the browser `/fs` backend,
  which `xi mv update` does not replace), and browser-dev user data moves to
  `.user-data` at the repo root
- `_resolve` had a sandbox check whose branches both returned the same value,
  reading as a guarantee it never gave. Removed, with a docstring saying the
  `127.0.0.1` bind is the only bound
- `/fs/list` and `/fs/read` now 404 rather than 500 on a missing file
- Default dev-server port is 8766, matching what `vite.config.js` proxies to

**Also:** granted `core:event:allow-listen` so the xi-log and tools-progress
listeners work; the boot update check is skipped on dev builds, which always
report the committed 1.0.1 and so nagged on every run; dropped the inert
`PlacementPanel` memo deps and their `void` statements; documented `XI_DATA_DIR`
and `XI_TOOLS_DIR`.

---

## [1.0.12] — 2026-08-31

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.10...v1.0.12)

### NPC effects
- **Assets → NPCs gets the Both / Mesh / VFX control and the effect volume
  slider.** An NPC keeps its routines inside the model DAT itself, so the actor's
  own path is the effect source
- **Nothing plays until you pick a routine.** An NPC has no `main`: its routines
  are event-keyed (`dead`, `atk0`, `gurd`, `cast`, `damg`, …) and the server
  fires them, with nothing in the DAT linking `ded0` to `dead`. The old "main,
  else first playable" fallback picked an arbitrary routine and replayed it on
  every clip — one effect for every animation, on every NPC. Routines are now
  listed in an **Effect** dropdown instead

### Skill packs
- **`npcs.json` entries carry `anims: [{path, clips}]`** — the animation packs a
  trust borrows. Each pack is self-contained: one clip plus its whole VFX bundle
  under a `main` routine, the same shape as a PC action DAT
- **A new Skill dropdown loads one pack at a time**, selects its clip and arms
  its routine. One at a time because a set reuses clip ids, and merging would
  shadow the duplicates

Two fixes fell out of getting that on screen:
- **`attachEffectSystem` deleted the incumbent GL texture on a name clash.**
  Harmless for a PC (separate effect DAT, no overlap), fatal for an NPC whose
  effect DAT *is* the model DAT — every body texture collided with itself and was
  re-decoded through the particle path, repainting the model. It now leaves alone
  the names the geometry actually draws with
- **The floor was grounded on the bind pose**, whose straight legs hang below
  every animated one — measured 0.0704 under Iroha's idle soles, which reads as
  hovering. It re-grounds on frame 0 of each clip, and `fitCamera` no longer
  undoes that. Framing still uses rest bounds; a pivot that moves with the
  animation makes the model swim

### Camera Sequencer
- **Lock to Actor** — keyframes record facing the actor, and playback re-solves
  the rotation every frame rather than interpolating it. Interpolated yaw/pitch
  cut the corner where the path swings around
- **Play always runs from the top**, cutting and rewinding the actor clip the way
  Stop does. It used to resume from the playhead while the actor restarted at 0,
  so a take begun anywhere but the start ran short against a full-length action
- **Effects and sound now play.** The paired routine is re-triggered from the
  clip's loop point, and a sequence runs the clip once with looping off — a shot
  used to play mesh-only
- **Scrubbing hands back an orbit camera** at the same eye and look direction.
  Only playback needs fly mode; leaving it on meant the next drag flew away from
  the shot
- **Reaching the end rewinds to frame 0**, so the viewport and the timeline agree
  on where the next take begins
- **The working document survives closing the panel** — keyframes, length, fps
  and toggles. Named sequences stay a separate explicit save
- **Play at the end of a non-looping clip rewinds first.** It used to advance
  straight past the end and stop on the same frame, which read as a dead button

### Animation fixes
- **PC battle and weapon-skill packs load properly** — battle skirt (`btl2`)
  packs load per weapon type, cross-directory `Motion.csv` ranges expand so WS
  clips get their waist/upper motion DATs, partial clips underlay idle, and
  stance anims stay visible
- **No invented blend-out when a schedule segment sets `transOut` 0.** Eagle Eye
  Shot jittered on the `yu0` → `yu1` hand-off, reading as a single frame of
  battle stance mid-weapon-skill: the routine leaves a real gap (yu0 ends at 58,
  yu1 starts at 60) and both carry `transOut` 0, so the substituted 8-frame
  default had the pose a quarter of the way back to base before the successor
  claimed the joints. `transOut` 0 means "hand straight over", so the final pose
  is held instead. Measured across all 21 PC schedules, only `main` changes — its
  worst per-frame jump drops from 7.965 to 4.974
- **The ranged weapon is stowed unless the action uses it.** A bow hung in view
  through every melee swing: ranged weapons have no grip joint to re-parent
  (`standardJointIndex` 255), so the mesh sat wherever its back-mount bone put
  it. The game scales the weapon to 0 until it is drawn; the viewer now has a
  renderer deny-list that does the same, and re-parents the bow onto the bow hand
  (`gear_sets.json` `handRef`) for actions that use it

### Scene → Flat Floor
- **A plain untextured ground plane with a colour picker**, held separately from
  a loaded floor so ticking it discards nothing. It reuses the existing plane
  with a 1×1 solid texture, keeping the fade ring, the fog and the model's shadow

### DAT Browser, gear lists and viewers
- **Fixed a wedged file-index search.** DAT Browser search could stick on
  "Building file index…" forever. Three things lined up: `loadMergedTables`
  cached an all-empty result (its per-ROM catch is for uninstalled expansions,
  but it also swallowed "no game path yet"), `ensureFilePathIndex` guarded with
  `if (fileIndexRef.current)` and an empty array is truthy, and `FileTree`
  rendered an empty index and a missing one identically. The Files view is the
  default on a fresh profile, so the index effect ran before settings landed and
  poisoned both caches. Now an empty table read throws instead of caching, the
  guard tests `?.length` and clears the ref on failure, and a failed index says so
- **Gear sections come from `characters.json` `gearSections`** rather than a
  hard-coded array, so a new set in the generator needs no change here. Adds
  Abjuration and the Mythic/Aeonic/Prime weapon sets, and merges Ebur, Furia and
  Ebon into one section
- **Weapon-slot leftovers fold into one "Other" bucket** pinned to the bottom —
  Unidentified, the missing-DAT one-off and everything ungrouped. "None" is
  exempt and still pins to the top
- **DAT Browser badges images by group** — UI, Cutscene, Map — instead of calling
  every image a Map
- **Data Struct: SkeletonAnimation and Info rows are inspectable**
- **Texture and image viewers get a persisted background colour** (right-click
  clears back to the checker) plus zoom and pan
- **Ctrl+LMB pans** the viewport
- Gear lists resynced from xi-tools (the Limbus set was retired upstream)
- AGENTS.md documents how to run the app outside Tauri and debug it

---

## [1.0.10] — 2026-08-30

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.9...v1.0.10)

### Zone geometry and culling
- **PVS region culling** — parses 0x1C `drawDist` / `subAreaId` / `regionPtr` and
  builds region sets with a camera-based region pick, under **View → Region
  Culling**
- **Collision proxies (drawDist 1.0) are hidden**, as are far-copy `m_`/`lnd_`
  stand-ins when a richer twin is placed — this is the Ru'Aun z-fighting fix.
  Sub-area sets draw under PVS
- **Live Selection can pick sub-area, unplaced and collision objects** when they
  are visible
- **Section-fourcc mesh aliases are deferred** so they cannot steal real names —
  this fixes Dynamis `saku` and `stardust`→`star`, plus roughly 69 similar zones
- The ZoneDef modal shows the sub-area id

### Objects panel
- **Meshes / VFX / SFX tabs** in a segmented style, with SFX coming from live
  `listSoundGroups` and offering play plus focus
- **Kind sections** — Sky, Water, Collision, Sub areas, Unplaced — with kind
  search, denser rows and an inset list shell
- Close only; the minimize control and footer are gone

### Effects and camera
- **EffectActorsPanel** puts Character and NPC pickers under Effects, keeps the
  loaded actor across views, and forces one F-style reset when leaving Zones for
  Effects/PC/NPC
- **Zone framing is FOV-aware**; entities and effects keep radius × 2.4, and **F
  focuses the current selection**
- **The camera F-resets on any Assets view switch**

### Data Struct
- **Click-through tables for EffectRoutine, SpriteSheetMesh, ParticleMesh,
  ParticleKeyFrameData and WeightedMesh**, with atlas textures paired beside
  sheets and meshes

### Settings, tools and updates
- **Settings split into General and XI Tools tabs**, with `tools_status` reading
  disk only and `tools_check_updates` doing the network call
- **GitHub API plus HTML fallback** for release lookups, and clearer rate-limit
  errors
- **The app update check runs through Tauri / `serve.py`**, avoiding a
  browser→GitHub CORS failure
- **Settings no longer resets mid-edit** — the draft is snapshotted only when the
  modal opens, not on every FPS re-render. Grid and axes moved to the toolbar only

### Lists and search
- **Shared Search fields on the NPC, Music and Sound Effects lists**, and every
  left-hand list search unified onto the same inset text field (search icons and
  Options rules dropped)
- **HD no longer breaks weapon-skill animations** — schedule and motion packs
  load from game/pivot only, skipping HD stubs, and focus paths match via
  ROM-relative keys
- Effects Actors gear slots expanded, with a close/status toggle and an NPC inset
  shell
- Right-rail padding and gap polish, and shared UI chrome throughout

---

## [1.0.9] — 2026-08-29

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.8...v1.0.9)

### The app tells you when there's a new release
- **A background release check on boot.** It asks GitHub for the newest published
  release and, when it is newer than the running build, raises a dismissable
  "Update available" notice with a link. Every failure path — offline,
  rate-limited, timed out — resolves to nothing, so a failed check is invisible
- **Nothing waits on it.** It runs from its own effect and is never awaited by
  startup, and a zone-preview window skips the check entirely
- **OK remembers the version**, so the notice stays gone until the next release
  ships
- **A green download CTA with the exe size**, and **File → Check for Updates**
  with an up-to-date panel for checking on demand

### Effects play on your character, with the cast animation
- **Actor-bound generators attach to the character's skeleton.** 91% of
  generators in retail effect DATs are SourceActor/TargetActor and the joint is
  already in the data (`attachedJoint0`) — joint 0 is only 54% of them, so a
  fixed root attach would misplace the rest onto hands, head and feet
- **Particles no longer come out mirrored against the actor.** Joint transforms
  are handed over pre-multiplied by `DISPLAY_ROT`, which cancels the one applied
  on the way out — otherwise particles sat at the reflection of their joint with
  smoke sinking instead of rising
- **"Show Character Animation" plays the caster's motion.** The cast is not the
  0x05 op — it is a call to a schedule on the character's own DAT (`shbk` black,
  `shnj` ninjutsu, `shwh` white) which `flattenRoutine` was discarding as
  unresolvable. Every race ships those `sh*` schedules empty while the `ca*` twin
  carries the ref, so the twin is read instead
- **The effect is delayed so generators fire on the release frame**, and the cast
  is one clip with `segments`, so SkeletonPose cross-fades back to idle over 0.3s
- **Effect attach slots (0/1/21/43/48…) map to actor height** rather than raw
  bones, so Stone V stays on the floor and Fire/Thunder sit on the body
- **A full transport — Play / Pause / Rewind / Loop.** The old single button was
  labelled Stop but only ever set `effectPaused`; a non-looping routine now parks
  instead of tearing itself down, so Rewind and Play can replay it
- **Returning from Effects to NPC/PC keeps the loaded actor** and restores list
  selection state
- **A schedule segment no longer drops one step early.** The release check was
  `< 1`, so the last 1/`transOut` of the travel happened in a single frame — this
  affects schedule playback generally, not just casts

### New particle types
- **0x22 Distortion** — a billboard quad that refracts a frozen scene grab by
  `hazeOffset`, for heat haze and Utsusemi shimmer
- **0x24 Ring** — a procedural ring built from `ringMeshParams`
- **The opaque-snap hack no longer applies to effect shells.** Alpha-blended
  *zone* particle meshes do snap past the halfway point (confirmed on Bibiki
  Bay's ocean), but forcing a = 1 on a spell shell made Utsusemi's cage read as
  solid and over-bright, so the snap is gated on association kind

### Viewport: backgrounds, floor and light
- **Scene → Background Image**, backed by `ui/bgs/` and baked at build time. The
  renderer draws it as a cover-fit full-screen quad after clear with depth off,
  so models and floors sit on top; it is skipped when the skybox is on
- **Backgrounds are cover-fit, not contain** — the clear colour used to show as
  bars down the side of the canvas. Both scale factors stay ≤ 1 so the sampler
  never reads outside [0,1]
- **The floor fades out on a circle** instead of ending on a hard horizon.
  Radial, not square, or the corners would reach further than the sides; the
  fully-faded ring discards rather than writing depth
- **Scene → Floor Repeat**, with the per-texture default and your multiplier kept
  apart so picking a different floor re-derives the default without discarding
  the setting
- **Fixed a runaway canvas that read as being zoomed in.** `resize()` now
  measures the window, not the canvas's own layout box — deriving the buffer from
  `clientWidth` is self-referential, so buffer → layout → buffer grew every frame
  until it pinned at 8192
- **Entity shadows no longer clip on a hard diagonal.** Shadow maps are fitted to
  the model's corners *plus* those corners dropped down the light onto the floor;
  the old range came from model bounds alone, so past ~30° of sun elevation the
  shadow's far end fell outside near/far
- **A shadow light gizmo** (bottom-right, Shadows on only) overrides the
  zone/entity sun direction for cast shadows; double-click resets and the
  direction persists
- **The light gizmo can reach the far hemisphere.** `hitDir` returned
  `Math.sqrt(1 - d2)` for z, which is never negative, so dragging could only ever
  aim the light in front of the model. A screen point maps to two directions, so
  the second handle is the antipode, drawn mirrored through the centre;
  right-dragging it negates the vector. The ray dashes when the light passes
  behind
- **Orbit after a pan pivots around the model** instead of snapping the view back
- **The orbit pivot no longer overshoots small models.** Switching fly → orbit
  dropped the pivot at least 5 units ahead of the camera, which suits a zone but
  not an entity a couple of units across. The 5-unit floor is zones-only now

### Data Struct and the DAT browser
- **DAT Browser rows are labelled** — "Zone", "Gear", "Effect" — from data the
  app already holds: the baked lists, the merged FTABLE map and the gear/zone-id
  tables. A miss returns nothing rather than guessing
- **`USER\<id>\` save files read properly.** They are not sectioned resource DATs
  and previously fell through to the "not a sectioned DAT" card; `mcr.dat` /
  `mcr<N>.dat` macro books and `mcr.ttl` / `mcr_2.ttl` book names now get real
  layouts, everything else a hex/strings view
- **A draggable table inspector** for SpellList (`mgc_`), AbilityList (`comm`)
  and generic `mnc2`/`mon_`/`levc` tables
- **XISTRING menu string tables** parse in the Data viewer with searchable
  index/text rows — TOS and lobby help text, menu labels and so on
- **XISTRING lengths and FA/ED control codes decode correctly** — u16 lengths
  (the high word is flags), with runtime placeholders rendered as `{n}`/`{s}`/`{#}`
  plus singular|plural forms and `{PS}`

### Zone fidelity
- **Fuzzy mesh resolve no longer latches onto fourcc aliases.** Mhaura's
  `ship_room` is a sub-area placeholder with no mesh of its own, but the fuzzy
  pass normalised it to "shiproom", matched that tail against the 4-char
  section-id alias `room`, and drew `room-hanyou` — a generic house interior — on
  the dock, where nothing renders in game. Fuzzy matching is now restricted to
  real 0x2E mesh names. Across all 601 zone DATs this changes 306 of 1,106,615
  placements: 296 phantom or duplicate draws dropped, and 10 `id_bus_path`
  placements corrected from the fourcc `path` to the real mesh `bus_path`
  *(reported by Crevox)*

### UI plumbing
- **The Graphics modal became a toolbar popover** — resolution scale, shadow
  distance and FPS cap now use the same chrome as the FOV and Scene popovers, and
  `GraphicsModal.jsx` is gone. One less full-screen modal for settings you tweak
  while looking at the viewport
- **A Scene popover** for background and floor, next to Graphics
- **Native `title` tooltips moved onto Tippy** across 19 panels and modals,
  keeping existing aria-labels for accessibility
- **The settings modal was reworked**, and **Open notes file moved into Settings**
- **Tippy raised above modals**, with tighter UiMenu/UiElementGroup notes wiring
- **The tools bridge is exposed to the UI** — the `src-tauri` tools command
  surface plus the `toolsBoot`/backend hooks the front end calls through
- The last effect is restored on boot; empty-stage axes orientation fixed;
  grid/axes preferences kept

### Build and lists
- **Background images ship once, not twice.** `ui/public/bgs/` held a
  byte-identical second copy of every background — Vite bundled `ui/bgs/` through
  the glob *and* copied `public/` verbatim, costing 2.6 MB of the build
- **Baked entries carry only `path`.** Effect entries duplicated their DAT
  location as `dir` + `file` alongside the full path; `EffectList` now derives the
  `15/89` badge from the path, so search matches either form
- **Placeholder duplicates dropped from the lists.** The upstream CSVs list some
  DATs twice — once named, once blank — and the baker turned the blank row into a
  "181/55" placeholder that read as a second effect sitting under the real one.
  Two genuine names for one DAT (Corsair's 164/61 is both Dancer's Roll and
  Double-Up) are left alone
- Baked lists now emit 1-space indent to match each other, so a rebake is a small
  diff rather than a 35k-line reformat
- Dropped the dead `did_sync` flag in setup

---

## [1.0.8] — 2026-08-27

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.5...v1.0.8)

### Open a zone straight from another tool
- **`--zone` launch** — `xi-model-viewer.exe --zone "ROM/171/34.DAT"` starts the
  viewer already showing that zone, so a zone editor's Preview button, a shortcut
  or a shell can hand off to it
- **Minimal by default** — viewport plus the Zone panel (weather, time of day,
  fog, brightness, background, BGM/ambient volume) and nothing else; **`--full-ui`**
  opens the same zone in the whole app
- **`--weather`, `--time`, `--clock`** set the scene up front, and the window
  title becomes the zone name
- **Takes the path you have** — game-relative, a leveleditor `game/ROM/…` path,
  the DAT's absolute path (game or HD root), or a zone id; unlisted prototype
  DATs still open by path
- **A preview is a side trip** — it doesn't overwrite your last-opened DAT,
  doesn't change the page the full app restores to, and doesn't eat the
  first-launch About greeting. Launched before a game path was ever set, it asks
  for one and then opens your zone instead of the demo model
- **One parser covers both shells** — a `launch_args` command hands the process
  argv to the frontend, and browser dev mode takes the same options as a query
  string (`?zone=…&time=18:00`)

### Title UI: inspect, edit, save
- **UiMenu (0x30) windows** — frame and child buttons as a draggable table:
  position, size and Up/Down/Left/Right nav
- **Edit and save back** — patch x/y/w/h and nav through `xi title menu`
  (xi-tools); the DAT reloads with edit mode intact so you can keep iterating
- **Writes land in the right root** — pivot (Ashita / override), HD, or game,
  resolved per DAT
- **UiElementGroup (0x31) inspector** — set header plus sprite layout rows
  (owner / parent / dest / src), same chrome as the menu window
- **Console output panel** — bottom-left dump of what `xi` actually printed,
  optional auto-close with a countdown
- **Settings** — xi-tools folder, setup helper, and toggles for the console panel
- Backend `xi_run` / `xi_setup` helpers, and modal z-ordering so the new windows
  stack sanely

### Notes on anything
- **Free-text notes per DAT and per UiMenu**, stored in
  `%LOCALAPPDATA%\XiModelViewer\notes.json` — plain, portable, editable outside
  the app
- **File tree tooltips show the note**, so a folder of numbered DATs stops being
  anonymous
- Unsaved typing survives a DAT reload; optional close-on-save for the whole-DAT
  Notes window

### Images and sprites
- **Title / lobby packs read properly** — `lobb` packs (a few 0x20 textures plus
  one giant 0x31 layout blob) used to show a single broken set and hide the local
  textures; those textures are now surfaced and the blob is parsed into sprite
  rows
- **Sprite panel** under Images — every sprite in the layout, filtered to the
  atlas you have selected, searchable
- Bare 0x20 textures no set claims (logos, `wardrb`) are listed instead of dropped

### Data Struct
- **Bump maps (0x5D)** decode as height fields and preview as tangent-space
  normal maps
- **Routes (0x06)** open as a keyframe table — camera paths from scene DATs, with
  focal length shown as FOV
- **Companion tabs always there** — empty event / NPC / dialog DATs still get a
  tab, so the chrome stops collapsing as you switch
- **Dialog by event or as flat lines**, with search across both; NPC rows show
  record and target index
- Texture modals centre themselves

### Objects panel
- **Meshes and Visual Effects tabs** — the VFX catalog lists zone-owned effects
  and the weather folder each one sits under, built from the full DAT tree rather
  than only live generators
- **Per-object and per-group visibility toggles**, with hidden and moved state
  marked on the row and reset on moved rows only
- Sky and water listed only when Toggle Skybox is on; unplaced objects always
  listed; the chosen tab persists

### File browser
- **Pin favourites** — pinned files sit in a folder at the top and open without
  yanking the tree back to their original path
- Multiple top-level roots, each with its own label

### Zone list
- **Dev / XI Modified group** — the 22 custom ROM10/100 dev zones (405–426),
  named by matching each zone's placement signature against the prototype sources
  rather than slot order, which is how 407 turned out to be Character Creation
  from ROM/1/5 rather than a ROM/0/* prototype
- **Sunny castle town and windmill town prototypes (403, 404)** added; stale
  408/413 entries dropped
- **Group ordering fixed** — curated groups were pinned to the bottom by a
  hardcoded `TAIL_GROUPS` list, so a new group fell through to the ROM-number
  comparator, where `+a.slice(3) || 1` gives NaN → 1 and it sorted next to ROM
  (base). Anything matching `ROM<n>` now sorts by number and everything else tails
  alphabetically, so a future group needs no code change

### Prototype zones and the Camera Sequencer
- **Better prototype rendering** — prefer the richer of duplicate meshes, planar
  two-sided doors, particle-owned mills with spinning `w_mill` companions, an
  unplaced toggle, and sky / enclosing shells skipped when casting shadows
- **Time track in the sequencer** — a 25px track with lerped time of day, a
  smooth time-only lighting path that doesn't rebuild the scene, and a rAF-driven
  day clock

### Settings
- **Game, HD and pivot paths** in one column
- **Auto-switch to WASD on zone load** (fly camera: WASD / QE / Shift / wheel)

---

## [1.0.5] — 2026-08-19

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.4...v1.0.5)

### Zones that actually work as a toolkit
- **Data Struct knows the whole zone bundle** — mesh, events, dialog and NPCs as
  related DATs, kept in sync as you change zone
- **ZoneDef browser** — a placements table you can open, search and click through,
  including ParticleGenerators
- **In-modal particle preview** — play generators without hijacking the main
  viewport; resize, grid and background colour
- **Live Selection** — click objects in the world, hover/select wireframes, drag a
  solid XYZ gizmo for in-memory moves, with undo and reset on moved rows only
- **Converted / prototype zones** — a score-first 0x54 vs 0x64 placement stride so
  patched DATs don't shred object lists
- **A1R5G5B5 palette decode** so prototype textures stop looking like green
  static. Paletted-texture headers carry bits-per-palette-entry in the final dword
  of the 40-byte BITMAPINFOHEADER — 0x20 = 32-bit BGRA (1024 bytes), 0x10 =
  16-bit A1R5G5B5 (512) — and both decoders read that field then discarded it and
  hardcoded a 256 × u32 palette, which on a 0x10 texture scrambles the colours and
  shifts every pixel by 512 bytes. That was the bright-green speckle covering Dev
  Castle Town (`rom/0/33`). Retail content is always 0x20, so nothing else changes
- **Pin favourite zones** — hover → pin; pinned maps sit in a folder at the top of
  the list and persist in localStorage
- **FPS limit options**

### Camera Sequencer
- Two-track timeline (Camera + Scene), record at the playhead, scrub, multi-select
  and group drag
- Snap, path **Curve**, Space play/pause, a compact transport bar, zoom and wheel
  pan on the timeline
- Fixed-height panel, width-only resize, **New** sequence; Tippy tooltips
  throughout

### Gear, files, and camera behaviour
- **Gear + race skeleton resolved from FTABLE / gear tables first**, with the
  binary name sniff demoted to a scored fallback — a digit-prefixed tag (`70hm`)
  now beats a `_slot` suffix (`hm_m`), where before a bare `hf` substring in
  random binary noise could pick the wrong skeleton and put male boots on a HumeF
- **Data Struct keeps every character slot** in the DAT dropdown when you inspect
  a piece
- **File tree collapse sticks** — folders don't re-expand every frame. A folder you
  closed stays closed, and reveal auto-expand only fires when the target *changes*
  to something beneath it
- **Show in Explorer fixed for paths with spaces** (`Program Files (x86)`, etc.).
  Explorer's `/select` parsing splits a single `/select,C:\…` argument on spaces
  and dumps you in Documents, so the flag and the path go in as two separate argv
  entries, with the `\\?\` prefix from `canonicalize` stripped
- **Camera stays put** after you've orbited, panned or zoomed when loading the
  next entity DAT
- Auto-play idle is **off by default** (still available in Settings)

### Quality of life
- Tippy-only tooltips for UI hover text
- Cleaner status/path flows around inspect ↔ 3D

---

## [1.0.4] — 2026-08-18

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.3...v1.0.4)

- **Multi-DAT Data Struct inspection** — dropdowns for characters and creation,
  RT/SHAPE/DMB/SQLE inspectors, and structure search
- **Gear** — auto skeleton pairing and per-slot mesh isolation
- **Clickable texture and skeleton rows**, with a floating skeleton tree
- **SoundEffectPointer playback** — play a row once with a spinning icon, click to
  stop
- **Path links open in the OS file manager**, and path jumps land in the File
  Browser
- Status bar split into left/right pills; orbit controls restored after toggling
  the creation cinematic camera

---

## [1.0.3] — 2026-08-18

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.2...v1.0.3)

- **Character creation faces** — expanded to 8, with A/B DMB variants
- **Equipment mesh stays put** instead of dropping on reload
- **SQLE animation playback** — PB sequences play as authored absolute poses,
  including floor staging
- **Prefix-channel locomotion** on equip bodies such as Mithra
- Curated zone groups sort after ROM folders

---

## [1.0.2] — 2026-08-13

[Full changelog](https://github.com/vekien/xi-model-viewer/compare/v1.0.1...v1.0.2)

- **Smart-open DATs by type** — zone, model, image, audio, effect, data — with
  path search and selection highlight in the File Browser
- **Falls back to the structure inspector** with a clear notice when a file can't
  be drawn
- **Pre-production MZB zones parse** — multi-group meshes, 0x54 placements,
  strips, blank names — so maps like ROM/0/41 and 46 load more completely
- Additional texture types decoded; structure Texture rows are clickable
- Status-bar Data Struct toggle, and WASD stays on for zones opened from the
  browser
- Build fix: `beforeBuildCommand` no longer looks for `ui/ui` — it uses an
  explicit cwd of `../ui` with `npm run build` instead of the dual `--prefix`
  fallback that errored when Tauri already ran from the `ui` tree

---

## [1.0.1] — 2026-08-06

[Full changelog](https://github.com/vekien/xi-model-viewer/commits/v1.0.1)

- First public release of XI Model Viewer, under GNU GPL v3
- Refreshed app icons
