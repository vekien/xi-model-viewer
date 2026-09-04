import { useEffect, useMemo, useState } from 'react';
import { Tooltip } from './Tooltip.jsx';
import { Combo } from './Combo.jsx';
import { BG_IMAGES, resolveBgUrl } from './bgs.js';

// Floor slider bounds — mirrored by Renderer.setFloor* clamps.
const TILE_MIN = 0.25;
const TILE_MAX = 4;
const RADIUS_MIN = 2;
const RADIUS_MAX = 200;
const FADE_MIN = 0;
const FADE_MAX = 200;

// floors.json rows: { zone, spec: "rom/dir/file", fourcc }
async function loadFloors() {
  try {
    const res = await fetch('lists/floors.json');
    if (!res.ok) return [];
    const list = await res.json();
    if (!Array.isArray(list)) return [];
    return list
      .filter((f) => f?.spec && f?.fourcc)
      .slice()
      .sort((a, b) => String(a.zone || a.fourcc).localeCompare(String(b.zone || b.fourcc), undefined, { sensitivity: 'base' }));
  } catch {
    return [];
  }
}

/**
 * Compact viewport controls (toolbar popover): background colour / image,
 * clear floor, and a short floor picker.
 */
export function ViewportPanel({
  bgColor = '#1a1a24',
  onBg,
  bgImage = 'none',
  onBgImage,
  onFloor,
  onClearFloor,
  selectedFloor = '',
  floorTileScale = 1,
  onFloorTileScale,
  floorRadius = 42,
  onFloorRadius,
  floorFadeRadius = 30,
  onFloorFadeRadius,
  flatFloor = false,
  onFlatFloor,
  flatFloorColor = '#8a8a94',
  onFlatFloorColor,
  zoneLoaded = false,
}) {
  const [floors, setFloors] = useState(null);

  useEffect(() => {
    loadFloors().then(setFloors).catch(() => setFloors([]));
  }, []);

  const bgItems = useMemo(
    () => [{ id: 'none', label: 'None' }, ...BG_IMAGES],
    [],
  );

  const keyOf = (f) => `${f.spec}:${f.fourcc}`;
  const hasFloor = !!selectedFloor;
  const floorLive = hasFloor || !!flatFloor;

  return (
    <div className="tool-pop-body">
      <h3>VIEWPORT SETTINGS</h3>

      <div className="gfx-line">
        <span className="gfx-lab">Background Colour</span>
        <div className="gfx-ctrl gfx-ctrl-end">
          <Tooltip content="Viewport background">
            <input
              type="color"
              className="tool-pop-color"
              value={bgColor}
              onChange={(e) => onBg?.(e.target.value)}
            />
          </Tooltip>
        </div>
      </div>

      {zoneLoaded && (
        <div className="scene-note">
          <span className="icon">map</span>
          <span>Background image and floor are paused while a zone is loaded — the zone brings its own ground and sky. Settings are kept.</span>
        </div>
      )}

      <div className={`gfx-line${zoneLoaded ? ' scene-locked' : ''}`}>
        <span className="gfx-lab">Background Image</span>
        <div className="gfx-ctrl">
          <Combo
            value={bgImage || 'none'}
            items={bgItems}
            onChange={(id) => {
              if (id == null) return;
              // Pass filename id; App resolves to URL via resolveBgUrl.
              onBgImage?.(id === 'none' ? 'none' : id);
            }}
          />
        </div>
      </div>

      <hr />

      <div className={`scene-floor${zoneLoaded ? ' scene-locked' : ''}`}>
      <div className="tool-pop-actions">
        <Tooltip content={hasFloor ? 'Remove the ground plane' : 'No floor loaded'}>
          <button
            type="button"
            className="cam-reset"
            disabled={!hasFloor}
            onClick={() => onClearFloor?.()}
          >
            <span className="icon">layers_clear</span>
            Remove floor
          </button>
        </Tooltip>
      </div>

      <div className="gfx-line">
        <span className="gfx-lab">Flat Floor</span>
        <div className="gfx-ctrl gfx-ctrl-end">
          <Tooltip content="Plain untextured ground plane — still catches the model's shadow">
            <label className="switch cseq-switch">
              <input
                type="checkbox"
                checked={!!flatFloor}
                onChange={(e) => onFlatFloor?.(e.target.checked)}
              />
              <span className="track" />
            </label>
          </Tooltip>
        </div>
      </div>

      <div className={`gfx-line${flatFloor ? '' : ' dim'}`}>
        <span className="gfx-lab">Flat Floor Color</span>
        <div className="gfx-ctrl gfx-ctrl-end">
          <Tooltip content="Flat floor colour">
            <input
              type="color"
              className="tool-pop-color"
              value={flatFloorColor}
              disabled={!flatFloor}
              onChange={(e) => onFlatFloorColor?.(e.target.value)}
            />
          </Tooltip>
        </div>
      </div>

      <div className={`gfx-line${floorLive ? '' : ' dim'}`}>
        <span className="gfx-lab">
          Floor Radius &nbsp; • &nbsp; <strong>{Number(floorRadius).toFixed(0)}</strong>
        </span>
      </div>
      <input
        type="range"
        min={RADIUS_MIN}
        max={RADIUS_MAX}
        step="1"
        value={floorRadius}
        disabled={!floorLive}
        onChange={(e) => onFloorRadius?.(+e.target.value)}
        className="vol-slider gfx-slider"
        style={{ '--fill': `${((floorRadius - RADIUS_MIN) / (RADIUS_MAX - RADIUS_MIN)) * 100}%` }}
      />

      <div className={`gfx-line${floorLive ? '' : ' dim'}`}>
        <span className="gfx-lab">
          Floor Fade Radius &nbsp; • &nbsp; <strong>{Number(floorFadeRadius).toFixed(0)}</strong>
        </span>
      </div>
      <input
        type="range"
        min={FADE_MIN}
        max={FADE_MAX}
        step="1"
        value={floorFadeRadius}
        disabled={!floorLive}
        onChange={(e) => onFloorFadeRadius?.(+e.target.value)}
        className="vol-slider gfx-slider"
        style={{ '--fill': `${((floorFadeRadius - FADE_MIN) / (FADE_MAX - FADE_MIN)) * 100}%` }}
      />

      <div className={`gfx-line${hasFloor ? '' : ' dim'}`}>
        <span className="gfx-lab">
          Floor Repeat &nbsp; • &nbsp; <strong>{Number(floorTileScale).toFixed(2)}×</strong>
        </span>
      </div>
      <input
        type="range"
        min={TILE_MIN}
        max={TILE_MAX}
        step="0.05"
        value={floorTileScale}
        disabled={!hasFloor}
        onChange={(e) => onFloorTileScale?.(+e.target.value)}
        className="vol-slider gfx-slider"
        style={{ '--fill': `${((floorTileScale - TILE_MIN) / (TILE_MAX - TILE_MIN)) * 100}%` }}
      />

      <div className="tool-pop-section">Floor texture</div>
      <div className="tool-pop-list">
        {floors === null && <div className="tool-pop-note">Loading…</div>}
        {floors?.length === 0 && <div className="tool-pop-note">No floors listed.</div>}
        {floors?.map((f) => {
          const key = keyOf(f);
          const on = selectedFloor === key;
          return (
            <button
              key={key}
              type="button"
              className={`tool-pop-item alone${on ? ' on' : ''}`}
              onClick={() => onFloor?.(f.spec, f.fourcc)}
            >
              <span className="icon">grass</span>
              <span className="tool-pop-item-label">{f.zone || f.fourcc}</span>
              <span className="mono tool-pop-item-meta">{f.fourcc}</span>
              {on ? <span className="icon tool-pop-check">check</span> : null}
            </button>
          );
        })}
      </div>
      </div>
    </div>
  );
}
