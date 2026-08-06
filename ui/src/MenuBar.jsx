import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Tooltip } from './Tooltip.jsx';

const MENUS = [
  {
    label: 'File',
    items: [
      { id: 'open-dat', label: 'Open DAT…', icon: 'file_open' },
      { id: 'export', label: 'Export', icon: 'download' },
      { id: 'settings', label: 'Settings', icon: 'settings' },
      { id: 'help', label: 'About', icon: 'star' },
    ],
  },
  {
    label: 'View',
    items: [
      { id: 'reset-camera', label: 'Reset Camera', icon: 'recenter' },
      { id: 'toggle-explorer', label: 'Toggle Explorer', icon: 'list_alt', check: 'explorer' },
      { id: 'toggle-wasd', label: 'Toggle WASD', icon: 'keyboard', check: 'wasd' },
      { id: 'toggle-wireframe', label: 'Toggle Wireframe', icon: 'grid_on', check: 'wireframe' },
      { id: 'toggle-skeleton', label: 'Toggle Skeleton', icon: 'accessibility_new', check: 'skeleton' },
      { id: 'toggle-textures', label: 'Toggle Textures', icon: 'texture', check: 'textures' },
      { id: 'toggle-hd', label: 'Toggle HD', icon: 'hd', check: 'hd', disableWhen: 'noHdPath' },
      { id: 'toggle-alpha', label: 'Toggle Alpha', icon: 'opacity', check: 'alpha' },
      { id: 'toggle-blend-lequal', label: 'Toggle Blend LEQUAL', icon: 'layers', check: 'blendLequal' },
      { id: 'toggle-unlit', label: 'Toggle Unlit', icon: 'light_mode', check: 'unlit' },
      { id: 'toggle-shadows', label: 'Toggle Shadows', icon: 'wb_shade', check: 'shadows' },
      { id: 'toggle-collision', label: 'Toggle Collision', icon: 'select_all', check: 'collision', disableWhen: 'noCollision' },
      { id: 'toggle-navmesh', label: 'Toggle Navmesh', icon: 'polyline', check: 'navmesh', disableWhen: 'noNavmesh' },
      { id: 'toggle-sound-markers', label: 'Toggle Sound Markers', icon: 'sound_detection_loud_sound', check: 'soundMarkers' },
      { id: 'toggle-skybox', label: 'Toggle Skybox', icon: 'cloud', check: 'skybox', disableWhen: 'noSkybox' },
      { id: 'toggle-effects', label: 'Toggle Effects', icon: 'auto_awesome', check: 'effects' },
      { id: 'toggle-axes', label: 'Toggle Axes', icon: 'open_with', check: 'axes' },
      { id: 'toggle-grid', label: 'Toggle Grid', icon: 'grid_4x4', check: 'grid' },
    ],
  },
  {
    label: 'Assets',
    items: [
      { id: 'assets-files', label: 'File Browser', icon: 'folder_open' },
      { id: 'assets-data', label: 'Data', icon: 'database' },
      { id: 'assets-characters', label: 'Characters', icon: 'person' },
      { id: 'assets-npcs', label: 'NPCs', icon: 'pets' },
      { id: 'assets-zones', label: 'Zones', icon: 'map' },
      { id: 'assets-effects', label: 'Effects', icon: 'auto_awesome' },
      { id: 'assets-images', label: 'Images', icon: 'image' },
      { id: 'assets-music', label: 'Music', icon: 'music_note' },
      { id: 'assets-sfx', label: 'Sound FX', icon: 'graphic_eq' },
      { id: 'assets-scene', label: 'Scene', icon: 'grass' },
      // Set apart at the bottom: still work in progress (the creation sequence
      // needs its event layer, and per-shape textures are not mapped yet).
      { sep: true },
      { id: 'assets-creation', label: '(WIP) Character Creation', icon: 'person_add' },
    ],
  },
];

