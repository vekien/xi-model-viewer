import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { backend } from '../js/backend.js';
import { gameCandidates, normRel, relFromAbs } from '../js/gamePath.js';
import { animDisplayName, groupAnimations, matchAnimRef, mergeModels, parseEntity, resolveScheduleClip } from '../js/dat.js';
import { Renderer } from '../js/renderer.js';
import { FileTree } from './FileTree.jsx';
import { MenuBar } from './MenuBar.jsx';
import { NpcList } from './NpcList.jsx';
import { CharacterList, useCharacter } from './CharacterList.jsx';
import { EffectActorsPanel } from './EffectActorsPanel.jsx';
import { CreationList, useCreation } from './CreationList.jsx';
import {
  buildCreationModel, parseSqleMotion, CreationAnimator, restoreCreationBind, CREATION_CLIPS,
  creationCameraPaths, buildCreationCamera, CREATION_RACES, CREATION_SEQUENCE_META,
  parseCreationCues,
} from '../js/creation.js';
import { AnimationPanel } from './AnimationPanel.jsx';
import { Combo } from './Combo.jsx';
import { MusicList, useAudioPlayer } from './MusicList.jsx';
import { MusicPlayer } from './MusicPlayer.jsx';
import { SfxList } from './SfxList.jsx';

import { ZoneList } from './ZoneList.jsx';
import { PlacementPanel } from './PlacementPanel.jsx';
import { LoadingOverlay } from './LoadingOverlay.jsx';
import { SettingsModal } from './SettingsModal.jsx';
import { ExportModal } from './ExportModal.jsx';
import { DetailsPanel } from './DetailsPanel.jsx';
import { SkeletonPanel } from './SkeletonPanel.jsx';
import { TextureModal } from './TextureModal.jsx';
import { HelpModal } from './HelpModal.jsx';
import { UpdateModal } from './UpdateModal.jsx';
import { LightGizmo, DEFAULT_LIGHT_DIR } from './LightGizmo.jsx';

import { CameraSequencer } from './CameraSequencer.jsx';
import { parseFloorTexture } from '../js/dat.js';
import { extractKeyTables, parseZone, parseDatTextures, parseZoneDefAt } from '../js/zone.js';
import { ZoneDefModal } from './ZoneDefModal.jsx';
import { ParticlePreviewModal } from './ParticlePreviewModal.jsx';
import { armGeneratorPreview } from '../js/particlePreview.js';
import { checkForUpdate, checkForUpdateManual, dismissUpdate } from '../js/update.js';
import {
  zoneDatRelPath, zoneToModel, rebuildZoneDraws, buildPlacementDraws, translatePlacementDisplay,
  clonePlacementPose, applyPlacementPose, posesEqual, pickPvsRegion, applyPvsRegion,
} from '../js/zoneModel.js';
import { pickZoneAt } from '../js/zonePick.js';
import { loadDatTypeLists, makeDatTypeLookup } from '../js/dattypes.js';
import { pickGizmoAxis, axisDragDelta } from '../js/zoneGizmo.js';
import { parseEnvironments, parseEnvironmentsByRoot, resolveEnvironment, defaultWeather, listWeathers, terrainLightingFromEnv, skyDomeFromEnv, EnvironmentManager } from '../js/environment.js';
import { parseSections } from '../js/zone.js';
import { buildDatTree, SEC } from '../js/dat/tree.js';
import { makeParsers } from '../js/dat/sections.js';
import { parseParticleGenerator } from '../js/particle/parser.js';
import { ParticleSystem } from '../js/particle/system.js';
import { parseEffectRoutines, flattenRoutine } from '../js/effect.js';
import { EffectList } from './EffectList.jsx';
import { ensureXiToolsOnBoot } from '../js/toolsBoot.js';
import { WeatherAudio } from '../js/particle/audio.js';
import { toAudioBuffer, parseAudioHeader, FMT_ATRAC3 } from '../js/audio.js';
import { parseImageDat, textureForSet } from '../js/images.js';
import { inspectDat, parseInspectSkeleton, parseInspectRoute, parseInspectUiMenu, parseInspectUiElementGroup, parseInspectDataTable, parseInspectEffectRoutine, parseInspectSpriteSheet, parseInspectParticleMesh, parseInspectKeyFrame, parseInspectWeightedMesh, inspectDmsg, attachDataTableNames } from '../js/dat/inspect.js';
import { SkeletonModal } from './SkeletonModal.jsx';
import { RouteModal } from './RouteModal.jsx';
import { UiMenuModal } from './UiMenuModal.jsx';
import { UiElementGroupModal } from './UiElementGroupModal.jsx';
import { DataTableModal } from './DataTableModal.jsx';
import { CliOutputPanel } from './CliOutputPanel.jsx';
import { DatNotesModal } from './DatNotesModal.jsx';
import { datFileKey, getNote, loadNotes } from '../js/notes.js';
import { matchTablePath, parseFileTable } from '../js/dat/ftable.js';
import { classifyDat } from '../js/dat/classify.js';
import {
  sniffGearRace, composerRaceFromFileId, composerRaceFromGearTable,
  RACE_SKELETON_RELS, RACE_SKELETON_LABELS,
} from '../js/dat/modelids.js';
import { soundPath } from '../js/particle/audio.js';
import {
  sniffZoneDat, zoneForFileId, zoneFileIds, buildZoneDatBundle, parseNpcList, npcNameMap,
  parseEventDat, parseDialogDat, dialogSpeakers, dialogConversations, EVENT_CATEGORIES,
} from '../js/dat/zonedat.js';
import { DataViewer } from './DataViewer.jsx';
import { ImageList } from './ImageList.jsx';
import { ImageSetPanel } from './ImageSetPanel.jsx';
import { ImageSpritePanel } from './ImageSpritePanel.jsx';
import { ImageViewer } from './ImageViewer.jsx';
import { WeatherPanel } from './WeatherPanel.jsx';
import { Tooltip } from './Tooltip.jsx';
import { loadZoneNavmesh } from '../js/navmesh.js';
import { launchZoneRel } from '../js/launch.js';
import { normalizeBgId, resolveBgUrl } from './bgs.js';

