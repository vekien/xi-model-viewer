import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Tooltip } from './Tooltip.jsx';
import { ViewportPanel } from './ViewportPanel.jsx';
import { GraphicsPanel } from './GraphicsPanel.jsx';

const MENUS = [
  {
    label: 'File',
    items: [
      { id: 'open-dat', label: 'Open DAT…', icon: 'file_open' },
      { id: 'reload-dat', label: 'Reload DAT', icon: 'refresh' },
      { id: 'export', label: 'Export', icon: 'download' },
      { id: 'batch-export', label: 'Batch Export…', icon: 'library_add_check' },
      { id: 'database-manager', label: 'Database Manager…', icon: 'database' },
      { id: 'settings', label: 'Settings', icon: 'settings' },
      { sep: true },
      { id: 'check-updates', label: 'Check for Updates…', icon: 'system_update_alt' },
      { id: 'help', label: 'About', icon: 'star' },
    ],
  },
  {
    label: 'View',
    items: [
      { id: 'reset-camera', label: 'Reset Camera', icon: 'recenter' },
      { id: 'toggle-explorer', label: 'Toggle Explorer', icon: 'list_alt', check: 'explorer' },
      { id: 'toggle-wasd', label: 'Toggle WASD', icon: 'keyboard', check: 'wasd' },
      { id: 'toggle-hd', label: 'Toggle HD', icon: 'hd', check: 'hd', disableWhen: 'noHdPath' },
      { id: 'toggle-pivot', label: 'Toggle PIVOT', icon: 'swap_horiz', check: 'pivot', disableWhen: 'noPivotPath' },
      { toolbarSep: true },
      { id: 'toggle-wireframe', label: 'Toggle Wireframe', icon: 'grid_on', check: 'wireframe' },
      { id: 'toggle-skeleton', label: 'Toggle Skeleton', icon: 'accessibility_new', check: 'skeleton' },
      { id: 'toggle-textures', label: 'Toggle Textures', icon: 'texture', check: 'textures' },
      { id: 'toggle-alpha', label: 'Toggle Alpha', icon: 'opacity', check: 'alpha' },
      { id: 'toggle-blend-lequal', label: 'Toggle Blend LEQUAL', icon: 'layers', check: 'blendLequal' },
      { id: 'toggle-unlit', label: 'Toggle Unlit', icon: 'light_mode', check: 'unlit' },
      { id: 'toggle-shadows', label: 'Toggle Shadows', icon: 'wb_shade', check: 'shadows' },
      { id: 'toggle-collision', label: 'Toggle Collision', icon: 'select_all', check: 'collision', disableWhen: 'noCollision' },
      { id: 'toggle-navmesh', label: 'Toggle Navmesh', icon: 'polyline', check: 'navmesh', disableWhen: 'noNavmesh' },
      { id: 'toggle-sound-markers', label: 'Toggle Sound Markers', icon: 'sound_detection_loud_sound', check: 'soundMarkers' },
      { id: 'toggle-skybox', label: 'Toggle Skybox', icon: 'cloud', check: 'skybox', disableWhen: 'noSkybox' },
      { id: 'toggle-region-cull', label: 'Toggle Region Culling', icon: 'visibility_lock', check: 'regionCull', disableWhen: 'noRegions' },
      { id: 'toggle-effects', label: 'Toggle Effects', icon: 'auto_awesome', check: 'effects' },
      { id: 'toggle-axes', label: 'Toggle Axes', icon: 'open_with', check: 'axes' },
      { id: 'toggle-grid', label: 'Toggle Grid', icon: 'grid_4x4', check: 'grid' },
    ],
  },
  {
    label: 'Assets',
    items: [
      { id: 'assets-files', label: 'DAT Browser', icon: 'folder_open' },
      { id: 'assets-database', label: 'Database', icon: 'database' },
      { id: 'assets-characters', label: 'Characters', icon: 'person' },
      { id: 'assets-npcs', label: 'NPCs', icon: 'pets' },
      { id: 'assets-zones', label: 'Zones', icon: 'map' },
      { id: 'assets-effects', label: 'Effects', icon: 'auto_awesome' },
      { id: 'assets-images', label: 'Images', icon: 'image' },
      { id: 'assets-music', label: 'Music', icon: 'music_note' },
      { id: 'assets-sfx', label: 'Sound FX', icon: 'graphic_eq' },
      // Set apart at the bottom: still work in progress (the creation sequence
      // needs its event layer, and per-shape textures are not mapped yet).
      { sep: true },
      { id: 'assets-creation', label: '(WIP) Character Creation', icon: 'person_add' },
    ],
  },
];

/** Quick-toggle strip next to the menus — View checks minus a few menu-only items. */
const TOOLBAR_SKIP = new Set(['toggle-blend-lequal', 'toggle-region-cull']);
const VIEW_TOOLBAR = MENUS.find((m) => m.label === 'View').items
  .filter((i) => i.toolbarSep || (i.check && !TOOLBAR_SKIP.has(i.id)));

/**
 * Classic menubar: click opens; while open, hovering another top-level button
 * switches to it. The dropdown is portaled to <body> with fixed positioning so
 * it always layers above the blurred side panels (which form their own
 * stacking contexts and would otherwise swallow it).
 */