/** Quick-toggle strip next to the menus — same View toggles, icon-only. */
const VIEW_TOOLBAR = MENUS.find((m) => m.label === 'View').items.filter((i) => i.check);

/**
 * Classic menubar: click opens; while open, hovering another top-level button
 * switches to it. The dropdown is portaled to <body> with fixed positioning so
 * it always layers above the blurred side panels (which form their own
 * stacking contexts and would otherwise swallow it).
 */
export function MenuBar({
  onAction, checks = {}, flySpeed = 0, fov = 45, onFov,
  graphicsOpen = false, sequencerOpen = false,
}) {
  const [active, setActive] = useState(null);   // { label, left, top } | null
  const [camera, setCamera] = useState(null);   // { left, top } | null
  const barRef = useRef(null);
  const panelRef = useRef(null);
  const camRef = useRef(null);

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

  // The camera popover dismisses the same way, but independently — opening a
  // menu shouldn't leave it hanging, and vice versa.
  useEffect(() => {
    if (!camera) return;
    const close = (e) => {
      if (barRef.current?.contains(e.target)) return;
      if (camRef.current?.contains(e.target)) return;
      setCamera(null);
    };
    const onKey = (e) => e.key === 'Escape' && setCamera(null);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [camera]);

  const openMenu = (label, target) => {
    const rect = target.getBoundingClientRect();
    setCamera(null);
    setActive({ label, left: rect.left, top: rect.bottom + 10 });
  };

  const toggleCamera = (target) => {
    if (camera) { setCamera(null); return; }
    const rect = target.getBoundingClientRect();
    setActive(null);
    setCamera({ left: rect.left, top: rect.bottom + 10 });
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
        {VIEW_TOOLBAR.map((item) => {
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
        {/* Panel openers, grouped apart from the on/off toggles to their left. */}
        <Tooltip content="Graphics Settings" placement="bottom">
          <button
            type="button"
            className={`view-tool${graphicsOpen ? ' on' : ''}`}
            aria-label="Graphics Settings"
            aria-expanded={graphicsOpen}
            onClick={() => { setActive(null); setCamera(null); onAction('graphics', 'Graphics Settings'); }}
          >
            <span className="icon">display_settings</span>
          </button>
        </Tooltip>
        <Tooltip content="Camera Sequencer" placement="bottom">
          <button
            type="button"
            className={`view-tool${sequencerOpen ? ' on' : ''}`}
            aria-label="Camera Sequencer"
            aria-expanded={sequencerOpen}
            onClick={() => { setActive(null); setCamera(null); onAction('camera-sequencer', 'Camera Sequencer'); }}
          >
            <span className="icon">movie</span>
          </button>
        </Tooltip>
        <Tooltip content="Camera" placement="bottom">
          <button
            type="button"
            className={`view-tool${camera ? ' on' : ''}`}
            aria-label="Camera settings"
            aria-expanded={!!camera}
            onClick={(e) => toggleCamera(e.currentTarget)}
          >
            <span className="icon">videocam</span>
          </button>
        </Tooltip>
        <Tooltip content="Fly speed — scroll the viewport with WASD on to change" placement="bottom">
          <span className="cam-speed mono">{Math.round(flySpeed)}</span>
        </Tooltip>
      </div>

      {camera &&
        createPortal(
          <div
            className="menu-panel cam-panel"
            ref={camRef}
            style={{ position: 'fixed', left: camera.left, top: camera.top }}
          >
            <div className="cam-row">
              <span className="cam-label">Field of view</span>
              <span className="cam-val mono">{fov}°</span>
            </div>
            <input
              type="range" min="20" max="120" step="1" value={fov}
              onChange={(e) => onFov?.(+e.target.value)}
              className="vol-slider"
              style={{ '--fill': `${((fov - 20) / 100) * 100}%` }}
            />
            <button type="button" className="cam-reset" onClick={() => onFov?.(45)}>
              Reset to 45°
            </button>
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
              if (item.sep) return <div key={`sep${i}`} className="menu-divider" role="separator" />;
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