const DEFAULT_DAT_SUFFIX = 'ROM\\5\\3.DAT';
const DEFAULT_BG = '#303438';
const LAST_DAT_KEY = 'lastDat';
const LAST_VIEW_KEY = 'lastView';
const LAST_IMAGE_KEY = 'lastImage';
const LAST_EFFECT_KEY = 'lastEffect';
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
const VIEWS = ['files', 'npc', 'pc', 'creation', 'music', 'sfx', 'zones', 'images', 'effects'];
/** Views that browse individual models, where fly controls are a hindrance. */
const ORBIT_VIEWS = new Set(['files', 'npc', 'pc', 'creation']);
/** Views with a Details panel — model/zone stats, or an effect's sprite images. */
const DETAIL_VIEWS = new Set([...ORBIT_VIEWS, 'effects', 'zones']);
// Zone list keeps a loaded zone when staying on Zones. Other view changes tear down.
const ZONE_VIEWS = new Set(['zones']);
// The only views that own the audio player. A zone's BGM plays through the same
// player, so leaving Zones has to stop it too — hence "was it an audio view",
// not just "is it one now".
const AUDIO_VIEWS = new Set(['music', 'sfx']);
// Views that put their own content on screen as soon as they open. Restoring
// one of these at startup must not also load the last/default DAT.
const SELF_LOADING_VIEWS = new Set(['pc', 'creation', 'images', 'music', 'sfx', 'effects']);
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
  const pivotPath = localStorage.getItem('pivotPath') || '';
  return {
    gamePath,
    hdPath,
    hdEnabled: !!hdPath && localStorage.getItem('hdEnabled') === '1',
    pivotPath,
    pivotEnabled: !!pivotPath && localStorage.getItem('pivotEnabled') === '1',
    bgColor: localStorage.getItem('bgColor') || DEFAULT_BG,
    autoPlay: localStorage.getItem('autoPlay') === '1',
    autoWasdZones: localStorage.getItem('autoWasdZones') !== '0',
    autoFocusZoneObject: localStorage.getItem('autoFocusZoneObject') !== '0',
    closeDatNotesOnSave: localStorage.getItem('closeDatNotesOnSave') === '1',
    showXiConsole: localStorage.getItem('showXiConsole') !== '0',
    autoCloseXiConsole: localStorage.getItem('autoCloseXiConsole') === '1',
    xiPath: localStorage.getItem('xiPath') || '',
    showGrid: localStorage.getItem('showGrid') === '1',
    showAxes: localStorage.getItem('showAxes') === '1',
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
/**
 * Cross-fade between cast stages, and from the release back to idle, in 30fps
 * clip frames. SkeletonPose.evaluate consumes it as a segment's `transOut`.
 */
const CAST_BLEND_FRAMES = 9;   // 0.3s

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
    let npcs = [];
    try { npcs = parseNpcList(bytes); } catch { npcs = []; }
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
    let names = null;
    try { names = npcBytes ? npcNameMap(parseNpcList(npcBytes)) : null; } catch { names = null; }
    let actors = [];
    try { actors = parseEventDat(bytes, names); } catch { actors = []; }
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
  let entries = [];
  let obfuscated = false;
  try {
    ({ entries, obfuscated } = parseDialogDat(bytes));
  } catch {
    entries = [];
    obfuscated = false;
  }
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

export default function App({ launch = null }) {
  // Zone preview launch (`--zone <dat> [--minimal]`, see js/launch.js). Minimal
  // mode drops the whole app chrome — menu bar, asset panel, status bars,
  // object browser — leaving the viewport and the Zone panel (weather, time of
  // day, fog, brightness, audio). The prop never changes for a given run, so
  // everything below can branch on it freely.
  const launchRef = useRef(launch);
  const minimal = !!launch?.zone && !!launch?.minimal;

  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  const modelRef = useRef(null);
  // Entity (NPC/PC) still on stage after Effects — restore path UI when leaving.
  const lastEntityRef = useRef(null);
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
    if (minimal) return false;    // a preview window is not a first launch
    const firstBoot = localStorage.getItem('booted') !== '1';
    if (firstBoot) {
      try { localStorage.setItem('booted', '1'); } catch { /* quota */ }
    }
    return firstBoot;
  });
  // A newer GitHub release than this build, once the boot check finds one.
  const [update, setUpdate] = useState(null);
  // Background update check. Deliberately its own effect and never awaited by
  // startup: the app finishes booting whether GitHub answers, is slow, or is
  // unreachable. checkForUpdate() swallows every failure and resolves to null,
  // and it already filters out versions the user has dismissed.
  useEffect(() => {
    if (minimal) return undefined;   // a zone-preview window is not the place for it
    let alive = true;
    checkForUpdate().then((info) => {
      if (alive && info) setUpdate(info);
    });
    return () => { alive = false; };
  }, [minimal]);

  // xi-tools: auto-install / update from GitHub (same policy as xi-zone-editor).
  // Does not block the UI; status text only when something actually changed.
  useEffect(() => {
    if (minimal) return undefined;
    let alive = true;
    const xiPath = localStorage.getItem('xiPath') || '';
    ensureXiToolsOnBoot({ xiPath }).then((result) => {
      if (!alive || !result) return;
      const st = result.status;
      if (st?.toolsDir && result.changed) {
        try { localStorage.setItem('xiPath', st.toolsDir); } catch { /* quota */ }
        setSettings((prev) => {
          if (!prev) return prev;
          const next = { ...prev, xiPath: st.toolsDir };
          settingsRef.current = next;
          return next;
        });
      } else if (st?.toolsDir && !(localStorage.getItem('xiPath') || '').trim()) {
        try { localStorage.setItem('xiPath', st.toolsDir); } catch { /* quota */ }
        setSettings((prev) => {
          if (!prev) return prev;
          const next = { ...prev, xiPath: st.toolsDir };
          settingsRef.current = next;
          return next;
        });
      }
      if (result.changed && result.message) setStatusText(result.message);
    });
    return () => { alive = false; };
  }, [minimal]);
  const [exportSpec, setExportSpec] = useState(null);
  const [leftView, setLeftViewState] = useState(() => {
    // A launch zone arrives on the Zones page. Set as the *initial* view, not a
    // switch: switching runs the view-change cleanup, which would unload the
    // zone mid-load. Not persisted either — a preview isn't a page the user
    // navigated to.
    if (launch?.zone) return 'zones';
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
  // What the DAT Browser last opened (zone/image/…); drives the right-hand
  // panels without leaving Assets > DAT Browser.
  const [browserKind, setBrowserKind] = useState(null);
  // Structure owns the viewport when the DAT Browser has nothing rendered, or
  // what it opened is a plain table. Otherwise it's the status-bar overlay.
  const dataOwnsPage = browserKind === 'data' || (leftView === 'files' && !browserKind);
  // FTABLE paths for DAT Browser search (ROM\…\n.DAT).
  const [filePathIndex, setFilePathIndex] = useState(null);
  const fileIndexRef = useRef(null);
  // (path) => 'Zone' | 'Gear' | … for the tree's type badges; null until the
  // baked lists and the FTABLE map have loaded.
  const [datTypeOf, setDatTypeOf] = useState(null);
  // File → Open DAT from a non-browser view: switch to DAT Browser, then open.
  const pendingBrowserFileRef = useRef(null);
  // Browsing single models rather than a zone: fly controls put the camera
  // somewhere arbitrary and WASD swallows typing in the filter boxes, so drop
  // back to orbit on arrival. Zones (including prototype ones opened from the
  // file browser) stay in fly/WASD — same as Assets > Zones.
  useEffect(() => {
    if (browserKind === 'zone') {
      if (settingsRef.current?.autoWasdZones !== false) setWasd(true);
      return;
    }
    if (ORBIT_VIEWS.has(leftView) && wasdRef.current) setWasd(false);
  }, [leftView, browserKind, setWasd]);
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
  const [skelWindows, setSkelWindows] = useState([]); // [{ id, joints, title, cascade }]
  const skelIdRef = useRef(0);
  const [zdefWindows, setZdefWindows] = useState([]); // [{ id, placements, title, cascade }]
  const zdefIdRef = useRef(0);
  const [routeWindows, setRouteWindows] = useState([]); // [{ id, route, title }]
  const routeIdRef = useRef(0);
  const [uiMenuWindows, setUiMenuWindows] = useState([]); // [{ id, menu, title }]
  const uiMenuIdRef = useRef(0);
  const [cliOutput, setCliOutput] = useState(null); // { title, text } bottom-left console
  const [datNotesOpen, setDatNotesOpen] = useState(false);
  const [datNotesTick, setDatNotesTick] = useState(0); // refresh has-note badge
  // Global stacking: click/focus any floating modal → highest z (cross-type).
  const modalZCounterRef = useRef(10000);
  const [modalZByKey, setModalZByKey] = useState({}); // key -> zIndex
  const raiseModal = useCallback((key) => {
    if (!key) return;
    const z = ++modalZCounterRef.current;
    setModalZByKey((prev) => (prev[key] === z ? prev : { ...prev, [key]: z }));
  }, []);
  const modalZ = useCallback(
    (key, fallback) => modalZByKey[key] ?? fallback,
    [modalZByKey],
  );
  const [uiEgWindows, setUiEgWindows] = useState([]); // [{ id, group, title }]
  const uiEgIdRef = useRef(0);
  const [dataTableWindows, setDataTableWindows] = useState([]); // [{ id, table, title }]
  const dataTableIdRef = useRef(0);
  const zonePlacementsRef = useRef(null); // raw 0x1C list from last loadZone
  const dataStructOpenRef = useRef(false); // keep loadZone in sync without TDZ
  // Data Struct ParticleGenerator preview (plays on main canvas).
  const [fxPreview, setFxPreview] = useState(null); // { genId, title, note, error, ownsScene }
  const fxPreviewTokenRef = useRef(0);
  const [selectedFloor, setSelectedFloor] = useState('');
  // Scene > Floor Repeat: multiplier on the floor texture's tiling. Persisted,
  // and re-applied by the renderer whenever a new floor texture is loaded.
  const [floorTileScale, setFloorTileScaleState] = useState(() => {
    const v = parseFloat(localStorage.getItem('floorTileScale'));
    return Number.isFinite(v) ? Math.min(4, Math.max(0.25, v)) : 1;
  });
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
  // Origin axis gizmo + world grid — persisted (Settings + View menu).
  const [showAxes, setShowAxes] = useState(() => localStorage.getItem('showAxes') === '1');
  const [showGrid, setShowGrid] = useState(() => localStorage.getItem('showGrid') === '1');
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [showAlpha, setShowAlpha] = useState(true);
  // Zone blend submeshes: LEQUAL depth (on) vs strict LESS (off). Default on.
  const [blendLequal, setBlendLequal] = useState(() => localStorage.getItem('blendLequal') !== '0');
  const [showUnlit, setShowUnlit] = useState(false);
  // Cast shadows from a single sun. Not a retail feature — a viewer toggle.
  const [showShadows, setShowShadows] = useState(() => localStorage.getItem('shadows') === '1');
  // Display-space sun aim from the light gizmo (null = default / zone env).
  const [customSunDir, setCustomSunDir] = useState(() => {
    try {
      const raw = localStorage.getItem('customSunDir');
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n))) return v;
    } catch { /* */ }
    return null;
  });
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
  const [fpsCap, setFpsCap] = useState(() => {
    const v = parseInt(localStorage.getItem('fpsCap'), 10);
    return v === 30 || v === 60 || v === 120 ? v : 0;
  });
  const fpsCapRef = useRef(fpsCap);
  fpsCapRef.current = fpsCap;
  const [renderHeight, setRenderHeight] = useState(() => {
    const v = parseInt(localStorage.getItem('renderHeight'), 10);
    // Only known presets — a corrupt/huge value OOMs the canvas (seen 33M×33M).
    const allowed = new Set([0, 720, 900, 1080, 1440, 1800, 2160]);
    return allowed.has(v) ? v : 0;   // 0 = follow the window
  });
  // Mirrors what the renderer actually sized its buffer to, so the Graphics
  // panel can show it. Sampled while the panel is open — resize() is the only
  // writer and it runs per frame.
  const [bufferSize, setBufferSize] = useState(null);
  const [zoneBrightness, setZoneBrightness] = useState(0); // 0 = zone default, 1 = unlit
  const [showCollision, setShowCollision] = useState(false);
  const [showEffects, setShowEffects] = useState(true);
  // Region culling: draw only the MZB visibility set for the region the camera
  // is in, the way the client does. Off = every placement at once, which is
  // what a viewer wants for an overview but stacks the far-region copies of
  // geometry that zones like Ru'Aun Gardens carry.
  const [regionCull, setRegionCull] = useState(() => localStorage.getItem('regionCull') !== '0');
  const regionCullRef = useRef(regionCull);
  regionCullRef.current = regionCull;
  const [hasRegions, setHasRegions] = useState(false);
  // Camera readouts for the toolbar. Fly speed is mirrored from the camera each
  // frame; FOV is owned here and pushed down, since nothing else writes it.
  const [flySpeed, setFlySpeed] = useState(0);
  const [fps, setFps] = useState(0);
  const [fov, setFovState] = useState(() => {
    const saved = Number(localStorage.getItem('fovDegrees'));
    return Number.isFinite(saved) && saved >= 20 && saved <= 120 ? saved : 45;
  });
  // Mirrored so the cinematic camera can restore your FOV when it hands back.
  const fovRef = useRef(fov);
  fovRef.current = fov;
  const [showNavmesh, setShowNavmesh] = useState(false);
  // Sky, clouds and weather shells are on unless the user turned them off —
  // a zone without its weather isn't what the zone looks like.
  const [showSkybox, setShowSkyboxState] = useState(() => localStorage.getItem('skybox') !== '0');
  // Persisted skybox preference — kept across zone switches and sessions.
  const setSkybox = useCallback((on) => {
    const next = !!on;
    setShowSkyboxState(next);
    try { localStorage.setItem('skybox', next ? '1' : '0'); } catch { /* quota */ }
    if (rendererRef.current) rendererRef.current.showSkybox = next;
  }, []);
  const [hasCollision, setHasCollision] = useState(false);
  /** Zone particle effects for Objects → VFX tab. */
  const [effectGroups, setEffectGroups] = useState(null);
  const [vfxHiddenTick, setVfxHiddenTick] = useState(0);
  /** Zone positional SFX for Objects → SFX tab. */
  const [soundGroups, setSoundGroups] = useState(null);
  const [sfxListTick, setSfxListTick] = useState(0);
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
  // 'playing' | 'paused' | 'stopped'. Pause freezes the stage as it is; Stop
  // clears it and rewinds — the old single Play/Stop button only ever paused.
  const [effectTransport, setEffectTransport] = useState('playing');
  const [effectSpeed, setEffectSpeedState] = useState(1);
  const effectRoutinesRef = useRef([]);                     // mirror for stable playback callbacks
  const effectSpeedRef = useRef(1);
  const [effectVolume, setEffectVolumeState] = useState(() => {
    const v = parseFloat(localStorage.getItem('effectVolume'));
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.6;
  });
  const effectVolumeRef = useRef(effectVolume);
  // Effects loop by default — a spell preview is over in a second or two. The
  // choice sticks, and the ref is what the arming calls read.
  const [effectLoop, setEffectLoopState] = useState(
    () => localStorage.getItem('effectLoop') !== '0',
  );
  const effectLoopRef = useRef(effectLoop);
  // Called from the render loop when a non-looping routine plays itself out —
  // a ref so arming the routine never has to be redone when the callback
  // identity changes.
  const effectFinishedRef = useRef(() => {});
  // Animation panel > Show Character Animation. The effect DAT's 0x05 commands
  // name the caster's clip, so a Ninjutsu effect finds the ninjutsu motion and a
  // nuke finds the cast motion with nothing mapped by hand.
  // Off by default — only play caster clips when the user turns this on.
  const [showCharAnim, setShowCharAnimState] = useState(
    () => localStorage.getItem('showCharAnim') === '1',
  );
  const showCharAnimRef = useRef(showCharAnim);
  // Spawn TargetActor FX at the character AABB centre (default on).
  const [attachFx, setAttachFxState] = useState(
    () => localStorage.getItem('attachFxToChar') !== '0',
  );
  const attachFxRef = useRef(attachFx);
  const effectSfxOnRef = useRef(true);
  const effectTokenRef = useRef(0);                         // drop stale effect-load results
  const zoneMusicRef = useRef(null);                        // zone_music.json (server zone_settings)
  const zoneMusicIdRef = useRef(null);                      // zone id of the loaded zone
  const zoneCamKeyRef = useRef('');
  /** Assets view switch — one F-style reset so the next load doesn't keep a wild camera. */
  const forceCamResetOnViewRef = useRef(false);
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
  const [actorsOpen, setActorsOpen] = useState(() => {
    try { return localStorage.getItem('effectActorsOpen') !== '0'; } catch { return true; }
  });
  const setActorsOpenPersist = useCallback((v) => {
    const next = typeof v === 'function' ? v(actorsOpen) : !!v;
    setActorsOpen(next);
    try { localStorage.setItem('effectActorsOpen', next ? '1' : '0'); } catch { /* quota */ }
  }, [actorsOpen]);
  // Click zone viewport → select Objects row (no camera focus) + hover wireframe.
  const [liveSelection, setLiveSelection] = useState(() => {
    try { return localStorage.getItem('liveSelection') === '1'; } catch { return false; }
  });
  const liveSelectionRef = useRef(liveSelection);
  liveSelectionRef.current = liveSelection;
  const plcSelectedRef = useRef('');
  const plcHoverRef = useRef(null); // placement or null
  const gizmoHoverRef = useRef(null); // 'x'|'y'|'z'|null
  const toggleLiveSelection = useCallback(() => {
    const next = !liveSelectionRef.current;
    liveSelectionRef.current = next;
    try { localStorage.setItem('liveSelection', next ? '1' : '0'); } catch { /* quota */ }
    setLiveSelection(next);
    if (!next) {
      // Leaving Live Selection clears hover, selection, and gizmo.
      plcHoverRef.current = null;
      gizmoHoverRef.current = null;
      plcSelectedRef.current = '';
      setPlcSelected('');
      rendererRef.current?.setZonePickHighlight?.(null);
    }
  }, []);

  const gizmoDragRef = useRef(null); // { axis, placement, lastX, lastY, startPose }
  // Undo stack of pose snapshots taken *before* each completed gizmo move.
  const plcUndoRef = useRef([]);
  // First-seen pose per placement name (zone load) for "Reset object placement".
  const plcOriginalRef = useRef(new Map());
  // Bumps when poses change so the Objects list can show/hide Reset buttons.
  const [plcMovedTick, setPlcMovedTick] = useState(0);
  const bumpMoved = useCallback(() => setPlcMovedTick((n) => n + 1), []);

  const isPlacementMoved = useCallback((p) => {
    if (!p?.name) return false;
    const orig = plcOriginalRef.current.get(p.name);
    if (!orig) return false;
    return !posesEqual(clonePlacementPose(p), orig);
  }, [plcMovedTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const placementGizmoPos = (p) => {
    if (!p) return null;
    if (p.pos) return p.pos;
    if (p.bounds?.min && p.bounds?.max) {
      return [
        (p.bounds.min[0] + p.bounds.max[0]) * 0.5,
        (p.bounds.min[1] + p.bounds.max[1]) * 0.5,
        (p.bounds.min[2] + p.bounds.max[2]) * 0.5,
      ];
    }
    return null;
  };

  const syncZonePickHighlight = useCallback(() => {
    const r = rendererRef.current;
    if (!r?.setZonePickHighlight) return;
    const model = modelRef.current;
    if (model?.kind !== 'zone') {
      r.setZonePickHighlight(null);
      return;
    }
    const list = model.zonePlacements ?? [];
    const key = plcSelectedRef.current;
    let selected = null;
    if (key.startsWith('inst:')) {
      const name = key.slice(5);
      selected = list.find((p) => p.name === name) ?? null;
    } else if (key.startsWith('mesh:')) {
      const mesh = key.slice(5);
      selected = list.find((p) => p.mesh === mesh && !p.kind) ?? null;
    }
    const live = liveSelectionRef.current;
    const hover = live ? plcHoverRef.current : null;
    const selOk = selected && !selected.userHidden;
    const gizmoPos = selOk ? placementGizmoPos(selected) : null;
    const activeAxis = gizmoDragRef.current?.axis ?? null;
    const hoverAxis = gizmoHoverRef.current ?? null;
    r.setZonePickHighlight({
      hover: hover && hover !== selected && !hover.userHidden ? hover.bounds : null,
      selected: selOk ? selected.bounds : null,
      gizmo: gizmoPos ? { pos: gizmoPos, activeAxis, hoverAxis } : null,
    });
  }, []);

  const rememberOriginalPose = useCallback((placement) => {
    if (!placement?.name) return;
    if (!plcOriginalRef.current.has(placement.name)) {
      plcOriginalRef.current.set(placement.name, clonePlacementPose(placement));
    }
  }, []);

  const applyPlacementAndRebuild = useCallback((placement, snap) => {
    const model = modelRef.current;
    const r = rendererRef.current;
    if (!model || !r || !placement || !snap) return;
    applyPlacementPose(placement, snap);
    placement.dragHidden = false;
    r.setZoneMoveProxy(null);
    rebuildZoneDraws(model);
    r.reloadZoneBatches(model);
    syncZonePickHighlight();
  }, [syncZonePickHighlight]);

  /** Hide original, show move-proxy, rebuild zone batches. */
  const beginPlacementDrag = useCallback((placement) => {
    const model = modelRef.current;
    const r = rendererRef.current;
    if (!model || !r || !placement) return;
    rememberOriginalPose(placement);
    placement.dragHidden = true;
    rebuildZoneDraws(model);
    r.reloadZoneBatches(model);
    const draws = buildPlacementDraws(model, placement);
    r.setZoneMoveProxy(draws);
  }, [rememberOriginalPose]);

  const updatePlacementDragProxy = useCallback((placement) => {
    const model = modelRef.current;
    const r = rendererRef.current;
    if (!model || !r || !placement) return;
    const draws = buildPlacementDraws(model, placement);
    r.setZoneMoveProxy(draws);
    syncZonePickHighlight();
  }, [syncZonePickHighlight]);

  const endPlacementDrag = useCallback((placement, startPose) => {
    const model = modelRef.current;
    const r = rendererRef.current;
    if (!model || !r) return;
    if (placement) placement.dragHidden = false;
    r.setZoneMoveProxy(null);
    rebuildZoneDraws(model);
    r.reloadZoneBatches(model);
    // Push undo if the object actually moved.
    if (placement && startPose && !posesEqual(startPose, clonePlacementPose(placement))) {
      plcUndoRef.current.push(startPose);
      if (plcUndoRef.current.length > 100) plcUndoRef.current.shift();
      bumpMoved();
    }
    syncZonePickHighlight();
  }, [syncZonePickHighlight, bumpMoved]);

  const undoPlacementMove = useCallback(() => {
    const snap = plcUndoRef.current.pop();
    if (!snap) {
      setStatusText('Nothing to undo');
      return;
    }
    const model = modelRef.current;
    const placement = model?.zonePlacements?.find((p) => p.name === snap.name);
    if (!placement) {
      setStatusText('Undo failed — object gone');
      return;
    }
    applyPlacementAndRebuild(placement, snap);
    bumpMoved();
    setStatusText(`Undo · ${snap.name}`);
  }, [applyPlacementAndRebuild, bumpMoved]);
  const undoPlacementMoveRef = useRef(undoPlacementMove);
  undoPlacementMoveRef.current = undoPlacementMove;

  const resetPlacementPose = useCallback((placementOrName) => {
    const model = modelRef.current;
    if (!model) return;
    const name = typeof placementOrName === 'string'
      ? placementOrName
      : placementOrName?.name;
    const placement = model.zonePlacements?.find((p) => p.name === name);
    if (!placement) return;
    const orig = plcOriginalRef.current.get(name);
    if (!orig) {
      setStatusText(`${name} · already at original placement`);
      return;
    }
    const current = clonePlacementPose(placement);
    if (posesEqual(current, orig)) {
      setStatusText(`${name} · already at original placement`);
      return;
    }
    // Undo can restore the pre-reset pose.
    plcUndoRef.current.push(current);
    applyPlacementAndRebuild(placement, orig);
    bumpMoved();
    setStatusText(`Reset · ${name}`);
  }, [applyPlacementAndRebuild, bumpMoved]);

  // Bumps so Objects list eye icons re-render after mutating placement.userHidden.
  const [plcHiddenTick, setPlcHiddenTick] = useState(0);

  const rebuildAfterVisibility = useCallback(() => {
    const model = modelRef.current;
    const r = rendererRef.current;
    if (!model || !r || model.kind !== 'zone') return;
    rebuildZoneDraws(model);
    r.reloadZoneBatches(model);
    syncZonePickHighlight();
    setPlcHiddenTick((n) => n + 1);
  }, [syncZonePickHighlight]);

  /** Toggle one placement's draw visibility (Objects list eye). */
  const togglePlacementVisible = useCallback((placement) => {
    if (!placement) return;
    placement.userHidden = !placement.userHidden;
    // Sky panel rows are particle-only — flag is UI-only.
    if (placement.kind === 'sky') setPlcHiddenTick((n) => n + 1);
    else rebuildAfterVisibility();
    setStatusText(placement.userHidden
      ? `Hidden · ${placement.name}`
      : `Shown · ${placement.name}`);
  }, [rebuildAfterVisibility]);

  /** Toggle all instances in a mesh group. If any visible → hide all; else show all. */
  const togglePlacementGroupVisible = useCallback((group) => {
    const list = group?.instances;
    if (!list?.length) return;
    const anyVisible = list.some((p) => !p.userHidden);
    for (const p of list) p.userHidden = anyVisible;
    if (group.kind === 'sky') setPlcHiddenTick((n) => n + 1);
    else rebuildAfterVisibility();
    const label = group.mesh || 'group';
    setStatusText(anyVisible ? `Hidden · ${label}` : `Shown · ${label}`);
  }, [rebuildAfterVisibility]);

  const refreshEffectGroups = useCallback(() => {
    const sys = rendererRef.current?.particleSystem;
    setEffectGroups(sys?.listEffectGroups?.() ?? []);
    setVfxHiddenTick((n) => n + 1);
  }, []);

  const toggleEffectVisible = useCallback((entry) => {
    const sys = rendererRef.current?.particleSystem;
    if (!sys || !entry?.key) return;
    const next = !(entry.userHidden || entry.hidden);
    sys.setEffectHidden(entry.key, next);
    refreshEffectGroups();
    setStatusText(next ? `Hidden · ${entry.name}` : `Shown · ${entry.name}`);
  }, [refreshEffectGroups]);

  const toggleEffectGroupVisible = useCallback((group) => {
    const sys = rendererRef.current?.particleSystem;
    const list = group?.instances;
    if (!sys || !list?.length) return;
    const anyVisible = list.some((p) => !(p.userHidden || p.hidden));
    sys.setEffectsHidden(list.map((p) => p.key).filter(Boolean), anyVisible);
    refreshEffectGroups();
    setStatusText(anyVisible ? `Hidden · ${group.name}` : `Shown · ${group.name}`);
  }, [refreshEffectGroups]);
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
    // Sequencer HMR / crash can leave body.cinematic on and hide the whole UI.
    document.body.classList.remove('cinematic');
    const canvas = canvasRef.current;
    // Recover from a runaway backing store (seen at 33M×33M — freezes the tab).
    if (canvas && (canvas.width > 8192 || canvas.height > 8192)) {
      canvas.width = 1;
      canvas.height = 1;
    }
    const renderer = new Renderer(canvas);
    renderer.screenOffsetX = 0;
    rendererRef.current = renderer;
    // Dev-only escape hatch for driving/inspecting the renderer from the
    // console (headless verification, quick probes). Not part of the app API.
    // Exposed as the ref, not the instance — StrictMode mounts twice and a
    // captured instance goes stale the moment the second one takes over.
    if (import.meta.env.DEV) window.__xiRendererRef = rendererRef;
    renderer.renderHeight = renderHeight;
    renderer.setFogOverride({ enabled: fogOn, scale: fogScale });
    renderer.showShadows = showShadows;
    renderer.shadowRange = shadowDistance;
    renderer.setCustomSunDir(customSunDir);
    renderer.camera.fovDegrees = fov;
    {
      const id = normalizeBgId(localStorage.getItem('bgImage') || 'none');
      const url = resolveBgUrl(id);
      if (url) renderer.setBackgroundImage(url);
    }
    renderer.setFloorTileScale(floorTileScale);
    renderer.playbackSpeed = playbackSpeedRef.current;
    renderer.showSkybox = localStorage.getItem('skybox') !== '0';
    // Unplaced orphans use per-row eyes in Objects (always eligible to draw).
    renderer.showUnplaced = true;
    // Restore View > Toggle WASD from last session.
    if (wasdRef.current) renderer.camera.setMode('fly');
    renderer.attachFxToActor = attachFxRef.current;
    // Seed the toolbar readout so it never shows 0 before the first frame.
    setFlySpeed(Math.round(renderer.camera.flySpeed));

    let raf;
    let last = performance.now();
    let lastDraw = last;
    let shownFlySpeed = -1;
    let shownFps = -1;
    let fpsFrames = 0;
    let fpsWindowStart = last;
    let lastRegionCheck = 0;
    // Resolve the camera to an MZB visibility set and re-bake only when the
    // region actually changes — you have to cross a region boundary for that,
    // so the steady-state cost is one box test per region every 150 ms.
    const updateRegions = () => {
      const model = modelRef.current;
      if (!model || model.kind !== 'zone' || !model.pvsRegions?.length) return;
      const want = regionCullRef.current ? pickPvsRegion(model, renderer.camera.target) : null;
      if ((want?.ptr ?? null) === (model.activeRegion ?? null)) return;
      if (!applyPvsRegion(model, want)) return;
      rebuildZoneDraws(model);
      renderer.reloadZoneBatches(model);
      // Culling can drop two thirds of a zone, so say so rather than leaving it
      // looking like geometry went missing.
      setStatusText(want
        ? `Region ${model.pvsRegions.indexOf(want) + 1}/${model.pvsRegions.length} — ${want.members.size} objects visible`
        : 'No region — drawing every object');
    };
    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      // FPS cap (0 = uncapped): skip the draw when under the target interval.
      // Still schedule the next rAF so the loop stays alive and input stays live.
      const cap = fpsCapRef.current;
      if (cap > 0 && (now - lastDraw) < (1000 / cap) - 0.5) return;
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      lastDraw = now;
      // A recorded sequence owns the camera outright while it plays.
      camSeqTick.current?.(dt);
      if (wasdRef.current && !renderer.camera.sequenceLock) {
        renderer.camera.flyUpdate(dt, heldKeys.current);
      }
      if (now - lastRegionCheck > 150) { lastRegionCheck = now; updateRegions(); }
      renderer.render(dt);
      // The camera owns fly speed and changes it from the wheel, from zone vs
      // entity range presets and from localStorage, so mirror it here rather
      // than trying to catch every writer. Only on a change of the rounded
      // value, so this is a handful of updates, not one per frame.
      const speed = Math.round(renderer.camera.flySpeed);
      if (speed !== shownFlySpeed) { shownFlySpeed = speed; setFlySpeed(speed); }
      // FPS: average over ~0.5s windows so the toolbar doesn't thrash.
      fpsFrames++;
      const fpsElapsed = now - fpsWindowStart;
      if (fpsElapsed >= 500) {
        const next = Math.round((fpsFrames * 1000) / fpsElapsed);
        if (next !== shownFps) { shownFps = next; setFps(next); }
        fpsFrames = 0;
        fpsWindowStart = now;
      }
      animTick.current?.(renderer.animFrame, renderer.currentAnimation?.lengthInFrames ?? 0);
    };
    raf = requestAnimationFrame(frame);

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
      // Ctrl+Z / Cmd+Z — undo last placement move (zone gizmo).
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'z') {
        e.preventDefault();
        undoPlacementMoveRef.current?.();
        return;
      }
      if (k === 'f') {
        e.preventDefault();
        focusOrResetCameraRef.current?.();
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
    if (rendererRef.current) rendererRef.current.setCustomSunDir(customSunDir);
    try {
      if (customSunDir) localStorage.setItem('customSunDir', JSON.stringify(customSunDir));
      else localStorage.removeItem('customSunDir');
    } catch { /* quota */ }
  }, [customSunDir]);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.shadowRange = shadowDistance;
    try { localStorage.setItem('shadowDistance', String(shadowDistance)); } catch { /* quota */ }
  }, [shadowDistance]);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.renderHeight = renderHeight;
    try { localStorage.setItem('renderHeight', String(renderHeight)); } catch { /* quota */ }
  }, [renderHeight]);

  useEffect(() => {
    fpsCapRef.current = fpsCap;
    try { localStorage.setItem('fpsCap', String(fpsCap)); } catch { /* quota */ }
  }, [fpsCap]);

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
    const { focusPaths = null, weaponSlots = null, battleTable = null, parts = null, displayPath = null } = opts;
    // Keep framing when the caller asks (gear swap) or the user has already
    // orbit/pan/zoomed on an entity — browsing successive DATs shouldn't yank
    // the camera. Assets view switches force a fresh F-style fit.
    const prev = modelRef.current;
    const prevEntity = !!(prev && prev.kind !== 'zone' && !rendererRef.current?.effectMode);
    const forceViewReset = forceCamResetOnViewRef.current;
    if (forceViewReset) forceCamResetOnViewRef.current = false;
    const keepCamera = !forceViewReset && !!(opts.keepCamera
      || (rendererRef.current?.camera?.userFramed && prevEntity));
    // Gear swaps (keepCamera) are snappy — skip the full-screen overlay there.
    const showOverlay = !opts.keepCamera;
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
        const why = `no renderable skeleton+mesh (skeleton: ${model.skeleton ? 'yes' : 'no'}, mesh groups: ${model.meshGroups.length})`;
        setStatusText(`${displayName} — ${why}`);
        return { ok: false, reason: why };
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
      setBrowserKind('entity');
      const primaryPath = displayPath ?? paths[paths.length - 1];
      setSelectedDat(primaryPath.toLowerCase());
      setModelPath(relativeName(primaryPath));
      shownPathRef.current = primaryPath;
      sourcePathRef.current = paths[paths.length - 1];
      if (parts?.length) pcPartsRef.current = parts;

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

      const autoPlay = settingsRef.current?.autoPlay ?? false;
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
      if (forceViewReset) renderer.resetCamera();

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
      // Match on relative path — resolved HD paths rarely equal the composer abs path.
      const relKey = (p) => relativeName(p).toLowerCase().replace(/\//g, '\\');
      const infoParts = (parts ?? []).map((p) => {
        const set = new Set((p.paths ?? []).map(relKey));
        const models = set.size
          ? parsed.filter((e) => set.has(relKey(e.path))).map((e) => e.model)
          : [];
        return {
          key: p.key,
          label: p.label,
          itemLabel: p.itemLabel,
          relPaths: (p.paths ?? []).map(relativeName),
          ...(models.length ? statsOf(models) : {
            joints: null, verts: 0, tris: 0, animCount: 0, scheduleCount: 0, textures: [],
          }),
        };
      });

      setModelInfo({
        name: displayName,
        ...statsOf([model]),
        joints: model.skeleton.joints.length,
        parts: infoParts,
      });

      // Multi-DAT set for Data Struct dropdown (race + each gear/anim part).
      {
        const seen = new Set();
        const sources = [];
        const pushSrc = (id, label, path) => {
          if (!path) return;
          const k = relKey(path);
          if (seen.has(k)) return;
          seen.add(k);
          sources.push({ id, label, path: String(path).replace(/\//g, '\\') });
        };
        if (parts?.length) {
          for (const p of parts) {
            for (const path of p.paths ?? []) {
              pushSrc(`${p.key}:${relKey(path)}`, p.itemLabel ? `${p.label} — ${p.itemLabel}` : p.label, path);
            }
          }
        }
        for (const path of paths) pushSrc(relKey(path), relativeName(path), path);
        setDataSources(sources);
      }

      setTexWindows([]);   // close texture windows from the previous model
      setObjectGroups(null);
      setEffectGroups(null);
      setSoundGroups(null);
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
      // Remember NPC/PC for Effects → back without a full reload.
      if (model.kind !== 'zone' && model.kind !== 'creation') {
        const view = leftViewRef.current === 'pc' || leftViewRef.current === 'npc'
          ? leftViewRef.current
          : (lastEntityRef.current?.view ?? 'npc');
      lastEntityRef.current = {
        view: leftViewRef.current === 'effects'
          ? (effectActorTabRef.current === 'pc' ? 'pc' : 'npc')
          : view,
        selectedPath: primaryPath.toLowerCase(),
        modelPath: relativeName(primaryPath),
        shownPath: primaryPath,
        sourcePath: paths[paths.length - 1],
        name: displayName,
      };
      }
      return { ok: true };
    } catch (err) {
      console.error(err);
      releaseOverlay();
      if (stillCurrent()) setStatusText(`${displayName} — failed to load: ${err.message ?? err}`);
      return { ok: false, reason: err.message ?? String(err) };
    }
  }, [beginLoad, stepLoad, endLoad]);

  const relativeName = (path) => relFromAbs(path, settingsRef.current);

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

    // Zone particle path only needs root+textures. Do NOT stash this as the
    // full globalEffectsRef — loadEffect needs routines from ROM/0/0.DAT too,
    // and an early incomplete cache would permanently drop shared routine links.
    let zoneGlobalRoot = globalEffectsRef.current?.root ?? null;
    let zoneGlobalTextures = globalEffectsRef.current?.textures ?? null;
    if (!zoneGlobalRoot) {
      try {
        const { data: buf } = await backend.readPrefer(gameCandidates('ROM\\0\\0.DAT', settings));
        zoneGlobalRoot = treeOf(buf, globalParsers);
        zoneGlobalTextures = parseDatTextures(buf);
      } catch (e) {
        console.warn('shared effects DAT (ROM/0/0.DAT) unavailable', e);
        zoneGlobalRoot = null;
        zoneGlobalTextures = new Map();
      }
    }

    const system = new ParticleSystem({
      zoneRoot: treeOf(treeBuf, zoneParsers),
      globalRoot: zoneGlobalRoot,
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
    // Must include `routines`. A partial cache (root/textures only) is treated
    // as incomplete and rebuilt so linked 0x03 targets still resolve.
    const cur = globalEffectsRef.current;
    if (cur?.root && cur?.routines) return cur;
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
    const abs = `${settings.gamePath}\\${rel}`;
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
      const renderer = rendererRef.current;
      const actor = modelRef.current;
      const onActor = !!(actor && actor.kind !== 'zone' && actor.isRenderable && renderer?.model === actor);

      // Caster animation: resolve each 0x05 ref against THIS character's clips.
      // A ref that doesn't resolve is dropped, which is how the weapon-skill
      // (`wz*`) refs degrade when the motion pack holding them isn't loaded.
      let animCues = [];
      let windup = 0;
      if (onActor && showCharAnimRef.current) {
        // `actor.animations` entries ARE clips (id + jointTracks +
        // lengthInFrames) — there is no `.clip` wrapper. That only appears once
        // groupAnimations() buckets them for the Anim dropdown.
        const ids = actor.animations.map((a) => a.id);
        const clipById = new Map(actor.animations.map((a) => [a.id, a]));
        /**
         * A ref like `mb0?` matches SEVERAL clips — `mb00`, `mb01` — and those
         * are body-region layers of one motion, not alternatives. Taking the
         * first played only the half that tracked the legs. groupAnimations
         * merges them into a single layered clip, which is what the Characters
         * view feeds the renderer (see resolveScheduleClip).
         */
        const findClip = (ref) => {
          const parts = matchAnimRef(ref, ids).map((id) => clipById.get(id)).filter(Boolean);
          if (!parts.length) return null;
          return groupAnimations(parts)[0]?.clip ?? null;
        };
        // `idl` and nothing else. `std` is a stand-UP motion, not a stance.
        const idleClip = () => findClip('idl?') ?? pickBaseIdle(actor);

        // A call the effect DAT can't satisfy is a schedule on the ACTOR — this
        // is where the cast motions live (`shbk` black, `shnj` ninjutsu, `shwh`
        // white). Every race ships the `sh*` schedules EMPTY while the `ca*`
        // twin carries the ref, so read the twin's ref when the direct one is
        // blank (verified identical on Hume/Taru/Galka/Mithra).
        const schedById = new Map((actor.schedules ?? []).map((sc) => [sc.id, sc]));
        const schoolRef = (id) => (schedById.get(id)?.refs ?? [])[0]
          ?? (id.startsWith('sh') ? (schedById.get(`ca${id.slice(2)}`)?.refs ?? [])[0] : null)
          ?? null;

        /**
         * Full cast — wind-up → hold → release — as ONE clip with `segments`,
         * not a run of setAnimation calls. That hands the whole thing to
         * SkeletonPose.evaluate, which already cross-fades a finished segment
         * back to `baseClip` over `transOut` frames and rests undriven joints
         * there instead of the bind pose. Firing separate clips could only
         * snap.
         *
         * The three stages are the same clip base with the stage digit walked
         * (`mb0?`/`mb1?`/`mb2?` for black magic), so this is derived, not a
         * table. Segment delays are 30fps clip frames; the routine clock is
         * 60/s, hence the doubling on the way out.
         */
        const buildCast = (scheduleId) => {
          // ONLY the magic-cast schedules have the three-stage structure.
          // `ca<school>` / `sh<school>` map to `m*0/1/2` = wind-up/hold/release.
          // Everything else a routine can call — res0, damg, sway, gurd, pary —
          // is a self-contained motion, and walking its stage digit invents a
          // sequence that does not exist: `res0` refs `rx0?`, so the walk
          // played rx0 → rx1 → rx2, i.e. Raise I then II then III.
          if (!/^(ca|sh)/.test(scheduleId)) return null;
          const ref = schoolRef(scheduleId);
          if (!ref) return null;
          const base = ref.slice(0, 2);
          // Belt and braces: the cast families all start with `m`.
          if (!base.startsWith('m')) return null;
          const inC = findClip(`${base}0?`);
          const holdC = findClip(`${base}1?`);
          const outC = findClip(`${base}2?`);
          if (!inC || !outC) return null;
          const len = (c) => c.lengthInFrames ?? 0;
          const segments = [{ clip: inC, delay: 0, transOut: CAST_BLEND_FRAMES }];
          let at = len(inC);
          if (holdC) {
            segments.push({ clip: holdC, delay: at, transOut: CAST_BLEND_FRAMES });
            at += len(holdC);
          }
          // The release runs its own length (~1s for most schools) and then
          // fades out over CAST_BLEND_FRAMES rather than cutting to idle.
          segments.push({ clip: outC, delay: at, transOut: CAST_BLEND_FRAMES });
          return { segments, releaseFrame: at, endFrame: at + len(outC) + CAST_BLEND_FRAMES };
        };

        const cast = (routine.flat.actorCalls ?? []).map((c) => buildCast(c.scheduleId)).find(Boolean);
        if (cast) {
          windup = cast.releaseFrame * 2;   // the effect lands on the release
          const jointTracks = new Map();
          for (const s of cast.segments) for (const [j, t] of s.clip.jointTracks) jointTracks.set(j, t);
          const idle = idleClip();
          // TWO cues, not one. Stretching the cast clip to cover the effect
          // can't work: the renderer loops on lengthInFrames, and an effect
          // outlives its own emission window (particles have their own
          // lifespans), so any length guessed from the routine wrapped early
          // and replayed the wind-up over the still-running spell. Instead the
          // cast runs exactly its own length, then hands over to the idle,
          // which loops cleanly on its own until the effect re-arms and
          // re-fires cue one.
          animCues = [{
            delay: 0,
            clip: {
              id: 'cast',
              segments: cast.segments,
              jointTracks,
              lengthInFrames: cast.endFrame,
              numFrames: Math.max(...cast.segments.map((s) => s.clip.numFrames ?? 0)),
              keyFrameDuration: 1,
              // Undriven joints and finished segments settle here, not bind pose.
              baseClip: idle,
              parts: cast.segments.map((s) => s.clip.id),
            },
          }];
          // Hand over to the looping idle the frame the cast finishes.
          if (idle) animCues.push({ delay: cast.endFrame * 2, clip: idle });
        } else {
          // No cast schedule: fall back to whatever 0x05 named outright.
          animCues = (routine.flat.anims ?? [])
            .map((a) => ({ delay: a.delay, clip: findClip(a.ref) }))
            .filter((a) => a.clip);
        }
      }
      if (onActor && !showCharAnimRef.current) {
        renderer.setAnimation(actorIdleClip());
        renderer.playing = true;
      }
      // Shift the whole effect so it fires on the cast's release frame.
      const shift = (arr) => (windup ? arr.map((x) => ({ ...x, delay: x.delay + windup })) : arr);
      system.playEffectRoutine(shift(routine.flat.commands), {
        loop: effectLoopRef.current,
        sounds: shift(routine.flat.sounds),
        anims: animCues,
        // Routine ticks are 60/s and clips are 30fps, but setAnimation starts at
        // frame 0 either way — the delay is what the effect clock already
        // applied, so nothing is converted here.
        onAnim: (a) => {
          const r = rendererRef.current;
          if (!r || !a.clip) return;
          r.setAnimation(a.clip);
          r.playing = true;
        },
        onFinished: effectFinishedRef.current,
      });
      setWasd(false);                    // effects orbit; fly controls would fight the framing

      const forceViewReset = forceCamResetOnViewRef.current;
      if (forceViewReset) forceCamResetOnViewRef.current = false;

      if (onActor) {
        // Keep the character mesh; composite particles like a zone weather pass.
        renderer.attachFxToActor = attachFxRef.current;
        renderer.attachEffectSystem(system, textures);
        if (forceViewReset) renderer.resetCamera();
      } else {
        // Empty stage: wipe any prior model and frame the origin once.
        // Assets view switch: full F framing (not keepView of the prior camera).
        const keepCamera = !forceViewReset && renderer.effectMode;
        renderer.setEffectScene(system, textures, keepCamera);
        if (forceViewReset) renderer.frameEffect();
        modelRef.current = null;
      }
      // Status bar + Data Struct always name the effect DAT (even on-actor).
      setModelPath(rel);
      shownPathRef.current = abs;
      renderer.effectSpeed = effectSpeedRef.current;
      renderer.effectPaused = false;

      effectRoutinesRef.current = routines;
      setEffectEntry(entry);
      setEffectRoutines(routines);
      setEffectSchedule(routine.id);
      setEffectTransport('playing');
      setSelectedDat(abs.toLowerCase());
      setDataSources([{ id: 'effect', label: rel, path: abs }]);
      if (dataStructOpenRef.current) {
        queueMicrotask(() => dataStructReloadRef.current?.(abs));
      }
      try {
        localStorage.setItem(LAST_EFFECT_KEY, JSON.stringify({
          name: entry.name,
          path: rel,
          cat: entry.cat ?? null,
        }));
      } catch { /* quota */ }

      // Details panel: the effect's sprite images (click to view, same as gear
      // textures) plus what the DAT actually contains.
      const dir = tree.getSubDirectories()[0] ?? tree;
      const sheets = dir.collectByTypeRecursive(SEC.SPRITE_SHEET);
      const pmeshes = dir.collectByTypeRecursive(SEC.PARTICLE_MESH);
      const countVerts = (list) => list.reduce(
        (n, r) => n + (r.meshes ?? []).reduce((m, x) => m + (x.count ?? 0), 0),
        0,
      );
      const verts = countVerts(sheets) + countVerts(pmeshes);
      const effectMeta = {
        path: rel,
        category: entry.cat ?? '—',
        generators: routine.flat.commands.length,
        sounds: routine.flat.sounds.length,
        spriteSheets: sheets.length,
        particleMeshes: pmeshes.length,
        onActor,
      };
      const effectTextures = [...ownTextures.values()].map((t) => ({
        name: texLabel(t.name), width: t.width, height: t.height, format: t.format, data: t.data,
      }));
      setTexWindows([]);   // close viewers from the previous effect
      if (onActor) {
        setModelInfo((prev) => ({
          ...(prev ?? { name: entry.name, joints: null, verts: 0, tris: 0, animCount: 0, parts: [] }),
          scheduleCount: routines.length,
          effect: effectMeta,
          // Keep actor textures; append effect sheets for the Details list.
          textures: [
            ...((prev?.textures ?? []).filter((t) => !effectTextures.some((e) => e.name === t.name))),
            ...effectTextures,
          ],
        }));
      } else {
        setModelInfo({
          name: entry.name,
          joints: null,
          verts,
          tris: Math.floor(verts / 3),
          animCount: 0,
          scheduleCount: routines.length,
          textures: effectTextures,
          parts: [],
          effect: effectMeta,
        });
      }
      const genLabel = routine.flat.commands.length
        ? `${entry.name}  ·  ${routine.flat.commands.length} generators`
        : `${entry.name}  ·  no particle routine`;
      setStatusText(onActor ? `${genLabel}  ·  on actor` : genLabel);
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

  /** The actor's idle clip — every PC and NPC skeleton ships `idl0` or `std0`. */
  const actorIdleClip = useCallback(() => {
    const actor = modelRef.current;
    if (!actor?.animations?.length) return null;
    const ids = actor.animations.map((a) => a.id);
    const parts = matchAnimRef('idl?', ids)
      .map((id) => actor.animations.find((a) => a.id === id))
      .filter(Boolean);
    return parts.length ? (groupAnimations(parts)[0]?.clip ?? null) : pickBaseIdle(actor);
  }, []);

  const setShowCharAnim = useCallback((on) => {
    showCharAnimRef.current = !!on;
    setShowCharAnimState(!!on);
    try { localStorage.setItem('showCharAnim', on ? '1' : '0'); } catch { /* quota */ }
    // Takes effect on the next effect load / schedule change — the cue list is
    // baked when the routine is armed. Either way settle the actor on its idle
    // rather than the bind pose, so a half-played cast is never left frozen.
    const r = rendererRef.current;
    if (!on && r) {
      r.setAnimation(actorIdleClip());
      r.playing = true;
    }
  }, [actorIdleClip]);

  const setAttachFx = useCallback((on) => {
    attachFxRef.current = !!on;
    setAttachFxState(!!on);
    try { localStorage.setItem('attachFxToChar', on ? '1' : '0'); } catch { /* quota */ }
    if (rendererRef.current) rendererRef.current.attachFxToActor = !!on;
  }, []);

  /** Loop toggle: applies to the armed routine immediately, and sticks. */
  const setEffectLoop = useCallback((on) => {
    effectLoopRef.current = !!on;
    setEffectLoopState(!!on);
    try { localStorage.setItem('effectLoop', on ? '1' : '0'); } catch { /* quota */ }
    rendererRef.current?.particleSystem?.setEffectLoop(!!on);
    // setEffectLoop replays a one-shot that had played itself out (but never a
    // stopped one), so the transport must not be left reading "paused".
    const sys = rendererRef.current?.particleSystem;
    if (on && sys && !sys.isEffectFinished()) {
      if (rendererRef.current) rendererRef.current.effectPaused = false;
      setEffectTransport('playing');
    }
  }, []);

  // A one-shot that reaches its end leaves an empty stage, which is the same
  // place Stop leaves it — so the transport reads "stopped" and Play re-runs it.
  effectFinishedRef.current = () => setEffectTransport('stopped');

  /** Play: resume a pause, or re-run a stopped/finished routine from frame 0. */
  const playEffect = useCallback(() => {
    const renderer = rendererRef.current;
    // An empty parked stage has nothing to un-pause, so Play must re-arm it.
    if (renderer?.particleSystem?.isEffectFinished()) {
      renderer.particleSystem.restartEffect();
    }
    if (renderer) {
      renderer.effectPaused = false;
      if (showCharAnimRef.current) renderer.playing = true;
    }
    setEffectTransport('playing');
  }, []);

  /** Pause: freeze the stage exactly as it is — actor included. */
  const pauseEffect = useCallback(() => {
    const r = rendererRef.current;
    if (r) {
      r.effectPaused = true;
      // The cast motion is part of the effect, so it holds too. Only while this
      // feature is driving the actor: otherwise pausing an effect would freeze
      // a clip the user picked by hand from the Anim dropdown.
      if (showCharAnimRef.current) r.playing = false;
    }
    setEffectTransport('paused');
  }, []);

  /** Stop: clear the stage and rewind, leaving the routine ready for Play. */
  const stopEffect = useCallback(() => {
    const renderer = rendererRef.current;
    renderer?.particleSystem?.stopEffect();
    if (renderer) renderer.effectPaused = false;
    setEffectTransport('stopped');
  }, []);

  const changeEffectSchedule = useCallback((id) => {
    setEffectSchedule(id);
    const system = rendererRef.current?.particleSystem;
    if (!system) return;
    const routine = effectRoutinesRef.current.find((r) => r.id === id);
    if (!routine) { system.clearEffect(); setEffectTransport('stopped'); return; }
    system.playEffectRoutine(routine.flat.commands, { loop: effectLoopRef.current, sounds: routine.flat.sounds, onFinished: effectFinishedRef.current });
    rendererRef.current.effectPaused = false;
    setEffectTransport('playing');
  }, []);

  /** Reset: restart the routine from frame 0 (speed reset is handled by onSpeed). */
  const restartEffect = useCallback(() => {
    const renderer = rendererRef.current;
    renderer?.particleSystem?.restartEffect();
    if (renderer) renderer.effectPaused = false;
    setEffectTransport('playing');
  }, []);

  /** Close Data Struct particle preview modal (does not touch the main view). */
  const closeFxPreview = useCallback(() => {
    fxPreviewTokenRef.current += 1;
    const prev = fxPreview;
    prev?.system?.clearEffect?.();
    setFxPreview(null);
  }, [fxPreview]);

  /**
   * Data Struct ParticleGenerator row → floating modal with its own WebGL canvas.
   * Builds a private ParticleSystem from the inspect buffer so the main zone /
   * effect view is left alone.
   */
  const openDataParticle = useCallback(async (res) => {
    const genId = String(res?.id ?? '').replace(/\0/g, '').trim();
    if (!genId) {
      setStatusText('ParticleGenerator has no id');
      return;
    }
    const token = ++fxPreviewTokenRef.current;
    const title = genId;
    // Drop any previous preview system before opening a new one.
    setFxPreview((prev) => {
      prev?.system?.clearEffect?.();
      return { genId, title, system: null, textures: null, error: '', loading: true };
    });
    raiseModal('fx');
    setStatusText(`Loading particle ${genId}…`);

    try {
      if (!dataBufRef.current) {
        throw new Error('No DAT buffer — reopen Data Struct on this file');
      }
      const settings = settingsRef.current;
      if (!settings?.gamePath) throw new Error('Game path not set');

      const warnings = [];
      await ensureGlobalEffects(settings, warnings);
      if (token !== fxPreviewTokenRef.current) return;

      const isZone = modelRef.current?.kind === 'zone';
      const live = rendererRef.current?.particleSystem;
      const tree = buildParticleTree(
        dataBufRef.current,
        particleParsers(isZone, warnings),
        warnings,
      );
      // Live zone system stores sections as Map<id, section[]>; constructor wants a flat list.
      let zoneMeshSections = [];
      if (live?.zoneMeshSections instanceof Map) {
        for (const list of live.zoneMeshSections.values()) zoneMeshSections.push(...list);
      } else if (Array.isArray(live?.zoneMeshSections)) {
        zoneMeshSections = live.zoneMeshSections;
      }
      const system = new ParticleSystem({
        zoneRoot: tree,
        globalRoot: globalEffectsRef.current?.root ?? null,
        // Mesh-linked zone gens need the live zone mesh tables when available.
        zoneMeshIdToName: live?.zoneMeshIdToName ?? new Map(),
        zoneMeshes: live?.zoneMeshes ?? new Map(),
        zoneMeshSections,
        camera: null,
        environment: null,
        onWarn: (m) => console.debug('[fx-preview]', m),
      });

      const ownTextures = parseDatTextures(dataBufRef.current);
      const textures = new Map(ownTextures);
      for (const [name, tex] of globalEffectsRef.current?.textures ?? []) {
        if (!textures.has(name)) textures.set(name, tex);
      }

      // Direct register at origin (not main-view routine path).
      const armed = armGeneratorPreview(system, genId);
      if (token !== fxPreviewTokenRef.current) {
        system.clearEffect();
        return;
      }
      const note = armed.live > 0
        ? `${armed.live} particles`
        : (armed.gen?.invalid ? 'generator invalid' : 'armed · waiting for emit');
      setFxPreview({
        genId, title, system, textures, error: '', loading: false, note,
      });
      setStatusText(`Particle ${genId} · ${note}`);
    } catch (e) {
      console.error('ParticleGenerator preview failed', e);
      if (token !== fxPreviewTokenRef.current) return;
      const msg = e?.message ?? String(e);
      setFxPreview({ genId, title, system: null, textures: null, error: msg, loading: false });
      setStatusText(`Particle ${genId}: ${msg}`);
    }
  }, [ensureGlobalEffects, raiseModal]);

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
    // `remember: false` keeps a one-off preview out of the session restore.
    const { keepCamera = false, cameraSnap = null, remember = true } = opts;
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
      // Keep raw placements for Data Struct ZoneDef clicks (before model filters).
      zonePlacementsRef.current = Array.isArray(parsed.placements)
        ? parsed.placements.map((p, i) => ({
          index: p.index ?? i,
          meshId: p.meshId || '',
          subAreaId: p.subAreaId ?? null,
          pos: p.pos || [0, 0, 0],
          rot: p.rot || [0, 0, 0],
          scale: p.scale || [1, 1, 1],
        }))
        : null;

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
        return { ok: false, reason: 'no renderable mesh' };
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
      // Zones default to fly/WASD (incl. pre-production MZB zones from the file
      // browser). A saved orbit pose still restores the eye, but we keep fly
      // unless the user turned Auto-WASD off in Settings.
      const wantFly = settingsRef.current?.autoWasdZones !== false;
      if (saved) {
        const mode = wantFly ? 'fly' : (saved.mode === 'orbit' ? 'orbit' : 'fly');
        wasdRef.current = mode === 'fly';
        setWasdState(mode === 'fly');
        try { localStorage.setItem('wasd', mode === 'fly' ? '1' : '0'); } catch { /* quota */ }
        renderer.camera.restore({ ...saved, mode });
        if (mode === 'fly') renderer.camera.setMode('fly');
      } else if (wantFly) {
        // setModel already fitted in orbit; seat fly on that eye.
        setWasd(true);
        renderer.fitCamera();
      }

      // setModel clears any previous system, so attach after it. Attaching also
      // installs the camera adapter, which the weather generators need.
      renderer.setParticleSystem(particleSystem, environment);
      environment?.activateInitialWeather();
      // Catalog every listable 0x05 (zone + all weather folders) for Objects → VFX.
      particleSystem?.rebuildEffectCatalog?.();
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
      // Mesh + Event/Dialog/NPC companions for Data Struct multi-DAT.
      try {
        const tables = await loadMergedTables(settingsRef.current, dataTablesRef);
        let zonesList = [];
        try { zonesList = await (await fetch('lists/zones.json')).json(); } catch { /* ok */ }
        const bundle = buildZoneDatBundle(rel, tables, zonesList);
        const gp = settingsRef.current.gamePath;
        const src = (bundle.dats?.length ? bundle.dats : [{ key: 'zone', label: 'DAT', rel, fileId: bundle.fileId }])
          .map((d) => ({
            id: d.key,
            label: d.fileId != null ? `${d.label} — ${d.rel} (#${d.fileId})` : `${d.label} — ${d.rel}`,
            path: `${gp}\\${normRel(d.rel)}`,
            fileId: d.fileId,
            rel: d.rel,
          }));
        setDataSources(src);
      } catch {
        setDataSources([{ id: 'zone', label: rel, path: resolvedAbs }]);
      }
      // Keep Data Struct in sync when switching zones while the overlay is open.
      if (dataStructOpenRef.current) {
        // loadDatData is declared later; call through a stable ref.
        queueMicrotask(() => dataStructReloadRef.current?.(resolvedAbs));
      }
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
      setHasRegions(!!model.pvsRegions?.length);
      setHasSkybox(hasSky);
      setWeatherList(envs ? listWeathers(envs) : []);
      setWeather(weather0 || '');
      setTimeMinutes(time0);
      setShowCollision(false);
      setShowNavmesh(false);
      renderer.showCollision = false;
      renderer.showNavmesh = false;
      // Restore the saved skybox preference (off if this zone has no sky).
      setSkybox(hasSky && localStorage.getItem('skybox') !== '0');
      // Unplaced: always drawable; default hidden via per-row userHidden eyes.
      renderer.showUnplaced = true;
      for (const p of model.zonePlacements ?? []) {
        if (p.kind === 'unplaced') p.userHidden = true;
      }
      if ((model.zonePlacements ?? []).some((p) => p.kind === 'unplaced')) {
        rebuildZoneDraws(model);
        renderer.reloadZoneBatches(model);
      }
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
      setEffectGroups(particleSystem?.listEffectGroups?.() ?? []);
      setSoundGroups(particleSystem?.listSoundGroups?.() ?? []);
      setSfxListTick((n) => n + 1);
      setPlcSelected('');
      setPlcOpen(true);
      // Fresh zone — drop edit history / originals from the previous area.
      plcUndoRef.current = [];
      plcOriginalRef.current = new Map();
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
      if (remember) {
        try {
          localStorage.setItem(LAST_DAT_KEY, JSON.stringify({
            kind: 'zone',
            zone: { id: zone.id, name: zone.name, path: zone.path },
          }));
        } catch { /* quota */ }
      }
      return { ok: true };
    } catch (err) {
      console.error(err);
      releaseOverlay();
      if (stillCurrent()) setStatusText(`${displayName} — failed: ${err.message ?? err}`);
      return { ok: false, reason: err.message ?? String(err) };
    }
  }, [getKeyTables, beginLoad, stepLoad, endLoad, setWasd, buildParticleSystem, getWeatherAudio, resolveZoneTrack, persistCurrentZoneCamera]);

  // Character composer (Assets > Characters) — shared by the left panel and
  // the Animation panel Action combo.
  const pcPartsRef = useRef([]);
  const applyPcIsolation = useCallback((keys, parts) => {
    if (parts) pcPartsRef.current = parts;
    const r = rendererRef.current;
    if (!r) return;
    if (!keys?.size) {
      r.setMeshSourceFilter(null);
      return;
    }
    const paths = [];
    for (const p of pcPartsRef.current) {
      if (!keys.has(p.key)) continue;
      for (const path of p.paths ?? []) paths.push(path);
    }
    r.setMeshSourceFilter(paths);
  }, []);
  // Effects ACTORS panel can drive the same PC composer as Assets > Characters.
  const [effectActorTab, setEffectActorTab] = useState('pc'); // 'pc' | 'npc'
  const effectActorTabRef = useRef(effectActorTab);
  effectActorTabRef.current = effectActorTab;
  const loadEffectNpc = useCallback((entry) => {
    setEffectActorTab('npc');
    effectActorTabRef.current = 'npc';
    loadNpcEntry({ ...entry, keepCamera: true });
  }, [loadNpcEntry]);
  const loadEffectPc = useCallback((entry) => {
    setEffectActorTab('pc');
    effectActorTabRef.current = 'pc';
    loadNpcEntry({ ...entry, keepCamera: leftViewRef.current === 'effects' });
  }, [loadNpcEntry]);
  const pc = useCharacter({
    enabled: (leftView === 'pc' || leftView === 'effects') && !!settings?.gamePath,
    onLoad: (entry) => {
      if (leftViewRef.current === 'effects') loadEffectPc(entry);
      else loadNpcEntry(entry);
    },
    onError: (msg) => setStatusText(msg),
    onIsolationChange: applyPcIsolation,
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
  // Orbit pose to hand back when cinematic camera is turned off (cinematic
  // forces camera.mode = 'fly' every frame — leaving that stuck breaks orbit).
  const crOrbitSnapRef = useRef(null);
  const setCrCameraOn = useCallback((on) => {
    crCameraOnRef.current = on;
    setCrCameraOnState(on);
    const r = rendererRef.current;
    if (!r) return;
    const cam = r.camera;
    if (on) {
      // Capture the user's orbit framing before the track takes over.
      crOrbitSnapRef.current = cam.snapshot();
      r.creationCamera = crCameraTrackRef.current;
      return;
    }
    r.creationCamera = null;
    cam.fovDegrees = fovRef.current;
    // Always return to orbit — creation is an orbit view; fly mode would make
    // drag update lookDir while eye stays frozen at the last cinematic shot.
    if (wasdRef.current) {
      setWasd(false); // setWasd(false) → setMode('orbit')
    } else {
      cam.setMode('orbit');
    }
    const snap = crOrbitSnapRef.current;
    if (snap) {
      cam.restore({ ...snap, mode: 'orbit' });
    } else if (r.creationDriver) {
      const seq = r.creationDriver.sequenceBounds();
      if (seq) cam.fit(seq.min, seq.max);
      else r.fitCamera();
    } else {
      r.fitCamera();
    }
    crOrbitSnapRef.current = null;
  }, [setWasd]);
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
      const headVar = desc.headVariant ?? 0;
      let modelKey = [bodyMeshRel, bodyMatRel, desc.headMesh, desc.headMat, desc.headY, headVar].join('|');
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
            {
              mesh: headMesh, mat: headMat, isBody: false,
              offsetY: desc.headY, variantIndex: headVar,
            },
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

      // Matched body/head motion pair. Prefer the Equipment body the user
      // chose; only fall back to altBody when channels truly cannot pair
      // (should be rare after equip↔clip pairing in CreationList).
      let driver = null;
      let motions = null;
      let usedAlt = false;
      if (desc.motions) {
        if (showOverlay) stepLoad('Reading motion…');
        const [bodyMo, headMo] = await Promise.all([
          readMotion(desc.motions.body).catch(() => null),
          readMotion(desc.motions.head).catch(() => null),
        ]);
        if (!stillCurrent()) { releaseOverlay(); return; }
        motions = { body: bodyMo, head: headMo };
        driver = new CreationAnimator(model, [bodyMo, headMo]);
        if (!driver.compatible && desc.allowAltBody && desc.altBodyMesh) {
          const alt = await buildWith(desc.altBodyMesh, desc.altBodyMat);
          if (!stillCurrent()) { releaseOverlay(); return; }
          const altDriver = new CreationAnimator(alt, [bodyMo, headMo]);
          if (altDriver.compatible) {
            model = alt;
            bodyMeshRel = desc.altBodyMesh;
            bodyMatRel = desc.altBodyMat;
            modelKey = [bodyMeshRel, bodyMatRel, desc.headMesh, desc.headMat, desc.headY, headVar].join('|');
            crModelCacheRef.current = { key: modelKey, model };
            driver = altDriver;
            rebuild = true;
            usedAlt = true;
          }
        }
        if (!driver.compatible) driver = null;
      }

      if (!stillCurrent()) { releaseOverlay(); return; }
      player.stop();
      const renderer = rendererRef.current;
      modelRef.current = model;
      if (renderer.model !== model) renderer.setModel(model, crFramedRef.current);

      let camera = null;
      let cueCount = null;
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
        renderer.playing = settingsRef.current?.autoPlay ?? false;
        setPlayingState(renderer.playing);
        setCrSegments([]);
        setCrSegment(-1);

        // Authored camera track — only the long sequence has one.
        // Auto-enable: most of the retail presentation is camera motion.
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
            if (built && Math.abs(built.frameCount - driver.frameCount) <= 1) camera = built;
          }
          const meta = CREATION_SEQUENCE_META[desc.raceId];
          if (meta?.cue) {
            try {
              const cues = parseCreationCues(await readRel(meta.cue));
              cueCount = cues?.events?.length ?? 0;
            } catch { /* optional */ }
          }
        }
        setCrHasCamera(!!camera);
        crCameraTrackRef.current = camera;
        // Do not auto-drive the cinematic camera — skeleton pose must be
        // judged in orbit view. User can still toggle it on.
        renderer.creationCamera = crCameraOnRef.current ? camera : null;
      } else {
        renderer.creationDriver = null;
        renderer.setAnimation(null);
        restoreCreationBind(renderer);
        renderer.playing = false;
        setPlayingState(false);
        setCrSegments([]);
        setCrSegment(-1);
        crFramedRef.current = true;
        setCrHasCamera(false);
        crCameraTrackRef.current = null;
        renderer.creationCamera = null;
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

      {
        const absOf = (rel) => `${settings.gamePath}\\${normRel(rel)}`;
        const src = [];
        const seen = new Set();
        const push = (id, label, rel) => {
          if (!rel) return;
          const k = normRel(rel).toLowerCase();
          if (seen.has(k)) return;
          seen.add(k);
          src.push({ id, label, path: absOf(rel) });
        };
        push('bodyMesh', 'Body mesh', bodyMeshRel);
        push('bodyMat', 'Body material', bodyMatRel);
        push('headMesh', 'Head mesh', desc.headMesh);
        push('headMat', 'Head material', desc.headMat);
        if (desc.motions) {
          push('motionBody', 'Motion (body)', desc.motions.body);
          push('motionHead', 'Motion (head)', desc.motions.head);
        }
        const raceDef = CREATION_RACES.find((r) => r.id === desc.raceId);
        if (raceDef?.cameras) {
          raceDef.cameras.forEach((pair, i) => {
            push(`cam${i}fov`, `Camera ${i + 1} FOV`, pair[0]);
            push(`cam${i}mat`, `Camera ${i + 1} matrix`, pair[1]);
          });
        }
        const meta = CREATION_SEQUENCE_META[desc.raceId];
        if (meta?.cue) push('cue', 'Sequence cues', meta.cue);
        if (meta?.actions) push('actions', 'Action table', meta.actions);
        setDataSources(src);
      }

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
          repaired: driver?.repairedFrames ?? 0,
          cues: cueCount,
          leadIn: 0,
        } : null,
      });
      releaseOverlay();
      const mismatch = desc.motions && !driver
        ? ` — motion channels (${motions?.body?.channelCount ?? '?'}/${motions?.head?.channelCount ?? '?'})`
          + ` don't match the skeleton pair (${cr.channelSums.join('/')}); showing bind pose`
        : '';
      setStatusText(driver
        ? `${desc.name} — ${driver.frameCount.toLocaleString()} frames, ${driver.duration.toFixed(1)}s`
          + (desc.anim === 'seq' && camera ? ' · camera on' : '')
          + (cueCount != null ? ` · ${cueCount} cues` : '')
          + (usedAlt ? ' · body swapped to match clip skeleton' : '')
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

  // --- zone preview launch -------------------------------------------------

  // Why the launch zone couldn't be opened (minimal mode has no status bar to
  // say it in).
  const [launchError, setLaunchError] = useState('');
  // --weather / --time / --clock, applied once the zone's environment is up.
  const pendingLaunchSceneRef = useRef(null);

  /**
   * Open the zone named on the launch line: a DAT path (game-relative,
   * `game/ROM/…`, or absolute) or a zone id. Called on startup, and again after
   * the game path is filled in — a preview launch on a fresh install should
   * still land on its zone rather than the demo model.
   */
  const openLaunchZone = useCallback(async () => {
    const opts = launchRef.current;
    if (!opts?.zone) return false;
    const raw = String(opts.zone).trim();
    let zones = [];
    try { zones = await (await fetch('lists/zones.json')).json(); } catch { /* baked list unavailable */ }

    let zone;
    if (/^\d+$/.test(raw)) {
      const hit = zones.find((z) => z.id === Number(raw));
      if (!hit) {
        setLaunchError(`No zone with id ${raw}.`);
        setStatusText(`Zone id ${raw} not found.`);
        return false;
      }
      zone = { id: hit.id, name: hit.name, path: hit.path };
    } else {
      const s = settingsRef.current;
      const rel = launchZoneRel(raw, [s?.pivotPath, s?.hdPath, s?.gamePath]);
      // Prefer the baked entry: it carries the zone name and the id the BGM
      // lookup needs. An unlisted DAT (a prototype zone) still opens by path.
      const hit = zones.find((z) => zoneDatRelPath(z.path).toLowerCase() === rel.toLowerCase());
      zone = hit
        ? { id: hit.id, name: hit.name, path: hit.path }
        : { id: null, name: rel, path: `game/${rel.replace(/\\/g, '/')}` };
    }

    setLaunchError('');
    pendingLaunchSceneRef.current = (opts.weather || opts.timeMinutes != null || opts.clock)
      ? { weather: opts.weather, timeMinutes: opts.timeMinutes, clock: opts.clock }
      : null;
    // A preview is a side trip — don't overwrite the session's last-opened DAT.
    const result = await loadZone(zone, { remember: !opts.minimal });
    if (result?.ok === false) {
      pendingLaunchSceneRef.current = null;
      setLaunchError(`Could not open ${zone.name} — ${result.reason}.`);
      return false;
    }
    // The window is the preview of one zone; name it so in the taskbar.
    if (opts.minimal) document.title = `${zone.name} — XI Model Viewer`;
    if (settingsRef.current?.autoWasdZones !== false) setWasd(true);
    return true;
  }, [loadZone, setWasd]);

  // Prefetch AppData notes so the status-bar Notes badge is accurate.
  useEffect(() => {
    loadNotes().then(() => setDatNotesTick((n) => n + 1)).catch(() => {});
  }, []);

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

        // Launched as a zone preview — that zone is the whole session; the
        // last-opened DAT and the restored page have no say in it.
        if (launchRef.current?.zone) {
          await openLaunchZone();
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
        if (restoredView === 'music' || restoredView === 'sfx') return;
        // Effects: replay the last spell/ability (empty stage) so reload lands
        // on a live preview, not a blank origin with upside-down helpers.
        if (restoredView === 'effects') {
          setWasd(false);
          try {
            const last = JSON.parse(localStorage.getItem(LAST_EFFECT_KEY) || 'null');
            if (last?.path) {
              await loadEffect({
                name: last.name || last.path,
                path: last.path,
                cat: last.cat ?? undefined,
              });
              return;
            }
          } catch { /* stale/corrupt — fall through to framed empty stage */ }
          rendererRef.current?.frameEffect?.();
          return;
        }

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
  // loadImage is declared below this effect; the async body closes over it safely,
  // but listing it in deps would hit the temporal dead zone on first render.
  }, [loadModel, loadZone, loadEffect, setWasd, openLaunchZone]);

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

  const openTexture = useCallback((tex, opts = {}) => {
    const initialPos = opts.initialPos || null;
    setTexWindows((prev) => {
      const i = prev.findIndex((w) => w.tex.name === tex.name);
      if (i >= 0) {
        const next = prev.slice();
        const [w] = next.splice(i, 1);
        next.push(initialPos ? { ...w, initialPos } : w);
        raiseModal(`tex:${w.id}`);
        return next;
      }
      const id = ++texIdRef.current;
      raiseModal(`tex:${id}`);
      return [...prev, { id, tex, cascade: id - 1, initialPos }];
    });
  }, [raiseModal]);

  const closeTexture = useCallback((id) => {
    setTexWindows((prev) => prev.filter((w) => w.id !== id));
  }, []);

  const focusTexture = useCallback((id) => {
    raiseModal(`tex:${id}`);
    setTexWindows((prev) => {
      const i = prev.findIndex((w) => w.id === id);
      if (i < 0 || i === prev.length - 1) return prev;
      const next = prev.slice();
      const [w] = next.splice(i, 1);
      next.push(w);
      return next;
    });
  }, [raiseModal]);

  // Escape closes the topmost overlay (modals → skeleton/tex windows).
  // Data Struct is handled later (after its state is declared).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (exportSpec) { setExportSpec(null); e.preventDefault(); return; }
      if (settingsOpen) { setSettingsOpen(false); e.preventDefault(); return; }
      if (helpOpen) { setHelpOpen(false); e.preventDefault(); return; }
      if (datNotesOpen) { setDatNotesOpen(false); e.preventDefault(); return; }
      if (fxPreview) {
        closeFxPreview();
        e.preventDefault();
        return;
      }
      if (dataTableWindows.length > 0) {
        setDataTableWindows((prev) => prev.slice(0, -1));
        e.preventDefault();
        return;
      }
      if (uiEgWindows.length > 0) {
        setUiEgWindows((prev) => prev.slice(0, -1));
        e.preventDefault();
        return;
      }
      if (uiMenuWindows.length > 0) {
        setUiMenuWindows((prev) => prev.slice(0, -1));
        e.preventDefault();
        return;
      }
      if (routeWindows.length > 0) {
        setRouteWindows((prev) => prev.slice(0, -1));
        e.preventDefault();
        return;
      }
      if (zdefWindows.length > 0) {
        setZdefWindows((prev) => prev.slice(0, -1));
        e.preventDefault();
        return;
      }
      if (skelWindows.length > 0) {
        setSkelWindows((prev) => prev.slice(0, -1));
        e.preventDefault();
        return;
      }
      if (texWindows.length > 0) {
        setTexWindows((prev) => prev.slice(0, -1));
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exportSpec, settingsOpen, helpOpen, datNotesOpen, texWindows.length, skelWindows.length, zdefWindows.length, routeWindows.length, uiMenuWindows.length, uiEgWindows.length, dataTableWindows.length, fxPreview, closeFxPreview]);

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

  // Character Creation playback. Pose auto-splits removed — they were quiet
  // holds, not real poses. Sequence skips its own lead-in hold in the driver.
  const creationAnim = {
    anims: CREATION_CLIPS.map((c) => ({ id: c.id, label: c.label, clip: {} })),
    currentAnim: cr.anim,
    onAnimChange: (id) => {
      setCrSegment(-1);
      const driver = rendererRef.current?.creationDriver;
      if (driver && id === cr.anim) {
        // Reselect same clip → full authored window (incl. lead-in skip).
        rendererRef.current.setAnimation(driver.clip);
        rendererRef.current.playing = true;
        setPlayingState(true);
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
    transport: effectTransport,
    onPlay: playEffect,
    onPause: pauseEffect,
    onStop: stopEffect,
    loop: effectLoop,
    onLoop: setEffectLoop,
    charAnim: showCharAnim,
    onCharAnim: setShowCharAnim,
    // Only meaningful when an effect is playing on a loaded PC/NPC.
    charAnimEnabled: !!modelInfo?.effect?.onActor,
    attachFx,
    onAttachFx: setAttachFx,
    attachFxEnabled: !!modelInfo?.effect?.onActor,
    speed: effectSpeed,
    onSpeed: setEffectSpeed,
    onSeek: restartEffect,
    volume: effectVolume,
    onVolume: setEffectVolume,
  };

  /**
   * Show a DAT in the OS file manager (Windows Explorer), selected.
   * Accepts absolute paths or game-relative paths (ROM\…\n.DAT).
   * Resolves through HD/game candidates so the file that actually exists is opened.
   */
  const revealInExplorer = useCallback(async (pathOrRel) => {
    const settings = settingsRef.current;
    // Prefer the displayed model path (relative ROM\…) + game root — selectedDat
    // can be a stale lowercased abs from a previous load.
    const raw = pathOrRel
      || shownPathRef.current
      || modelPath
      || selectedDat
      || null;
    if (!raw) {
      setStatusText('Nothing to show in Explorer.');
      return;
    }
    let abs = String(raw).replace(/\//g, '\\').trim();
    // Strip a leading "game\" leftover from zone-style paths.
    abs = abs.replace(/^game\\/i, '');
    const isAbs = /^[a-zA-Z]:[\\/]/.test(abs) || abs.startsWith('\\\\');
    try {
      if (!isAbs) {
        if (!settings?.gamePath) {
          setStatusText('Game path not set — open Settings first.');
          return;
        }
        const rel = abs.replace(/^\\+/, '');
        const cands = gameCandidates(rel, settings);
        if (!cands.length) {
          setStatusText('Game path not set — open Settings first.');
          return;
        }
        abs = await backend.resolvePrefer(cands);
      } else if (settings?.gamePath || settings?.hdPath) {
        // Prefer an existing HD twin when the abs path is under game/HD root.
        const rel = relFromAbs(abs, settings);
        if (rel && rel.toLowerCase() !== abs.toLowerCase()) {
          try {
            abs = await backend.resolvePrefer(gameCandidates(rel, settings));
          } catch { /* keep original abs */ }
        }
      }
      await backend.revealPath(abs);
    } catch (err) {
      setStatusText(`Could not show in Explorer: ${err.message ?? err}`);
    }
  }, [selectedDat, modelPath]);

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

  const changeFloorTileScale = useCallback((v) => {
    const s = Math.min(4, Math.max(0.25, Number(v) || 1));
    setFloorTileScaleState(s);
    try { localStorage.setItem('floorTileScale', String(s)); } catch { /* quota */ }
    rendererRef.current?.setFloorTileScale(s);
  }, []);

  const setBg = useCallback((hex) => {
    rendererRef.current.setClearColor(hex);
    rendererRef.current.setFog({ color: hex });   // fade toward the background
    localStorage.setItem('bgColor', hex);
    setSettings((s) => (s ? { ...s, bgColor: hex } : s));
  }, []);

  // Scene > Background Image — store bare filename or 'none'.
  const [bgImage, setBgImageState] = useState(() => (
    normalizeBgId(localStorage.getItem('bgImage') || 'none')
  ));
  const setBgImage = useCallback((id) => {
    const next = normalizeBgId(id);
    setBgImageState(next);
    try {
      if (next !== 'none') localStorage.setItem('bgImage', next);
      else localStorage.removeItem('bgImage');
    } catch { /* quota */ }
    const url = resolveBgUrl(next);
    rendererRef.current?.setBackgroundImage(url || null);
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
  const [imageSprite, setImageSprite] = useState(null);

  // ── DAT structure inspector (DAT Browser page + status-bar overlay) ───────
  const [dataDoc, setDataDoc] = useState(null);         // inspectDat result + path
  // Status-bar overlay: peek structure without leaving the live zone/model/etc.
  const [dataStructOpen, setDataStructOpenState] = useState(false);
  const setDataStructOpen = useCallback((v) => {
    const next = typeof v === 'function' ? v(dataStructOpenRef.current) : !!v;
    dataStructOpenRef.current = next;
    setDataStructOpenState(next);
  }, []);
  // loadZone (declared earlier) reloads structure via this when a zone changes.
  const dataStructReloadRef = useRef(null);
  // Multi-DAT context (PC gear parts, creation body/head/motion, multi-file loads).
  const [dataSources, setDataSources] = useState([]);   // [{ id, label, path }]
  const dataSourcesRef = useRef([]);                    // sync for loadFromTree / Open in 3D
  dataSourcesRef.current = dataSources;
  const dataStructStatusRef = useRef('');               // status text to restore on close
  const dataTokenRef = useRef(0);                       // drop stale reads
  const dataBufRef = useRef(null);                      // raw buffer, for texture decode on click
  const dataTexturesRef = useRef(null);                 // lazy parseDatTextures cache
  const dataTablesRef = useRef(null);                   // merged FTABLE maps (zone DAT cross-refs)
  /** Composer race id when opening gear from FTABLE (HumeM, …) — beats binary sniff. */
  const gearRaceHintRef = useRef(null);

  /**
   * @param {string} path
   * @param {{ notice?: string, overlay?: boolean }} [opts]
   *   overlay — don't rewrite modelPath / selection (status-bar toggle)
   */
  const loadDatData = useCallback(async (path, opts = {}) => {
    const token = ++dataTokenRef.current;
    const settings = settingsRef.current;
    const rel = relativeName(path);
    if (!opts.overlay) setStatusText(`Reading ${rel}…`);
    // Highlight immediately so the tree tracks the click even if parse is slow.
    if (!opts.overlay) setSelectedDat(String(path).toLowerCase().replace(/\//g, '\\'));
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
        dataBufRef.current = buf;
        const bytes = buf instanceof Uint8Array
          ? buf
          : new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer);
        // Zone script companions (dialog/events/npc list) must win over the
        // section walker — dialog tables often look "section-like" and produce
        // truncated-walk warnings instead of the dialog view.
        // Prefer the zone-tab source id (events/dialog/npclist) over sniff so
        // empty companions still open the right view instead of a broken
        // section walk that steals the Zone tab.
        const pathNorm = String(path).replace(/\//g, '\\').toLowerCase();
        const srcHit = (dataSourcesRef.current || []).find(
          (s) => String(s.path || '').replace(/\//g, '\\').toLowerCase() === pathNorm,
        );
        const kindFromTab = (srcHit?.id === 'events' || srcHit?.id === 'dialog' || srcHit?.id === 'npclist')
          ? srcHit.id
          : null;
        let zkind = kindFromTab || sniffZoneDat(bytes);
        // Empty/stub companions fail sniff (0-byte NPC, etc.) — recover kind from
        // FTABLE so the Events/Dialog/NPCs tab still opens instead of a broken
        // section walk that looks like Zone.
        if (!zkind) {
          try {
            const tables = await loadMergedTables(settingsRef.current, dataTablesRef);
            const fid = tables.byPath.get(rel.replace(/\\/g, '/').toUpperCase());
            const hit = fid != null ? zoneForFileId(fid) : null;
            if (hit) zkind = hit.kind;
          } catch { /* tables unavailable */ }
        }
        if (zkind) {
          doc = await buildZoneDatDoc(zkind, bytes, rel, settingsRef.current, dataTablesRef);
          if (token !== dataTokenRef.current) return;
        } else {
          doc = inspectDat(buf, path);
        }
      }
      dataTexturesRef.current = null;

      // Zone mesh or companion script: attach file id + the four-DAT bundle.
      // Never clobber PC/NPC multi-part dataSources when inspecting a gear DAT
      // that merely has an FTABLE file id (that used to wipe Head/Body/… slots).
      let zoneMeta = {};
      try {
        const tables = await loadMergedTables(settings, dataTablesRef);
        let zonesList = [];
        try { zonesList = await (await fetch('lists/zones.json')).json(); } catch { /* ok */ }
        const bundle = buildZoneDatBundle(rel, tables, zonesList);
        if (bundle.zoneId != null) {
          zoneMeta = {
            fileId: bundle.fileId ?? doc.fileId ?? null,
            zoneId: bundle.zoneId,
            zoneName: bundle.zoneName ?? doc.zoneName ?? null,
            zoneDats: bundle.dats,
          };
          // Real zone bundle only — replace the source dropdown with mesh/event/dialog/npc.
          const gp = settings.gamePath;
          if (bundle.dats?.length) {
            setDataSources(bundle.dats.map((d) => ({
              id: d.key,
              label: d.fileId != null ? `${d.label} — ${d.rel} (#${d.fileId})` : `${d.label} — ${d.rel}`,
              path: `${gp}\\${normRel(d.rel)}`,
              fileId: d.fileId,
              rel: d.rel,
            })));
          }
        } else if (doc.fileId == null && bundle.fileId != null) {
          zoneMeta = { fileId: bundle.fileId };
        } else if (doc.fileId == null) {
          const key = rel.replace(/\\/g, '/').toUpperCase();
          const fid = tables.byPath.get(key);
          if (fid != null) zoneMeta = { fileId: fid };
        }
      } catch { /* tables unavailable */ }

      const finalDoc = {
        ...doc,
        ...zoneMeta,
        fileId: zoneMeta.fileId ?? doc.fileId ?? null,
        zoneName: zoneMeta.zoneName ?? doc.zoneName ?? null,
        zoneId: zoneMeta.zoneId ?? doc.zoneId ?? null,
        path: rel,
        fullPath: String(path).replace(/\//g, '\\'),
        notice: opts.notice || null,
      };
      setDataDoc(finalDoc);
      if (!opts.overlay) {
        setSelectedDat(String(path).toLowerCase().replace(/\//g, '\\'));
        setModelPath(rel);
        shownPathRef.current = path;
      }
      const zoneSuffix = finalDoc.zoneName ? ` · ${finalDoc.zoneName}` : '';
      const baseStatus = finalDoc.kind === 'sections' && finalDoc.format === 'creation'
        ? `${finalDoc.formatLabel || 'Creation DAT'} · ${finalDoc.sectionCount.toLocaleString()} entries`
        : finalDoc.kind === 'sections'
        ? `${finalDoc.sectionCount.toLocaleString()} sections · ${finalDoc.dirCount.toLocaleString()} folder${finalDoc.dirCount === 1 ? '' : 's'}`
        : finalDoc.kind === 'ftable'
          ? `${finalDoc.registered.toLocaleString()} of ${finalDoc.capacity.toLocaleString()} file ids registered`
          : finalDoc.kind === 'npclist'
            ? `${finalDoc.npcs.length.toLocaleString()} NPCs${zoneSuffix}`
            : finalDoc.kind === 'events'
              ? `${finalDoc.actors.length.toLocaleString()} actors · ${finalDoc.stats.events.toLocaleString()} events${zoneSuffix}`
              : finalDoc.kind === 'dialog'
                ? `${finalDoc.entries.length.toLocaleString()} dialog lines${zoneSuffix}`
                : finalDoc.kind === 'xistring'
                  ? `${finalDoc.entries.length.toLocaleString()} XISTRING entries`
                  : finalDoc.kind === 'dmsg'
                    ? `${finalDoc.entries.length.toLocaleString()} d_msg entries`
                    : finalDoc.label;
      if (!opts.overlay) {
        setStatusText(opts.notice ? `${rel} — ${opts.notice}` : baseStatus);
      }
    } catch (e) {
      if (token !== dataTokenRef.current) return;
      if (!opts.overlay) {
        setDataDoc(null);
        setStatusText(`Failed to read ${rel}: ${e.message ?? e}`);
      } else {
        setStatusText(`Data struct failed: ${e.message ?? e}`);
      }
    }
  }, []);

  /** Status-bar toggle: structure overlay without unloading the live view. */
  const toggleDataStruct = useCallback(async () => {
    if (dataStructOpen) {
      setDataStructOpen(false);
      // Drop overlay-only docs; keep docs that own the page.
      if (!dataOwnsPage) {
        setDataDoc(null);
        dataBufRef.current = null;
        dataTexturesRef.current = null;
      }
      if (dataStructStatusRef.current !== undefined) {
        setStatusText(dataStructStatusRef.current);
        dataStructStatusRef.current = '';
      }
      return;
    }
    const path = shownPathRef.current
      || dataSources[0]?.path
      || (player.current?.path)
      || selectedDat;
    if (!path) {
      setStatusText('Nothing loaded to inspect.');
      return;
    }
    dataStructStatusRef.current = statusText;
    setStatusText('Loading data structure…');
    await loadDatData(path, { overlay: true });
    setDataStructOpen(true);
    // Restore prior status (zone name, etc.) — structure lives in the overlay.
    setStatusText(dataStructStatusRef.current || '');
  }, [dataStructOpen, dataOwnsPage, selectedDat, statusText, loadDatData, player, dataSources]);

  /** Re-parse floating inspect windows from the current dataBufRef (after reload). */
  const refreshOpenInspectWindows = useCallback(() => {
    const buf = dataBufRef.current;
    if (!buf) return;

    const offsetOf = (w, prefix) => {
      if (w.offset != null && Number.isFinite(w.offset)) return w.offset;
      if (typeof w.key === 'string' && w.key.startsWith(prefix)) {
        const n = Number(w.key.slice(prefix.length));
        return Number.isFinite(n) ? n : null;
      }
      return null;
    };

    setUiMenuWindows((prev) => {
      if (!prev.length) return prev;
      return prev.map((w) => {
        const off = offsetOf(w, 'uimenu:');
        if (off == null) return w;
        try {
          const menu = parseInspectUiMenu(buf, off);
          if (!menu?.frame) return w;
          return {
            ...w,
            offset: off,
            menu,
            title: menu.bareName || menu.name || w.title,
          };
        } catch {
          return w;
        }
      });
    });

    setUiEgWindows((prev) => {
      if (!prev.length) return prev;
      return prev.map((w) => {
        const off = offsetOf(w, 'uieg:');
        if (off == null) return w;
        try {
          const group = parseInspectUiElementGroup(buf, off);
          if (!group) return w;
          return {
            ...w,
            offset: off,
            group,
            title: group.setLabel || group.id || w.title,
          };
        } catch {
          return w;
        }
      });
    });

    setRouteWindows((prev) => {
      if (!prev.length) return prev;
      return prev.map((w) => {
        const off = offsetOf(w, 'route:');
        if (off == null) return w;
        try {
          const route = parseInspectRoute(buf, off);
          if (!route?.keys?.length) return w;
          return { ...w, offset: off, route };
        } catch {
          return w;
        }
      });
    });

    setSkelWindows((prev) => {
      if (!prev.length) return prev;
      return prev.map((w) => {
        // key: `${kind}:${offset}` or live fallback
        let off = w.offset;
        let kind = w.skelKind;
        if (off == null && typeof w.key === 'string') {
          const colon = w.key.indexOf(':');
          if (colon > 0) {
            kind = kind || w.key.slice(0, colon);
            const n = Number(w.key.slice(colon + 1));
            if (Number.isFinite(n)) off = n;
          }
        }
        if (off == null || !kind || kind === 'live') return w;
        try {
          const joints = parseInspectSkeleton(buf, kind, off);
          if (!joints?.length) return w;
          return { ...w, offset: off, skelKind: kind, joints };
        } catch {
          return w;
        }
      });
    });
  }, []);

  dataStructReloadRef.current = (absPath) => {
    if (!absPath || !dataStructOpenRef.current) return;
    loadDatData(absPath, { overlay: true }).then(() => refreshOpenInspectWindows());
  };

  /** Re-read current DAT from disk; keep Data Struct open; refresh inspect modals.
   *  @param {string} [forcePath] optional absolute path (e.g. pivot file just written) */
  const reloadCurrentDat = useCallback(async (forcePath) => {
    const path = (typeof forcePath === 'string' && forcePath)
      || dataDoc?.fullPath
      || shownPathRef.current
      || dataSources[0]?.path
      || (player.current?.path)
      || selectedDat;
    if (!path) {
      setStatusText('Nothing loaded to reload.');
      return;
    }
    const prevStatus = statusText;
    setStatusText(`Reloading ${relativeName(path)}…`);
    try {
      // overlay: true keeps selection/modelPath and does not close Data Struct
      await loadDatData(path, { overlay: true });
      refreshOpenInspectWindows();
      setStatusText(`Reloaded ${relativeName(path)}`);
      // brief status flash then restore zone/etc. hint if Data Struct is overlay
      if (dataStructOpen && prevStatus) {
        window.setTimeout(() => {
          setStatusText((cur) => (cur.startsWith('Reloaded ') ? prevStatus : cur));
        }, 1200);
      }
    } catch (e) {
      setStatusText(`Reload failed: ${e.message ?? e}`);
    }
  }, [
    dataDoc, dataSources, selectedDat, statusText, dataStructOpen,
    loadDatData, refreshOpenInspectWindows, player,
  ]);

  // Escape closes Data Struct after modals/texture windows (see earlier Escape handler).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || !dataStructOpen) return;
      // Let the earlier handler claim Escape first when a modal/window is open.
      if (exportSpec || settingsOpen || helpOpen || datNotesOpen) return;
      if (fxPreview || skelWindows.length || texWindows.length || zdefWindows.length) return;
      if (routeWindows.length || uiMenuWindows.length || uiEgWindows.length || dataTableWindows.length) return;
      toggleDataStruct();
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dataStructOpen, toggleDataStruct, exportSpec, settingsOpen, helpOpen,
    datNotesOpen, skelWindows.length, texWindows.length, zdefWindows.length, routeWindows.length,
    uiMenuWindows.length, uiEgWindows.length, dataTableWindows.length, fxPreview]);

  /** Switch the Data Struct inspector to another DAT in the current multi-file set. */
  const selectDataSource = useCallback(async (path) => {
    if (!path) return;
    await loadDatData(path, {
      overlay: dataStructOpen || !dataOwnsPage,
    });
  }, [loadDatData, dataStructOpen, dataOwnsPage]);

  /**
   * A row in the file-table view names a DAT — jump the inspector to it.
   * @param {string} datRel
   * @param {{ tableRace?: string, races?: string[] }} [meta] gear-table race key(s)
   */
  const openDatFromTable = useCallback((datRel, meta = {}) => {
    const gamePath = settingsRef.current?.gamePath;
    if (!gamePath) return;
    const abs = `${gamePath}\\${datRel.replace(/\//g, '\\')}`;
    // Prefer the race the user browsed (tree) over multi-race shared file ids.
    const tableRace = meta.tableRace || meta.races?.[0] || null;
    gearRaceHintRef.current = tableRace ? composerRaceFromGearTable(tableRace) : null;
    setRevealTarget(abs.toLowerCase());
    loadDatData(abs);
  }, [loadDatData]);

  /** Ensure dataTexturesRef is populated from the current inspect buffer. */
  const ensureDataTextures = useCallback(() => {
    if (!dataTexturesRef.current && dataBufRef.current) {
      try { dataTexturesRef.current = parseDatTextures(dataBufRef.current); }
      catch { dataTexturesRef.current = new Map(); }
    }
    return dataTexturesRef.current;
  }, []);

  /** Data Struct skeleton row → floating bone tree (bind pose). */
  const openDataSkeleton = useCallback((res) => {
    const title = (res?.id && String(res.id).trim()) || res?.name || 'Skeleton';
    const kind = res?.skeletonKind
      || (res?.type === 0x29 || res?.type === 41 ? 'entity' : null)
      || (res?.name === 'Skeleton' ? 'entity' : null);

    let joints = null;
    // 1) Parse from the inspected DAT buffer (preferred — matches the row).
    if (dataBufRef.current && kind && res?.offset != null) {
      try {
        joints = parseInspectSkeleton(dataBufRef.current, kind, res.offset);
      } catch (e) {
        console.warn('parseInspectSkeleton', e);
      }
    }
    // 2) Fallback: live model pose (composed PC may already have this skeleton).
    if (!joints?.length) {
      const live = rendererRef.current?.pose?.skeleton?.joints
        ?? modelRef.current?.skeleton?.joints;
      if (live?.length) joints = live.map((j) => ({
        parent: j.parent, rot: j.rot, trans: j.trans,
      }));
    }
    if (!joints?.length) {
      setStatusText(`Couldn't parse skeleton${dataBufRef.current ? '' : ' (no DAT buffer)'}`);
      return;
    }
    const offset = res?.offset ?? null;
    const key = `${kind || 'live'}:${offset ?? title}`;
    setSkelWindows((prev) => {
      const i = prev.findIndex((w) => w.key === key);
      if (i >= 0) {
        const copy = prev.slice();
        const [hit] = copy.splice(i, 1);
        const next = { ...hit, joints, title, offset, skelKind: kind || hit.skelKind };
        copy.push(next);
        raiseModal(`skel:${next.id}`);
        return copy;
      }
      const id = ++skelIdRef.current;
      raiseModal(`skel:${id}`);
      return [...prev, {
        id, key, joints, title, cascade: prev.length, offset, skelKind: kind,
      }];
    });
  }, [raiseModal]);

  const closeSkeletonWin = useCallback((id) => {
    setSkelWindows((prev) => prev.filter((w) => w.id !== id));
  }, []);

  const focusSkeletonWin = useCallback((id) => {
    raiseModal(`skel:${id}`);
    setSkelWindows((prev) => {
      const i = prev.findIndex((w) => w.id === id);
      if (i < 0 || i === prev.length - 1) return prev;
      const copy = prev.slice();
      const [hit] = copy.splice(i, 1);
      copy.push(hit);
      return copy;
    });
  }, [raiseModal]);

  /** Collect ZoneDef rows from live model / last loadZone cache (sync). */
  const collectZonePlacements = useCallback(() => {
    if (zonePlacementsRef.current?.length) return zonePlacementsRef.current;
    const live = modelRef.current;
    const raw = live?.zonePlacements;
    if (!Array.isArray(raw) || !raw.length) return null;
    return raw
      .filter((p) => !p.kind)
      .map((p, i) => ({
        index: Number.isFinite(p.index) && p.index >= 0 ? p.index : i,
        meshId: p.meshId || p.mesh || p.name || '',
        subAreaId: p.subAreaId ?? null,
        pos: p.rawPos || p.pos || [0, 0, 0],
        rot: p.rot || [0, 0, 0],
        scale: p.scale || [1, 1, 1],
      }));
  }, []);

  /** Data Struct 0x06 Route → camera path preview (+ optional scene overlay). */
  const openDataRoute = useCallback((res) => {
    const title = (res?.id && String(res.id).trim()) || 'Route';
    if (!dataBufRef.current || res?.offset == null) {
      setStatusText("Couldn't parse route (no DAT buffer)");
      return;
    }
    let route = null;
    try {
      route = parseInspectRoute(dataBufRef.current, res.offset);
    } catch (e) {
      console.warn('parseInspectRoute', e);
    }
    if (!route?.keys?.length) {
      setStatusText(`Couldn't parse route ${title}`);
      return;
    }
    const key = `route:${res.offset}`;
    const offset = res.offset;
    setRouteWindows((prev) => {
      const i = prev.findIndex((w) => w.key === key);
      if (i >= 0) {
        const copy = prev.slice();
        const [hit] = copy.splice(i, 1);
        const next = { ...hit, route, title, offset };
        copy.push(next);
        raiseModal(`route:${next.id}`);
        return copy;
      }
      const id = ++routeIdRef.current;
      raiseModal(`route:${id}`);
      return [...prev, { id, key, title, route, offset }];
    });
  }, [raiseModal]);

  const openDataUiMenu = useCallback((res) => {
    const tag = (res?.id && String(res.id).trim()) || 'UiMenu';
    if (!dataBufRef.current || res?.offset == null) {
      setStatusText("Couldn't parse UiMenu (no DAT buffer)");
      return;
    }
    let menu = null;
    try {
      menu = parseInspectUiMenu(dataBufRef.current, res.offset);
    } catch (e) {
      console.warn('parseInspectUiMenu', e);
    }
    if (!menu?.frame) {
      setStatusText(`Couldn't parse UiMenu ${tag}`);
      return;
    }
    const title = menu.bareName || menu.name || tag;
    const key = `uimenu:${res.offset}`;
    const offset = res.offset;
    setUiMenuWindows((prev) => {
      const i = prev.findIndex((w) => w.key === key);
      if (i >= 0) {
        const copy = prev.slice();
        const [hit] = copy.splice(i, 1);
        // Re-parse on re-open so values match disk after external edits.
        const next = { ...hit, menu, title, offset };
        copy.push(next);
        raiseModal(`uimenu:${next.id}`);
        return copy;
      }
      const id = ++uiMenuIdRef.current;
      raiseModal(`uimenu:${id}`);
      return [...prev, { id, key, title, menu, offset }];
    });
  }, [raiseModal]);

  const openDataUiElementGroup = useCallback((res) => {
    const tag = (res?.id && String(res.id).trim()) || 'UiElementGroup';
    if (!dataBufRef.current || res?.offset == null) {
      setStatusText("Couldn't parse UiElementGroup (no DAT buffer)");
      return;
    }
    let group = null;
    try {
      group = parseInspectUiElementGroup(dataBufRef.current, res.offset);
    } catch (e) {
      console.warn('parseInspectUiElementGroup', e);
    }
    if (!group) {
      setStatusText(`Couldn't parse UiElementGroup ${tag}`);
      return;
    }
    const title = group.setLabel || group.id || tag;
    const key = `uieg:${res.offset}`;
    const offset = res.offset;
    setUiEgWindows((prev) => {
      const i = prev.findIndex((w) => w.key === key);
      if (i >= 0) {
        const copy = prev.slice();
        const [hit] = copy.splice(i, 1);
        const next = { ...hit, group, title, offset };
        copy.push(next);
        raiseModal(`uieg:${next.id}`);
        return copy;
      }
      const id = ++uiEgIdRef.current;
      raiseModal(`uieg:${id}`);
      return [...prev, { id, key, title, group, offset }];
    });
  }, [raiseModal]);

  const openDataTable = useCallback((res) => {
    const tag = (res?.id && String(res.id).trim()) || res?.name || 'Table';
    if (!dataBufRef.current || res?.offset == null) {
      setStatusText("Couldn't parse table (no DAT buffer)");
      return;
    }
    let table = null;
    try {
      // 0x07 / 0x21 / 0x1F share the table modal.
      if (res?.isEffectRoutine || res?.type === 0x07 || res?.name === 'EffectRoutine') {
        table = parseInspectEffectRoutine(dataBufRef.current, res.offset);
      } else if (res?.isSpriteSheet || res?.type === 0x21 || res?.name === 'SpriteSheetMesh') {
        table = parseInspectSpriteSheet(dataBufRef.current, res.offset);
      } else if (res?.isParticleMesh || res?.type === 0x1F || res?.name === 'ParticleMesh') {
        table = parseInspectParticleMesh(dataBufRef.current, res.offset);
      } else if (res?.isKeyFrame || res?.type === 0x19 || res?.name === 'ParticleKeyFrameData') {
        table = parseInspectKeyFrame(dataBufRef.current, res.offset);
      } else if (res?.isWeightedMesh || res?.type === 0x25 || res?.name === 'WeightedMesh') {
        table = parseInspectWeightedMesh(dataBufRef.current, res.offset);
      }
      if (!table?.rows) table = parseInspectDataTable(dataBufRef.current, res.offset);
    } catch (e) {
      console.warn('parseInspectDataTable', e);
    }
    if (!table?.rows) {
      setStatusText(`Couldn't parse table ${tag}`);
      return;
    }
    const title = `${table.id || tag} · ${table.title || 'Table'}`;
    const key = `dtable:${res.offset}`;
    const offset = res.offset;

    // Sprite / particle mesh + atlas: tile side-by-side so the texture isn't buried.
    let tablePos = null;
    let texPos = null;
    const pairTex = table.kind === 'spriteSheet' || table.kind === 'particleMesh' || table.kind === 'weightedMesh';
    if (pairTex) {
      const vw = window.innerWidth || 1200;
      const vh = window.innerHeight || 800;
      const gap = 14;
      const top = Math.max(56, Math.round(vh * 0.1));
      const tableW = Math.min(560, Math.round(vw * 0.48));
      const texW = 300;
      const total = tableW + gap + texW;
      const left0 = Math.max(16, Math.round((vw - total) / 2));
      tablePos = { x: left0, y: top };
      texPos = { x: left0 + tableW + gap, y: top };
    }

    const pushWin = (tbl) => {
      setDataTableWindows((prev) => {
        const i = prev.findIndex((w) => w.key === key);
        if (i >= 0) {
          const copy = prev.slice();
          const [hit] = copy.splice(i, 1);
          const next = { ...hit, table: tbl, title, offset, initialPos: tablePos };
          copy.push(next);
          raiseModal(`dtable:${next.id}`);
          return copy;
        }
        const id = ++dataTableIdRef.current;
        raiseModal(`dtable:${id}`);
        return [...prev, { id, key, title, table: tbl, offset, initialPos: tablePos }];
      });
    };

    pushWin(table);

    // Sprite / particle mesh → open atlas texture(s) when this DAT has them.
    const texNames = table.kind === 'spriteSheet' || table.kind === 'particleMesh' || table.kind === 'weightedMesh'
      ? (table.textureNames?.length ? table.textureNames : (table.textureName ? [table.textureName] : []))
      : [];
    if (texNames.length) {
      try {
        const map = ensureDataTextures();
        if (map?.size) {
          let slot = 0;
          for (const raw of texNames) {
            const want = String(raw).replace(/\s+/g, '').toLowerCase();
            if (!want) continue;
            let tex = map.get(raw) || null;
            if (!tex) {
              for (const [k, v] of map) {
                const kk = String(k).replace(/\s+/g, '').toLowerCase();
                if (kk === want || kk.includes(want) || want.includes(kk)) { tex = v; break; }
              }
            }
            if (!tex) continue;
            const pos = texPos
              ? { x: texPos.x + slot * 28, y: texPos.y + slot * 28 }
              : null;
            openTexture(tex, { initialPos: pos });
            slot += 1;
            if (slot >= 4) break; // don't flood the desktop
          }
        }
      } catch { /* texture optional */ }
    }

    // SpellList / AbilityList: pull names from d_msg name DATs when game path is set.
    const nameDat = table.nameDat;
    if (nameDat && settingsRef.current?.gamePath) {
      const rel = nameDat.replace(/\//g, '\\');
      backend.readPrefer(gameCandidates(rel, settingsRef.current))
        .then(({ data }) => {
          const dmsg = inspectDmsg(data);
          if (!dmsg) return;
          const enriched = attachDataTableNames(
            { ...table, rows: table.rows.map((r) => ({ ...r })) },
            dmsg,
          );
          enriched.nameDatPath = rel;
          setDataTableWindows((prev) => prev.map((w) => (
            w.key === key ? { ...w, table: enriched } : w
          )));
        })
        .catch((e) => {
          console.warn('name DAT load failed', nameDat, e);
        });
    }
  }, [raiseModal, ensureDataTextures, openTexture]);

  const closeRouteWin = useCallback((id) => {
    setRouteWindows((prev) => prev.filter((w) => w.id !== id));
  }, []);

  const closeUiMenuWin = useCallback((id) => {
    setUiMenuWindows((prev) => prev.filter((w) => w.id !== id));
  }, []);

  const closeUiEgWin = useCallback((id) => {
    setUiEgWindows((prev) => prev.filter((w) => w.id !== id));
  }, []);

  const focusRouteWin = useCallback((id) => {
    raiseModal(`route:${id}`);
    setRouteWindows((prev) => {
      const i = prev.findIndex((w) => w.id === id);
      if (i < 0 || i === prev.length - 1) return prev;
      const copy = prev.slice();
      const [hit] = copy.splice(i, 1);
      copy.push(hit);
      return copy;
    });
  }, [raiseModal]);

  const focusUiMenuWin = useCallback((id) => {
    raiseModal(`uimenu:${id}`);
    setUiMenuWindows((prev) => {
      const i = prev.findIndex((w) => w.id === id);
      if (i < 0 || i === prev.length - 1) return prev;
      const copy = prev.slice();
      const [hit] = copy.splice(i, 1);
      copy.push(hit);
      return copy;
    });
  }, [raiseModal]);

  const focusUiEgWin = useCallback((id) => {
    raiseModal(`uieg:${id}`);
    setUiEgWindows((prev) => {
      const i = prev.findIndex((w) => w.id === id);
      if (i < 0 || i === prev.length - 1) return prev;
      const copy = prev.slice();
      const [hit] = copy.splice(i, 1);
      copy.push(hit);
      return copy;
    });
  }, [raiseModal]);

  /** Data Struct ZoneDef row → floating placements table. */
  const openDataZoneDef = useCallback((res) => {
    const title = (res?.id && String(res.id).trim()) || 'ZoneDef';
    const key = `zdef:${res?.offset ?? title}`;
    const cached = collectZonePlacements();

    // Always open UI on the same tick as the click (texture-modal pattern).
    const pushWin = (partial) => {
      setZdefWindows((prev) => {
        const i = prev.findIndex((w) => w.key === key);
        if (i >= 0) {
          const copy = prev.slice();
          copy[i] = { ...copy[i], ...partial, title };
          const [hit] = copy.splice(i, 1);
          copy.push(hit);
          raiseModal(`zdef:${hit.id}`);
          return copy;
        }
        const id = ++zdefIdRef.current;
        raiseModal(`zdef:${id}`);
        return [...prev, {
          id,
          key,
          title,
          placements: [],
          loading: false,
          error: '',
          cascade: prev.length,
          ...partial,
        }];
      });
    };

    if (cached?.length) {
      pushWin({ placements: cached, loading: false, error: '' });
      setStatusText(`${title} · ${cached.length.toLocaleString()} placements`);
      return;
    }

    pushWin({ placements: [], loading: true, error: '' });
    setStatusText(`Reading ${title} placements…`);

    (async () => {
      try {
        if (!dataBufRef.current) {
          throw new Error('No DAT buffer — reopen Data Struct on the zone mesh DAT');
        }
        const keys = await getKeyTables();
        if (!keys?.table1) throw new Error('FFXiMain.dll keys missing (check game path)');
        const parsed = parseZoneDefAt(dataBufRef.current, res?.offset ?? 0, keys);
        const placements = parsed?.placements ?? [];
        if (!placements.length) throw new Error('No placements in this ZoneDef section');
        zonePlacementsRef.current = placements.map((p, i) => ({
          index: p.index ?? i,
          meshId: p.meshId || '',
          subAreaId: p.subAreaId ?? null,
          pos: p.pos || [0, 0, 0],
          rot: p.rot || [0, 0, 0],
          scale: p.scale || [1, 1, 1],
        }));
        pushWin({ placements: zonePlacementsRef.current, loading: false, error: '' });
        setStatusText(`${title} · ${placements.length.toLocaleString()} placements`);
      } catch (e) {
        console.error('ZoneDef open failed', e);
        const msg = e?.message ?? String(e);
        pushWin({ placements: [], loading: false, error: msg });
        setStatusText(`ZoneDef: ${msg}`);
      }
    })();
  }, [getKeyTables, collectZonePlacements, raiseModal]);

  const closeZdefWin = useCallback((id) => {
    setZdefWindows((prev) => prev.filter((w) => w.id !== id));
  }, []);

  const focusZdefWin = useCallback((id) => {
    raiseModal(`zdef:${id}`);
    setZdefWindows((prev) => {
      const i = prev.findIndex((w) => w.id === id);
      if (i < 0 || i === prev.length - 1) return prev;
      const copy = prev.slice();
      const [hit] = copy.splice(i, 1);
      copy.push(hit);
      return copy;
    });
  }, [raiseModal]);

  // One-shot SFX from Data Struct SoundEffectPointer rows.
  const [playingSoundKey, setPlayingSoundKey] = useState(null);
  const dataSfxRef = useRef(null); // { ctx, source, gain }

  const stopDataSound = useCallback(() => {
    const cur = dataSfxRef.current;
    dataSfxRef.current = null;
    setPlayingSoundKey(null);
    if (!cur) return;
    try { cur.source?.stop(); } catch { /* already stopped */ }
    try { cur.ctx?.close(); } catch { /* ok */ }
  }, []);

  const playDataSound = useCallback(async (res) => {
    const soundId = res?.soundId;
    if (soundId == null) {
      setStatusText(`No sound id on this pointer`);
      return;
    }
    const settings = settingsRef.current;
    if (!settings?.gamePath) {
      setStatusText('Game path not set — open Settings first.');
      return;
    }
    const key = `${res.offset ?? ''}:${soundId}`;
    // Click again on the playing row → stop.
    if (dataSfxRef.current?.key === key || playingSoundKey === key) {
      stopDataSound();
      setStatusText(`se ${soundId} stopped`);
      return;
    }
    // Stop any other one-shot first.
    stopDataSound();

    const rel = soundPath(soundId);
    setPlayingSoundKey(key);
    setStatusText(`Playing se ${soundId}…`);
    try {
      const abs = await backend.resolvePrefer(gameCandidates(rel, settings));
      const buffer = await backend.readFile(abs);
      const header = parseAudioHeader(buffer);
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') await ctx.resume();
      let audioBuffer;
      if (header?.sampleFormat === FMT_ATRAC3) {
        const wav = await backend.decodeVgmstream(abs);
        audioBuffer = await ctx.decodeAudioData(wav);
      } else {
        audioBuffer = toAudioBuffer(ctx, buffer).audioBuffer;
      }
      // Aborted / switched while decoding.
      if (playingSoundKey !== null && dataSfxRef.current?.key && dataSfxRef.current.key !== key) {
        try { ctx.close(); } catch { /* ok */ }
        return;
      }
      const gain = ctx.createGain();
      gain.gain.value = 1;
      gain.connect(ctx.destination);
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gain);
      dataSfxRef.current = { ctx, source, gain, key };
      source.onended = () => {
        if (dataSfxRef.current?.source === source) dataSfxRef.current = null;
        setPlayingSoundKey((k) => (k === key ? null : k));
        try { ctx.close(); } catch { /* ok */ }
      };
      source.start();
      setStatusText(`se ${soundId} · ${audioBuffer.duration.toFixed(2)}s`);
    } catch (e) {
      setPlayingSoundKey(null);
      dataSfxRef.current = null;
      setStatusText(`Couldn't play se ${soundId}: ${e.message ?? e}`);
    }
  }, [playingSoundKey, stopDataSound]);

  /** Decode this DAT's 0x20 textures on first click and open the viewer. */
  const openDataTexture = useCallback((name) => {
    // null/undefined name → open the first texture (Contents census row).
    const map = ensureDataTextures();
    if (!map?.size) {
      setStatusText(`Couldn't decode textures in this DAT`);
      return;
    }
    if (!name) {
      const first = map.values().next().value;
      if (first) openTexture(first);
      if (map.size > 1) {
        setStatusText(`Opened ${first?.name || 'texture'} (1 of ${map.size} — click Structure rows for others)`);
      }
      return;
    }
    let tex = map.get(name);
    if (!tex) {
      // Fuzzy: section id, embedded name, or 8+8 half ("tower_25").
      const n = String(name).replace(/\s+/g, '').toLowerCase();
      for (const [k, v] of map) {
        const kk = String(k).replace(/\s+/g, '').toLowerCase();
        if (kk === n || kk.includes(n) || n.includes(kk)) { tex = v; break; }
      }
    }
    if (tex) openTexture(tex);
    else setStatusText(`Couldn't decode texture ${name}`);
  }, [openTexture, ensureDataTextures]);

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
    setDataSources([]);
    shownPathRef.current = '';
    sourcePathRef.current = '';
    setAnims([]);
    setCurrentAnim('');
    setSchedules([]);
    setCurrentSchedule('');
    setPlayingState(false);
    setObjectGroups(null);
    setEffectGroups(null);
    setSoundGroups(null);
    setPlcOpen(false);
    setPlcSelected('');
    setWeatherList([]);
    setHasCollision(false);
    setHasNavmesh(false);
    setHasSkybox(false);
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

    // DAT Browser can host zone content in-place via browserKind.
    const prevZone = ZONE_VIEWS.has(prev)
      || (prev === 'files' && browserKind === 'zone');
    const nextZone = ZONE_VIEWS.has(leftView)
      || (leftView === 'files' && browserKind === 'zone');
    const prevAudio = AUDIO_VIEWS.has(prev)
      || (prev === 'files' && (browserKind === 'music' || browserKind === 'sfx'));
    const nextAudio = AUDIO_VIEWS.has(leftView)
      || (leftView === 'files' && (browserKind === 'music' || browserKind === 'sfx'));

    // Zones keeps a loaded zone; Effects keeps a PC/NPC; returning NPC/PC from
    // Effects keeps that same actor (no reload) and restores path UI.
    const actor = modelRef.current;
    const isEntity = !!(actor && actor.kind !== 'zone' && actor.isRenderable);
    const keepActorForEffects = leftView === 'effects' && isEntity;
    const keepActorFromEffects = isEntity
      && prev === 'effects'
      && (leftView === 'npc' || leftView === 'pc');
    if (!(prevZone && nextZone) && !keepActorForEffects && !keepActorFromEffects) {
      unloadModel();
    }
    if (!(prevAudio && nextAudio)) player.stop();
    // Leaving the zone views silences the zone outright: the BGM and every
    // ambient/weather voice, including one-shots already in flight. Detaching
    // the particle system alone leaves those playing, which is why zone sound
    // followed you into other pages.
    if (!nextZone) {
      player.stop();
      weatherAudioRef.current?.stopAll();
      setZoneTrack(null);
      zoneMusicIdRef.current = null;
    }
    if (leftView !== 'images' && leftView !== 'files') {
      setImageEntry(null); setImageDoc(null); setImageSet(null); setImageSprite(null);
    }
    if (leftView !== 'files') {
      setDataDoc(null); dataBufRef.current = null; dataTexturesRef.current = null;
    }
    if (leftView !== 'files') setBrowserKind(null);
    setDataStructOpen(false);
    // Re-entering Character Creation frames the model once more; while you are
    // in it, the camera is yours.
    if (leftView !== 'creation') crFramedRef.current = false;
    if (leftView !== 'pc') rendererRef.current?.setMeshSourceFilter(null);
    // Leaving Effects: disarm playback, but keep effectEntry so the list still
    // highlights the last DAT when you return (Character ↔ Effects).
    if ((prev === 'effects' || (prev === 'files' && browserKind === 'effect'))
      && leftView !== 'effects' && leftView !== 'files') {
      effectRoutinesRef.current = [];
      setEffectRoutines([]);
      setEffectSchedule('');
      setEffectTransport('stopped');
      rendererRef.current?.particleSystem?.clearEffect?.();
      weatherAudioRef.current?.stopOneShots?.();
      if (rendererRef.current) {
        rendererRef.current.particleSystem = null;
        rendererRef.current.effectMode = false;
      }
    }
    // Effects → NPC/PC with actor still on stage: put the status bar / selection
    // back on the character DAT (effect load had overwritten them).
    if (keepActorFromEffects) {
      const last = lastEntityRef.current;
      if (last) {
        setModelPath(last.modelPath);
        setSelectedDat(last.selectedPath);
        shownPathRef.current = last.shownPath;
        sourcePathRef.current = last.sourcePath;
        setModelInfo((prev) => {
          if (!prev) return prev;
          const next = { ...prev };
          delete next.effect;
          return next;
        });
        setStatusText(last.name || '');
      }
      lastEntityRef.current = {
        ...(lastEntityRef.current || {}),
        view: leftView,
      };
    }
    // Entering Effects with an actor: clear any leftover particles; list selection stays.
    if (keepActorForEffects && prev !== 'effects') {
      rendererRef.current?.particleSystem?.clearEffect?.();
      weatherAudioRef.current?.stopOneShots?.();
      effectRoutinesRef.current = [];
      setEffectRoutines([]);
      setEffectSchedule('');
      setEffectTransport('stopped');
    }

    // Any Assets > X switch: one F-style camera reset (and force the next load to fit).
    forceCamResetOnViewRef.current = true;
    const r = rendererRef.current;
    if (r) {
      if (!nextZone) {
        setWasd(false);
        r.camera?.setMode?.('orbit');
      }
      if (leftView === 'effects') {
        if (keepActorForEffects && modelRef.current) r.resetCamera();
        else {
          r.effectMode = true;
          r.frameEffect();
        }
      } else if (modelRef.current) {
        focusOrResetCameraRef.current?.();
      } else if (!nextZone && leftView !== 'creation') {
        r.camera?.setRangeFor?.('entity');
      }
    }
  }, [leftView, unloadModel, player, setZoneTrack, browserKind, setWasd]);

  const loadImage = useCallback(async (entry) => {
    const settings = settingsRef.current;
    if (!settings?.gamePath) { setStatusText('Game path not set — open Settings first.'); return; }
    setImageEntry(entry);
    // Remember it so reopening on the Images page restores this image rather
    // than falling through to the default model. Store just {name, path}.
    try { localStorage.setItem(LAST_IMAGE_KEY, JSON.stringify({ name: entry.name, path: entry.path })); } catch { /* quota */ }
    setImageSet(null);
    setImageSprite(null);
    setImageDoc(null);
    // Images are 2D and cover the viewport, so anything still in the scene just
    // shows through. Drop it the way switching to Music does.
    rendererRef.current?.setModel(null);
    modelRef.current = null;
    setModelPath(entry.path);
    setAnims([]);
    setCurrentAnim('');
    try {
      const cands = gameCandidates(entry.path, settings);
      const { path: resolved, data: buf } = await backend.readPrefer(cands);
      const doc = parseImageDat(buf);
      if (doc.kind === 'sets') {
        // Resolve each set's atlas once here so the panel and the viewer agree.
        // Synthetic texture rows already carry .texture from parseImageDat.
        doc.sets = doc.sets.map((s) => (
          s.texture ? s : { ...s, texture: textureForSet(s, doc.textures) }
        ));
      }
      setImageDoc(doc);
      // Prefer a row that actually has pixels in this file (title packs: textures
      // first; menu packs: first set whose atlas resolved).
      const first = doc.kind === 'sets'
        ? (doc.sets.find((s) => s.kind === 'texture' && s.texture)
          ?? doc.sets.find((s) => s.texture)
          ?? doc.sets[0])
        : null;
      setImageSet(first ?? null);
      const nSet = doc.kind === 'sets' ? doc.sets.filter((s) => s.kind !== 'texture').length : 0;
      const nTex = doc.kind === 'sets' ? doc.sets.filter((s) => s.kind === 'texture').length : 0;
      const nSpr = doc.sprites?.length ?? 0;
      const srcTag = (() => {
        const p = String(resolved || '').toLowerCase();
        if (settings.pivotPath && p.startsWith(String(settings.pivotPath).toLowerCase())) return 'pivot';
        if (settings.hdPath && p.startsWith(String(settings.hdPath).toLowerCase())) return 'hd';
        return 'game';
      })();
      const base = doc.kind === 'png' ? 'PNG'
        : doc.titlePack
          ? `title pack · ${nTex} textures · ${nSpr} sprites`
          : `${nSet} image sets${nTex ? ` · ${nTex} textures` : ''}${nSpr ? ` · ${nSpr} sprites` : ''}`;
      setStatusText(`${base} · ${srcTag}`);
    } catch (e) {
      setImageDoc({ kind: 'empty' });
      setStatusText(`Failed to read ${entry.path}: ${e.message ?? e}`);
    }
  }, []);

  /** FTABLE path list for DAT Browser search (once per session / install). */
  const ensureFilePathIndex = useCallback(async () => {
    if (fileIndexRef.current) return fileIndexRef.current;
    try {
      const { byPath } = await loadMergedTables(settingsRef.current, dataTablesRef);
      const paths = [...byPath.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      fileIndexRef.current = paths;
      setFilePathIndex(paths);
      // Type badges ride along: the lists are small and the FTABLE map is
      // already in hand. Failing here must not cost us the path index.
      loadDatTypeLists()
        .then((lists) => setDatTypeOf(() => makeDatTypeLookup(lists, byPath)))
        .catch(() => {});
      return paths;
    } catch (e) {
      console.warn('file path index failed', e);
      fileIndexRef.current = [];
      setFilePathIndex([]);
      return [];
    }
  }, []);

  useEffect(() => {
    if (leftView === 'files') ensureFilePathIndex();
  }, [leftView, ensureFilePathIndex, settings?.gamePath]);

  /**
   * Assets > DAT Browser click: sniff the DAT and open the matching viewer
   * (zone / model / image / music / sfx / effect / data inspector).
   * opts.fromOverlay — Open-in-3D from Data Struct overlay; on failure re-open
   * the overlay instead of hijacking the page into browserKind=data.
   */
  const loadFromTree = useCallback(async (path, opts = {}) => {
    const settings = settingsRef.current;
    if (!settings?.gamePath) { setStatusText('Game path not set — open Settings first.'); return; }
    const rel = relativeName(path);
    const lower = String(path).toLowerCase().replace(/\//g, '\\');
    // Highlight the clicked row immediately (before async load finishes).
    setSelectedDat(lower);
    setRevealTarget(lower);
    setDataStructOpen(false);
    setStatusText(`Reading ${rel}…`);
    try {
      // Always resolve through pivot/HD/game candidates when the path maps to a
      // ROM\… key — re-clicks and pin clicks must not stick to a stale absolute.
      const readAbs = async (abs) => {
        const cands = gameCandidates(abs, settings);
        if (cands.length) {
          const { data } = await backend.readPrefer(cands);
          return data;
        }
        return backend.readFile(abs);
      };
      const buf = await readAbs(path);
      const cls = classifyDat(buf, path);

      const clearImages = () => { setImageEntry(null); setImageDoc(null); setImageSet(null); setImageSprite(null); };
      const clearData = () => {
        setDataDoc(null);
        dataBufRef.current = null;
        dataTexturesRef.current = null;
      };
      const clearEffect = () => {
        effectRoutinesRef.current = [];
        setEffectEntry(null);
        setEffectRoutines([]);
        setEffectSchedule('');
        weatherAudioRef.current?.stopOneShots();
        rendererRef.current?.particleSystem?.clearEffect?.();
      };

      /** Zone/entity parse failed — drop the old scene and show structure + why. */
      const openAsData = async (notice) => {
        if (opts.fromOverlay) {
          await loadDatData(path, { notice, overlay: true });
          setDataStructOpen(true);
          return;
        }
        clearImages();
        clearEffect();
        player.stop();
        unloadModel();
        setBrowserKind('data');
        setDataSources([{ id: lower, label: rel, path: String(path).replace(/\//g, '\\') }]);
        await loadDatData(path, { notice });
      };

      /**
       * Gear DAT with mesh but no skeleton — pair with the race base skeleton.
       * Race resolution order: explicit hint (FTABLE browse) → file_id gear
       * tables → binary section-id sniff (last resort; can false-positive).
       */
      const tryGearWithSkeleton = async (raceHint = null) => {
        // raceHint only from FTABLE browse / Open-in-3D — never a stale leftover.
        let race = raceHint || null;
        if (!race) {
          try {
            const tables = await loadMergedTables(settings, dataTablesRef);
            const key = rel.replace(/\\/g, '/').toUpperCase();
            const fid = tables.byPath.get(key);
            race = composerRaceFromFileId(fid);
          } catch { /* tables unavailable */ }
        }
        if (!race) race = sniffGearRace(buf);
        if (!race) return null;
        const baseRel = RACE_SKELETON_RELS[race];
        if (!baseRel) return null;
        const baseAbs = `${settings.gamePath}\\${normRel(baseRel)}`;
        const raceLabel = RACE_SKELETON_LABELS[race] || race;
        const gearAbs = String(path).replace(/\//g, '\\');
        setStatusText(`Gear for ${raceLabel} — loading skeleton…`);
        try {
          // Full loadModel path: GPU upload, anim lists, details parts.
          const result = await loadModel(
            [baseAbs, gearAbs],
            `${rel} · ${raceLabel}`,
            {
              displayPath: gearAbs,
              parts: [
                {
                  key: 'race', label: 'Race skeleton', itemLabel: raceLabel,
                  paths: [baseAbs],
                },
                {
                  key: 'gear', label: 'Gear', itemLabel: rel,
                  paths: [gearAbs],
                },
              ],
            },
          );
          if (!result || result.ok === false) return null;
          // Race base is usually skeleton-only; if it has skin, hide it so the
          // isolated gear piece is what you inspect.
          rendererRef.current?.setMeshSourceFilter([gearAbs]);
          setStatusText(`${rel} · ${raceLabel} skeleton (gear only)`);
          return { ok: true };
        } catch (err) {
          console.warn('gear+skeleton load failed:', err);
          return null;
        }
      };

      if (cls.kind === 'zone') {
        clearImages();
        clearData();
        clearEffect();
        player.stop();
        // Stay on the current Assets page — switching Data→Files runs the view
        // cleanup effect and would unload the zone we are about to load.
        setBrowserKind('zone');
        setDataDoc(null);
        const slash = rel.replace(/\\/g, '/');
        const zonePath = `game/${slash}`;
        // Prefer the baked zone name when this DAT is a known zone.
        let zone = { id: null, name: rel, path: zonePath };
        try {
          const zones = await (await fetch('lists/zones.json')).json();
          const hit = zones.find((z) => zoneDatRelPath(z.path).toLowerCase() === rel.toLowerCase());
          if (hit) zone = { id: hit.id, name: hit.name, path: hit.path };
        } catch { /* nameless is fine */ }
        const result = await loadZone(zone);
        if (result && result.ok === false) {
          await openAsData(
            `Looks like a zone DAT, but nothing drawable was found (${result.reason}). `
            + 'Showing the file structure instead.',
          );
          setSelectedDat(lower);
          return;
        }
        // Keep tree highlight on the clicked path (not an HD resolve path).
        setSelectedDat(lower);
        setBrowserKind('zone');
        setDataDoc(null);
        if (settingsRef.current?.autoWasdZones !== false) setWasd(true);
        return;
      }

      if (cls.kind === 'entity') {
        clearImages();
        clearData();
        clearEffect();
        player.stop();
        // Models orbit. Dropping fly here rather than leaving it to the
        // ORBIT_VIEWS effect matters: that effect fires on the browserKind
        // commit, which can land after fitCamera() and re-derive the pivot
        // from the fly pose instead of the framing we just computed.
        if (wasdRef.current) setWasd(false);
        setBrowserKind('entity');
        setDataDoc(null);
        const absPath = String(path).replace(/\//g, '\\');
        const prevSources = opts.keepSources ? dataSourcesRef.current.slice() : [];
        if (!opts.keepSources) {
          setDataSources([{ id: lower, label: rel, path: absPath }]);
        }
        const peek = parseEntity(buf, path);
        // Isolated gear: meshes, no skeleton — pair with the race base DAT.
        if (peek.meshGroups.length && !peek.skeleton) {
          const geared = await tryGearWithSkeleton(opts.raceHint ?? null);
          if (geared?.ok) { setSelectedDat(lower); return; }
        }
        // Skeleton-only race DAT while a multi-part set is known — load the set.
        if (peek.skeleton && !peek.meshGroups.length && prevSources.length > 1) {
          const result = await loadModel(prevSources.map((s) => s.path), modelInfo?.name || 'Model');
          if (result && result.ok !== false) {
            setDataSources(prevSources);
            setSelectedDat(lower);
            return;
          }
        }
        const result = await loadModel([path], rel);
        if (result && result.ok === false) {
          // Retry gear pairing even if the first sniff/path failed early.
          if (peek.meshGroups.length && !peek.skeleton) {
            const geared = await tryGearWithSkeleton(opts.raceHint ?? null);
            if (geared?.ok) { setSelectedDat(lower); return; }
          }
          if (prevSources.length > 1) setDataSources(prevSources);
          await openAsData(
            `Looks like a model DAT, but nothing drawable was found (${result.reason}). `
            + 'Showing the file structure instead.',
          );
          setSelectedDat(lower);
          return;
        }
        setSelectedDat(lower);
        return;
      }

      if (cls.kind === 'image') {
        clearData();
        clearEffect();
        player.stop();
        unloadModel();
        setBrowserKind('image');
        await loadImage({ name: rel.split(/[\\/]/).pop() || rel, path: rel });
        setSelectedDat(lower);
        return;
      }

      if (cls.kind === 'music' || cls.kind === 'sfx') {
        clearImages();
        clearData();
        clearEffect();
        unloadModel();
        setBrowserKind(cls.kind);
        const file = rel.split(/[\\/]/).pop() || rel;
        const root = rel.match(/^(sound\d*)\\/i)?.[1] || 'sound';
        setSelectedDat(lower);
        setModelPath(rel);
        shownPathRef.current = path;
        try {
          await player.play({ path, file, root, name: rel, num: '' });
          setStatusText(cls.label);
        } catch (e) {
          await openAsData(`Could not play as ${cls.label}: ${e.message ?? e}`);
          setSelectedDat(lower);
        }
        return;
      }

      if (cls.kind === 'effect') {
        clearImages();
        clearData();
        player.stop();
        unloadModel();
        setBrowserKind('effect');
        await loadEffect({ name: rel, path: rel });
        setSelectedDat(lower);
        return;
      }

      // data / unknown → structure inspector.
      clearImages();
      clearEffect();
      player.stop();
      unloadModel();
      setBrowserKind('data');
      await loadDatData(path, cls.kind === 'unknown'
        ? { notice: 'Not a renderable zone, model, image, audio, or effect DAT. Showing structure.' }
        : undefined);
      setSelectedDat(lower);
    } catch (err) {
      console.error(err);
      try {
        player.stop();
        unloadModel();
        setBrowserKind('data');
        await loadDatData(path, { notice: `Failed to open: ${err.message ?? err}` });
        setSelectedDat(lower);
      } catch {
        setBrowserKind(null);
        setStatusText(`${rel} — failed: ${err.message ?? err}`);
      }
    }
  }, [loadModel, loadZone, loadImage, loadEffect, loadDatData, unloadModel, player, setWasd]);

  // File → Open DAT arrived from another Assets page: open after the switch.
  useEffect(() => {
    if (leftView !== 'files') return;
    const pending = pendingBrowserFileRef.current;
    if (!pending) return;
    pendingBrowserFileRef.current = null;
    loadFromTree(pending);
  }, [leftView, loadFromTree]);

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
    const pivotPath = (draft.pivotPath || '').trim();
    const xiPath = (draft.xiPath || '').trim();
    const prevPath = settingsRef.current?.gamePath ?? '';
    const prevHd = settingsRef.current?.hdPath ?? '';
    const prevPivot = settingsRef.current?.pivotPath ?? '';

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
    if (pivotPath) {
      try {
        await backend.listDir(pivotPath);
      } catch {
        setSettingsError(`Pivot path not found:\n${pivotPath}`);
        return;
      }
    }

    localStorage.setItem('gamePath', gamePath);
    localStorage.setItem('hdPath', hdPath);
    localStorage.setItem('pivotPath', pivotPath);
    localStorage.setItem('bgColor', draft.bgColor);
    localStorage.setItem('autoPlay', draft.autoPlay ? '1' : '0');
    localStorage.setItem('autoWasdZones', draft.autoWasdZones === false ? '0' : '1');
    localStorage.setItem('autoFocusZoneObject', draft.autoFocusZoneObject === false ? '0' : '1');
    localStorage.setItem('closeDatNotesOnSave', draft.closeDatNotesOnSave ? '1' : '0');
    localStorage.setItem('showXiConsole', draft.showXiConsole === false ? '0' : '1');
    localStorage.setItem('autoCloseXiConsole', draft.autoCloseXiConsole ? '1' : '0');
    localStorage.setItem('xiPath', xiPath);
    // Grid/axes live on the toolbar only — don't clobber them from Settings save.
    // Clearing a root forces its toggle off.
    const hdEnabled = hdPath ? !!draft.hdEnabled : false;
    const pivotEnabled = pivotPath ? !!draft.pivotEnabled : false;
    if (!hdPath) localStorage.setItem('hdEnabled', '0');
    if (!pivotPath) localStorage.setItem('pivotEnabled', '0');
    const next = {
      ...draft,
      gamePath,
      hdPath,
      hdEnabled,
      pivotPath,
      pivotEnabled,
      xiPath,
      autoWasdZones: draft.autoWasdZones !== false,
      autoFocusZoneObject: draft.autoFocusZoneObject !== false,
      closeDatNotesOnSave: !!draft.closeDatNotesOnSave,
      showXiConsole: draft.showXiConsole !== false,
      autoCloseXiConsole: !!draft.autoCloseXiConsole,
    };
    setSettings(next);
    settingsRef.current = next;
    setSettingsError('');
    setSettingsOpen(false);

    // Path changed (or first successful set) — load the default model.
    if (gamePath.toLowerCase() !== prevPath.toLowerCase() || !modelRef.current) {
      keyTablesRef.current = null;   // FFXiMain.dll keys are install-specific
      globalEffectsRef.current = null;
      // Preview launch that had nowhere to read from until now: open the zone
      // it was started for, not the demo model.
      if (launchRef.current?.zone) {
        await openLaunchZone();
        return;
      }
      const dat = `${gamePath}\\${DEFAULT_DAT_SUFFIX}`;
      await loadModel([dat], DEFAULT_DAT_SUFFIX);
      setRevealTarget(dat.toLowerCase());
    } else if (
      hdPath.toLowerCase() !== prevHd.toLowerCase()
      || pivotPath.toLowerCase() !== prevPivot.toLowerCase()
    ) {
      // Override roots changed while a model is up — drop cached shared tables.
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
      case 'reload-dat':
        reloadCurrentDat();
        break;
      case 'settings':
        setSettingsError('');
        setSettingsOpen(true);
        break;
      case 'check-updates': {
        setStatusText('Checking for updates…');
        checkForUpdateManual().then((result) => {
          if (result?.upToDate) {
            setUpdate({
              upToDate: true,
              current: result.current,
              latest: result.latest,
            });
            setStatusText(`All up to date (v${result.current || '?'}).`);
            return;
          }
          if (result?.upToDate === false && result.info) {
            setUpdate(result.info);
            setStatusText(`Update available: v${result.info.version}`);
            return;
          }
          setStatusText(result?.message || 'Could not check for updates.');
        });
        break;
      }
      case 'export': {
        const spec = buildExportSpec();
        if (spec) setExportSpec(spec);
        else setStatusText('Nothing to export — load a model or play a track first.');
        break;
      }
      case 'reset-camera':
        focusOrResetCamera();
        break;
      case 'toggle-wasd':
        setWasd(!wasdRef.current);
        break;
      case 'toggle-textures':
        setShowTex((v) => !v);
        break;
      case 'toggle-hd':
      case 'toggle-pivot': {
        const s = settingsRef.current;
        const isPivot = id === 'toggle-pivot';
        if (isPivot ? !s?.pivotPath : !s?.hdPath) break;

        const loaded = modelRef.current;
        const camSnap = rendererRef.current?.camera?.snapshot?.() ?? null;
        if (loaded?.kind === 'zone') persistCurrentZoneCamera();

        // Image viewer keeps no modelRef — recover path from entry / last-image.
        const imagePath = imageEntry?.path
          || (() => {
            try { return JSON.parse(localStorage.getItem(LAST_IMAGE_KEY) || 'null')?.path || ''; }
            catch { return ''; }
          })();

        let rel = '';
        try {
          const last = JSON.parse(localStorage.getItem(LAST_DAT_KEY) || 'null');
          const abs = selectedDat || imagePath || last?.paths?.[last.paths.length - 1]
            || last?.zone?.path || '';
          rel = relFromAbs(abs, s) || '';
          if (!rel && abs) {
            const m = String(abs).replace(/\//g, '\\').match(/(?:^|\\)((?:ROM\d*|sound\d*|maps)\\.+)$/i);
            if (m) rel = m[1];
          }
          if (!rel && imagePath) {
            const m = String(imagePath).replace(/\//g, '\\').match(/(?:^|\\)?((?:ROM\d*|sound\d*|maps)\\.+)$/i);
            if (m) rel = m[1];
            else if (!/^[a-zA-Z]:\\/.test(imagePath)) rel = imagePath;
          }
        } catch { /* ignore */ }

        const next = isPivot
          ? { ...s, pivotEnabled: !s.pivotEnabled }
          : { ...s, hdEnabled: !s.hdEnabled };
        try {
          if (isPivot) localStorage.setItem('pivotEnabled', next.pivotEnabled ? '1' : '0');
          else localStorage.setItem('hdEnabled', next.hdEnabled ? '1' : '0');
        } catch { /* quota */ }
        setSettings(next);
        settingsRef.current = next;
        globalEffectsRef.current = null;
        dataTablesRef.current = null;

        const on = isPivot ? next.pivotEnabled : next.hdEnabled;
        const root = isPivot ? s.pivotPath : s.hdPath;
        if (on && rel && isPivot) {
          const pivotAbs = `${s.pivotPath}\\${normRel(rel)}`;
          const r = normRel(rel);
          backend.fileExists(pivotAbs).then((ok) => {
            setStatusText(ok
              ? `Pivot on — override found for ${r}`
              : `Pivot on — no override for ${r} (falls back)`);
          }).catch(() => setStatusText(`Pivot on — ${s.pivotPath}`));
        } else if (on) {
          setStatusText(isPivot ? `Pivot on — ${root}` : `HD on — ${root}`);
        } else {
          setStatusText(isPivot ? 'Pivot off — HD/game path only' : 'HD off — using game path');
        }

        // Reload whatever is on screen (zone / model / image / data).
        const reloadAsset = async () => {
          try {
            const last = JSON.parse(localStorage.getItem(LAST_DAT_KEY) || 'null');
            if (loaded?.kind === 'zone' && last?.kind === 'zone' && last.zone?.path) {
              await loadZone(last.zone, { keepCamera: true, cameraSnap: camSnap });
              return;
            }
            if (loaded && last?.paths?.length) {
              await loadModel(last.paths, last.name || relativeName(last.paths[last.paths.length - 1]), {
                ...(last.opts ?? {}),
                keepCamera: true,
              });
              return;
            }
            // Image DAT (no modelRef) — force re-read with new candidate order.
            if (imagePath || (browserKind === 'image' && imageEntry)) {
              const img = imageEntry || JSON.parse(localStorage.getItem(LAST_IMAGE_KEY) || 'null');
              if (img?.path) {
                setImageDoc(null); // drop stale pixels immediately
                await loadImage({ name: img.name || relativeName(img.path), path: img.path });
                return;
              }
            }
            // Data Struct inspector buffer
            if (dataBufRef.current && (dataDoc || browserKind === 'data')) {
              const p = dataDoc?.fullPath || selectedDat;
              if (p) await loadDatData(p);
            }
          } catch (e) {
            console.warn(`${isPivot ? 'Pivot' : 'HD'} reload failed`, e);
          }
        };
        reloadAsset();
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
      case 'toggle-region-cull':
        setRegionCull((v) => {
          const next = !v;
          try { localStorage.setItem('regionCull', next ? '1' : '0'); } catch { /* quota */ }
          return next;
        });
        break;
      case 'toggle-axes':
        setShowAxes((v) => {
          const next = !v;
          try { localStorage.setItem('showAxes', next ? '1' : '0'); } catch { /* quota */ }
          return next;
        });
        break;
      case 'toggle-grid':
        setShowGrid((v) => {
          const next = !v;
          try { localStorage.setItem('showGrid', next ? '1' : '0'); } catch { /* quota */ }
          return next;
        });
        break;
      case 'assets-files':
        setLeftView('files');
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
        // Sniff the type and open it the way a click in the tree would.
        backend.pickFile(settingsRef.current?.gamePath || null)
          .then((file) => {
            if (!file) return;
            if (leftView === 'files') {
              loadFromTree(file);
              return;
            }
            // Switch view first so cleanup finishes, then open the file.
            pendingBrowserFileRef.current = file;
            setLeftView('files');
          })
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
    const r = rendererRef.current;
    const cam = r?.camera;
    if (!cam || !min || !max) return;
    if (!wasdRef.current && settingsRef.current?.autoWasdZones !== false) setWasd(true);
    const canvas = r.canvas;
    const aspect = canvas?.clientWidth > 0 && canvas?.clientHeight > 0
      ? canvas.clientWidth / canvas.clientHeight
      : undefined;
    cam.fit(min, max, aspect ? { aspect } : undefined);
    // fit() already reseats fly mode when active
  }, [setWasd]);

  /**
   * F / Reset Camera: with a zone object selected, frame that selection;
   * otherwise frame the whole model/zone (fixed FOV fit — not the old radius×2.4).
   */
  const focusOrResetCamera = useCallback(() => {
    const r = rendererRef.current;
    if (!r) return;
    const model = modelRef.current;
    if (model?.kind === 'zone') {
      const key = plcSelectedRef.current || '';
      const placements = model.zonePlacements || [];
      if (key.startsWith('inst:')) {
        const name = key.slice(5);
        const p = placements.find((x) => x.name === name);
        if (p?.bounds) {
          focusBounds(p.bounds.min, p.bounds.max);
          return;
        }
      } else if (key.startsWith('mesh:')) {
        const mesh = key.slice(5);
        let min = [Infinity, Infinity, Infinity];
        let max = [-Infinity, -Infinity, -Infinity];
        let any = false;
        for (const p of placements) {
          if (p.mesh !== mesh || !p.bounds) continue;
          any = true;
          for (let i = 0; i < 3; i++) {
            if (p.bounds.min[i] < min[i]) min[i] = p.bounds.min[i];
            if (p.bounds.max[i] > max[i]) max[i] = p.bounds.max[i];
          }
        }
        if (any) {
          focusBounds(min, max);
          return;
        }
      }
    }
    r.resetCamera();
  }, [focusBounds]);
  const focusOrResetCameraRef = useRef(focusOrResetCamera);
  focusOrResetCameraRef.current = focusOrResetCamera;

  const focusEffectInstance = useCallback((entry) => {
    if (!entry?.pos) return;
    const [x, y, z] = entry.pos;
    const pad = 4;
    focusBounds([x - pad, y - pad, z - pad], [x + pad, y + pad, z + pad]);
    setStatusText(`${entry.name}${entry.id ? `  [${entry.id}]` : ''}`);
  }, [focusBounds]);

  const focusEffectGroup = useCallback((group) => {
    const list = group?.instances;
    if (!list?.length) return;
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    let any = false;
    for (const p of list) {
      const pos = p.pos;
      if (!pos) continue;
      any = true;
      for (let i = 0; i < 3; i++) {
        if (pos[i] < min[i]) min[i] = pos[i];
        if (pos[i] > max[i]) max[i] = pos[i];
      }
    }
    if (!any) return;
    const pad = 4;
    focusBounds(
      [min[0] - pad, min[1] - pad, min[2] - pad],
      [max[0] + pad, max[1] + pad, max[2] + pad],
    );
  }, [focusBounds]);

  const refreshSoundGroups = useCallback(() => {
    const sys = rendererRef.current?.particleSystem;
    setSoundGroups(sys?.listSoundGroups?.() ?? []);
    setSfxListTick((n) => n + 1);
  }, []);

  const focusSoundInstance = useCallback((entry) => {
    if (!entry?.pos) return;
    const [x, y, z] = entry.pos;
    const pad = Math.max(6, (entry.far || 0) * 0.05, 4);
    focusBounds([x - pad, y - pad, z - pad], [x + pad, y + pad, z + pad]);
    const se = entry.soundId != null ? `se${String(entry.soundId).padStart(6, '0')}` : '';
    setStatusText(`${entry.name}${se ? `  ${se}` : ''}${entry.active === false ? '  (out of range)' : ''}`);
    plcSelectedRef.current = entry.key || '';
    setPlcSelected(entry.key || '');
  }, [focusBounds]);

  const focusSoundGroup = useCallback((group) => {
    const list = group?.instances;
    if (!list?.length) return;
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    let any = false;
    for (const p of list) {
      const pos = p.pos;
      if (!pos) continue;
      any = true;
      for (let i = 0; i < 3; i++) {
        if (pos[i] < min[i]) min[i] = pos[i];
        if (pos[i] > max[i]) max[i] = pos[i];
      }
    }
    if (!any) return;
    const pad = 8;
    focusBounds(
      [min[0] - pad, min[1] - pad, min[2] - pad],
      [max[0] + pad, max[1] + pad, max[2] + pad],
    );
    const se = group.soundId != null ? `se${String(group.soundId).padStart(6, '0')}` : group.name;
    setStatusText(`${se} · ${list.length} source${list.length === 1 ? '' : 's'}`);
    plcSelectedRef.current = `sfxg:${group.soundId ?? group.name}`;
    setPlcSelected(`sfxg:${group.soundId ?? group.name}`);
  }, [focusBounds]);

  const playZoneSfx = useCallback((entry) => {
    const soundId = entry?.soundId;
    if (soundId == null) {
      setStatusText('No sound id on this source');
      return;
    }
    playDataSound({ soundId, offset: entry.key || soundId });
  }, [playDataSound]);

  // Live weather/time for the TOD clock and sequencer (avoid stale closures).
  const todStateRef = useRef({ weather: '', minutes: 12 * 60 });
  todStateRef.current = { weather, minutes: timeMinutes };
  const todUiAtRef = useRef(0);
  const todMusicHourRef = useRef(-1);

  /**
   * Drive EnvironmentManager for weather / time of day.
   *
   * Weather changes: full switchWeather + sky rebuild (3.33s cross-fade).
   * Time-only (sequencer TOD play, day clock, slider): lighting every call so
   * the sun eases smoothly; sky dome rebuilds ~every 30 game-seconds so the
   * gradient keeps up without hitching on a GPU buffer rebuild each frame.
   * React state is throttled during rapid ticks so the App tree doesn't re-
   * render at 60 Hz (the readout still updates ~20×/s).
   */
  const applyWeatherTime = useCallback((w, tm) => {
    const minutes = ((Number(tm) % 1440) + 1440) % 1440;
    const prev = todStateRef.current;
    const weatherChanged = w !== prev.weather;
    todStateRef.current = { weather: w, minutes };

    const now = performance.now();
    if (weatherChanged || now - todUiAtRef.current > 50) {
      todUiAtRef.current = now;
      setWeather(w);
      setTimeMinutes(minutes);
    }

    const env = zoneEnvManagerRef.current;
    const renderer = rendererRef.current;
    if (!renderer) return;
    try {
      if (env) {
        if (minutes !== env.getTimeMinutes()) env.setTimeMinutes(minutes);
        if (weatherChanged) {
          env.switchWeather(w);
          renderer.skyWeather = env.getWeather();
          renderer.setSkyDome(env.getSkyDome());
          renderer._skyBuiltAt = env.clock.currentTimeOfDayInSeconds();
          // Live gens changed; catalog is tree-wide so just refresh hide stamps + UI.
          renderer.particleSystem?.rebuildEffectCatalog?.();
          setEffectGroups(renderer.particleSystem?.listEffectGroups?.() ?? []);
          setVfxHiddenTick((n) => n + 1);
          setSoundGroups(renderer.particleSystem?.listSoundGroups?.() ?? []);
          setSfxListTick((n) => n + 1);
        } else {
          // Smooth sun / ambient every tick; sky colours catch up on a short lag.
          renderer.setTerrainLighting(env.getTerrainLighting());
          const tod = env.clock.currentTimeOfDayInSeconds();
          const built = renderer._skyBuiltAt;
          if (built == null || Math.abs(tod - built) > 30 || env.weatherTransition) {
            renderer.setSkyDome(env.getSkyDome());
            renderer._skyBuiltAt = tod;
          }
        }
        // Day/night BGM flips at 06:00 and 18:00 — only re-resolve on boundary.
        const hour = Math.floor(minutes / 60);
        const night = hour < 6 || hour >= 18;
        const musicHour = night ? 0 : 12;
        if (weatherChanged || musicHour !== todMusicHourRef.current) {
          todMusicHourRef.current = musicHour;
          resolveZoneTrack(zoneMusicIdRef.current, night);
        }
        if (weatherChanged) {
          renderer.setTerrainLighting(env.getTerrainLighting());
        }
        return;
      }
      const envs = zoneEnvsRef.current;
      if (!envs) return;
      const resolved = resolveEnvironment(envs, w, minutes);
      renderer.setTerrainLighting(terrainLightingFromEnv(resolved, minutes));
      if (weatherChanged) {
        renderer.setSkyDome(skyDomeFromEnv(resolved));
        renderer.skyWeather = w;
      }
    } catch (e) { console.warn('weather apply failed', e); }
  }, [resolveZoneTrack]);

  /**
   * Run the game clock: one full FFXI day per TOD_DAY_MS of real time.
   * rAF + light time path so the sun eases like the slider, not 10 Hz jumps.
   */
  useEffect(() => {
    if (!todPlaying) return undefined;
    const TOD_DAY_MS = 60000;
    const perSec = 1440 / (TOD_DAY_MS / 1000);
    let last = performance.now();
    let raf = 0;
    const tick = (now) => {
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      const { weather: w, minutes } = todStateRef.current;
      applyWeatherTime(w, (minutes + perSec * dt) % 1440);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [todPlaying, applyWeatherTime]);

  /**
   * Apply `--weather` / `--time` / `--clock` from the launch line. Deferred to
   * here because the weather has to exist in the zone before it can be
   * switched to, and that list only arrives when the zone has finished loading.
   */
  useEffect(() => {
    const pending = pendingLaunchSceneRef.current;
    if (!pending || !zoneEnvManagerRef.current) return;
    pendingLaunchSceneRef.current = null;
    let w = weather;
    if (pending.weather) {
      if (weatherList.includes(pending.weather)) w = pending.weather;
      else console.warn(`launch: this zone has no '${pending.weather}' weather — keeping ${weather || 'its default'}`);
    }
    applyWeatherTime(w, pending.timeMinutes ?? timeMinutes);
    if (pending.clock) setTodPlaying(true);
  }, [weatherList, weather, timeMinutes, applyWeatherTime]);

  // Leaving the Zones view takes its panel — and the stop button — off screen,
  // so don't leave the clock running where it can't be stopped.
  useEffect(() => {
    if (leftView !== 'zones' && browserKind !== 'zone') {
      setTodPlaying(false);
    }
  }, [leftView, browserKind]);

  /** Highlight Objects row only — no camera move (used by Live Selection). */
  const selectPlacementGroup = useCallback((group) => {
    if (!group?.instances?.length) return;
    const key = `mesh:${group.mesh}`;
    plcSelectedRef.current = key;
    setPlcSelected(key);
    setPlcOpen(true);
    setStatusText(`${group.mesh} · ${group.count} instance${group.count === 1 ? '' : 's'}`);
    syncZonePickHighlight();
  }, [syncZonePickHighlight]);

  const selectPlacementInstance = useCallback((p) => {
    if (!p) return;
    const key = `inst:${p.name}`;
    plcSelectedRef.current = key;
    setPlcSelected(key);
    setPlcOpen(true);
    const pos = (p.rawPos || p.pos || []).map((n) => Number(n).toFixed(1)).join(', ');
    setStatusText(`${p.name}  #${p.index}${pos ? `  (${pos})` : ''}`);
    syncZonePickHighlight();
  }, [syncZonePickHighlight]);

  /** Panel click: select, and frame the camera unless Auto Focus is off. */
  const focusPlacementGroup = useCallback((group) => {
    if (!group?.instances?.length) return;
    selectPlacementGroup(group);
    if (settingsRef.current?.autoFocusZoneObject === false) return;
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (const p of group.instances) {
      const b = p.bounds;
      if (!b) continue;
      for (let i = 0; i < 3; i++) {
        if (b.min[i] < min[i]) min[i] = b.min[i];
        if (b.max[i] > max[i]) max[i] = b.max[i];
      }
    }
    if (Number.isFinite(min[0])) focusBounds(min, max);
  }, [focusBounds, selectPlacementGroup]);

  const focusPlacementInstance = useCallback((p) => {
    if (!p) return;
    selectPlacementInstance(p);
    if (settingsRef.current?.autoFocusZoneObject === false) return;
    if (p.bounds) focusBounds(p.bounds.min, p.bounds.max);
  }, [focusBounds, selectPlacementInstance]);

  // Right-look / camera drag gesture — survives after end so contextmenu can
  // suppress the native menu when release lands on a panel (same fix as xi-zone-editor).
  const camGestureRef = useRef({ active: false, moved: false, btn: -1, pointerId: null });

  const endPointerDrag = useCallback((opts = {}) => {
    const {
      fromCanvasClick = false,
      clientX = 0,
      clientY = 0,
      pointerId = null,
    } = opts;
    const d = drag.current;
    const gest = camGestureRef.current;
    const gizmoDrag = gizmoDragRef.current;

    if (gizmoDrag) {
      endPlacementDrag(gizmoDrag.placement, gizmoDrag.startPose);
      const p = gizmoDrag.placement;
      const pos = (p.pos || []).map((n) => Number(n).toFixed(1)).join(', ');
      setStatusText(`${p.name}  #${p.index}${pos ? `  (${pos})` : ''}`);
      gizmoDragRef.current = null;
      drag.current = { btn: -1, x: 0, y: 0, sx: 0, sy: 0, moved: false, gizmo: false };
      gest.active = false;
      gest.moved = false;
      gest.btn = -1;
      gest.pointerId = null;
      const canvas = canvasRef.current;
      if (canvas && pointerId != null) {
        try { canvas.releasePointerCapture(pointerId); } catch { /* */ }
      }
      if (canvas) {
        canvas.style.cursor = liveSelectionRef.current ? 'crosshair' : '';
      }
      syncZonePickHighlight();
      return;
    }

    // No active camera/gizmo drag — nothing to tear down.
    if (!(d?.btn >= 0) && !gest.active) return;

    const wasClick = fromCanvasClick
      && d?.btn === 0 && !d.moved && !d.gizmo
      && Math.hypot(clientX - (d.sx ?? clientX), clientY - (d.sy ?? clientY)) <= 5;

    drag.current = { btn: -1, x: 0, y: 0, sx: 0, sy: 0, moved: false, gizmo: false };
    // Keep gest.moved until contextmenu so a look-drag can still swallow the menu.
    gest.active = false;
    gest.btn = -1;
    gest.pointerId = null;

    const canvas = canvasRef.current;
    if (canvas && pointerId != null) {
      try { canvas.releasePointerCapture(pointerId); } catch { /* already released */ }
    }

    // Live Selection: genuine canvas click only (not window teardown over UI).
    if (!fromCanvasClick || !liveSelectionRef.current || !wasClick) return;
    if (rendererRef.current?.camera?.sequenceLock) return;
    const model = modelRef.current;
    if (model?.kind !== 'zone') return;
    const hit = pickZoneAt(rendererRef.current, model, clientX, clientY);
    if (hit) {
      selectPlacementInstance(hit);
    } else {
      plcSelectedRef.current = '';
      setPlcSelected('');
      setStatusText('No object under cursor');
      syncZonePickHighlight();
    }
  }, [endPlacementDrag, selectPlacementInstance, syncZonePickHighlight]);

  // Robust camera-drag teardown (ported from xi-zone-editor): releasing RMB over a
  // panel used to open that UI's context menu and never deliver canvas pointerup,
  // leaving orbit/fly stuck. Window capture + blur + lostcapture always end it;
  // contextmenu is swallowed when the gesture was a look-drag.
  useEffect(() => {
    const releaseOverCanvas = (e) => {
      const canvas = canvasRef.current;
      if (!canvas) return false;
      const r = canvas.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX < r.right
        && e.clientY >= r.top && e.clientY < r.bottom;
    };
    const onWinPointerUp = (e) => {
      if (e.button !== 0 && e.button !== 2 && e.button !== 1) return;
      if (!(drag.current?.btn >= 0) && !gizmoDragRef.current && !camGestureRef.current.active) return;
      // Capture-phase so we win even when release is over a panel. Live-pick only
      // if the cursor is still over the viewport (not a UI chrome release).
      endPointerDrag({
        fromCanvasClick: e.button === 0 && releaseOverCanvas(e),
        clientX: e.clientX,
        clientY: e.clientY,
        pointerId: e.pointerId,
      });
    };
    const onWinBlur = () => endPointerDrag();
    const onLostCapture = () => endPointerDrag();
    const onWinContextMenu = (e) => {
      const g = camGestureRef.current;
      const dragging = drag.current?.btn >= 0 || g.active || !!gizmoDragRef.current;
      if (g.moved || dragging) {
        e.preventDefault();
        e.stopPropagation();
      }
      g.moved = false;
      g.active = false;
      endPointerDrag({ pointerId: g.pointerId });
    };
    window.addEventListener('pointerup', onWinPointerUp, true);
    window.addEventListener('pointercancel', onWinPointerUp, true);
    window.addEventListener('blur', onWinBlur);
    window.addEventListener('contextmenu', onWinContextMenu, true);
    const canvas = canvasRef.current;
    canvas?.addEventListener('lostpointercapture', onLostCapture);
    return () => {
      window.removeEventListener('pointerup', onWinPointerUp, true);
      window.removeEventListener('pointercancel', onWinPointerUp, true);
      window.removeEventListener('blur', onWinBlur);
      window.removeEventListener('contextmenu', onWinContextMenu, true);
      canvas?.removeEventListener('lostpointercapture', onLostCapture);
    };
  }, [endPointerDrag]);

  const onPointerDown = (e) => {
    drag.current = {
      btn: e.button, x: e.clientX, y: e.clientY,
      sx: e.clientX, sy: e.clientY, moved: false, gizmo: false,
    };
    camGestureRef.current = {
      active: true,
      moved: false,
      btn: e.button,
      pointerId: e.pointerId,
    };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* */ }

    // Prefer grabbing the XYZ gizmo over camera orbit / live pick.
    if (e.button !== 0) return;
    if (rendererRef.current?.camera?.sequenceLock) return;
    if (modelRef.current?.kind !== 'zone') return;

    const r = rendererRef.current;
    const gz = r?.getZoneGizmo?.();
    if (!gz?.pos) return;

    const axis = pickGizmoAxis(r, gz, e.clientX, e.clientY);
    if (!axis) return;

    // Resolve selected placement (instance preferred; mesh → first instance).
    const key = plcSelectedRef.current;
    const list = modelRef.current.zonePlacements ?? [];
    let placement = null;
    if (key.startsWith('inst:')) {
      placement = list.find((p) => p.name === key.slice(5)) ?? null;
    } else if (key.startsWith('mesh:')) {
      const mesh = key.slice(5);
      placement = list.find((p) => p.mesh === mesh && !p.kind) ?? null;
    }
    if (!placement) return;

    gizmoDragRef.current = {
      axis,
      placement,
      lastX: e.clientX,
      lastY: e.clientY,
      startPose: clonePlacementPose(placement),
    };
    gizmoHoverRef.current = axis;
    r.setGizmoHoverAxis?.(axis);
    drag.current.gizmo = true;
    drag.current.moved = true; // don't treat as object pick / orbit on release
    camGestureRef.current.moved = true;
    beginPlacementDrag(placement);
    setStatusText(`Move ${placement.name} · ${axis.toUpperCase()}-axis`);
    e.preventDefault();
  };
  const onPointerUp = (e) => {
    // Window capture-phase handler usually ends the drag first; this is a
    // fallback if that listener isn't mounted yet. Idempotent once cleared.
    endPointerDrag({
      fromCanvasClick: e.button === 0,
      clientX: e.clientX,
      clientY: e.clientY,
      pointerId: e.pointerId,
    });
  };
  const onPointerMove = (e) => {
    // Gizmo axis drag — screen-projected so mouse direction matches the arrow
    // (FFXI display X is mirrored; ray-t deltas felt inverted left/right).
    const gd = gizmoDragRef.current;
    if (gd) {
      const r = rendererRef.current;
      const gz = r?.getZoneGizmo?.() || { pos: gd.placement.pos };
      const delta = axisDragDelta(r, gz, gd.axis, gd.lastX, gd.lastY, e.clientX, e.clientY);
      gd.lastX = e.clientX;
      gd.lastY = e.clientY;
      if (!delta) return;
      if (Math.abs(delta.dx) + Math.abs(delta.dy) + Math.abs(delta.dz) < 1e-8) return;
      translatePlacementDisplay(gd.placement, delta.dx, delta.dy, delta.dz);
      updatePlacementDragProxy(gd.placement);
      e.preventDefault();
      return;
    }

    const dragging = drag.current.btn >= 0;
    if (dragging) {
      if (rendererRef.current?.camera.sequenceLock) return;
      // Never orbit if this press started on the gizmo.
      if (drag.current.gizmo) return;
      const dx = e.clientX - drag.current.x;
      const dy = e.clientY - drag.current.y;
      drag.current.x = e.clientX;
      drag.current.y = e.clientY;
      if (!drag.current.moved
        && Math.hypot(e.clientX - drag.current.sx, e.clientY - drag.current.sy) > 5) {
        drag.current.moved = true;
        camGestureRef.current.moved = true;
      }
      // Also mark moved while RMB is held even if events arrive via window.
      if ((e.buttons & 2) && (Math.abs(dx) > 0 || Math.abs(dy) > 0)) {
        camGestureRef.current.moved = true;
      }
      const cam = rendererRef.current.camera;
      if (wasdRef.current) {
        if (drag.current.btn === 0 || drag.current.btn === 2) cam.flyLook(dx, dy);
      } else if (drag.current.btn === 0) {
        // Entities/effects: orbit around the model pivot so a pan is preserved
        // (character stays put on screen). Zones keep free tumble about look-at.
        const pivot = rendererRef.current.getOrbitPivot?.() ?? null;
        cam.orbit(dx, dy, pivot);
      } else {
        cam.pan(dx, dy);
      }
      return;
    }

    // Hover: gizmo axis highlight + cursor, then live object pick.
    if (rendererRef.current?.camera?.sequenceLock) return;
    const model = modelRef.current;
    if (model?.kind === 'zone') {
      const r = rendererRef.current;
      const gz = r?.getZoneGizmo?.();
      if (gz) {
        const axis = pickGizmoAxis(r, gz, e.clientX, e.clientY);
        const prevAxis = gizmoHoverRef.current;
        if (axis !== prevAxis) {
          gizmoHoverRef.current = axis;
          r.setGizmoHoverAxis?.(axis);
        }
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.style.cursor = axis
            ? (axis === 'y' ? 'ns-resize' : 'ew-resize')
            : (liveSelectionRef.current ? 'crosshair' : '');
        }
        if (axis) return; // don't thrash object hover while aiming at gizmo
      } else if (gizmoHoverRef.current) {
        gizmoHoverRef.current = null;
      }
    }

    if (!liveSelectionRef.current) return;
    if (model?.kind !== 'zone') return;
    const hit = pickZoneAt(rendererRef.current, model, e.clientX, e.clientY);
    const prev = plcHoverRef.current;
    if ((hit?.name ?? null) === (prev?.name ?? null)) return;
    plcHoverRef.current = hit;
    syncZonePickHighlight();
  };

  // Keep selected wireframe in sync when panel selection changes without pick.
  useEffect(() => {
    plcSelectedRef.current = plcSelected;
    syncZonePickHighlight();
  }, [plcSelected, syncZonePickHighlight]);

  // Clear hover when leaving zone view or turning live selection off; keep gizmo if still selected.
  useEffect(() => {
    if (leftView !== 'zones' && browserKind !== 'zone') {
      plcHoverRef.current = null;
      rendererRef.current?.setZonePickHighlight?.(null);
      return;
    }
    if (!liveSelection) plcHoverRef.current = null;
    syncZonePickHighlight();
  }, [liveSelection, leftView, browserKind, syncZonePickHighlight]);

  // --- render --------------------------------------------------------------

  // The viewport, hoisted so the minimal tree below mounts the same element
  // (and therefore the same GL context) as the full one.
  const viewport = (
    <canvas
      id="canvas"
      ref={canvasRef}
      className={liveSelection && (leftView === 'zones' || browserKind === 'zone') ? 'live-pick' : undefined}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerMove={onPointerMove}
      onPointerLeave={() => {
        if (gizmoHoverRef.current) {
          gizmoHoverRef.current = null;
          rendererRef.current?.setGizmoHoverAxis?.(null);
        }
        if (plcHoverRef.current) {
          plcHoverRef.current = null;
          syncZonePickHighlight();
        }
        if (canvasRef.current) {
          canvasRef.current.style.cursor = liveSelectionRef.current ? 'crosshair' : '';
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
    />
  );

  const zonePanel = (
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
      heading={minimal ? (modelInfo?.name || 'Zone') : 'Zone'}
      objectsOpen={!minimal && !!objectGroups && plcOpen}
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
  );

  // Zone preview (`--zone … --minimal`): the viewport and the Zone panel, and
  // nothing else. Settings still mount — a preview launched before the game
  // path was ever set needs somewhere to set it.
  if (minimal) {
    return (
      <>
        {viewport}
        {modelInfo?.zone && zonePanel}
        {launchError && (
          <div id="launchError" className="panel" role="alert">
            <span className="icon">error</span>
            <span>{launchError}</span>
          </div>
        )}
        <SettingsModal
          open={settingsOpen}
          initial={{
            ...(settings ?? { gamePath: '', hdPath: '', hdEnabled: false, pivotPath: '', pivotEnabled: false, bgColor: DEFAULT_BG, autoPlay: false, autoWasdZones: true, autoFocusZoneObject: true, closeDatNotesOnSave: false, showXiConsole: true, autoCloseXiConsole: false, xiPath: '' }),
            showGrid,
            showAxes,
          }}
          error={settingsError}
          onSave={saveSettings}
          onClose={() => { setSettingsOpen(false); setSettingsError(''); }}
        />
        <LoadingOverlay
          open={!!loading}
          title={loading?.title}
          detail={loading?.detail}
        />
      </>
    );
  }

  return (
    <>
      {viewport}

      <MenuBar
        onAction={handleMenuAction}
        checks={{
          textures: showTex,
          hd: !!settings?.hdEnabled,
          pivot: !!settings?.pivotEnabled,
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
          regionCull,
          effects: showEffects,
          axes: showAxes,
          grid: showGrid,
          noCollision: !hasCollision,
          noRegions: !hasRegions,
          noNavmesh: !hasNavmesh,
          noSkybox: !hasSkybox,
          noHdPath: !settings?.hdPath,
          noPivotPath: !settings?.pivotPath,
        }}
        flySpeed={flySpeed}
        fps={fps}
        fov={fov}
        onFov={setFov}
        sequencerOpen={sequencerOpen}
        bgColor={settings?.bgColor ?? DEFAULT_BG}
        onBgColor={setBg}
        bgImage={bgImage}
        onBgImage={setBgImage}
        onFloor={loadFloor}
        onClearFloor={clearFloor}
        selectedFloor={selectedFloor}
        floorTileScale={floorTileScale}
        onFloorTileScale={changeFloorTileScale}
        shadowsOn={showShadows}
        shadowDistance={shadowDistance}
        onShadowDistance={setShadowDistance}
        renderHeight={renderHeight}
        onRenderHeight={setRenderHeight}
        bufferSize={bufferSize}
        fpsCap={fpsCap}
        onFpsCap={setFpsCap}
        onGraphicsOpenChange={setGraphicsOpen}
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
          roots={[
            settings?.gamePath && { path: settings.gamePath, label: 'FINAL FANTASY XI' },
            settings?.hdPath && { path: settings.hdPath, label: 'HD' },
            settings?.pivotPath && { path: settings.pivotPath, label: 'PIVOT' },
          ].filter(Boolean)}
          selectedPath={selectedDat}
          revealTarget={revealTarget}
          onSelectFile={loadFromTree}
          onError={(msg) => setStatusText(msg)}
          pathIndex={filePathIndex}
          typeOf={datTypeOf}
          settings={settings}
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

      {/* Structure: owned page (empty browser / table / failed open) or overlay. */}
      {(dataStructOpen || dataOwnsPage) && (
        <>
          {dataDoc?.notice && (
            <div className="file-open-banner" role="status">
              <span className="icon">info</span>
              <span className="file-open-banner-text">{dataDoc.notice}</span>
            </div>
          )}
          <DataViewer
            doc={dataDoc}
            sources={dataSources}
            onSelectSource={selectDataSource}
            onOpenTexture={openDataTexture}
            onOpenSkeleton={openDataSkeleton}
            onOpenZoneDef={openDataZoneDef}
            onOpenRoute={openDataRoute}
            onOpenUiMenu={openDataUiMenu}
            onOpenUiElementGroup={openDataUiElementGroup}
            onOpenDataTable={openDataTable}
            onOpenParticle={openDataParticle}
            onPlaySound={playDataSound}
            playingSoundKey={playingSoundKey}
            onRevealPath={revealInExplorer}
            onOpenDat={openDatFromTable}
            onRenderFile={dataDoc?.fullPath ? () => {
              const path = dataDoc.fullPath;
              const fromOverlay = dataStructOpen || !dataOwnsPage;
              setDataStructOpen(false);
              // Composed character/NPC/creation already on screen — just dismiss.
              if (fromOverlay && modelRef.current
                && (leftView === 'pc' || leftView === 'npc' || leftView === 'creation')) {
                setDataDoc(null);
                dataBufRef.current = null;
                dataTexturesRef.current = null;
                return;
              }
              // Multi-DAT set (race + gear + …): load the whole set, not one
              // skeleton-only part that would fail alone and wipe the dropdown.
              const sources = dataSourcesRef.current;
              if (sources.length > 1) {
                setDataDoc(null);
                dataBufRef.current = null;
                dataTexturesRef.current = null;
                const keep = sources.slice();
                loadModel(keep.map((s) => s.path), modelInfo?.name || 'Model').then((r) => {
                  if (r?.ok !== false) setDataSources(keep);
                });
                return;
              }
              if (fromOverlay) {
                setDataDoc(null);
                dataBufRef.current = null;
                dataTexturesRef.current = null;
              }
              loadFromTree(path, {
                fromOverlay,
                keepSources: true,
                raceHint: gearRaceHintRef.current,
              });
            } : undefined}
          />
        </>
      )}

      {!dataStructOpen && (leftView === 'images' || (leftView === 'files' && browserKind === 'image'))
        && imageDoc && (
        <>
          <ImageViewer
            doc={imageDoc}
            set={imageSet}
            sprites={imageDoc.sprites || []}
            highlightSprite={imageSprite}
          />
          <ImageSetPanel
            file={imageEntry}
            sets={imageDoc.kind === 'sets' ? imageDoc.sets : []}
            selected={imageSet}
            onSelect={(s) => { setImageSet(s); setImageSprite(null); }}
            titlePack={!!imageDoc.titlePack}
            spriteCount={imageDoc.sprites?.length || 0}
          />
          {(imageDoc.sprites?.length > 0) && (
            <ImageSpritePanel
              sprites={imageDoc.sprites}
              selectedSet={imageSet}
              selectedSprite={imageSprite}
              onSelect={setImageSprite}
            />
          )}
        </>
      )}

      {/* Stays visible while zone music plays — the play button lives in here,
          so taking the panel over would pull the controls out from under it. */}
      {!dataStructOpen && (leftView === 'zones' || browserKind === 'zone') && zonePanel}

      {!dataStructOpen && objectGroups && plcOpen
        && (leftView === 'zones' || browserKind === 'zone') && (
        <PlacementPanel
          groups={objectGroups}
          selectedKey={plcSelected}
          onSelectGroup={focusPlacementGroup}
          onSelectInstance={focusPlacementInstance}
          onClose={() => setPlcOpen(false)}
          showEnv={showSkybox}
          liveSelection={liveSelection}
          onToggleLiveSelection={toggleLiveSelection}
          isPlacementMoved={isPlacementMoved}
          isPlacementHidden={(p) => !!p?.userHidden}
          hiddenTick={plcHiddenTick}
          onTogglePlacementVisible={togglePlacementVisible}
          onToggleGroupVisible={togglePlacementGroupVisible}
          effectGroups={effectGroups}
          vfxHiddenTick={vfxHiddenTick}
          onToggleEffectVisible={toggleEffectVisible}
          onToggleEffectGroupVisible={toggleEffectGroupVisible}
          onSelectEffect={focusEffectInstance}
          onSelectEffectGroup={focusEffectGroup}
          soundGroups={soundGroups}
          sfxListTick={sfxListTick}
          onRefreshSoundGroups={refreshSoundGroups}
          onSelectSound={focusSoundInstance}
          onSelectSoundGroup={focusSoundGroup}
          onPlaySound={playZoneSfx}
          playingSoundKey={playingSoundKey}
          onResetPlacement={(p) => {
            rememberOriginalPose(p);
            resetPlacementPose(p);
          }}
        />
      )}

      {!dataStructOpen && player.current && leftView !== 'zones' && browserKind !== 'zone' && (
        <MusicPlayer player={player} />
      )}

      {/* Only the views that actually put a model on screen get playback
          controls — Images/Music/SFX have their own right-hand panels.
          Creation is ORBIT but not browserKind==='entity', so list it explicitly. */}
      {/* PC/NPC/Creation own the viewport directly (browserKind is cleared on
          view switch). DAT Browser needs browserKind==='entity'. */}
      {!dataStructOpen && !player.current
        && (leftView === 'pc' || leftView === 'npc' || leftView === 'creation'
          || (ORBIT_VIEWS.has(leftView) && browserKind === 'entity'))
        && (
        <AnimationPanel
          pc={leftView === 'pc' ? pc : null}
          anim={leftView === 'creation' ? creationAnim : animControls}
        />
      )}

      {/* Effects: Options transport + Actors (PC/NPC) stacked on the right. */}
      {!dataStructOpen
        && ((leftView === 'effects') || (leftView === 'files' && browserKind === 'effect'))
        && effectEntry && (
        <div id="effect-stack">
          <AnimationPanel anim={effectAnim} />
          {actorsOpen && (
            <EffectActorsPanel
              tab={effectActorTab}
              onTab={setEffectActorTab}
              pc={pc}
              selectedPath={selectedDat}
              onSelectNpc={loadEffectNpc}
              onClose={() => setActorsOpenPersist(false)}
            />
          )}
        </div>
      )}

      {/* Left floating bar: DAT path + Data Struct toggle */}
      <div id="statusFile" className="panel mono">
        {!player.current && modelPath && selectedDat ? (
            <Tooltip content="Show in Explorer">
              <button
                id="statusPath"
                className="status-path-link"
                onClick={() => revealInExplorer(shownPathRef.current || modelPath || selectedDat)}
              >
                {modelPath}
              </button>
            </Tooltip>
        ) : (
          <span id="statusPath">
            {player.current ? relativeName(player.current.path) : (modelPath || '—')}
          </span>
        )}
        {(modelPath || selectedDat || player.current) && (
          <>
            <span className="status-sep">·</span>
            <button
              type="button"
              className={`status-link status-data-struct${dataStructOpen ? ' on' : ''}`}
              onClick={() => { toggleDataStruct(); }}
            >
              {dataStructOpen ? 'Hide Data Struct' : 'Data Struct'}
            </button>
            {(() => {
              const datPath = dataDoc?.fullPath
                || shownPathRef.current
                || selectedDat
                || player.current?.path
                || '';
              if (!datPath) return null;
              const nKey = datFileKey(datPath, settings);
              void datNotesTick;
              const has = !!(nKey && getNote(nKey));
              return (
                <>
                  <span className="status-sep">·</span>
                  <button
                    type="button"
                    className={`status-link status-dat-notes${datNotesOpen ? ' on' : ''}${has ? ' has-note' : ''}`}
                    onClick={() => {
                      loadNotes().then(() => setDatNotesTick((n) => n + 1));
                      setDatNotesOpen((v) => {
                        const next = !v;
                        if (next) raiseModal('datnotes');
                        return next;
                      });
                    }}
                  >
                    {datNotesOpen ? 'Hide Notes' : 'Notes'}
                  </button>
                </>
              );
            })()}
          </>
        )}
      </div>

      {/* Right floating bar: live status + panel toggles */}
      <div id="status" className="panel mono">
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
              {modelInfo && ORBIT_VIEWS.has(leftView)
                && !(leftView === 'files' && browserKind && browserKind !== 'entity') && (
                <>
                  <span className="status-sep">·</span>
                  <button className="status-link" onClick={() => setSkeletonOpen((v) => !v)}>Skeleton</button>
                </>
              )}
              {((leftView === 'effects') || (leftView === 'files' && browserKind === 'effect'))
                && effectEntry && (
                <>
                  <span className="status-sep">·</span>
                  <button className="status-link" onClick={() => setActorsOpenPersist((v) => !v)}>
                    {actorsOpen ? 'Hide actors' : 'Actors'}
                  </button>
                </>
              )}
              {modelInfo && (DETAIL_VIEWS.has(leftView)
                || (leftView === 'files' && (browserKind === 'zone' || browserKind === 'effect')))
                && !(leftView === 'files' && browserKind && !['entity', 'zone', 'effect'].includes(browserKind)) && (
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
              {ORBIT_VIEWS.has(leftView)
                && !(leftView === 'files' && browserKind && browserKind !== 'entity') && (
                <>
                  <span className="status-sep">·</span>
                  <button className="status-link" onClick={() => setSkeletonOpen((v) => !v)}>Skeleton</button>
                </>
              )}
              {((leftView === 'effects') || (leftView === 'files' && browserKind === 'effect'))
                && effectEntry && (
                <>
                  <span className="status-sep">·</span>
                  <button className="status-link" onClick={() => setActorsOpenPersist((v) => !v)}>
                    {actorsOpen ? 'Hide actors' : 'Actors'}
                  </button>
                </>
              )}
              {(DETAIL_VIEWS.has(leftView)
                || (leftView === 'files' && (browserKind === 'zone' || browserKind === 'effect')))
                && !(leftView === 'files' && browserKind && !['entity', 'zone', 'effect'].includes(browserKind)) && (
                <>
                  <span className="status-sep">·</span>
                  <button className="status-link" onClick={() => setDetailsOpen((v) => !v)}>Details</button>
                </>
              )}
            </>
          ) : ''}
        </span>
      </div>

      {skeletonOpen && !player.current && ORBIT_VIEWS.has(leftView)
        && !(leftView === 'files' && browserKind && browserKind !== 'entity') && (
        <SkeletonPanel
          pose={rendererRef.current?.pose ?? null}
          onClose={() => setSkeletonOpen(false)}
        />
      )}

      {showShadows && (
        <LightGizmo
          dir={customSunDir || DEFAULT_LIGHT_DIR}
          detailsOpen={detailsOpen && !!modelInfo}
          onChange={(d) => setCustomSunDir(d)}
          onReset={() => setCustomSunDir(null)}
        />
      )}

      {detailsOpen && modelInfo && !player.current
        && (DETAIL_VIEWS.has(leftView) || (leftView === 'files' && (browserKind === 'zone' || browserKind === 'effect')))
        && !(leftView === 'files' && browserKind && !['entity', 'zone', 'effect'].includes(browserKind)) && (
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
          initialPos={w.initialPos || null}
          zIndex={modalZ(`tex:${w.id}`, 210 + i)}
          onClose={() => closeTexture(w.id)}
          onFocus={() => focusTexture(w.id)}
        />
      ))}

      {skelWindows.map((w, i) => (
        <SkeletonModal
          key={w.id}
          joints={w.joints}
          title={w.title}
          cascadeOffset={w.cascade}
          zIndex={modalZ(`skel:${w.id}`, 500 + i)}
          onClose={() => closeSkeletonWin(w.id)}
          onFocus={() => focusSkeletonWin(w.id)}
        />
      ))}

      {zdefWindows.map((w, i) => (
        <ZoneDefModal
          key={w.id}
          placements={w.placements}
          loading={!!w.loading}
          error={w.error || ''}
          title={w.title}
          cascadeOffset={w.cascade}
          zIndex={modalZ(`zdef:${w.id}`, 2000 + i)}
          onClose={() => closeZdefWin(w.id)}
          onFocus={() => focusZdefWin(w.id)}
        />
      ))}

      {routeWindows.map((w, i) => (
        <RouteModal
          key={w.id}
          route={w.route}
          title={w.title}
          zIndex={modalZ(`route:${w.id}`, 2100 + i)}
          onClose={() => closeRouteWin(w.id)}
          onFocus={() => focusRouteWin(w.id)}
        />
      ))}

      {dataTableWindows.map((w, i) => (
        <DataTableModal
          key={w.id}
          table={w.table}
          title={w.title}
          initialPos={w.initialPos || null}
          zIndex={modalZ(`dtable:${w.id}`, 2110 + i)}
          onClose={() => setDataTableWindows((prev) => prev.filter((x) => x.id !== w.id))}
          onFocus={() => raiseModal(`dtable:${w.id}`)}
        />
      ))}

      {uiMenuWindows.map((w, i) => (
        <UiMenuModal
          key={w.id}
          menu={w.menu}
          title={w.title}
          datPath={dataDoc?.fullPath || shownPathRef.current || selectedDat || ''}
          xiPath={settings?.xiPath || ''}
          settings={settings}
          zIndex={modalZ(`uimenu:${w.id}`, 2120 + i)}
          onClose={() => closeUiMenuWin(w.id)}
          onFocus={() => focusUiMenuWin(w.id)}
          onSaved={reloadCurrentDat}
          onCliLog={(log) => {
            if (settingsRef.current?.showXiConsole === false) return;
            setCliOutput(log);
          }}
        />
      ))}

      {settings?.showXiConsole !== false && (
        <CliOutputPanel
          log={cliOutput}
          autoClose={!!settings?.autoCloseXiConsole}
          autoCloseMs={10000}
          onClose={() => setCliOutput(null)}
        />
      )}

      {datNotesOpen && (() => {
        const datPath = dataDoc?.fullPath
          || shownPathRef.current
          || selectedDat
          || player.current?.path
          || '';
        const nKey = datFileKey(datPath, settings);
        if (!nKey) return null;
        const label = relativeName(datPath) || datPath;
        return (
          <DatNotesModal
            noteKey={nKey}
            label={label}
            zIndex={modalZ('datnotes', 2200)}
            closeOnSave={!!settings?.closeDatNotesOnSave}
            onFocus={() => raiseModal('datnotes')}
            onClose={() => {
              setDatNotesOpen(false);
              setDatNotesTick((n) => n + 1);
            }}
          />
        );
      })()}

      {uiEgWindows.map((w, i) => (
        <UiElementGroupModal
          key={w.id}
          group={w.group}
          title={w.title}
          zIndex={modalZ(`uieg:${w.id}`, 2130 + i)}
          onClose={() => closeUiEgWin(w.id)}
          onFocus={() => focusUiEgWin(w.id)}
        />
      ))}

      {fxPreview && (
        <ParticlePreviewModal
          title={fxPreview.title}
          genId={fxPreview.genId}
          system={fxPreview.system}
          textures={fxPreview.textures}
          error={fxPreview.error || ''}
          loading={!!fxPreview.loading}
          zIndex={modalZ('fx', 2010)}
          onFocus={() => raiseModal('fx')}
          onClose={closeFxPreview}
        />
      )}

      <SettingsModal
        open={settingsOpen}
        initial={{
          ...(settings ?? { gamePath: '', hdPath: '', hdEnabled: false, bgColor: DEFAULT_BG, autoPlay: false, autoWasdZones: true, autoFocusZoneObject: true, closeDatNotesOnSave: false, showXiConsole: true, autoCloseXiConsole: false, xiPath: '' }),
          showGrid,
          showAxes,
        }}
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

      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />

      {/* Queued behind the first-launch About panel rather than stacked on it. */}
      <UpdateModal
        open={!!update && !helpOpen}
        info={update}
        onClose={() => {
          // Only remember skip for a real available update, not "up to date".
          if (update?.version && !update.upToDate) dismissUpdate(update.version);
          setUpdate(null);
        }}
      />

      <LoadingOverlay
        open={!!loading}
        title={loading?.title}
        detail={loading?.detail}
      />
    </>
  );
}