export function MenuBar({
  onAction, checks = {}, flySpeed = 0, fps = 0, fov = 45, onFov,
  sequencerOpen = false,
  bgColor = '#1a1a24', onBgColor, bgImage = '', onBgImage,
  floorTileScale = 1, onFloorTileScale,
  floorRadius = 42, onFloorRadius,
  floorFadeRadius = 30, onFloorFadeRadius,
  flatFloor = false, onFlatFloor, flatFloorColor = '#8a8a94', onFlatFloorColor,
  onFloor, onClearFloor, selectedFloor = '', zoneLoaded = false,
  shadowsOn = false, shadowDistance = 90, onShadowDistance,
  renderHeight = 0, onRenderHeight, bufferSize = null,
  fpsCap = 0, onFpsCap, onGraphicsOpenChange,
  renderDistance = 5000, onRenderDistance,
  effectDistanceScale = 1, onEffectDistanceScale,
}) {
  const [active, setActive] = useState(null);   // { label, left, top } | null
  const [viewport, setViewport] = useState(null);     // { left, top } | null
  const [graphics, setGraphics] = useState(null); // { left, top } | null
  const barRef = useRef(null);
  const panelRef = useRef(null);
  const viewportRef = useRef(null);
  const gfxRef = useRef(null);

  useEffect(() => {
    if (!active) return;
    const close = (e) => {
      if (barRef.current?.contains(e.target)) return;
      if (panelRef.current?.contains(e.target)) return;
      setActive(null);
    };
    const onKey = (e) => e.key === 'Escape' && setActive(null);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [active]);

  // Shared: Combo options portal to <body>; never treat those clicks as "outside".
  const isComboPortalClick = (t) => !!(
    t?.closest?.(
      '.combo-options, .combo-option, .combo-input, [data-headlessui-portal], [role="listbox"], [role="option"]',
    )
  );

  useEffect(() => {
    if (!viewport) return;
    const close = (e) => {
      if (barRef.current?.contains(e.target)) return;
      if (viewportRef.current?.contains(e.target)) return;
      if (isComboPortalClick(e.target)) return;
      setViewport(null);
    };
    const onKey = (e) => e.key === 'Escape' && setViewport(null);
    // pointerdown bubbles before Listbox selects — use capture:false and skip portals
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [viewport]);

  useEffect(() => {
    if (!graphics) return;
    const close = (e) => {
      if (barRef.current?.contains(e.target)) return;
      if (gfxRef.current?.contains(e.target)) return;
      if (isComboPortalClick(e.target)) return;
      setGraphics(null);
      onGraphicsOpenChange?.(false);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setGraphics(null);
      onGraphicsOpenChange?.(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [graphics, onGraphicsOpenChange]);

  const openMenu = (label, target) => {
    const rect = target.getBoundingClientRect();
    setViewport(null);
    setGraphics(null);
    onGraphicsOpenChange?.(false);
    setActive({ label, left: rect.left, top: rect.bottom + 10 });
  };

  const toggleViewport = (target) => {
    if (viewport) { setViewport(null); return; }
    const rect = target.getBoundingClientRect();
    setActive(null);
    setGraphics(null);
    onGraphicsOpenChange?.(false);
    setViewport({ left: rect.left, top: rect.bottom + 10 });
  };

  const toggleGraphics = (target) => {
    if (graphics) {
      setGraphics(null);
      onGraphicsOpenChange?.(false);
      return;
    }
    const rect = target.getBoundingClientRect();
    setActive(null);
    setViewport(null);
    setGraphics({ left: rect.left, top: rect.bottom + 10 });
    onGraphicsOpenChange?.(true);
  };

  const activate = (id, label) => {
    setActive(null);
    onAction(id, label);
  };

  const activeMenu = active ? MENUS.find((m) => m.label === active.label) : null;

  return (
    <div id="menubar" className="panel" ref={barRef}>
      {MENUS.map((menu) => (
        <button
          key={menu.label}
          className={`menu-btn${active?.label === menu.label ? ' open' : ''}`}
          onClick={(e) => (active?.label === menu.label ? setActive(null) : openMenu(menu.label, e.currentTarget))}
          onMouseEnter={(e) => { if (active && active.label !== menu.label) openMenu(menu.label, e.currentTarget); }}
        >
          {menu.label}
        </button>
      ))}

      <span className="menu-sep" aria-hidden="true" />

      <div className="view-toolbar">
        {VIEW_TOOLBAR.map((item, i) => {
          if (item.toolbarSep || item.sep) {
            return <span key={`sep-${i}`} className="menu-sep" aria-hidden="true" />;
          }
          const disabled = !!(item.disabled || (item.disableWhen && checks[item.disableWhen]));
          const on = !!(item.check && checks[item.check]);
          const tip = item.label.replace(/^Toggle\s+/i, '');
          return (
            <Tooltip key={item.id} content={tip} placement="bottom">
              <button
                type="button"
                className={`view-tool${on ? ' on' : ''}`}
                disabled={disabled}
                aria-label={tip}
                aria-pressed={on}
                onClick={() => !disabled && onAction(item.id, item.label)}
              >
                <span className="icon">{item.icon}</span>
              </button>
            </Tooltip>
          );
        })}
      </div>

      <span className="menu-sep" aria-hidden="true" />

      <div className="cam-group">
        <Tooltip content="Reload DAT — refresh Data Struct and open inspect windows" placement="bottom">
          <button
            type="button"
            className="view-tool"
            aria-label="Reload DAT"
            onClick={() => {
              setActive(null); setViewport(null);
              setGraphics(null); onGraphicsOpenChange?.(false);
              onAction('reload-dat', 'Reload DAT');
            }}
          >
            <span className="icon">refresh</span>
          </button>
        </Tooltip>
        {/* Panel openers, grouped apart from the on/off toggles to their left. */}
        <Tooltip content="Graphics — shadows, resolution, FPS, FOV" placement="bottom">
          <button
            type="button"
            className={`view-tool${graphics ? ' on' : ''}`}
            aria-label="Graphics Settings"
            aria-expanded={!!graphics}
            onClick={(e) => toggleGraphics(e.currentTarget)}
          >
            <span className="icon">display_settings</span>
          </button>
        </Tooltip>
        <Tooltip content="Viewport — background & floor" placement="bottom">
          <button
            type="button"
            className={`view-tool${viewport ? ' on' : ''}`}
            aria-label="Viewport"
            aria-expanded={!!viewport}
            onClick={(e) => toggleViewport(e.currentTarget)}
          >
            <span className="icon">grass</span>
          </button>
        </Tooltip>
        <Tooltip content="Camera Sequencer" placement="bottom">
          <button
            type="button"
            className={`view-tool${sequencerOpen ? ' on' : ''}`}
            aria-label="Camera Sequencer"
            aria-expanded={sequencerOpen}
            onClick={() => {
              setActive(null); setViewport(null);
              setGraphics(null); onGraphicsOpenChange?.(false);
              onAction('camera-sequencer', 'Camera Sequencer');
            }}
          >
            <span className="icon">movie</span>
          </button>
        </Tooltip>
        <Tooltip content="Fly speed — scroll the viewport with WASD on to change" placement="bottom">
          <span className="cam-speed mono">{Math.round(flySpeed)}</span>
        </Tooltip>
        <span className="cam-spacer" aria-hidden="true" />
        <Tooltip content="Frames per second" placement="bottom">
          <span className="cam-fps mono">FPS: {fps > 0 ? fps : '—'}</span>
        </Tooltip>
      </div>

      {viewport &&
        createPortal(
          <div
            className="menu-panel tool-pop"
            ref={viewportRef}
            style={{ position: 'fixed', left: viewport.left, top: viewport.top }}
          >
            <ViewportPanel
              bgColor={bgColor}
              onBg={onBgColor}
              bgImage={bgImage}
              onBgImage={onBgImage}
              onFloor={onFloor}
              onClearFloor={onClearFloor}
              selectedFloor={selectedFloor}
              floorTileScale={floorTileScale}
              onFloorTileScale={onFloorTileScale}
              floorRadius={floorRadius}
              onFloorRadius={onFloorRadius}
              floorFadeRadius={floorFadeRadius}
              onFloorFadeRadius={onFloorFadeRadius}
              flatFloor={flatFloor}
              onFlatFloor={onFlatFloor}
              flatFloorColor={flatFloorColor}
              onFlatFloorColor={onFlatFloorColor}
              zoneLoaded={zoneLoaded}
            />
          </div>,
          document.body,
        )}

      {graphics &&
        createPortal(
          <div
            className="menu-panel tool-pop"
            ref={gfxRef}
            style={{ position: 'fixed', left: graphics.left, top: graphics.top }}
          >
            <GraphicsPanel
              shadowsOn={shadowsOn}
              shadowDistance={shadowDistance}
              onShadowDistance={onShadowDistance}
              renderHeight={renderHeight}
              onRenderHeight={onRenderHeight}
              fpsCap={fpsCap}
              onFpsCap={onFpsCap}
              fov={fov}
              onFov={onFov}
              renderDistance={renderDistance}
              onRenderDistance={onRenderDistance}
              effectDistanceScale={effectDistanceScale}
              onEffectDistanceScale={onEffectDistanceScale}
            />
          </div>,
          document.body,
        )}

      {activeMenu &&
        createPortal(
          <div
            className="menu-panel"
            ref={panelRef}
            style={{ position: 'fixed', left: active.left, top: active.top }}
          >
            {activeMenu.items.map((item, i) => {
              if (item.sep || item.toolbarSep) {
                return <div key={`sep${i}`} className="menu-divider" role="separator" />;
              }
              const disabled = !!(item.disabled || (item.disableWhen && checks[item.disableWhen]));
              return (
                <button
                  key={item.id}
                  className="menu-item"
                  disabled={disabled}
                  onClick={() => !disabled && activate(item.id, item.label)}
                >
                  <span className="icon">{item.icon}</span>
                  <span className="mi-label">{item.label}</span>
                  {item.check && checks[item.check] && <span className="icon mi-check">check</span>}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
