import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { backend } from '../js/backend.js';
import { gameCandidates, normRel, relFromAbs } from '../js/gamePath.js';
import { animDisplayName, groupAnimations, mergeModels, parseEntity, resolveScheduleClip } from '../js/dat.js';
import { Renderer } from '../js/renderer.js';
import { FileTree } from './FileTree.jsx';
import { MenuBar } from './MenuBar.jsx';
import { NpcList } from './NpcList.jsx';
import { CharacterList, useCharacter } from './CharacterList.jsx';
import { CreationList, useCreation } from './CreationList.jsx';
import {
  buildCreationModel, parseSqleMotion, CreationAnimator, restoreCreationBind, CREATION_CLIPS,
  creationCameraPaths, buildCreationCamera, CREATION_RACES,
} from '../js/creation.js';
import { AnimationPanel } from './AnimationPanel.jsx';
import { Combo } from './Combo.jsx';
import { MusicList, useAudioPlayer } from './MusicList.jsx';
import { MusicPlayer } from './MusicPlayer.jsx';
import { SfxList } from './SfxList.jsx';
import { SceneList } from './SceneList.jsx';
import { ZoneList } from './ZoneList.jsx';
import { PlacementPanel } from './PlacementPanel.jsx';
import { LoadingOverlay } from './LoadingOverlay.jsx';
import { SettingsModal } from './SettingsModal.jsx';
import { ExportModal } from './ExportModal.jsx';
import { DetailsPanel } from './DetailsPanel.jsx';
import { SkeletonPanel } from './SkeletonPanel.jsx';
import { TextureModal } from './TextureModal.jsx';
import { HelpModal } from './HelpModal.jsx';
import { GraphicsModal } from './GraphicsModal.jsx';
import { CameraSequencer } from './CameraSequencer.jsx';
import { parseFloorTexture } from '../js/dat.js';
import { extractKeyTables, parseZone, parseDatTextures } from '../js/zone.js';
import { zoneDatRelPath, zoneToModel } from '../js/zoneModel.js';
import { parseEnvironments, parseEnvironmentsByRoot, resolveEnvironment, defaultWeather, listWeathers, terrainLightingFromEnv, skyDomeFromEnv, EnvironmentManager } from '../js/environment.js';
import { parseSections } from '../js/zone.js';
import { buildDatTree, SEC } from '../js/dat/tree.js';
import { makeParsers } from '../js/dat/sections.js';
import { parseParticleGenerator } from '../js/particle/parser.js';
import { ParticleSystem } from '../js/particle/system.js';
import { parseEffectRoutines, flattenRoutine } from '../js/effect.js';
import { EffectList } from './EffectList.jsx';
import { WeatherAudio } from '../js/particle/audio.js';
import { toAudioBuffer, parseAudioHeader, FMT_ATRAC3 } from '../js/audio.js';
import { parseImageDat, textureForSet } from '../js/images.js';
import { inspectDat } from '../js/dat/inspect.js';
import { matchTablePath, parseFileTable } from '../js/dat/ftable.js';
import {
  sniffZoneDat, zoneForFileId, zoneFileIds, parseNpcList, npcNameMap,
  parseEventDat, parseDialogDat, dialogSpeakers, dialogConversations, EVENT_CATEGORIES,
} from '../js/dat/zonedat.js';
import { DataViewer } from './DataViewer.jsx';
import { ImageList } from './ImageList.jsx';
import { ImageSetPanel } from './ImageSetPanel.jsx';
import { ImageViewer } from './ImageViewer.jsx';
import { WeatherPanel } from './WeatherPanel.jsx';
import { Tooltip } from './Tooltip.jsx';
import { loadZoneNavmesh } from '../js/navmesh.js';

const DEFAULT_DAT_SUFFIX = 'ROM\\5\\3.DAT';
const DEFAULT_BG = '#303438';
const LAST_DAT_KEY = 'lastDat';
const LAST_VIEW_KEY = 'lastView';
const LAST_IMAGE_KEY = 'lastImage';
const ANIM_SEL_KEY = 'lastAnimSel';
/** Per-zone camera poses keyed by zone path (lowercase). */
const ZONE_CAM_KEY = 'zoneCameras';

const zoneCamKey = (zone) => String(zone?.path || zone?.id || '').replace(/\//g, '\\').toLowerCase();

function readZoneCamMap() {
  try { return JSON.parse(localStorage.getItem(ZONE_CAM_KEY) || '{}') || {}; }
  catch { return {}; }
}

function writeZoneCamera(key, snap) {
  if (!key || !snap) return;
  try {
    const map = readZoneCamMap();
    map[key] = snap;
    localStorage.setItem(ZONE_CAM_KEY, JSON.stringify(map));
  } catch { /* quota */ }
}

function readZoneCamera(key) {
  if (!key) return null;
  const snap = readZoneCamMap()[key];
  return snap && Array.isArray(snap.target) ? snap : null;
}
const VIEWS = ['files', 'npc', 'pc', 'creation', 'music', 'sfx', 'scene', 'zones', 'images', 'effects', 'data'];
/** Views that browse individual models, where fly controls are a hindrance. */
const ORBIT_VIEWS = new Set(['files', 'npc', 'pc', 'creation']);
/** Views with a Details panel — model/zone stats, or an effect's sprite images. */
const DETAIL_VIEWS = new Set([...ORBIT_VIEWS, 'effects']);
// Zones and Scene are two panels onto the same loaded zone, so moving between
// them keeps it. Every other view change is a fresh page: whatever the last one
// had running gets torn down.
const ZONE_VIEWS = new Set(['zones', 'scene']);
// The only views that own the audio player. A zone's BGM plays through the same
// player, so leaving Zones has to stop it too — hence "was it an audio view",
// not just "is it one now".
const AUDIO_VIEWS = new Set(['music', 'sfx']);
// Views that put their own content on screen as soon as they open. Restoring
// one of these at startup must not also load the last/default DAT.
const SELF_LOADING_VIEWS = new Set(['pc', 'creation', 'images', 'music', 'sfx', 'effects', 'data']);

// A schedule sequence lays segments on a timeline; a joint whose segment hasn't
// started yet would show bind pose (T-pose flash each loop). Underlay a looping
// idle so those joints rest naturally — battle idle for weapon actions if it's
// loaded, otherwise plain idle (falling back to std).
function pickBaseIdle(model) {
  const grouped = groupAnimations(model.animations);
  for (const id of ['btl', 'idl', 'std']) {
    const g = grouped.find((x) => x.id === id);
    if (g && g.clip.jointTracks.size > 0) return g.clip;
  }
  return null;
}

function scheduleClip(model, sched) {
  const clip = resolveScheduleClip(model, sched);
  if (clip?.segments) {
    const base = pickBaseIdle(model);
    if (base) clip.baseClip = base;
  }
  return clip;
}

/**
 * Yield so the loading overlay can paint before a long synchronous step.
 *
 * requestAnimationFrame alone deadlocks when the page isn't compositing — a
 * backgrounded tab, or a hidden panel — leaving the load stuck on whatever step
 * it had just announced. The timer is the escape hatch: whichever fires first
 * wins, so a visible page still yields on the frame boundary.
 */
const yieldToPaint = () => new Promise((resolve) => {
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(finish);
  setTimeout(finish, 100);
});

const loadSettings = (gamePath) => {
  const hdPath = localStorage.getItem('hdPath') || '';
  return {
    gamePath,
    hdPath,
    hdEnabled: !!hdPath && localStorage.getItem('hdEnabled') === '1',
    bgColor: localStorage.getItem('bgColor') || DEFAULT_BG,
    autoPlay: localStorage.getItem('autoPlay') !== '0',
    autoWasdZones: localStorage.getItem('autoWasdZones') !== '0',
    xiPath: localStorage.getItem('xiPath') || '',
  };
};


// Particle-DAT parsers/tree, shared by zone effects and standalone spell/ability
// DATs so both resolve links (meshes, keyframes, sprites) the same way. Effect
// DATs are static resources (zoneResource false — no x2 vertex-colour scale).
function particleParsers(zoneResource, warnings) {
  return makeParsers(
    { [SEC.EFFECT]: (b, d, s, e) => parseParticleGenerator(b, d, s, e, (m) => warnings.push(m)) },
    zoneResource,
  );
}
/**
 * DAT texture names are a 16-byte field holding an 8-byte group plus an 8-byte
 * name ("lvup    lvu1"); the trailing token is the texture's own id. Display
 * only — the raw name stays the lookup key.
 */
const texLabel = (name) => String(name ?? '').trim().split(/\s+/).pop() || String(name ?? '');

function buildParticleTree(buffer, parsers, warnings) {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return buildDatTree(bytes, dv, parseSections(dv), parsers, (m) => warnings.push(m));
}

/**
 * Merged file-id ↔ DAT-path maps across every FTABLE/VTABLE pair (base +
 * ROM2-10), the way the client resolves them: lowest table wins. Cached in
 * `cacheRef` — reads ~10 table pairs once per session.
 */
async function loadMergedTables(settings, cacheRef) {
  if (cacheRef.current) return cacheRef.current;
  const byFid = new Map();
  const byPath = new Map();
  for (let rom = 1; rom <= 10; rom++) {
    const ftRel = rom === 1 ? 'FTABLE.DAT' : `ROM${rom}\\FTABLE${rom}.DAT`;
    const vtRel = rom === 1 ? 'VTABLE.DAT' : `ROM${rom}\\VTABLE${rom}.DAT`;
    try {
      const [ft, vt] = await Promise.all([
        backend.readPrefer(gameCandidates(ftRel, settings)),
        backend.readPrefer(gameCandidates(vtRel, settings)),
      ]);
      for (const e of parseFileTable(ft.data, vt.data).entries) {
        if (!byFid.has(e.id)) byFid.set(e.id, e.dat);
        const key = e.dat.toUpperCase();
        if (!byPath.has(key)) byPath.set(key, e.id);
      }
    } catch { /* expansion not installed */ }
  }
  cacheRef.current = { byFid, byPath };
  return cacheRef.current;
}

/**
 * Build the Data-view doc for a zone script DAT (NPC list / events / dialog).
 * Resolves the zone id from the file id and reads the zone's sibling DATs so
 * the views can cross-reference: NPC names label event actors, event print
 * ops attribute dialog lines to speakers, dialog text annotates opcodes.
 */
async function buildZoneDatDoc(kind, bytes, relPath, settings, tablesRef) {
  const { byFid, byPath } = await loadMergedTables(settings, tablesRef);
  const fid = byPath.get(relPath.replace(/\\/g, '/').toUpperCase()) ?? null;
  const zone = fid != null ? zoneForFileId(fid) : null;
  const zoneId = zone?.zoneId ?? null;

  const readSibling = async (sibKind) => {
    if (zoneId == null) return null;
    const sibFid = zoneFileIds(zoneId)[sibKind];
    const dat = byFid.get(sibFid);
    if (!dat) return null;
    try {
      const { data } = await backend.readPrefer(gameCandidates(dat, settings));
      return new Uint8Array(data);
    } catch { return null; }
  };

  let zoneName = null;
  if (zoneId != null) {
    try {
      const zones = await (await fetch('lists/zones.json')).json();
      zoneName = zones.find((z) => z.id === zoneId)?.name ?? null;
    } catch { /* baked list unavailable */ }
  }

  const base = { kind, fileSize: bytes.byteLength, zoneId, zoneName, fileId: fid };

  if (kind === 'npclist') {
    const npcs = parseNpcList(bytes);
    // Per-NPC event counts from the zone's event DAT, when it parses.
    const evBytes = await readSibling('events');
    if (evBytes) {
      try {
        const counts = new Map();
        for (const a of parseEventDat(evBytes)) counts.set(a.actorId, a.events.length);
        for (const n of npcs) n.events = counts.get(n.id) ?? 0;
      } catch { /* names still render without counts */ }
    }
    return { ...base, npcs };
  }

  if (kind === 'events') {
    const npcBytes = await readSibling('npclist');
    const names = npcBytes ? npcNameMap(parseNpcList(npcBytes)) : null;
    const actors = parseEventDat(bytes, names);
    const dlgBytes = await readSibling('dialog');
    let dialogTexts = null;
    if (dlgBytes) {
      try { dialogTexts = parseDialogDat(dlgBytes).entries.map((e) => e.text); }
      catch { /* opcode rows just skip the snippet */ }
    }
    const stats = { events: 0, cutscenes: 0, categories: Object.fromEntries(EVENT_CATEGORIES.map((c) => [c, 0])) };
    for (const a of actors) {
      for (const e of a.events) {
        stats.events++;
        if (e.isCutscene) stats.cutscenes++;
        stats.categories[e.category] = (stats.categories[e.category] ?? 0) + 1;
      }
    }
    return { ...base, actors, dialogTexts, stats };
  }

  // dialog
  const { entries, obfuscated } = parseDialogDat(bytes);
  let conversations = null;
  const evBytes = await readSibling('events');
  if (evBytes) {
    try {
      const npcBytes = await readSibling('npclist');
      const names = npcBytes ? npcNameMap(parseNpcList(npcBytes)) : null;
      const actors = parseEventDat(evBytes, names);
      const speakers = dialogSpeakers(actors);
      for (const e of entries) e.speakers = [...(speakers.get(e.index) ?? [])];
      conversations = dialogConversations(actors);
    } catch { /* lines render unattributed, flat only */ }
  }
  return { ...base, entries, obfuscated, conversations };
}

export default function App() {
  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  const modelRef = useRef(null);
  const loadGenRef = useRef(0);       // drop stale async load results
  const overlayGenRef = useRef(0);    // which load gen owns the loading overlay
  const appliedPlayRef = useRef({ kind: null, id: '' }); // last applied anim/schedule (gear-swap resume)
  const settingsRef = useRef(null);
  const animsRef = useRef([]);
  const sourcePathRef = useRef('');
  // The DAT the status bar names, at its real casing — selectedDat is folded to
  // lower case for the tree's matching and isn't safe to hand a case-sensitive
  // filesystem. For composed characters this is the changed slot, not the last
  // DAT merged, so "show in Explorer" lands on what the user is reading.
  const shownPathRef = useRef('');
  const drag = useRef({ btn: -1, x: 0, y: 0 });
  const heldKeys = useRef(new Set());
  const wasdRef = useRef(localStorage.getItem('wasd') === '1');

  const [settings, setSettings] = useState(null);
  const [wasd, setWasdState] = useState(() => localStorage.getItem('wasd') === '1');
  const setWasd = useCallback((on) => {
    const next = !!on;
    wasdRef.current = next;
    setWasdState(next);
    try { localStorage.setItem('wasd', next ? '1' : '0'); } catch { /* quota */ }
    const cam = rendererRef.current?.camera;
    if (cam) cam.setMode(next ? 'fly' : 'orbit');
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  // Greet first-time users with the About panel (controls + links), then never
  // auto-open it again. A missing/false 'booted' flag means this install has
  // never launched before.
  const [helpOpen, setHelpOpen] = useState(() => {
    const firstBoot = localStorage.getItem('booted') !== '1';
    if (firstBoot) {
      try { localStorage.setItem('booted', '1'); } catch { /* quota */ }
    }
    return firstBoot;
  });
  const [exportSpec, setExportSpec] = useState(null);
  const [leftView, setLeftViewState] = useState(() => {
    const v = localStorage.getItem(LAST_VIEW_KEY);
    return VIEWS.includes(v) ? v : 'files';
  });
  // Mirrored for the startup effect, which runs once and must see the restored
  // view without taking it as a dependency.
  const leftViewRef = useRef(leftView);
  leftViewRef.current = leftView;
  const setLeftView = useCallback((v) => {
    setLeftViewState(v);
    localStorage.setItem(LAST_VIEW_KEY, v);
  }, []);
  // Browsing single models rather than a zone: fly controls put the camera
  // somewhere arbitrary and WASD swallows typing in the filter boxes, so drop
  // back to orbit on arrival. Only fires on a view change, so turning WASD back
  // on while you are in one of these views sticks.
  useEffect(() => {
    if (ORBIT_VIEWS.has(leftView) && wasdRef.current) setWasd(false);
  }, [leftView, setWasd]);
  // Left explorer panel (zones/files/…); toolbar toggle, persisted.
  const [explorerOpen, setExplorerOpen] = useState(() => localStorage.getItem('explorer') !== '0');
  const [statusText, setStatusText] = useState('');       // secondary detail/stats
  const [modelPath, setModelPath] = useState('');         // primary path of the loaded model
  const [anims, setAnims] = useState([]);        // grouped: [{ id, clip }]
  const [currentAnim, setCurrentAnim] = useState('');
  // Last picked animation/schedule — restored on launch and kept across gear
  // swaps (the actor reloads, the user's choice shouldn't reset to idle).
  const animSelRef = useRef((() => {
    try { return JSON.parse(localStorage.getItem(ANIM_SEL_KEY) || 'null') ?? {}; } catch { return {}; }
  })());
  const rememberAnimSel = (sel) => {
    animSelRef.current = sel;
    try { localStorage.setItem(ANIM_SEL_KEY, JSON.stringify(sel)); } catch { /* quota */ }
  };
  const [schedules, setSchedules] = useState([]);      // 0x07 routines
  const [currentSchedule, setCurrentSchedule] = useState('');
  const [modelInfo, setModelInfo] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [skeletonOpen, setSkeletonOpen] = useState(false);
  const [texWindows, setTexWindows] = useState([]); // [{ id, tex }] open texture viewers
  const texIdRef = useRef(0);
  const [selectedFloor, setSelectedFloor] = useState('');
  const [playing, setPlayingState] = useState(false);
  // Animation playback rate, 0.1–2.0 (10%–200%). Mirrored to a ref so the
  // renderer-lifecycle effect can seed a freshly-built renderer without listing
  // it as a dependency (which would rebuild the renderer on every speed change).
  const [playbackSpeed, setPlaybackSpeedState] = useState(() => {
    const v = parseFloat(localStorage.getItem('playbackSpeed'));
    return Number.isFinite(v) && v >= 0.1 && v <= 2 ? v : 1;
  });
  const playbackSpeedRef = useRef(playbackSpeed);
  const setPlaybackSpeed = useCallback((v) => {
    const clamped = Math.min(2, Math.max(0.1, v));
    playbackSpeedRef.current = clamped;
    setPlaybackSpeedState(clamped);
    try { localStorage.setItem('playbackSpeed', String(clamped)); } catch { /* quota */ }
    if (rendererRef.current) rendererRef.current.playbackSpeed = clamped;
  }, []);
  // Where the render loop pushes the playhead each frame. A ref, not state:
  // at 30 fps a state update would re-render the whole panel — and with it
  // every combo's option list — thirty times a second.
  const animTick = useRef(null);
  const [showTex, setShowTex] = useState(true);
  const [showWireframe, setShowWireframe] = useState(false);
  // Origin axis gizmo. Defaults on in Effects (particles play at 0,0,0 with no
  // other geometry to judge position against) and off everywhere else; the
  // view-change effect below re-applies that default on every switch.
  const [showAxes, setShowAxes] = useState(() => localStorage.getItem(LAST_VIEW_KEY) === 'effects');
  // World grid (the floor, as lines). Off until asked for; sticks across views.
  const [showGrid, setShowGrid] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [showAlpha, setShowAlpha] = useState(true);
  // Zone blend submeshes: LEQUAL depth (on) vs strict LESS (off). Default on.
  const [blendLequal, setBlendLequal] = useState(() => localStorage.getItem('blendLequal') !== '0');
  const [showUnlit, setShowUnlit] = useState(false);
  // Cast shadows from a single sun. Not a retail feature — a viewer toggle.
  const [showShadows, setShowShadows] = useState(() => localStorage.getItem('shadows') === '1');
  // Graphics Settings (toolbar icon): shadow draw distance + render resolution.
  const [graphicsOpen, setGraphicsOpen] = useState(false);
  const [sequencerOpen, setSequencerOpen] = useState(false);
  // Slot in the render loop for the Camera Sequencer to set the camera pose in
  // the same frame that pose is drawn; null whenever its panel is closed.
  const camSeqTick = useRef(null);
  const [shadowDistance, setShadowDistance] = useState(() => {
    const v = parseFloat(localStorage.getItem('shadowDistance'));
    return Number.isFinite(v) && v >= 20 && v <= 600 ? v : 90;
  });
  const [renderHeight, setRenderHeight] = useState(() => {
    const v = parseInt(localStorage.getItem('renderHeight'), 10);
    return Number.isFinite(v) && v > 0 ? v : 0;   // 0 = follow the window
  });
  // Mirrors what the renderer actually sized its buffer to, so the Graphics
  // panel can show it. Sampled while the panel is open — resize() is the only
  // writer and it runs per frame.
  const [bufferSize, setBufferSize] = useState(null);
  const [zoneBrightness, setZoneBrightness] = useState(0); // 0 = zone default, 1 = unlit
  const [showCollision, setShowCollision] = useState(false);
  const [showEffects, setShowEffects] = useState(true);
  // Camera readouts for the toolbar. Fly speed is mirrored from the camera each
  // frame; FOV is owned here and pushed down, since nothing else writes it.
  const [flySpeed, setFlySpeed] = useState(0);
  const [fov, setFovState] = useState(() => {
    const saved = Number(localStorage.getItem('fovDegrees'));
    return Number.isFinite(saved) && saved >= 20 && saved <= 120 ? saved : 45;
  });
  // Mirrored so the cinematic camera can restore your FOV when it hands back.
  const fovRef = useRef(fov);
  fovRef.current = fov;
  const [showNavmesh, setShowNavmesh] = useState(false);
  const [showSkybox, setShowSkyboxState] = useState(() => localStorage.getItem('skybox') === '1');
  // Persisted skybox preference — kept across zone switches and sessions.
  const setSkybox = useCallback((on) => {
    const next = !!on;
    setShowSkyboxState(next);
    try { localStorage.setItem('skybox', next ? '1' : '0'); } catch { /* quota */ }
    if (rendererRef.current) rendererRef.current.showSkybox = next;
  }, []);
  const [hasCollision, setHasCollision] = useState(false);
  const [hasNavmesh, setHasNavmesh] = useState(false);
  const [hasSkybox, setHasSkybox] = useState(false);
  const [selectedDat, setSelectedDat] = useState('');
  const [revealTarget, setRevealTarget] = useState('');
  const [objectGroups, setObjectGroups] = useState(null);   // zone object panel data
  const zoneEnvsRef = useRef(null);                         // parsed 0x2F environments (per zone)
  const zoneEnvManagerRef = useRef(null);                   // EnvironmentManager (clock + weather fades)
  const globalEffectsRef = useRef(null);                    // ROM/0/0.DAT shared effects tree
  const weatherAudioRef = useRef(null);                     // ambient weather bed (0x3D sound pointers)

  // ── Assets > Effects (standalone spell/ability VFX) ────────────────────────
  const [effectEntry, setEffectEntry] = useState(null);     // { name, dir, file, path } | null
  const [effectRoutines, setEffectRoutines] = useState([]); // 0x07 routines in the effect DAT
  const [effectSchedule, setEffectSchedule] = useState(''); // active routine id (AltanaViewer "Schedule")
  const [effectPlaying, setEffectPlaying] = useState(true);
  const [effectSpeed, setEffectSpeedState] = useState(1);
  const effectRoutinesRef = useRef([]);                     // mirror for stable playback callbacks
  const effectSpeedRef = useRef(1);
  const [effectVolume, setEffectVolumeState] = useState(() => {
    const v = parseFloat(localStorage.getItem('effectVolume'));
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.6;
  });
  const effectVolumeRef = useRef(effectVolume);
  const effectSfxOnRef = useRef(true);
  const effectTokenRef = useRef(0);                         // drop stale effect-load results
  const zoneMusicRef = useRef(null);                        // zone_music.json (server zone_settings)
  const zoneMusicIdRef = useRef(null);                      // zone id of the loaded zone
  const zoneCamKeyRef = useRef('');                         // path key for per-zone camera save
  const [zoneTrack, setZoneTrackState] = useState(null);    // resolved BGM for this zone + time
  const zoneTrackRef = useRef(null);
  const setZoneTrack = useCallback((t) => { zoneTrackRef.current = t; setZoneTrackState(t); }, []);
  const [weatherList, setWeatherList] = useState([]);       // weather ids present in the zone
  const [weather, setWeather] = useState('');
  const [timeMinutes, setTimeMinutes] = useState(12 * 60);
  // Time-of-day auto-advance (the play button on the Zone panel's clock row).
  const [todPlaying, setTodPlaying] = useState(false);
  const [plcSelected, setPlcSelected] = useState('');       // 'mesh:…' | 'inst:…'
  const [plcOpen, setPlcOpen] = useState(true);
  const [loading, setLoading] = useState(null); // { title, detail } | null

  const player = useAudioPlayer();
  // useAudioPlayer returns a fresh object literal every render, so it must never
  // appear in a dependency array — doing so gives every dependent callback a new
  // identity each render and the effects that depend on them loop forever.
  const playerRef = useRef(player);
  playerRef.current = player;

  const beginLoad = useCallback((title, detail = '') => {
    setLoading({ title, detail });
    setStatusText(detail ? `${title} — ${detail}` : title);
  }, []);
  const stepLoad = useCallback((detail) => {
    setLoading((prev) => (prev ? { ...prev, detail } : prev));
    if (detail) setStatusText(detail);
  }, []);
  const endLoad = useCallback(() => setLoading(null), []);

  settingsRef.current = settings;

  // --- renderer lifecycle --------------------------------------------------

  useEffect(() => {
    const renderer = new Renderer(canvasRef.current);
    renderer.screenOffsetX = explorerOpen ? 180 : 0;
    rendererRef.current = renderer;
    // Dev-only escape hatch for driving/inspecting the renderer from the
    // console (headless verification, quick probes). Not part of the app API.
    // Exposed as the ref, not the instance — StrictMode mounts twice and a
    // captured instance goes stale the moment the second one takes over.
    if (import.meta.env.DEV) window.__xiRendererRef = rendererRef;
    renderer.setFogOverride({ enabled: fogOn, scale: fogScale });
    renderer.camera.fovDegrees = fov;
    renderer.playbackSpeed = playbackSpeedRef.current;
    // Restore View > Toggle WASD from last session.
    if (wasdRef.current) renderer.camera.setMode('fly');
    // Seed the toolbar readout so it never shows 0 before the first frame.
    setFlySpeed(Math.round(renderer.camera.flySpeed));

    let raf;
    let last = performance.now();
    let shownFlySpeed = -1;
    const frame = (now) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      // A recorded sequence owns the camera outright while it plays.
      camSeqTick.current?.(dt);
      if (wasdRef.current && !renderer.camera.sequenceLock) {
        renderer.camera.flyUpdate(dt, heldKeys.current);
      }
      renderer.render(dt);
      // The camera owns fly speed and changes it from the wheel, from zone vs
      // entity range presets and from localStorage, so mirror it here rather
      // than trying to catch every writer. Only on a change of the rounded
      // value, so this is a handful of updates, not one per frame.
      const speed = Math.round(renderer.camera.flySpeed);
      if (speed !== shownFlySpeed) { shownFlySpeed = speed; setFlySpeed(speed); }
      animTick.current?.(renderer.animFrame, renderer.currentAnimation?.lengthInFrames ?? 0);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const canvas = canvasRef.current;
    const onWheel = (e) => {
      e.preventDefault();
      if (renderer.camera.sequenceLock) return;
      if (wasdRef.current) {
        // Speed still shows live in the camera-settings readout; no status-bar spam.
        renderer.camera.adjustFlySpeed(e.deltaY < 0 ? 1 : -1);
      } else {
        // Anchored at the cursor: zooming dives toward what you point at.
        renderer.zoomAt(e.clientX, e.clientY, -Math.sign(e.deltaY) * 120);
      }
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    const isTyping = (t) => {
      const tag = t?.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable;
    };
    const onKeyDown = (e) => {
      if (isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === 'f') {
        rendererRef.current?.resetCamera();
        e.preventDefault();
        return;
      }
      if (k === 'w' || k === 'a' || k === 's' || k === 'd' || k === 'q' || k === 'e') {
        if (wasdRef.current) {
          heldKeys.current.add(k);
          e.preventDefault();
        }
      } else if (e.key === 'Shift') {
        heldKeys.current.add('shift');
      }
    };
    const onKeyUp = (e) => {
      const k = e.key.toLowerCase();
      heldKeys.current.delete(k);
      if (e.key === 'Shift') heldKeys.current.delete('shift');
    };
    const onBlur = () => heldKeys.current.clear();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.showTextures = showTex;
  }, [showTex]);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.showWireframe = showWireframe;
  }, [showWireframe]);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.showAxes = showAxes;
  }, [showAxes]);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.showGrid = showGrid;
  }, [showGrid]);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.showSkeleton = showSkeleton;
  }, [showSkeleton]);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.showAlpha = showAlpha;
  }, [showAlpha]);
  useEffect(() => {
    if (rendererRef.current) rendererRef.current.zoneBlendLequal = blendLequal;
  }, [blendLequal]);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.unlit = showUnlit;
  }, [showUnlit]);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.showShadows = showShadows;
  }, [showShadows]);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.shadowRange = shadowDistance;
    try { localStorage.setItem('shadowDistance', String(shadowDistance)); } catch { /* quota */ }
  }, [shadowDistance]);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.renderHeight = renderHeight;
    try { localStorage.setItem('renderHeight', String(renderHeight)); } catch { /* quota */ }
  }, [renderHeight]);

  // Poll the drawing-buffer size only while the panel that shows it is open —
  // the window can be resized under it, and 'Window Size' has no fixed answer.
  useEffect(() => {
    if (!graphicsOpen) return undefined;
    const read = () => {
      const c = rendererRef.current?.canvas;
      if (!c) return;
      setBufferSize((prev) => (prev && prev[0] === c.width && prev[1] === c.height
        ? prev
        : [c.width, c.height]));
    };
    read();
    const id = setInterval(read, 250);
    return () => clearInterval(id);
  }, [graphicsOpen]);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.lightBrightness = zoneBrightness;
  }, [zoneBrightness]);

  useEffect(() => {
    try { localStorage.setItem('explorer', explorerOpen ? '1' : '0'); } catch { /* quota */ }
    if (rendererRef.current) rendererRef.current.screenOffsetX = explorerOpen ? 180 : 0;
  }, [explorerOpen]);

  useEffect(() => {
    if (settings && rendererRef.current) rendererRef.current.setClearColor(settings.bgColor);
  }, [settings]);

  // --- model loading -------------------------------------------------------

  /**
   * Loads one or more DATs (later ones rig onto the first's skeleton) as one model.
   * opts:
   *   focusPaths  — DATs whose clips/schedules populate the viewbar lists (the
   *                 selected action set); everything still merges for playback.
   *   weaponSlots — { main: [paths], sub: [paths] } for hand re-parenting.
   *   battleTable — race's battle-idle DATs indexed by weaponAnimationType; the
   *                 equipped weapon's own battle stance is loaded as the base pose.
   *   keepCamera  — don't re-fit the camera (gear swap on the same actor).
   */
  const loadModel = useCallback(async (paths, displayName, opts = {}) => {
    const { focusPaths = null, weaponSlots = null, battleTable = null, parts = null, keepCamera = false, displayPath = null } = opts;
    // Gear swaps (keepCamera) are snappy — skip the full-screen overlay there.
    const showOverlay = !keepCamera;
    const gen = ++loadGenRef.current;
    const stillCurrent = () => gen === loadGenRef.current;
    const releaseOverlay = () => {
      if (showOverlay && overlayGenRef.current === gen) endLoad();
    };
    try {
      if (showOverlay) {
        beginLoad(displayName, 'Reading DAT…');
        overlayGenRef.current = gen;
      } else {
        setStatusText(`Loading ${displayName}…`);
      }
      const parsed = [];
      const skipped = [];
      const parse1 = async (path) => {
        const settings = settingsRef.current;
        const rel = relFromAbs(path, settings);
        const { path: resolved, data: buffer } = await backend.readPrefer(
          // Already-absolute paths outside either root (Open DAT…) read as-is.
          rel !== path ? gameCandidates(rel, settings) : [path],
        );
        return { path: resolved, model: parseEntity(buffer, resolved) };
      };
      for (let i = 0; i < paths.length; i++) {
        if (!stillCurrent()) { releaseOverlay(); return; }
        const path = paths[i];
        try {
          if (showOverlay && paths.length > 1) stepLoad(`Reading DAT ${i + 1}/${paths.length}…`);
          parsed.push(await parse1(path));
        } catch (err) {
          // Character/NPC merges list DATs that may not exist in every client
          // build — drop those instead of failing the whole actor.
          if (paths.length === 1) throw err;
          skipped.push(path);
          console.warn(`skipping ${path}:`, err);
        }
      }
      if (!stillCurrent()) { releaseOverlay(); return; }
      if (parsed.length === 0) throw new Error('no readable DATs');
      if (showOverlay) stepLoad('Building model…');

      // The right battle idle depends on the equipped weapon's animation type,
      // only known after parsing it — resolve + merge that battle DAT now so the
      // weapon rests in its own stance (e.g. a greatsword held two-handed), not
      // the hand-to-hand fists idle. Non-focus, so it never enters the lists.
      if (battleTable && weaponSlots?.main?.length) {
        const mainSet = new Set(weaponSlots.main.map((p) => p.toLowerCase()));
        const weapon = parsed.find((e) => mainSet.has(e.path.toLowerCase()))?.model;
        const type = weapon?.info?.weaponAnimationType;
        const rel = type != null ? battleTable[type] : null;
        if (rel) {
          const abs = `${settingsRef.current.gamePath}\\${normRel(rel)}`;
          if (!parsed.some((e) => relFromAbs(e.path, settingsRef.current).toLowerCase() === normRel(rel).toLowerCase())) {
            try { parsed.push(await parse1(abs)); } catch (err) { console.warn(`battle idle ${abs}:`, err); }
          }
        }
      }
      if (!stillCurrent()) { releaseOverlay(); return; }
      const model = parsed.length === 1 ? parsed[0].model : mergeModels(parsed.map((e) => e.model), displayName);

      if (!model.isRenderable) {
        releaseOverlay();
        setStatusText(`${displayName} — no renderable skeleton+mesh (skeleton: ${model.skeleton ? 'yes' : 'no'}, mesh groups: ${model.meshGroups.length})`);
        return;
      }

      if (showOverlay) stepLoad('Uploading to GPU…');
      // Drawn-weapon attach (xim jointParentOverrides): re-parent the weapon
      // grip joint (info.standardJointIndex -> joint reference) onto the hand
      // attach reference — 127 right hand (main), 126 left hand (sub).
      const refs = model.skeleton?.references ?? [];
      if (weaponSlots && refs.length > 127) {
        const overrides = new Map();
        for (const [slot, handRefIdx] of [['main', 127], ['sub', 126]]) {
          const slotSet = new Set((weaponSlots[slot] ?? []).map((p) => p.toLowerCase()));
          const weapon = parsed.find((e) => slotSet.has(e.path.toLowerCase()))?.model;
          const stdIdx = weapon?.info?.standardJointIndex;
          if (stdIdx == null) continue;
          const grip = refs[stdIdx];
          const hand = refs[handRefIdx];
          if (grip && hand && grip.index !== hand.index) overrides.set(grip.index, hand.index);
        }
        if (overrides.size) model.jointOverrides = overrides;
      }

      // Loading a model takes over the viewport — stop any music and close the player.
      player.stop();

      if (!stillCurrent()) { releaseOverlay(); return; }
      const renderer = rendererRef.current;
      // Gear swap: remember progress so the same clip continues mid-cycle.
      const resumeFrame = keepCamera ? renderer.animFrame : null;
      const wasPlaying = renderer.playing;
      const prevPlay = appliedPlayRef.current;
      modelRef.current = model;
      renderer.setModel(model, keepCamera);
      const primaryPath = displayPath ?? paths[paths.length - 1];
      setSelectedDat(primaryPath.toLowerCase());
      setModelPath(relativeName(primaryPath));
      shownPathRef.current = primaryPath;
      sourcePathRef.current = paths[paths.length - 1];

      // Viewbar lists. Group over the WHOLE model so each clip's body-region
      // parts merge across DATs — locomotion is split (lower body wlk0 lives in
      // the race/movement DAT, upper body wlk1 in the weapon's battle DAT), and
      // grouping only the focus DATs would drop the lower half. Then, with a
      // focus set (the selected action's schedule DATs), keep just the groups
      // those DATs contribute — motion packs still merge for playback but never
      // flood the list (Motion.csv rows are whole-class aggregated ranges).
      let grouped = groupAnimations(model.animations)
        .filter((g) => g.clip.jointTracks.size > 0 && g.clip.numFrames > 0);
      let schedSrc = model.schedules ?? [];
      if (focusPaths?.length) {
        const fset = new Set(focusPaths.map((p) => p.toLowerCase()));
        const fBases = new Set();   // clip display-names (body-slot digit stripped)
        const fScheds = new Set();
        for (const { path, model: m } of parsed) {
          if (!fset.has(path.toLowerCase())) continue;
          for (const a of m.animations) fBases.add(animDisplayName(a.id));
          for (const s of m.schedules ?? []) fScheds.add(s.id);
        }
        // Unconditional: if the action's own DATs are missing from this client
        // build, the lists stay empty rather than falling back to every clip.
        schedSrc = schedSrc.filter((s) => fScheds.has(s.id));
        for (const s of schedSrc) for (const c of s.clipIds) fBases.add(animDisplayName(c));
        grouped = grouped.filter((g) => fBases.has(g.id));
      }
      animsRef.current = grouped;
      setAnims(grouped);
      setSchedules(schedSrc);
      // What to play, best first: the user's remembered pick if this actor still
      // has it, then idle, then (for a focused action set, which has no idle)
      // its 'main' schedule so picking a weapon skill shows the skill.
      const want = animSelRef.current ?? {};
      const pickSched = (id) => schedSrc.find((s) => s.id === id && s.clipIds.length);
      const chosen =
        (want.schedule && pickSched(want.schedule) && { schedule: pickSched(want.schedule) })
        || (want.anim && grouped.find((g) => g.id === want.anim) && { anim: grouped.find((g) => g.id === want.anim) })
        || (grouped.find((g) => g.id.toLowerCase().startsWith('idl')) && { anim: grouped.find((g) => g.id.toLowerCase().startsWith('idl')) })
        || (focusPaths?.length && (pickSched('main') ?? schedSrc.find((s) => s.clipIds.length))
          && { schedule: pickSched('main') ?? schedSrc.find((s) => s.clipIds.length) })
        || null;

      const autoPlay = settingsRef.current?.autoPlay ?? true;
      if (chosen?.anim) {
        const same = keepCamera && prevPlay.kind === 'anim' && prevPlay.id === chosen.anim.id;
        renderer.setAnimation(chosen.anim.clip, same ? { frame: resumeFrame } : undefined);
        renderer.playing = same ? wasPlaying : !!autoPlay;
        appliedPlayRef.current = { kind: 'anim', id: chosen.anim.id };
        setCurrentAnim(chosen.anim.id);
        setCurrentSchedule('');
        setPlayingState(renderer.playing);
      } else if (chosen?.schedule) {
        const same = keepCamera && prevPlay.kind === 'schedule' && prevPlay.id === chosen.schedule.id;
        renderer.setAnimation(scheduleClip(model, chosen.schedule), same ? { frame: resumeFrame } : undefined);
        renderer.playing = same ? wasPlaying : !!autoPlay;
        appliedPlayRef.current = { kind: 'schedule', id: chosen.schedule.id };
        setCurrentSchedule(chosen.schedule.id);
        setCurrentAnim('');
        setPlayingState(renderer.playing);
      } else {
        renderer.setAnimation(null);
        renderer.playing = false;
        appliedPlayRef.current = { kind: null, id: '' };
        setCurrentAnim('');
        setCurrentSchedule('');
        setPlayingState(false);
      }
      // Re-fit after the idle pose is applied so the floor snaps to feet (not bind-pose /
      // dangling weapon tips that made some actors hover). Gear swaps on the
      // same actor keep the user's camera.
      if (keepCamera) renderer.snapFloorToFeet();
      else renderer.fitCamera();

      const statsOf = (models) => ({
        joints: models.find((m) => m.skeleton)?.skeleton.joints.length ?? null,
        verts: models.reduce((s, m) => s + m.meshGroups.reduce((a, g) => a + g.vertices.length, 0), 0),
        tris: models.reduce((s, m) => s + m.meshGroups.reduce(
          (a, g) => a + g.pieces.reduce((t, p) => t + (p.topology === 'strip' ? p.corners.length - 2 : p.corners.length / 3), 0), 0), 0),
        animCount: models.reduce((s, m) => s + m.animations.length, 0),
        scheduleCount: models.reduce((s, m) => s + (m.schedules?.length ?? 0), 0),
        textures: models.flatMap((m) => [...m.textures.values()]).map((t) => ({
          name: t.name, width: t.width, height: t.height, format: t.format, data: t.data,
        })),
      });

      // Per-part breakdown (character composer): stats of each slot's own DATs.
      const infoParts = (parts ?? [])
        .map((p) => {
          const set = new Set(p.paths.map((x) => x.toLowerCase()));
          const models = parsed.filter((e) => set.has(e.path.toLowerCase())).map((e) => e.model);
          return models.length
            ? { key: p.key, label: p.label, itemLabel: p.itemLabel, relPaths: p.paths.map(relativeName), ...statsOf(models) }
            : null;
        })
        .filter(Boolean);

      setModelInfo({
        name: displayName,
        ...statsOf([model]),
        joints: model.skeleton.joints.length,
        parts: infoParts,
      });

      setTexWindows([]);   // close texture windows from the previous model
      setObjectGroups(null);
      setPlcSelected('');
      setHasCollision(false);
      setHasNavmesh(false);
      setHasSkybox(false);
      setShowCollision(false);
      setShowNavmesh(false);
      setShowSkyboxState(false);   // entities have no sky; keep the saved preference
      if (rendererRef.current) {
        rendererRef.current.showCollision = false;
        rendererRef.current.showNavmesh = false;
        rendererRef.current.showSkybox = false;
        rendererRef.current.setNavmesh(null);
        rendererRef.current.setSkyDome(null);
      }
      zoneEnvsRef.current = null;
      setWeatherList([]);
      releaseOverlay();
      setStatusText(skipped.length ? `${skipped.length} missing DAT${skipped.length > 1 ? 's' : ''} skipped` : '');
      try {
        localStorage.setItem(LAST_DAT_KEY, JSON.stringify({ paths, name: displayName, opts: { focusPaths, weaponSlots, battleTable, parts } }));
      } catch { /* quota / private mode */ }
    } catch (err) {
      console.error(err);
      releaseOverlay();
      if (stillCurrent()) setStatusText(`${displayName} — failed to load: ${err.message ?? err}`);
    }
  }, [beginLoad, stepLoad, endLoad]);

  const relativeName = (path) => relFromAbs(path, settingsRef.current);

  const loadFromTree = useCallback(
    (path) => loadModel([path], relativeName(path)),
    [loadModel]);

  const loadNpcEntry = useCallback(
    (entry) => {
      const abs = (p) => `${settingsRef.current.gamePath}\\${p}`;
      loadModel(entry.paths.map(abs), entry.name, {
        focusPaths: entry.focusPaths?.map(abs) ?? null,
        weaponSlots: entry.weaponSlots
          ? Object.fromEntries(Object.entries(entry.weaponSlots).map(([k, v]) => [k, (v ?? []).map(abs)]))
          : null,
        battleTable: entry.battleTable ?? null,
        parts: entry.parts?.map((p) => ({ ...p, paths: p.paths.map(abs) })) ?? null,
        keepCamera: !!entry.keepCamera,
        displayPath: entry.displayPath ? abs(entry.displayPath) : null,
      });
    },
    [loadModel]);

  // Cached FFXiMain.dll decrypt tables (zone 0x2E / 0x1C).
  const keyTablesRef = useRef(null);
  const getKeyTables = useCallback(async () => {
    if (keyTablesRef.current) return keyTablesRef.current;
    const settings = settingsRef.current;
    if (!settings?.gamePath) throw new Error('Game path not set');
    // DLL keys are install-specific — always the vanilla game path, not HD.
    const buf = await backend.readFile(`${settings.gamePath}\\FFXiMain.dll`);
    keyTablesRef.current = extractKeyTables(buf);
    return keyTablesRef.current;
  }, []);

  /**
   * Build the zone's particle system (xim ParticleSystem + GlobalDirectory).
   *
   * ROM/0/0.DAT is the shared `syst/effe` tree every zone links into for common
   * meshes, sprites and curves — impact splashes, sparks, lens flares. It's
   * loaded once and cached, since zones swap far more often than it changes.
   */
  const buildParticleSystem = useCallback(async (treeBuf, parsed, environment, settings) => {
    const warnings = [];
    const effectParser = {
      [SEC.EFFECT]: (b, d, s, e) => parseParticleGenerator(b, d, s, e, (m) => warnings.push(m)),
    };
    const zoneParsers = makeParsers(effectParser, true);
    const globalParsers = makeParsers(effectParser, false);

    const treeOf = (buffer, parsers) => {
      const bytes = new Uint8Array(buffer);
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return buildDatTree(bytes, dv, parseSections(dv), parsers, (m) => warnings.push(m));
    };

    if (!globalEffectsRef.current) {
      try {
        const { data: buf } = await backend.readPrefer(gameCandidates('ROM\\0\\0.DAT', settings));
        globalEffectsRef.current = { root: treeOf(buf, globalParsers), textures: parseDatTextures(buf) };
      } catch (e) {
        console.warn('shared effects DAT (ROM/0/0.DAT) unavailable', e);
        globalEffectsRef.current = { root: null, textures: new Map() };
      }
    }

    const system = new ParticleSystem({
      zoneRoot: treeOf(treeBuf, zoneParsers),
      globalRoot: globalEffectsRef.current.root,
      zoneMeshIdToName: parsed.meshIdToName,
      zoneMeshes: parsed.meshes,
      zoneMeshSections: parsed.meshSections,
      camera: null,                 // supplied by renderer.setParticleSystem
      environment,
      onWarn: (m) => console.debug('[particles]', m),
    });

    const zoneCount = system.registerZoneEffects();
    if (warnings.length) console.debug(`[particles] ${warnings.length} parse warnings`);
    console.debug(`[particles] registered ${zoneCount} zone effects`);
    return system;
  }, []);

  // ── Assets > Effects ───────────────────────────────────────────────────────

  /** Load ROM/0/0.DAT once — the shared effects tree spell DATs link into. */
  const ensureGlobalEffects = useCallback(async (settings, warnings) => {
    if (globalEffectsRef.current) return globalEffectsRef.current;
    try {
      const { data: buf } = await backend.readPrefer(gameCandidates('ROM\\0\\0.DAT', settings));
      globalEffectsRef.current = {
        root: buildParticleTree(buf, particleParsers(false, warnings), warnings),
        textures: parseDatTextures(buf),
        // Shared routines (mdam, stnm, dada, …) that effect routines invoke by
        // name through their 0x03 commands.
        routines: new Map(parseEffectRoutines(buf).map((r) => [r.id, r])),
      };
    } catch (e) {
      console.warn('shared effects DAT (ROM/0/0.DAT) unavailable', e);
      globalEffectsRef.current = { root: null, textures: new Map(), routines: new Map() };
    }
    return globalEffectsRef.current;
  }, []);

  /**
   * Load and play a standalone spell/ability effect on the empty stage. The DAT
   * is a directory of 0x05 generators plus a 0x07 routine timeline; we build its
   * particle tree, arm the routine, and hand the system to the renderer, which
   * draws the particles at the world origin (no actor rig — see effect.js).
   */
  const loadEffect = useCallback(async (entry) => {
    const settings = settingsRef.current;
    if (!settings?.gamePath) { setStatusText('Set a game path in Settings first.'); return; }
    const rel = normRel(entry.path);
    const token = ++effectTokenRef.current;
    // Silence the outgoing effect on the click, not when the new one finishes
    // loading — reading and parsing the DAT takes long enough that the old
    // sounds would otherwise carry on over the new selection. Also covers a
    // load that fails or gets superseded before it can attach.
    weatherAudioRef.current?.stopOneShots();
    rendererRef.current?.particleSystem?.clearEffect();
    setStatusText(`Loading ${entry.name}…`);

    try {
      const { data: buf } = await backend.readPrefer(gameCandidates(rel, settings));
      const parsed = parseEffectRoutines(buf);
      const warnings = [];
      await ensureGlobalEffects(settings, warnings);
      if (token !== effectTokenRef.current) return;   // superseded by a newer click

      // Expand each routine's 0x03 calls now, so picking one from the Schedule
      // combo is just a lookup. A `main` that spawns nothing itself usually
      // delegates to another routine (Cure: main → tgt0) — see flattenRoutine.
      const byId = new Map(parsed.map((r) => [r.id, r]));
      const globalById = globalEffectsRef.current?.routines ?? null;
      const routines = parsed.map((r) => ({ ...r, flat: flattenRoutine(r, byId, globalById) }));

      const tree = buildParticleTree(buf, particleParsers(false, warnings), warnings);
      // The effect's own images; the shared ROM/0/0.DAT set is merged in for
      // rendering (links reach into it) but kept out of the Details listing,
      // which should show what *this* effect ships.
      const ownTextures = parseDatTextures(buf);
      const textures = new Map(ownTextures);
      for (const [name, tex] of globalEffectsRef.current?.textures ?? []) {
        if (!textures.has(name)) textures.set(name, tex);
      }

      const system = new ParticleSystem({
        zoneRoot: tree,
        globalRoot: globalEffectsRef.current?.root ?? null,
        camera: null,
        environment: null,
        onWarn: (m) => console.debug('[effect]', m),
      });
      // `main` is the entry point and must win, even when it isn't first in DAT
      // order — Banishga V declares sub1, main, sub2, so picking "first routine
      // with content" played sub1: half the generators and none of the sounds.
      // Only fall back to another routine when main genuinely plays nothing.
      const playable = (r) => r && r.flat.commands.length > 0;
      const named = routines.find((r) => r.id === 'main');
      const routine = (playable(named) ? named : null)
        ?? routines.find(playable)
        ?? routines[0]
        ?? { id: 'main', flat: { commands: [], sounds: [] } };

      // Particle- and routine-driven SFX. WeatherAudio's play() is a generic
      // sound-pointer backend; passing no environment keeps its ambient bed out
      // of it, leaving just the effect's own one-shots.
      const audio = getWeatherAudio();
      audio.attach(system, null);
      audio.setEnabled(effectSfxOnRef.current);
      audio.setVolume(effectVolumeRef.current);

      // Decode every scheduled sound BEFORE arming the routine — a cold first
      // play pays read + decode at fire time and lands audibly late no matter
      // how right the schedule is. All routines' sounds, so switching Schedule
      // stays warm too.
      const warmIds = new Set();
      for (const r of routines) {
        for (const s of r.flat.sounds) {
          const ptr = system.areaRoot?.getChildRecursive(s.soundId, SEC.SOUND_POINTER)
            ?? system.globalRoot?.getChildRecursive(s.soundId, SEC.SOUND_POINTER);
          if (ptr) warmIds.add(ptr.soundId);
        }
      }
      if (warmIds.size && effectSfxOnRef.current) {
        await Promise.all([...warmIds].map((id) => audio.warm(id)));
        if (token !== effectTokenRef.current) return;
      }

      system.playEffectRoutine(routine.flat.commands, { loop: true, sounds: routine.flat.sounds });

      const renderer = rendererRef.current;
      setWasd(false);                    // effects orbit; fly controls would fight the framing
      // Already showing an effect? Keep the orbit — only frame the first one so
      // switching effects doesn't yank the camera back each time.
      const keepCamera = renderer.effectMode;
      renderer.setEffectScene(system, textures, keepCamera);
      renderer.effectSpeed = effectSpeedRef.current;
      renderer.effectPaused = false;

      modelRef.current = null;
      effectRoutinesRef.current = routines;
      setEffectEntry(entry);
      setEffectRoutines(routines);
      setEffectSchedule(routine.id);
      setEffectPlaying(true);
      setModelPath(rel);
      setSelectedDat(abs.toLowerCase());
      shownPathRef.current = abs;

      // Details panel: the effect's sprite images (click to view, same as gear
      // textures) plus what the DAT actually contains.
      const dir = tree.getSubDirectories()[0] ?? tree;
      const sheets = dir.collectByTypeRecursive(SEC.SPRITE_SHEET);
      const pmeshes = dir.collectByTypeRecursive(SEC.PARTICLE_MESH);
      const countVerts = (list) => list.reduce(
        (n, r) => n + (r.meshes ?? []).reduce((m, x) => m + (x.count ?? 0), 0), 0,
      );
      const verts = countVerts(sheets) + countVerts(pmeshes);
      setTexWindows([]);   // close viewers from the previous effect
      setModelInfo({
        name: entry.name,
        joints: null,
        verts,
        tris: Math.floor(verts / 3),
        animCount: 0,
        scheduleCount: routines.length,
        textures: [...ownTextures.values()].map((t) => ({
          name: texLabel(t.name), width: t.width, height: t.height, format: t.format, data: t.data,
        })),
        parts: [],
        effect: {
          path: rel,
          category: entry.cat ?? '—',
          generators: routine.flat.commands.length,
          sounds: routine.flat.sounds.length,
          spriteSheets: sheets.length,
          particleMeshes: pmeshes.length,
        },
      });
      setStatusText(
        routine.flat.commands.length
          ? `${entry.name}  ·  ${routine.flat.commands.length} generators`
          : `${entry.name}  ·  no particle routine`,
      );
    } catch (e) {
      console.warn('[effect] load failed', abs, e);
      if (token === effectTokenRef.current) {
        setStatusText(`Effect load failed: ${e.message || e || 'unknown error'}`);
      }
    }
    // getWeatherAudio is declared below this callback, so it can't go in the
    // dependency array without tripping the temporal dead zone. It's a
    // useCallback with no deps — stable for the life of the component — so the
    // captured reference is always the right one.
  }, [ensureGlobalEffects, setWasd]);

  /** Effect SFX level. 0 mutes: the backend stops rather than playing silence. */
  const setEffectVolume = useCallback((v) => {
    const clamped = Math.min(1, Math.max(0, v));
    effectVolumeRef.current = clamped;
    effectSfxOnRef.current = clamped > 0;
    setEffectVolumeState(clamped);
    try { localStorage.setItem('effectVolume', String(clamped)); } catch { /* quota */ }
    const audio = weatherAudioRef.current;
    if (!audio) return;
    audio.setVolume(clamped);
    audio.setEnabled(clamped > 0);
  }, []);

  const setEffectSpeed = useCallback((v) => {
    const clamped = Math.min(2, Math.max(0.1, v));
    effectSpeedRef.current = clamped;
    setEffectSpeedState(clamped);
    if (rendererRef.current) rendererRef.current.effectSpeed = clamped;
  }, []);

  const toggleEffectPlay = useCallback(() => {
    setEffectPlaying((p) => {
      const next = !p;
      if (rendererRef.current) rendererRef.current.effectPaused = !next;
      return next;
    });
  }, []);

  const changeEffectSchedule = useCallback((id) => {
    setEffectSchedule(id);
    const system = rendererRef.current?.particleSystem;
    if (!system) return;
    const routine = effectRoutinesRef.current.find((r) => r.id === id);
    if (!routine) { system.clearEffect(); setEffectPlaying(false); return; }
    system.playEffectRoutine(routine.flat.commands, { loop: true, sounds: routine.flat.sounds });
    rendererRef.current.effectPaused = false;
    setEffectPlaying(true);
  }, []);

  /** Reset: restart the routine from frame 0 (speed reset is handled by onSpeed). */
  const restartEffect = useCallback(() => {
    const renderer = rendererRef.current;
    renderer?.particleSystem?.restartEffect();
    if (renderer) renderer.effectPaused = false;
    setEffectPlaying(true);
  }, []);

  /**
   * Zone BGM from the server's zone_settings (see dev/bake-zone-music.mjs).
   * Each zone names a day and a night track; id 0 means genuine silence, which
   * is why Valkurm Dunes and Qufim Island have no daytime music.
   *
   * Resolving is cheap and happens on zone load / time change; *decoding* is not
   * (ATRAC3 shells out to vgmstream), so playback is left to an explicit press
   * of the play button rather than firing automatically on every zone load.
   */
  const resolveZoneTrack = useCallback(async (zoneId, isNight) => {
    if (zoneId == null) { setZoneTrack(null); return; }
    if (!zoneMusicRef.current) {
      try {
        const res = await fetch('lists/zone_music.json');
        zoneMusicRef.current = res.ok ? await res.json() : {};
      } catch { zoneMusicRef.current = {}; }
    }
    const entry = zoneMusicRef.current[String(zoneId)];
    const track = isNight ? (entry?.night ?? entry?.day) : (entry?.day ?? entry?.night);
    setZoneTrack(track?.root ? { ...track, isNight } : null);
  }, []);

  /** Play (or stop) the resolved zone track. */
  const toggleZoneMusic = useCallback(async () => {
    const p = playerRef.current;
    const track = zoneTrackRef.current;
    if (!p) return;
    if (!track) { p.stop(); return; }

    const rel = `${track.root}\\win\\music\\data\\${track.file}`;
    const path = await backend.resolvePrefer(gameCandidates(rel, settingsRef.current));
    if (p.current?.path === path && p.playing) { p.pause(); return; }
    if (p.current?.path === path) { p.resume(); return; }

    try {
      await p.play({
        file: track.file,
        path,
        root: track.root,
        num: String(track.id),
        name: track.name ?? `music${String(track.id).padStart(3, '0')}`,
      });
    } catch (e) {
      console.warn('zone music failed', e);
      setStatusText(`Zone music failed: ${e.message ?? e}`);
    }
  }, []);

  /**
   * Ambient weather audio. The context is created lazily on first use because
   * browsers refuse to start one before a user gesture.
   */
  const getWeatherAudio = useCallback(() => {
    if (weatherAudioRef.current) return weatherAudioRef.current;
    let ctx = null;
    weatherAudioRef.current = new WeatherAudio({
      getContext: () => {
        if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
      },
      loadSound: async (relPath) => {
        const settings = settingsRef.current;
        if (!settings?.gamePath) return null;
        const abs = await backend.resolvePrefer(gameCandidates(relPath, settings));
        const buffer = await backend.readFile(abs);
        const header = parseAudioHeader(buffer);
        const audioCtx = weatherAudioRef.current.getContext();
        // The loop point is a property of the source file, so it survives
        // whichever decoder runs. Without it an ambient bed replays its intro
        // on every cycle and clicks.
        const loopStart = header?.loopStartSec ?? 0;
        // ATRAC3 needs the native decoder via vgmstream; ADPCM/PCM decode here.
        if (header?.sampleFormat === FMT_ATRAC3) {
          const wav = await backend.decodeVgmstream(abs);
          return { buffer: await audioCtx.decodeAudioData(wav), loopStart };
        }
        return { buffer: toAudioBuffer(audioCtx, buffer).audioBuffer, loopStart };
      },
    });
    return weatherAudioRef.current;
  }, []);

  /** Persist the live camera for the zone currently on screen (if any). */
  const persistCurrentZoneCamera = useCallback(() => {
    const key = zoneCamKeyRef.current;
    const cam = rendererRef.current?.camera;
    if (!key || !cam || modelRef.current?.kind !== 'zone') return;
    writeZoneCamera(key, cam.snapshot());
  }, []);

  // Keep the last zone pose across app quit / tab close.
  useEffect(() => {
    const onHide = () => persistCurrentZoneCamera();
    window.addEventListener('pagehide', onHide);
    window.addEventListener('beforeunload', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('beforeunload', onHide);
    };
  }, [persistCurrentZoneCamera]);

  /**
   * Load a zone DAT into the viewport (Assets > Zones).
   * opts.keepCamera / opts.cameraSnap — skip the default fit (HD reload).
   * Otherwise restores the last saved camera for this zone, if any.
   */
  const loadZone = useCallback(async (zone, opts = {}) => {
    const { keepCamera = false, cameraSnap = null } = opts;
    const settings = settingsRef.current;
    if (!settings?.gamePath) {
      setStatusText('Game path not set — open Settings first.');
      return;
    }
    // Leaving another zone — remember where the camera was.
    persistCurrentZoneCamera();
    const rel = zoneDatRelPath(zone.path);
    const displayName = zone.name || rel;
    const key = zoneCamKey(zone);
    const gen = ++loadGenRef.current;
    const stillCurrent = () => gen === loadGenRef.current;
    const releaseOverlay = () => {
      if (overlayGenRef.current === gen) endLoad();
    };
    try {
      beginLoad(displayName, 'Reading DAT…');
      overlayGenRef.current = gen;
      player.stop();
      const [{ data: datBuf, path: resolvedAbs }, keyTables] = await Promise.all([
        backend.readPrefer(gameCandidates(rel, settings)),
        getKeyTables(),
      ]);
      if (!stillCurrent()) { releaseOverlay(); return; }
      stepLoad('Decrypting zone…');
      // Yield so the overlay can paint before the heavy CPU work.
      await yieldToPaint();
      if (!stillCurrent()) { releaseOverlay(); return; }
      // parseZone decrypts the 0x2E/0x1C chunks in place, so the DAT tree needs
      // its own copy of the bytes taken before that happens.
      const treeBuf = datBuf.slice(0);
      const parsed = parseZone(datBuf, keyTables);

      // Xim terrain lighting + procedural sky dome from the 0x2F environment.
      // EnvironmentManager owns the clock and the weather cross-fade; the panel
      // drives it rather than re-resolving the DAT on every change.
      let environment = null;
      let terrainLit = null;
      let skyDome = null;
      let envs = null;
      let weather0 = null;
      const time0 = 12 * 60;
      try {
        const byRoot = parseEnvironmentsByRoot(treeBuf);
        envs = byRoot.get('weat') ?? new Map();
        environment = new EnvironmentManager(byRoot);
        environment.setTimeMinutes(time0);
        weather0 = environment.getWeather();
        terrainLit = environment.getTerrainLighting();
        skyDome = environment.getSkyDome();
      } catch (e) { console.warn('environment parse failed', e); }
      zoneEnvsRef.current = envs;

      // Live particle system: zone effects (water, spray, fountains) plus the
      // active weather's effects, driven by the ported xim runtime.
      stepLoad('Loading effects…');
      let particleSystem = null;
      try {
        particleSystem = await buildParticleSystem(treeBuf, parsed, environment, settings);
        if (environment) environment.particleSystem = particleSystem;
        // The weather set is activated after the renderer attaches its camera —
        // sun/moon generators read the camera as they're constructed.
      } catch (e) { console.warn('particle system init failed', e); }
      if (!stillCurrent()) { releaseOverlay(); return; }
      stepLoad('Baking placements…');
      await yieldToPaint();
      if (!stillCurrent()) { releaseOverlay(); return; }
      const model = zoneToModel(parsed, displayName);
      if (!model.isRenderable) {
        releaseOverlay();
        setStatusText(`${displayName} — no renderable mesh`);
        return;
      }

      stepLoad('Uploading to GPU…');
      if (!stillCurrent()) { releaseOverlay(); return; }
      // Shared-effect textures live in ROM/0/0.DAT, not the zone; fold them in
      // so particles linking to them have something to sample.
      for (const [name, tex] of globalEffectsRef.current?.textures ?? []) {
        if (!model.textures.has(name)) model.textures.set(name, tex);
      }
      modelRef.current = model;
      const renderer = rendererRef.current;
      renderer.setFloorTexture(null);   // actor floor plane doesn't apply to zones
      setSelectedFloor('');
      // Always push lighting (fallback when the DAT has no 0x2F / indoor default).
      renderer.setTerrainLighting(terrainLit || terrainLightingFromEnv(null, time0));
      renderer.setSkyDome(skyDome);
      renderer.skyWeather = weather0;

      // Camera: HD reload keeps the live pose; re-open restores the last pose
      // for this zone; first visit fits + optional auto-WASD.
      const saved = keepCamera ? (cameraSnap || null) : readZoneCamera(key);
      renderer.setModel(model, !!saved);
      if (saved) {
        const mode = saved.mode === 'orbit' ? 'orbit' : 'fly';
        // Sync WASD UI without setMode — restore() assigns mode itself.
        wasdRef.current = mode === 'fly';
        setWasdState(mode === 'fly');
        try { localStorage.setItem('wasd', mode === 'fly' ? '1' : '0'); } catch { /* quota */ }
        renderer.camera.restore({ ...saved, mode });
      } else if (settingsRef.current?.autoWasdZones !== false) {
        // setModel already fitted in orbit; seat fly on that eye.
        setWasd(true);
        renderer.fitCamera();
      }

      // setModel clears any previous system, so attach after it. Attaching also
      // installs the camera adapter, which the weather generators need.
      renderer.setParticleSystem(particleSystem, environment);
      environment?.activateInitialWeather();
      zoneEnvManagerRef.current = environment;
      if (particleSystem && environment) {
        const audio = getWeatherAudio();
        audio.attach(particleSystem, environment);
        // Zone ambient uses sfxVolume / sfxOn (Weather panel), not the effect-viewer volume.
        audio.setVolume(sfxVolumeRef.current);
        audio.setEnabled(!!sfxOnRef.current && sfxVolumeRef.current > 0);
        renderer.weatherAudio = audio;
        renderer.showSoundMarkers = localStorage.getItem('soundMarkers') === '1';
      }

      // Zone BGM. FFXI treats 18:00–06:00 as night for music purposes.
      zoneMusicIdRef.current = zone.id ?? null;
      const hour = Math.floor((environment?.getTimeMinutes() ?? time0) / 60);
      resolveZoneTrack(zone.id, hour < 6 || hour >= 18);
      setSelectedDat(resolvedAbs.toLowerCase());
      setModelPath(rel);
      shownPathRef.current = resolvedAbs;
      sourcePathRef.current = resolvedAbs;
      zoneCamKeyRef.current = key;
      animsRef.current = [];
      setAnims([]);
      setSchedules([]);
      setCurrentAnim('');
      setCurrentSchedule('');
      setPlayingState(false);
      renderer.setAnimation(null);
      renderer.playing = false;

      const zs = model.zoneStats ?? {};
      // Skybox = gradient dome and/or cloud shells. Indoor star/sun discs alone
      // don't count — those zones get the "No Skybox" weather notice.
      const hasClouds = (model.zoneDraws ?? []).some(
        (d) => d.layer === 'sky' && !d.celestial && !d.positioned,
      );
      const hasSky = !!skyDome || hasClouds;
      setHasCollision(!!model.collision?.positions?.length);
      setHasSkybox(hasSky);
      setWeatherList(envs ? listWeathers(envs) : []);
      setWeather(weather0 || '');
      setTimeMinutes(time0);
      setShowCollision(false);
      setShowNavmesh(false);
      renderer.showCollision = false;
      renderer.showNavmesh = false;
      // Restore the saved skybox preference (off if this zone has no sky).
      setSkybox(hasSky && localStorage.getItem('skybox') === '1');
      // Navmesh from public/navmesh/<ZoneName>.nav (async; doesn't block load).
      setHasNavmesh(false);
      loadZoneNavmesh(displayName).then((nav) => {
        if (modelRef.current !== model) return; // zone changed
        if (nav) {
          renderer.setNavmesh(nav);
          setHasNavmesh(true);
        } else {
          renderer.setNavmesh(null);
          setHasNavmesh(false);
        }
      }).catch(() => { setHasNavmesh(false); });
      setObjectGroups(model.objectGroups ?? []);
      setPlcSelected('');
      setPlcOpen(true);
      setModelInfo({
        name: displayName,
        joints: 1,
        verts: zs.vertexCount ?? 0,
        tris: zs.triCount ?? 0,
        animCount: 0,
        scheduleCount: 0,
        textures: [...model.textures.values()].map((t) => ({
          name: t.name, width: t.width, height: t.height, format: t.format, data: t.data,
        })),
        parts: [],
        zone: {
          id: zone.id,
          path: rel,
          meshCount: zs.meshCount,
          placementCount: zs.placementCount,
          placementTotal: zs.placementTotal,
          objectTypes: zs.objectTypes,
          skippedWild: zs.skippedWild ?? 0,
          skippedMissing: zs.skippedMissing ?? 0,
          envCount: zs.envCount ?? 0,
          collTris: zs.collTris ?? 0,
        },
      });
      setTexWindows([]);
      releaseOverlay();
      setStatusText('');   // zone stats live in Details
      try {
        localStorage.setItem(LAST_DAT_KEY, JSON.stringify({
          kind: 'zone',
          zone: { id: zone.id, name: zone.name, path: zone.path },
        }));
      } catch { /* quota */ }
    } catch (err) {
      console.error(err);
      releaseOverlay();
      if (stillCurrent()) setStatusText(`${displayName} — failed: ${err.message ?? err}`);
    }
  }, [getKeyTables, beginLoad, stepLoad, endLoad, setWasd, buildParticleSystem, getWeatherAudio, resolveZoneTrack, persistCurrentZoneCamera]);

  // Character composer (Assets > Characters) — shared by the left panel and
  // the Animation panel Action combo.
  const pc = useCharacter({
    enabled: leftView === 'pc' && !!settings?.gamePath,
    onLoad: loadNpcEntry,
    onError: (msg) => setStatusText(msg),
  });

  // --- Character Creation (high-poly RT/SHAPE + SQLE models) ----------------

  const [crInfo, setCrInfo] = useState(null);
  // Auto-detected poses inside the long sequence, and which one is playing
  // (-1 = the whole clip). Picking one only re-windows the driver, no reload.
  const [crSegments, setCrSegments] = useState([]);
  const [crSegment, setCrSegment] = useState(-1);
  // The camera is framed once, on the first model this view shows. Every later
  // race/face/equipment/animation change keeps whatever view you set up — you
  // are comparing them, so yanking the camera each time is worse than useless.
  const crFramedRef = useRef(false);
  // Authored camera track: which of the two cameras, whether it is driving, and
  // the built track (kept in refs so the loader can read them without redoing).
  const [crHasCamera, setCrHasCamera] = useState(false);
  const [crCameraOn, setCrCameraOnState] = useState(false);
  const [crCameraIndex, setCrCameraIndexState] = useState(0);
  const crCameraOnRef = useRef(false);
  const crCameraRef = useRef(0);
  const crCameraTrackRef = useRef(null);
  const setCrCameraOn = useCallback((on) => {
    crCameraOnRef.current = on;
    setCrCameraOnState(on);
    const r = rendererRef.current;
    if (r) r.creationCamera = on ? crCameraTrackRef.current : null;
    // Handing the camera back leaves it wherever the last shot pointed, which
    // is rarely a useful view — re-frame the performance.
    if (!on && r?.creationDriver) {
      const seq = r.creationDriver.sequenceBounds();
      if (seq) r.camera.fit(seq.min, seq.max);
      r.camera.fovDegrees = fovRef.current;
    }
  }, []);
  const setCrCameraIndex = useCallback((i) => {
    crCameraRef.current = i;
    setCrCameraIndexState(i);
  }, []);
  // Assembled model cache: switching only the animation swaps motion drivers
  // without re-reading and re-building the mesh/material DATs.
  const crModelCacheRef = useRef({ key: '', model: null });
  const crMotionCacheRef = useRef(new Map());   // rel path -> parsed motion

  const loadCreation = useCallback(async (desc) => {
    const settings = settingsRef.current;
    if (!settings?.gamePath) { setStatusText('Game path not set — open Settings first.'); return; }
    const gen = ++loadGenRef.current;
    const stillCurrent = () => gen === loadGenRef.current;
    let bodyMeshRel = desc.bodyMesh;
    let bodyMatRel = desc.bodyMat;
    let modelKey = [bodyMeshRel, bodyMatRel, desc.headMesh, desc.headMat, desc.headY].join('|');
    let rebuild = crModelCacheRef.current.key !== modelKey || !crModelCacheRef.current.model;
    const showOverlay = rebuild;
    const releaseOverlay = () => { if (showOverlay && overlayGenRef.current === gen) endLoad(); };
    try {
      if (showOverlay) {
        beginLoad(desc.name, 'Reading DAT…');
        overlayGenRef.current = gen;
      } else {
        setStatusText(`Loading ${desc.name}…`);
      }
      const readRel = async (rel) => (await backend.readPrefer(gameCandidates(rel, settings))).data;

      const buildWith = async (meshRel, matRel) => {
        const [bodyMesh, bodyMat, headMesh, headMat] = await Promise.all([
          readRel(meshRel),
          readRel(matRel).catch(() => null),
          readRel(desc.headMesh),
          readRel(desc.headMat).catch(() => null),
        ]);
        stepLoad('Building model…');
        await yieldToPaint();
        const built = buildCreationModel([
          { mesh: bodyMesh, mat: bodyMat, isBody: true },
          { mesh: headMesh, mat: headMat, isBody: false, offsetY: desc.headY },
        ], desc.name);
        if (!built.isRenderable) throw new Error('no displayable creation geometry');
        return built;
      };

      let model = crModelCacheRef.current.model;
      if (rebuild) {
        model = await buildWith(bodyMeshRel, bodyMatRel);
        if (!stillCurrent()) { releaseOverlay(); return; }
        crModelCacheRef.current = { key: modelKey, model };
      }

      const readMotion = async (rel) => {
        const cache = crMotionCacheRef.current;
        if (!cache.has(rel)) cache.set(rel, parseSqleMotion(await readRel(rel)));
        return cache.get(rel);
      };

      // Matched body/head motion pair for the chosen animation (if any).
      let driver = null;
      let motions = null;
      let swappedVariant = null;
      if (desc.motions) {
        if (showOverlay) stepLoad('Reading motion…');
        const [bodyMo, headMo] = await Promise.all([
          readMotion(desc.motions.body).catch(() => null),
          readMotion(desc.motions.head).catch(() => null),
        ]);
        if (!stillCurrent()) { releaseOverlay(); return; }
        motions = { body: bodyMo, head: headMo };
        driver = new CreationAnimator(model, [bodyMo, headMo]);
        // Tarutaru/Mithra/Galka carry a different skeleton per equipment
        // variant, and each clip is authored for exactly one of them. Rather
        // than freeze on a bind pose, rebuild on the variant that can play it.
        if (!driver.compatible && desc.altBodyMesh) {
          const alt = await buildWith(desc.altBodyMesh, desc.altBodyMat);
          if (!stillCurrent()) { releaseOverlay(); return; }
          const altDriver = new CreationAnimator(alt, [bodyMo, headMo]);
          if (altDriver.compatible) {
            model = alt;
            bodyMeshRel = desc.altBodyMesh;
            bodyMatRel = desc.altBodyMat;
            modelKey = [bodyMeshRel, bodyMatRel, desc.headMesh, desc.headMat, desc.headY].join('|');
            crModelCacheRef.current = { key: modelKey, model };
            driver = altDriver;
            rebuild = true;
            swappedVariant = desc.altLabel;
          }
        }
        if (!driver.compatible) driver = null;
      }

      if (!stillCurrent()) { releaseOverlay(); return; }
      player.stop();
      const renderer = rendererRef.current;
      modelRef.current = model;
      if (renderer.model !== model) renderer.setModel(model, crFramedRef.current);

      if (driver) {
        renderer.creationDriver = driver;
        driver.bind(renderer);
        renderer.setAnimation(driver.clip);
        // Frame the whole performance, not the bind pose it starts from — but
        // only the first time, so later changes leave the camera alone.
        const seq = driver.sequenceBounds();
        if (seq) {
          if (!crFramedRef.current) renderer.camera.fit(seq.min, seq.max);
          renderer.snapFloorToFeet({ min: seq.min, max: seq.max, footY: seq.max[1] });
        }
        crFramedRef.current = true;
        renderer.playing = settingsRef.current?.autoPlay ?? true;
        setPlayingState(renderer.playing);
        setCrSegments(driver.segments);
        setCrSegment(-1);

        // Authored camera track — only the long sequence has one, and only it
        // shares the sequence's frame count.
        let camera = null;
        if (desc.anim === 'seq') {
          const race = CREATION_RACES.find((r) => r.id === desc.raceId);
          const cams = creationCameraPaths(race);
          const pick = cams[crCameraRef.current] ?? cams[0];
          if (pick) {
            const [fovMo, matMo] = await Promise.all([
              readMotion(pick.fov).catch(() => null),
              readMotion(pick.matrix).catch(() => null),
            ]);
            const built = buildCreationCamera(fovMo, matMo);
            if (built && built.frameCount === driver.frameCount) camera = built;
          }
        }
        setCrHasCamera(!!camera);
        renderer.creationCamera = crCameraOnRef.current ? camera : null;
        crCameraTrackRef.current = camera;
      } else {
        renderer.creationDriver = null;
        renderer.setAnimation(null);
        restoreCreationBind(renderer);
        renderer.playing = false;
        setPlayingState(false);
        setCrSegments([]);
        setCrSegment(-1);
        crFramedRef.current = true;
      }
      appliedPlayRef.current = { kind: null, id: '' };
      setAnims([]);
      setSchedules([]);
      setCurrentAnim('');
      setCurrentSchedule('');
      setModelPath(desc.name);
      setSelectedDat(desc.bodyMesh.toLowerCase());
      shownPathRef.current = `${settings.gamePath}\\${normRel(desc.bodyMesh)}`;
      sourcePathRef.current = shownPathRef.current;

      const cr = model.creation;
      setCrInfo({
        bones: cr.bones.length,
        verts: cr.groups.reduce((n, g) => n + g.vertCount, 0),
        shapes: cr.groups.length,
        motion: desc.motions ? {
          kind: motions?.body?.kind ?? 'frame',
          frames: motions?.body?.frameCount ?? 0,
          duration: motions?.body?.duration ?? 0,
          fps: motions?.body?.fps ?? 30,
          body: desc.motions.body,
          head: desc.motions.head,
          compatible: !!driver,
          movingBones: driver?.movingBoneCount ?? 0,
          totalBones: cr.bones.length,
          // Set when this clip could only play on the other equipment body.
          shownOn: swappedVariant,
          repaired: driver?.repairedFrames ?? 0,
        } : null,
      });
      releaseOverlay();
      const mismatch = desc.motions && !driver
        ? ` — motion channels (${motions?.body?.channelCount ?? '?'}/${motions?.head?.channelCount ?? '?'})`
          + ` don't match the skeleton pair (${cr.channelSums.join('/')}); showing bind pose`
        : '';
      setStatusText(driver
        ? `${desc.name} — ${driver.frameCount.toLocaleString()} frames, ${driver.duration.toFixed(1)}s`
          + `${swappedVariant ? ` (shown on the ${swappedVariant} body — this clip is authored for it)` : ''}`
        : `${desc.name}${desc.motions ? mismatch : ' — A-pose'}`);
    } catch (err) {
      console.error(err);
      releaseOverlay();
      if (stillCurrent()) setStatusText(`${desc.name} — failed: ${err.message ?? err}`);
    }
  }, [beginLoad, stepLoad, endLoad, player]);

  const cr = useCreation({
    enabled: leftView === 'creation' && !!settings?.gamePath,
    onLoad: loadCreation,
    onError: (msg) => setStatusText(msg),
  });

  // --- startup -------------------------------------------------------------

  useEffect(() => {
    (async () => {
      try {
        const saved = localStorage.getItem('gamePath');
        const gamePath = (saved || (await backend.defaultGamePath())).trim();
        const initialSettings = loadSettings(gamePath);
        setSettings(initialSettings);
        // Mirror to the ref now: setSettings won't reach it until the next
        // render, but loadImage() below reads settingsRef.current this tick.
        settingsRef.current = initialSettings;

        if (!gamePath) {
          setSettingsError('Game path not set. Browse to your FINAL FANTASY XI install folder.');
          setSettingsOpen(true);
          setStatusText('Set a game path in Settings to get started.');
          return;
        }

        try {
          await backend.listDir(gamePath);
        } catch {
          setSettingsError(`Game path not found:\n${gamePath}`);
          setSettingsOpen(true);
          setStatusText('Game path not found — open Settings to fix it.');
          return;
        }

        // Flat views (Images/Music/SFX) own no 3D model, so reopening on one
        // must NOT resurrect the last character behind it. Restore what that
        // page was showing instead and skip the model load entirely.
        const restoredView = localStorage.getItem(LAST_VIEW_KEY);
        if (restoredView === 'images') {
          try {
            const img = JSON.parse(localStorage.getItem(LAST_IMAGE_KEY) || 'null');
            if (img?.path) await loadImage(img);
          } catch { /* stale/corrupt entry — just show the list */ }
          return;
        }
        // Lists that own no model on boot — don't resurrect the last DAT behind them.
        if (restoredView === 'music' || restoredView === 'sfx' || restoredView === 'effects' || restoredView === 'data') return;

        // Prefer the last successfully loaded DAT; fall back to the default demo model.
        let paths = null;
        let name = null;
        let lastOpts = null;
        let lastZone = null;
        try {
          const last = JSON.parse(localStorage.getItem(LAST_DAT_KEY) || 'null');
          if (last?.kind === 'zone' && last.zone?.path) {
            lastZone = last.zone;
          } else if (last?.paths?.length) {
            // Probe with HD fallback so a pack-only DAT still restores.
            const probeRel = relFromAbs(last.paths[0], initialSettings);
            await backend.readPrefer(
              probeRel !== last.paths[0] ? gameCandidates(probeRel, initialSettings) : [last.paths[0]],
            );
            paths = last.paths;
            name = last.name || relativeName(last.paths[last.paths.length - 1]);
            lastOpts = last.opts ?? null;
          }
        } catch { /* stale path or corrupt entry */ }

        if (lastZone) {
          setLeftView('zones');
          await loadZone(lastZone);
          // Restoring a zone on launch puts you back in a walkable world, so
          // give the fly controls back — loadZone only auto-enables them for a
          // zone it has no saved camera for, which never happens on a reload.
          if (settingsRef.current?.autoWasdZones !== false) setWasd(true);
          return;
        }

        // Views that load their own content on arrival must not race the
        // restored/default DAT: it resolves later and replaces what they put
        // on screen (Character Creation came up showing ROM/5/3.DAT).
        if (!SELF_LOADING_VIEWS.has(leftViewRef.current)) {
          if (!paths) {
            paths = [`${gamePath}\\${DEFAULT_DAT_SUFFIX}`];
            name = DEFAULT_DAT_SUFFIX;
          }
          await loadModel(paths, name, lastOpts ?? {});
          setRevealTarget(paths[paths.length - 1].toLowerCase());
        }
      } catch (err) {
        console.error(err);
        setStatusText(`Startup failed: ${err.message ?? err}`);
      }
    })();
  }, [loadModel, loadZone, setWasd]);

  // Debug/verification hook (used by the headless capture flow)
  useEffect(() => {
    window.xi = {
      renderer: rendererRef.current,
      loadDat: (p) => loadModel([p], p),
      loadZone,
      getModel: () => modelRef.current,
    };
  }, [loadModel, loadZone]);

  // --- texture windows -----------------------------------------------------

  const openTexture = useCallback((tex) => {
    setTexWindows((prev) => {
      const i = prev.findIndex((w) => w.tex.name === tex.name);
      if (i >= 0) {
        // Already open — bring to front (keep cascade so it doesn't jump)
        const next = prev.slice();
        const [w] = next.splice(i, 1);
        next.push(w);
        return next;
      }
      const id = ++texIdRef.current;
      return [...prev, { id, tex, cascade: id - 1 }];
    });
  }, []);

  const closeTexture = useCallback((id) => {
    setTexWindows((prev) => prev.filter((w) => w.id !== id));
  }, []);

  const focusTexture = useCallback((id) => {
    setTexWindows((prev) => {
      const i = prev.findIndex((w) => w.id === id);
      if (i < 0 || i === prev.length - 1) return prev;
      const next = prev.slice();
      const [w] = next.splice(i, 1);
      next.push(w);
      return next;
    });
  }, []);

  // Escape closes the topmost modal (export → settings → help → top texture).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (exportSpec) { setExportSpec(null); e.preventDefault(); return; }
      if (settingsOpen) { setSettingsOpen(false); e.preventDefault(); return; }
      if (graphicsOpen) { setGraphicsOpen(false); e.preventDefault(); return; }
      if (helpOpen) { setHelpOpen(false); e.preventDefault(); return; }
      if (texWindows.length > 0) {
        setTexWindows((prev) => prev.slice(0, -1));
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exportSpec, settingsOpen, graphicsOpen, helpOpen, texWindows.length]);

  // --- handlers ------------------------------------------------------------

  const handleAnimChange = (id) => {
    setCurrentAnim(id);
    setCurrentSchedule('');
    rememberAnimSel({ anim: id, schedule: '' });
    appliedPlayRef.current = { kind: 'anim', id };
    const entry = animsRef.current.find((g) => g.id === id);
    rendererRef.current.setAnimation(entry ? entry.clip : null);
  };

  const handleScheduleChange = (id) => {
    setCurrentSchedule(id);
    setCurrentAnim('');
    rememberAnimSel({ anim: '', schedule: id });
    appliedPlayRef.current = { kind: 'schedule', id };
    const model = modelRef.current;
    const sched = model?.schedules.find((s) => s.id === id);
    const clip = sched?.clipIds?.length ? scheduleClip(model, sched) : null;
    rendererRef.current.setAnimation(clip);
    if (clip) {
      rendererRef.current.playing = true;
      setPlayingState(true);
    } else {
      rendererRef.current.playing = false;
      setPlayingState(false);
    }
  };

  const setPlaying = (p) => {
    rendererRef.current.playing = p;
    setPlayingState(p);
  };

  const animControls = {
    anims, currentAnim, onAnimChange: handleAnimChange,
    schedules, currentSchedule, onScheduleChange: handleScheduleChange,
    playing, onTogglePlay: () => setPlaying(!playing),
    frameSink: animTick, onSeek: (f) => rendererRef.current?.seekTo(f),
    speed: playbackSpeed, onSpeed: setPlaybackSpeed,
  };

  // Character Creation playback: idle, the long creation presentation, and the
  // individual poses auto-detected inside it (the file concatenates several,
  // separated by long holds). '— bind pose —' doubles as the A-pose. Transport,
  // scrubber and speed ride the same renderer playhead as ordinary clips.
  const crSecs = (n) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
  const crFps = rendererRef.current?.creationDriver?.fps || 30;
  const creationAnim = {
    anims: [
      ...CREATION_CLIPS.map((c) => ({ id: c.id, label: c.label, clip: {} })),
      // Poses detected inside the long sequence (it concatenates several).
      ...crSegments.map((s, i) => ({
        id: `seg:${i}`,
        label: `  ↳ Pose ${i + 1} (${crSecs(s.start / crFps)}–${crSecs((s.start + s.count) / crFps)})`,
        clip: {},
      })),
    ],
    currentAnim: crSegment >= 0 ? `seg:${crSegment}` : cr.anim,
    onAnimChange: (id) => {
      const driver = rendererRef.current?.creationDriver;
      const seg = typeof id === 'string' && id.startsWith('seg:') ? +id.slice(4) : -1;
      if (seg >= 0 && driver && crSegments[seg]) {
        driver.setRange(crSegments[seg].start, crSegments[seg].count);
        rendererRef.current.setAnimation(driver.clip);
        rendererRef.current.playing = true;
        setPlayingState(true);
        setCrSegment(seg);
        return;
      }
      setCrSegment(-1);
      if (driver && id === cr.anim) {   // same clip — back to its full range
        driver.setRange(0, null);
        rendererRef.current.setAnimation(driver.clip);
        return;
      }
      cr.setAnim(id ?? '');
    },
    playing, onTogglePlay: () => setPlaying(!playing),
    frameSink: animTick, onSeek: (f) => rendererRef.current?.seekTo(f),
    speed: playbackSpeed, onSpeed: setPlaybackSpeed,
  };

  // Effect playback panel: Schedule = the DAT's 0x07 routines, transport + speed.
  // No `onAnimChange` (no clip picker) and no `frameSink` (no scrubber), so the
  // shared AnimationPanel renders just those rows. `onSeek` is the Reset button.
  const effectAnim = {
    schedules: effectRoutines.map((r) => ({ id: r.id, clipIds: [] })),
    currentSchedule: effectSchedule,
    onScheduleChange: changeEffectSchedule,
    playing: effectPlaying,
    onTogglePlay: toggleEffectPlay,
    speed: effectSpeed,
    onSpeed: setEffectSpeed,
    onSeek: restartEffect,
    volume: effectVolume,
    onVolume: setEffectVolume,
  };

  /** Status-bar path → show that DAT in the system file manager, selected.
   *  sourcePathRef keeps the real casing; selectedDat is lowercased for the
   *  tree's own matching and would be a poor thing to hand the OS. */
  const revealInExplorer = async () => {
    const path = shownPathRef.current;
    if (!path) return;
    try {
      await backend.revealPath(path);
    } catch (err) {
      setStatusText(`Could not show in Explorer: ${err.message ?? err}`);
    }
  };

  // Play a raw DAT clip id (e.g. "at00") by switching to its display group ("at0").
  const playClipId = (rawId) => {
    const group = animsRef.current.find((g) => g.id === rawId)
      || animsRef.current.find((g) => g.id === animDisplayName(rawId));
    if (!group) return;
    handleAnimChange(group.id);
    rendererRef.current.playing = true;
    setPlayingState(true);
  };

  // --- scene / floor -------------------------------------------------------

  const resolveSpecRel = (spec) => {
    const parts = spec.split('/');
    const [rom, dir, file] = parts.length === 2 ? ['1', parts[0], parts[1]] : parts;
    const romDir = rom === '1' ? 'ROM' : `ROM${rom}`;
    return `${romDir}\\${dir}\\${file}.DAT`;
  };

  const loadFloor = useCallback(async (spec, fourcc) => {
    try {
      const { data: buffer } = await backend.readPrefer(gameCandidates(resolveSpecRel(spec), settingsRef.current));
      const tex = parseFloorTexture(buffer, fourcc);
      if (!tex) { setStatusText(`Floor '${fourcc}' not found in ${spec}`); return; }
      rendererRef.current.setFloorTexture(tex);
      setSelectedFloor(`${spec}:${fourcc}`);
    } catch (e) {
      setStatusText(`Failed to load floor: ${e.message ?? e}`);
    }
  }, []);

  const clearFloor = useCallback(() => {
    rendererRef.current.setFloorTexture(null);
    setSelectedFloor('');
  }, []);

  const setBg = useCallback((hex) => {
    rendererRef.current.setClearColor(hex);
    rendererRef.current.setFog({ color: hex });   // fade toward the background
    localStorage.setItem('bgColor', hex);
    setSettings((s) => (s ? { ...s, bgColor: hex } : s));
  }, []);

  // Fog on/off + a distance scale over whatever the scene authored. For zones
  // that's the 0x2F environment (re-pushed every frame while weather fades), so
  // these are kept as an override the renderer re-applies rather than a value
  // the environment can overwrite.
  // Off unless the user turned it on before — absent key = off.
  const [fogOn, setFogOnState] = useState(() => localStorage.getItem('fogOn') === '1');
  const [fogScale, setFogScaleState] = useState(() => {
    const v = parseFloat(localStorage.getItem('fogScale'));
    return Number.isFinite(v) && v > 0 ? v : 1;
  });

  const setFogOn = useCallback((on) => {
    setFogOnState(on);
    try { localStorage.setItem('fogOn', on ? '1' : '0'); } catch { /* quota */ }
    rendererRef.current?.setFogOverride({ enabled: on });
  }, []);

  const setFogScale = useCallback((scale) => {
    setFogScaleState(scale);
    try { localStorage.setItem('fogScale', String(scale)); } catch { /* quota */ }
    rendererRef.current?.setFogOverride({ scale });
  }, []);

  // ── Assets > Images ────────────────────────────────────────────────────────
  const [imageEntry, setImageEntry] = useState(null);   // { name, path }
  const [imageDoc, setImageDoc] = useState(null);       // parseImageDat result + resolved sets
  const [imageSet, setImageSet] = useState(null);

  // ── Assets > Data (DAT structure inspector) ────────────────────────────────
  const [dataDoc, setDataDoc] = useState(null);         // inspectDat result + path
  const dataTokenRef = useRef(0);                       // drop stale reads
  const dataBufRef = useRef(null);                      // raw buffer, for texture decode on click
  const dataTexturesRef = useRef(null);                 // lazy parseDatTextures cache
  const dataTablesRef = useRef(null);                   // merged FTABLE maps (zone DAT cross-refs)

  const loadDatData = useCallback(async (path) => {
    const token = ++dataTokenRef.current;
    const settings = settingsRef.current;
    const rel = relativeName(path);
    setStatusText(`Reading ${rel}…`);
    const readAbs = async (abs) => {
      const r = relFromAbs(abs, settings);
      if (r !== abs) {
        const { data } = await backend.readPrefer(gameCandidates(r, settings));
        return data;
      }
      return backend.readFile(abs);
    };
    try {
      // FTABLE/VTABLE pairs get the id → DAT listing, not a section walk.
      const table = matchTablePath(path);
      let doc;
      if (table) {
        const dir = path.slice(0, path.length - path.split(/[\\/]/).pop().length);
        const siblingPath = `${dir}${table.siblingName}`;
        const [own, sibling] = await Promise.all([readAbs(path), readAbs(siblingPath)]);
        if (token !== dataTokenRef.current) return;
        const [ftBuf, vtBuf] = table.kind === 'ftable' ? [own, sibling] : [sibling, own];
        doc = {
          kind: 'ftable',
          ...parseFileTable(ftBuf, vtBuf),
          romIdx: table.romIdx,
          siblingName: table.siblingName,
          fileSize: own.byteLength,
          siblingSize: sibling.byteLength,
        };
        dataBufRef.current = null;
      } else {
        const buf = await readAbs(path);
        if (token !== dataTokenRef.current) return;
        doc = inspectDat(buf);
        dataBufRef.current = buf;
        // Non-sectioned DATs may still be a known zone script format.
        if (doc.kind === 'other') {
          const bytes = new Uint8Array(buf);
          const zkind = sniffZoneDat(bytes);
          if (zkind) {
            doc = await buildZoneDatDoc(zkind, bytes, rel, settingsRef.current, dataTablesRef);
            if (token !== dataTokenRef.current) return;
          }
        }
      }
      dataTexturesRef.current = null;
      setDataDoc({ ...doc, path: rel });
      setSelectedDat(path.toLowerCase());
      setModelPath(rel);
      shownPathRef.current = path;
      const zoneSuffix = doc.zoneName ? ` · ${doc.zoneName}` : '';
      setStatusText(doc.kind === 'sections'
        ? `${doc.sectionCount.toLocaleString()} sections · ${doc.dirCount.toLocaleString()} folder${doc.dirCount === 1 ? '' : 's'}`
        : doc.kind === 'ftable'
          ? `${doc.registered.toLocaleString()} of ${doc.capacity.toLocaleString()} file ids registered`
          : doc.kind === 'npclist'
            ? `${doc.npcs.length.toLocaleString()} NPCs${zoneSuffix}`
            : doc.kind === 'events'
              ? `${doc.actors.length.toLocaleString()} actors · ${doc.stats.events.toLocaleString()} events${zoneSuffix}`
              : doc.kind === 'dialog'
                ? `${doc.entries.length.toLocaleString()} dialog entries${zoneSuffix}`
                : doc.label);
    } catch (e) {
      if (token !== dataTokenRef.current) return;
      setDataDoc(null);
      setStatusText(`Failed to read ${rel}: ${e.message ?? e}`);
    }
  }, []);

  /** A row in the file-table view names a DAT — jump the inspector to it. */
  const openDatFromTable = useCallback((datRel) => {
    const gamePath = settingsRef.current?.gamePath;
    if (!gamePath) return;
    const abs = `${gamePath}\\${datRel.replace(/\//g, '\\')}`;
    setRevealTarget(abs.toLowerCase());
    loadDatData(abs);
  }, [loadDatData]);

  /** Decode this DAT's 0x20 textures on first click and open the viewer. */
  const openDataTexture = useCallback((name) => {
    if (!dataTexturesRef.current && dataBufRef.current) {
      try { dataTexturesRef.current = parseDatTextures(dataBufRef.current); } catch { dataTexturesRef.current = new Map(); }
    }
    const tex = dataTexturesRef.current?.get(name);
    if (tex) openTexture(tex);
    else setStatusText(`Couldn't decode texture ${name}`);
  }, [openTexture]);

  /** Drop the scene and everything that described it. */
  const unloadModel = useCallback(() => {
    persistCurrentZoneCamera();
    rendererRef.current?.setModel(null);
    modelRef.current = null;
    zoneCamKeyRef.current = '';
    // Zone ambience is driven by the particle system, which setModel just threw
    // away. Detaching alone leaves already-playing voices running, so stop them
    // all — the bed, the crossfading pair, and any one-shots in flight.
    weatherAudioRef.current?.stopAll();
    weatherAudioRef.current?.attach(null, null);
    appliedPlayRef.current = { kind: null, id: '' };
    setModelInfo(null);
    setModelPath('');
    setSelectedDat('');
    shownPathRef.current = '';
    sourcePathRef.current = '';
    setAnims([]);
    setCurrentAnim('');
    setSchedules([]);
    setCurrentSchedule('');
    setPlayingState(false);
    setObjectGroups(null);
    setStatusText('');
  }, [persistCurrentZoneCamera]);

  // One view on screen at a time, each arriving clean. Without this a model
  // keeps rendering (and animating) behind the Images page, music plays on under
  // a 3D view, and the GPU carries a scene nobody can see.
  const prevViewRef = useRef(leftView);
  useEffect(() => {
    const prev = prevViewRef.current;
    if (prev === leftView) return;
    prevViewRef.current = leftView;

    // Zones <-> Scene share one zone; anything else starts empty. Characters
    // reloads itself on arrival, so unloading here just clears the old actor.
    if (!(ZONE_VIEWS.has(prev) && ZONE_VIEWS.has(leftView))) unloadModel();
    if (!(AUDIO_VIEWS.has(prev) && AUDIO_VIEWS.has(leftView))) player.stop();
    // Leaving the zone views silences the zone outright: the BGM and every
    // ambient/weather voice, including one-shots already in flight. Detaching
    // the particle system alone leaves those playing, which is why zone sound
    // followed you into other pages.
    if (!ZONE_VIEWS.has(leftView)) {
      player.stop();
      weatherAudioRef.current?.stopAll();
      setZoneTrack(null);
      zoneMusicIdRef.current = null;
    }
    if (leftView !== 'images') { setImageEntry(null); setImageDoc(null); setImageSet(null); }
    if (leftView !== 'data') { setDataDoc(null); dataBufRef.current = null; dataTexturesRef.current = null; }
    setShowAxes(leftView === 'effects');   // per-view default; the toggle still overrides
    // Leaving Effects: unloadModel already tore down the particle scene; drop the
    // selection so returning starts clean instead of showing dead transport rows.
    // Re-entering Character Creation frames the model once more; while you are
    // in it, the camera is yours.
    if (leftView !== 'creation') crFramedRef.current = false;
    if (prev === 'effects' && leftView !== 'effects') {
      effectRoutinesRef.current = [];
      setEffectEntry(null);
      setEffectRoutines([]);
      setEffectSchedule('');
    }
  }, [leftView, unloadModel, player, setZoneTrack]);

  const loadImage = useCallback(async (entry) => {
    const settings = settingsRef.current;
    if (!settings?.gamePath) { setStatusText('Game path not set — open Settings first.'); return; }
    setImageEntry(entry);
    // Remember it so reopening on the Images page restores this image rather
    // than falling through to the default model. Store just {name, path}.
    try { localStorage.setItem(LAST_IMAGE_KEY, JSON.stringify({ name: entry.name, path: entry.path })); } catch { /* quota */ }
    setImageSet(null);
    setImageDoc(null);
    // Images are 2D and cover the viewport, so anything still in the scene just
    // shows through. Drop it the way switching to Music does.
    rendererRef.current?.setModel(null);
    modelRef.current = null;
    setModelPath(entry.path);
    setAnims([]);
    setCurrentAnim('');
    try {
      const { data: buf } = await backend.readPrefer(gameCandidates(entry.path, settings));
      const doc = parseImageDat(buf);
      if (doc.kind === 'sets') {
        // Resolve each set's atlas once here so the panel and the viewer agree.
        doc.sets = doc.sets.map((s) => ({ ...s, texture: textureForSet(s, doc.textures) }));
      }
      setImageDoc(doc);
      const first = doc.kind === 'sets' ? doc.sets.find((s) => s.texture) ?? doc.sets[0] : null;
      setImageSet(first ?? null);
      setStatusText(doc.kind === 'png' ? 'PNG' : `${doc.sets?.length ?? 0} image sets`);
    } catch (e) {
      setImageDoc({ kind: 'empty' });
      setStatusText(`Failed to read ${entry.path}: ${e.message ?? e}`);
    }
  }, []);

  const setFov = useCallback((deg) => {
    const v = Math.min(120, Math.max(20, Math.round(deg)));
    setFovState(v);
    try { localStorage.setItem('fovDegrees', String(v)); } catch { /* quota */ }
    // Read fresh every frame by projectionMatrix(), so no redraw call needed.
    const camera = rendererRef.current?.camera;
    if (camera) camera.fovDegrees = v;
  }, []);

  // Ambient/weather SFX volume. Kept in a ref as well so a zone loading later
  // can apply it without waiting for a re-render.
  const [sfxVolume, setSfxVolumeState] = useState(() => {
    const v = parseFloat(localStorage.getItem('sfxVolume'));
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.6;
  });
  const sfxVolumeRef = useRef(sfxVolume);
  const setSfxVolume = useCallback((v) => {
    const clamped = Math.min(1, Math.max(0, v));
    sfxVolumeRef.current = clamped;
    setSfxVolumeState(clamped);
    try { localStorage.setItem('sfxVolume', String(clamped)); } catch { /* quota */ }
    // Ensure the backend exists so the first slider move before a zone finishes
    // loading still sticks when the bed starts. Resume on this user gesture.
    const audio = weatherAudioRef.current ?? getWeatherAudio();
    audio.getContext();
    audio.setVolume(clamped);
  }, [getWeatherAudio]);

  const [sfxOn, setSfxOnState] = useState(() => localStorage.getItem('weatherAudio') !== '0');
  const sfxOnRef = useRef(sfxOn);
  const toggleSfx = useCallback((on) => {
    const next = !!on;
    sfxOnRef.current = next;
    setSfxOnState(next);
    try { localStorage.setItem('weatherAudio', next ? '1' : '0'); } catch { /* quota */ }
    const audio = weatherAudioRef.current ?? getWeatherAudio();
    audio.getContext(); // user gesture — unlock / resume AudioContext
    audio.setVolume(sfxVolumeRef.current);
    audio.setEnabled(next);
  }, [getWeatherAudio]);

  const [showSoundMarkers, setShowSoundMarkers] = useState(
    () => localStorage.getItem('soundMarkers') === '1',
  );
  useEffect(() => {
    if (rendererRef.current) rendererRef.current.showSoundMarkers = showSoundMarkers;
  }, [showSoundMarkers]);
  const toggleSoundMarkers = useCallback((on) => {
    setShowSoundMarkers(on);
    try { localStorage.setItem('soundMarkers', on ? '1' : '0'); } catch { /* quota */ }
    if (rendererRef.current) rendererRef.current.showSoundMarkers = on;
  }, []);

  const saveSettings = async (draft) => {
    const gamePath = draft.gamePath.trim();
    const hdPath = (draft.hdPath || '').trim();
    const xiPath = (draft.xiPath || '').trim();
    const prevPath = settingsRef.current?.gamePath ?? '';
    const prevHd = settingsRef.current?.hdPath ?? '';

    if (!gamePath) {
      setSettingsError('Game path is required. Browse to your FINAL FANTASY XI install folder.');
      return;
    }
    try {
      await backend.listDir(gamePath);
    } catch {
      setSettingsError(`Game path not found:\n${gamePath}`);
      return;
    }
    if (hdPath) {
      try {
        await backend.listDir(hdPath);
      } catch {
        setSettingsError(`HD path not found:\n${hdPath}`);
        return;
      }
    }

    localStorage.setItem('gamePath', gamePath);
    localStorage.setItem('hdPath', hdPath);
    localStorage.setItem('bgColor', draft.bgColor);
    localStorage.setItem('autoPlay', draft.autoPlay ? '1' : '0');
    localStorage.setItem('autoWasdZones', draft.autoWasdZones === false ? '0' : '1');
    localStorage.setItem('xiPath', xiPath);
    // Clearing the HD path forces the toggle off.
    const hdEnabled = hdPath ? !!draft.hdEnabled : false;
    if (!hdPath) localStorage.setItem('hdEnabled', '0');
    const next = {
      ...draft,
      gamePath,
      hdPath,
      hdEnabled,
      xiPath,
      autoWasdZones: draft.autoWasdZones !== false,
    };
    setSettings(next);
    settingsRef.current = next;
    setSettingsError('');
    setSettingsOpen(false);

    // Path changed (or first successful set) — load the default model.
    if (gamePath.toLowerCase() !== prevPath.toLowerCase() || !modelRef.current) {
      keyTablesRef.current = null;   // FFXiMain.dll keys are install-specific
      globalEffectsRef.current = null;
      const dat = `${gamePath}\\${DEFAULT_DAT_SUFFIX}`;
      await loadModel([dat], DEFAULT_DAT_SUFFIX);
      setRevealTarget(dat.toLowerCase());
    } else if (hdPath.toLowerCase() !== prevHd.toLowerCase()) {
      // HD root changed while a model is up — drop cached shared tables/effects
      // so the next load picks up the new pack.
      globalEffectsRef.current = null;
      dataTablesRef.current = null;
    }
  };

  const buildExportSpec = () => {
    const t = player.current;
    if (t) {
      const isSfx = t.root && t.path?.toLowerCase().includes('\\se\\');
      const type = isSfx ? 'sfx' : 'music';
      const title = t.name ?? `music${t.num?.padStart(3, '0')}`;
      const details = player.info
        ? `${player.info.formatName} · ${(player.info.sampleRate / 1000).toFixed(1)} kHz`
          + ` · ${player.info.channels === 1 ? 'mono' : 'stereo'}`
          + (player.info.durationSec ? ` · ${Math.floor(player.info.durationSec / 60)}:${String(Math.floor(player.info.durationSec % 60)).padStart(2, '0')}` : '')
        : null;
      return {
        type,
        typeLabel: isSfx ? 'Sound Effect' : 'Music',
        icon: isSfx ? 'graphic_eq' : 'music_note',
        formatIcon: 'audio_file',
        title,
        details,
        outStem: title,
        sourcePath: t.path,
      };
    }
    if (modelRef.current) {
      const info = modelInfo;
      const src = sourcePathRef.current || '';
      const datStem = (src.split(/[\\/]/).pop() || 'model').replace(/\.dat$/i, '');
      return {
        type: 'model',
        typeLabel: 'Model',
        icon: 'deployed_code',
        title: modelPath || 'model',
        details: info ? `${info.joints} joints · ${info.verts} verts · ${info.tris} tris` : null,
        datStem,
        sourcePath: src,
        animations: animsRef.current.map((g) => ({ id: g.id, frames: g.clip.numFrames })),
        xiPath: settingsRef.current?.xiPath || '',
      };
    }
    return null;
  };

  const handleMenuAction = (id, label) => {
    switch (id) {
      case 'settings':
        setSettingsError('');
        setSettingsOpen(true);
        break;
      case 'export': {
        const spec = buildExportSpec();
        if (spec) setExportSpec(spec);
        else setStatusText('Nothing to export — load a model or play a track first.');
        break;
      }
      case 'reset-camera':
        rendererRef.current.resetCamera();
        break;
      case 'toggle-wasd':
        setWasd(!wasdRef.current);
        break;
      case 'toggle-textures':
        setShowTex((v) => !v);
        break;
      case 'toggle-hd': {
        const s = settingsRef.current;
        if (!s?.hdPath) break;
        const loaded = modelRef.current;
        const camSnap = rendererRef.current?.camera?.snapshot?.() ?? null;
        if (loaded?.kind === 'zone') persistCurrentZoneCamera();
        const next = { ...s, hdEnabled: !s.hdEnabled };
        try { localStorage.setItem('hdEnabled', next.hdEnabled ? '1' : '0'); } catch { /* quota */ }
        setSettings(next);
        settingsRef.current = next;
        // Shared ROM/0/0.DAT and FTABLE may differ between packs.
        globalEffectsRef.current = null;
        dataTablesRef.current = null;
        setStatusText(next.hdEnabled ? `HD on — ${s.hdPath}` : 'HD off — using game path');
        // Reload the on-screen zone/model so meshes/textures swap immediately.
        if (!loaded) break;
        try {
          const last = JSON.parse(localStorage.getItem(LAST_DAT_KEY) || 'null');
          if (loaded.kind === 'zone' && last?.kind === 'zone' && last.zone?.path) {
            loadZone(last.zone, { keepCamera: true, cameraSnap: camSnap });
          } else if (last?.paths?.length) {
            loadModel(last.paths, last.name || relativeName(last.paths[last.paths.length - 1]), {
              ...(last.opts ?? {}),
              keepCamera: true,
            });
          }
        } catch (e) {
          console.warn('HD reload failed', e);
        }
        break;
      }
      case 'toggle-wireframe':
        setShowWireframe((v) => !v);
        break;
      case 'toggle-skeleton':
        setShowSkeleton((v) => !v);
        break;
      case 'toggle-alpha':
        setShowAlpha((v) => {
          const next = !v;
          if (rendererRef.current) rendererRef.current.showAlpha = next;
          return next;
        });
        break;
      case 'toggle-blend-lequal':
        setBlendLequal((v) => {
          const next = !v;
          try { localStorage.setItem('blendLequal', next ? '1' : '0'); } catch { /* quota */ }
          if (rendererRef.current) rendererRef.current.zoneBlendLequal = next;
          return next;
        });
        break;
      case 'toggle-unlit':
        setShowUnlit((v) => {
          const next = !v;
          if (rendererRef.current) rendererRef.current.unlit = next;
          return next;
        });
        break;
      case 'toggle-shadows':
        setShowShadows((v) => {
          const next = !v;
          try { localStorage.setItem('shadows', next ? '1' : '0'); } catch { /* quota */ }
          if (rendererRef.current) rendererRef.current.showShadows = next;
          return next;
        });
        break;
      case 'graphics':
        setGraphicsOpen((v) => !v);
        break;
      case 'camera-sequencer':
        setSequencerOpen((v) => !v);
        break;
      case 'toggle-explorer':
        setExplorerOpen((v) => !v);
        break;
      case 'toggle-collision':
        setShowCollision((v) => {
          const next = !v;
          if (rendererRef.current) rendererRef.current.showCollision = next;
          return next;
        });
        break;
      case 'toggle-sound-markers':
        toggleSoundMarkers(!showSoundMarkers);
        break;
      // Particle effects on/off — water, spray, clouds, sun/moon, lights. Handy
      // for telling at a glance whether an artefact comes from the effect
      // runtime or from the zone's own geometry.
      case 'toggle-effects':
        setShowEffects((v) => {
          const next = !v;
          if (rendererRef.current) rendererRef.current.showEffects = next;
          return next;
        });
        break;
      case 'toggle-navmesh':
        setShowNavmesh((v) => {
          const next = !v;
          if (rendererRef.current) rendererRef.current.showNavmesh = next;
          return next;
        });
        break;
      case 'toggle-skybox':
        setSkybox(!showSkybox);
        break;
      case 'toggle-axes':
        setShowAxes((v) => !v);
        break;
      case 'toggle-grid':
        setShowGrid((v) => !v);
        break;
      case 'assets-files':
        setLeftView('files');
        break;
      case 'assets-data':
        setLeftView('data');
        break;
      case 'assets-npcs':
        setLeftView('npc');
        break;
      case 'assets-characters':
        setLeftView('pc');
        break;
      case 'assets-creation':
        setLeftView('creation');
        break;
      case 'assets-music':
        setLeftView('music');
        break;
      case 'assets-sfx':
        setLeftView('sfx');
        break;
      case 'assets-scene':
        setLeftView('scene');
        break;
      case 'assets-zones':
        setLeftView('zones');
        break;
      case 'assets-images':
        setLeftView('images');
        break;
      case 'assets-effects':
        setLeftView('effects');
        break;
      case 'open-dat':
        // In the Data view an opened DAT gets inspected, not loaded as a model.
        backend.pickFile(settingsRef.current?.gamePath || null)
          .then((file) => { if (file) (leftView === 'data' ? loadDatData : loadFromTree)(file); })
          .catch((err) => setStatusText(`Open DAT failed: ${err.message ?? err}`));
        break;
      case 'help':
        setHelpOpen(true);
        break;
      default:
        setStatusText(`${label} — not implemented yet`);
    }
  };

  /** Frame camera on a zone placement (or all instances of a mesh type). */
  const focusBounds = useCallback((min, max) => {
    const cam = rendererRef.current?.camera;
    if (!cam || !min || !max) return;
    if (!wasdRef.current && settingsRef.current?.autoWasdZones !== false) setWasd(true);
    cam.fit(min, max);
    // fit() already reseats fly mode when active
  }, [setWasd]);

  // Drive the EnvironmentManager rather than re-resolving the DAT: changing
  // weather starts a 3.33s cross-fade of sky, fog, lighting and the two
  // weathers' particle sets, exactly as the game does it.
  const applyWeatherTime = useCallback((w, tm) => {
    setWeather(w);
    setTimeMinutes(tm);
    const env = zoneEnvManagerRef.current;
    const renderer = rendererRef.current;
    if (!renderer) return;
    try {
      if (env) {
        if (tm !== env.getTimeMinutes()) env.setTimeMinutes(tm);
        env.switchWeather(w);
        // Day/night BGM follows the clock (FFXI flips at 06:00 and 18:00).
        const hour = Math.floor(tm / 60);
        resolveZoneTrack(zoneMusicIdRef.current, hour < 6 || hour >= 18);
        renderer.skyWeather = env.getWeather();
        // The per-frame update pushes lighting from here on; set it once now so
        // a paused scene reflects the change immediately.
        renderer.setTerrainLighting(env.getTerrainLighting());
        renderer.setSkyDome(env.getSkyDome());
        return;
      }
      const envs = zoneEnvsRef.current;
      if (!envs) return;
      const resolved = resolveEnvironment(envs, w, tm);
      renderer.setTerrainLighting(terrainLightingFromEnv(resolved, tm));
      renderer.setSkyDome(skyDomeFromEnv(resolved));
      renderer.skyWeather = w;
    } catch (e) { console.warn('weather apply failed', e); }
  }, [resolveZoneTrack]);

  // Mirrored so the clock ticker below can read the live weather/time without
  // listing them as effect deps — they change on every tick it fires.
  const todStateRef = useRef({ weather: '', minutes: 12 * 60 });
  todStateRef.current = { weather, minutes: timeMinutes };

  /**
   * Run the game clock: one full FFXI day per TOD_DAY_MS of real time.
   *
   * Ticked on a timer rather than per frame — each step re-resolves the
   * environment and rebuilds the sky dome, which is interactive-rate work, not
   * 60 Hz work. Reading the time back from state each tick (instead of
   * accumulating privately) means dragging the slider mid-run just moves the
   * clock rather than fighting the ticker.
   */
  useEffect(() => {
    if (!todPlaying) return undefined;
    const TOD_DAY_MS = 60000;
    const TICK_MS = 100;
    const perTick = (1440 * TICK_MS) / TOD_DAY_MS;
    const id = setInterval(() => {
      const { weather: w, minutes } = todStateRef.current;
      applyWeatherTime(w, (minutes + perTick) % 1440);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [todPlaying, applyWeatherTime]);

  // Leaving the Zones view takes its panel — and the stop button — off screen,
  // so don't leave the clock running where it can't be stopped.
  useEffect(() => {
    if (leftView !== 'zones') setTodPlaying(false);
  }, [leftView]);

  const focusPlacementGroup = useCallback((group) => {
    if (!group?.instances?.length) return;
    setPlcSelected(`mesh:${group.mesh}`);
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (const p of group.instances) {
      const b = p.bounds;
      for (let i = 0; i < 3; i++) {
        if (b.min[i] < min[i]) min[i] = b.min[i];
        if (b.max[i] > max[i]) max[i] = b.max[i];
      }
    }
    focusBounds(min, max);
    setStatusText(`${group.mesh} · ${group.count} instance${group.count === 1 ? '' : 's'}`);
  }, [focusBounds]);

  const focusPlacementInstance = useCallback((p) => {
    if (!p) return;
    setPlcSelected(`inst:${p.name}`);
    focusBounds(p.bounds.min, p.bounds.max);
    const pos = p.rawPos.map((n) => n.toFixed(1)).join(', ');
    setStatusText(`${p.name}  #${p.index}  (${pos})`);
  }, [focusBounds]);

  const onPointerDown = (e) => {
    drag.current = { btn: e.button, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerUp = (e) => {
    drag.current.btn = -1;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (drag.current.btn < 0) return;
    if (rendererRef.current?.camera.sequenceLock) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    drag.current.x = e.clientX;
    drag.current.y = e.clientY;
    const cam = rendererRef.current.camera;
    if (wasdRef.current) {
      // Fly: any drag looks around (LMB or RMB).
      if (drag.current.btn === 0 || drag.current.btn === 2) cam.flyLook(dx, dy);
    } else if (drag.current.btn === 0) {
      cam.orbit(dx, dy);
    } else {
      cam.pan(dx, dy);
    }
  };

  // --- render --------------------------------------------------------------

  return (
    <>
      <canvas
        id="canvas"
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerMove={onPointerMove}
        onContextMenu={(e) => e.preventDefault()}
      />

      <MenuBar
        onAction={handleMenuAction}
        checks={{
          textures: showTex,
          hd: !!settings?.hdEnabled,
          wireframe: showWireframe,
          skeleton: showSkeleton,
          alpha: showAlpha,
          blendLequal,
          unlit: showUnlit,
          shadows: showShadows,
          explorer: explorerOpen,
          wasd,
          collision: showCollision,
          navmesh: showNavmesh,
          soundMarkers: showSoundMarkers,
          skybox: showSkybox,
          effects: showEffects,
          axes: showAxes,
          grid: showGrid,
          noCollision: !hasCollision,
          noNavmesh: !hasNavmesh,
          noSkybox: !hasSkybox,
          noHdPath: !settings?.hdPath,
        }}
        flySpeed={flySpeed}
        fov={fov}
        onFov={setFov}
        graphicsOpen={graphicsOpen}
        sequencerOpen={sequencerOpen}
      />

      {/* Mounted only while open: unmounting is what releases the camera lock,
          clears the route overlay and un-hides the UI, all in one cleanup. */}
      {sequencerOpen && (
        <CameraSequencer
          onClose={() => setSequencerOpen(false)}
          rendererRef={rendererRef}
          tickRef={camSeqTick}
          weathers={weatherList}
          weather={weather}
          timeMinutes={timeMinutes}
          onScene={applyWeatherTime}
          onStopClock={() => setTodPlaying(false)}
        />
      )}

      {explorerOpen && leftView === 'files' && (
        <FileTree
          rootPath={settings?.gamePath ?? ''}
          selectedPath={selectedDat}
          revealTarget={revealTarget}
          onSelectFile={loadFromTree}
          onError={(msg) => setStatusText(msg)}
        />
      )}
      {explorerOpen && leftView === 'npc' && (
        <NpcList
          onSelectEntry={loadNpcEntry}
          selectedPath={selectedDat}
          onError={(msg) => setStatusText(msg)}
        />
      )}
      {explorerOpen && leftView === 'pc' && <CharacterList pc={pc} />}
      {explorerOpen && leftView === 'creation' && (
        <CreationList
          cr={cr}
          info={crInfo}
          camera={{
            available: crHasCamera,
            on: crCameraOn,
            onToggle: setCrCameraOn,
            index: crCameraIndex,
            onIndex: setCrCameraIndex,
          }}
        />
      )}
      {explorerOpen && leftView === 'music' && (
        <MusicList
          gamePath={settings?.gamePath ?? ''}
          hdPath={settings?.hdPath ?? ''}
          hdEnabled={!!settings?.hdEnabled}
          player={player}
          onError={(msg) => setStatusText(msg)}
        />
      )}
      {explorerOpen && leftView === 'sfx' && (
        <SfxList
          gamePath={settings?.gamePath ?? ''}
          hdPath={settings?.hdPath ?? ''}
          hdEnabled={!!settings?.hdEnabled}
          player={player}
          onError={(msg) => setStatusText(msg)}
        />
      )}
      {explorerOpen && leftView === 'scene' && (
        <SceneList
          bgColor={settings?.bgColor ?? DEFAULT_BG}
          selectedFloor={selectedFloor}
          onBg={setBg}
          onFloor={loadFloor}
          onClearFloor={clearFloor}
          onError={(msg) => setStatusText(msg)}
        />
      )}
      {explorerOpen && leftView === 'zones' && (
        <ZoneList
          selectedPath={selectedDat}
          onSelectZone={loadZone}
          onError={(msg) => setStatusText(msg)}
        />
      )}

      {explorerOpen && leftView === 'images' && (
        <ImageList
          selectedPath={imageEntry?.path}
          onSelectImage={loadImage}
          onError={(msg) => setStatusText(msg)}
        />
      )}

      {explorerOpen && leftView === 'effects' && (
        <EffectList onSelect={loadEffect} selectedPath={effectEntry?.path} />
      )}

      {/* Data view reuses the File Explorer's tree; clicking a DAT inspects its
          structure instead of loading it into the 3D scene. */}
      {explorerOpen && leftView === 'data' && (
        <FileTree
          rootPath={settings?.gamePath ?? ''}
          selectedPath={selectedDat}
          revealTarget={revealTarget}
          onSelectFile={loadDatData}
          onError={(msg) => setStatusText(msg)}
        />
      )}

      {leftView === 'data' && (
        <DataViewer doc={dataDoc} onOpenTexture={openDataTexture} onOpenDat={openDatFromTable} />
      )}

      {leftView === 'images' && imageDoc && (
        <>
          <ImageViewer doc={imageDoc} set={imageSet} />
          <ImageSetPanel
            file={imageEntry}
            sets={imageDoc.kind === 'sets' ? imageDoc.sets : []}
            selected={imageSet}
            onSelect={setImageSet}
          />
        </>
      )}

      {/* Stays visible while zone music plays — the play button lives in here,
          so taking the panel over would pull the controls out from under it. */}
      {leftView === 'zones' && (
        <WeatherPanel
          weathers={weatherList}
          weather={weather}
          timeMinutes={timeMinutes}
          onChange={applyWeatherTime}
          todPlaying={todPlaying}
          onToggleTod={setTodPlaying}
          skyboxOn={showSkybox}
          onToggleSkybox={setSkybox}
          hasSkybox={hasSkybox}
          objectsOpen={!!objectGroups && plcOpen}
          bgColor={settings?.bgColor ?? DEFAULT_BG}
          onBg={setBg}
          brightness={zoneBrightness}
          onBrightness={setZoneBrightness}
          fogOn={fogOn}
          onFogOn={setFogOn}
          fogScale={fogScale}
          onFogScale={setFogScale}
          musicVolume={player.volume}
          onMusicVolume={player.setVolume}
          sfxVolume={sfxVolume}
          onSfxVolume={setSfxVolume}
          sfxOn={sfxOn}
          onToggleSfx={toggleSfx}
          zoneTrack={zoneTrack}
          zoneTrackPlaying={
            !!zoneTrack && player.playing
            && player.current?.file === zoneTrack.file && player.current?.root === zoneTrack.root
          }
          onToggleZoneMusic={toggleZoneMusic}
        />
      )}

      {objectGroups && plcOpen && (leftView === 'zones' || !player.current) && (
        <PlacementPanel
          groups={objectGroups}
          selectedKey={plcSelected}
          onSelectGroup={focusPlacementGroup}
          onSelectInstance={focusPlacementInstance}
          onClose={() => setPlcOpen(false)}
          showEnv={showSkybox}
        />
      )}

      {player.current && leftView !== 'zones' && <MusicPlayer player={player} />}

      {/* Only the views that actually put a model on screen get playback
          controls — Images/Music/SFX have their own right-hand panels. */}
      {!player.current && ORBIT_VIEWS.has(leftView) && (
        <AnimationPanel
          pc={leftView === 'pc' ? pc : null}
          anim={leftView === 'creation' ? creationAnim : animControls}
        />
      )}

      {/* Standalone effect: Schedule picker + transport + speed (no scrubber —
          a live particle sim isn't frame-seekable). */}
      {leftView === 'effects' && effectEntry && (
        <AnimationPanel anim={effectAnim} />
      )}

      <div id="status" className="panel mono">
        {!player.current && modelPath && selectedDat ? (
          <Tooltip content="Show in Explorer">
            <button id="statusPath" className="status-path-link" onClick={revealInExplorer}>
              {modelPath}
            </button>
          </Tooltip>
        ) : (
          <span id="statusPath">
            {player.current ? relativeName(player.current.path) : (modelPath || '—')}
          </span>
        )}
        <span className="hints">
          {player.current ? (
            `${player.playing ? 'playing' : 'paused'}: ${player.current.name ?? `music${player.current.num?.padStart(3, '0')}`}`
          ) : statusText ? (
            <>
              <span>{statusText}</span>
              {objectGroups && (
                <>
                  <span className="status-sep">·</span>
                  <button className="status-link" onClick={() => setPlcOpen((v) => !v)}>
                    {plcOpen ? 'Hide objects' : 'Objects'}
                  </button>
                </>
              )}
              {modelInfo && ORBIT_VIEWS.has(leftView) && (
                <>
                  <span className="status-sep">·</span>
                  <button className="status-link" onClick={() => setSkeletonOpen((v) => !v)}>Skeleton</button>
                </>
              )}
              {modelInfo && DETAIL_VIEWS.has(leftView) && (
                <>
                  <span className="status-sep">·</span>
                  <button className="status-link" onClick={() => setDetailsOpen((v) => !v)}>Details</button>
                </>
              )}
            </>
          ) : modelInfo ? (
            <>
              <span className="status-actor">{modelInfo.name}</span>
              {!modelInfo.zone && (
                <>
                  <span className="status-sep">·</span>
                  <span>
                    {currentSchedule ? `Playing Schedule: ${currentSchedule}`
                      : currentAnim ? `Playing Animation: ${currentAnim}`
                        : 'Bind pose'}
                  </span>
                </>
              )}
              {objectGroups && (
                <>
                  <span className="status-sep">·</span>
                  <button className="status-link" onClick={() => setPlcOpen((v) => !v)}>
                    {plcOpen ? 'Hide objects' : 'Objects'}
                  </button>
                </>
              )}
              {ORBIT_VIEWS.has(leftView) && (
                <>
                  <span className="status-sep">·</span>
                  <button className="status-link" onClick={() => setSkeletonOpen((v) => !v)}>Skeleton</button>
                </>
              )}
              {/* Effects have no skeleton, but they do have sprite images. */}
              {DETAIL_VIEWS.has(leftView) && (
                <>
                  <span className="status-sep">·</span>
                  <button className="status-link" onClick={() => setDetailsOpen((v) => !v)}>Details</button>
                </>
              )}
            </>
          ) : ''}
        </span>
      </div>

      {skeletonOpen && !player.current && ORBIT_VIEWS.has(leftView) && (
        <SkeletonPanel
          pose={rendererRef.current?.pose ?? null}
          onClose={() => setSkeletonOpen(false)}
        />
      )}

      {detailsOpen && modelInfo && !player.current && DETAIL_VIEWS.has(leftView) && (
        <DetailsPanel
          info={modelInfo}
          animClip={animsRef.current.find((g) => g.id === currentAnim)?.clip ?? null}
          animId={currentAnim}
          schedule={schedules.find((s) => s.id === currentSchedule) ?? null}
          onClose={() => setDetailsOpen(false)}
          onOpenTexture={openTexture}
          onPlayClip={playClipId}
        />
      )}

      {texWindows.map((w, i) => (
        <TextureModal
          key={w.id}
          tex={w.tex}
          cascadeOffset={w.cascade}
          zIndex={210 + i}
          onClose={() => closeTexture(w.id)}
          onFocus={() => focusTexture(w.id)}
        />
      ))}

      <SettingsModal
        open={settingsOpen}
        initial={settings ?? { gamePath: '', hdPath: '', hdEnabled: false, bgColor: DEFAULT_BG, autoPlay: true, autoWasdZones: true, xiPath: '' }}
        error={settingsError}
        onSave={saveSettings}
        onClose={() => { setSettingsOpen(false); setSettingsError(''); }}
      />

      <ExportModal
        open={!!exportSpec}
        spec={exportSpec}
        onClose={() => setExportSpec(null)}
        onStatus={(msg) => setStatusText(msg)}
      />

      <GraphicsModal
        open={graphicsOpen}
        onClose={() => setGraphicsOpen(false)}
        shadowsOn={showShadows}
        shadowDistance={shadowDistance}
        onShadowDistance={setShadowDistance}
        renderHeight={renderHeight}
        onRenderHeight={setRenderHeight}
        bufferSize={bufferSize}
      />

      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />

      <LoadingOverlay
        open={!!loading}
        title={loading?.title}
        detail={loading?.detail}
      />
    </>
  );
}
