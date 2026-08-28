import { useEffect, useMemo, useState } from 'react';
import { Tooltip } from './Tooltip.jsx';
import { Combo } from './Combo.jsx';
import { BG_IMAGES, resolveBgUrl } from './bgs.js';

// Floor Repeat multiplier bounds — mirrored by Renderer.setFloorTileScale,
// which clamps to the same range.
const TILE_MIN = 0.25;
const TILE_MAX = 4;

// floors.json rows: { zone, spec: "rom/dir/file", fourcc }
async function loadFloors() {
  const groups = new Map();
  try {
    const res = await fetch('lists/floors.json');
    if (res.ok) {
      for (const { zone, spec, fourcc } of await res.json()) {
        if (!groups.has(zone)) groups.set(zone, []);
        groups.get(zone).push({ spec, fourcc });
      }
    }
  } catch { /* list optional */ }
  return [...groups.entries()].map(([zone, floors]) => ({ zone, floors }));
}

/**
 * Compact scene controls (toolbar popover): background colour / image,
 * clear floor, and a short floor picker.
 */
export function ScenePanel({
  bgColor = '#1a1a24',
  onBg,
  bgImage = 'none',
  onBgImage,
  onFloor,
  onClearFloor,
  selectedFloor = '',
  floorTileScale = 1,
  onFloorTileScale,
}) {
  const [groups, setGroups] = useState(null);
  const [openZone, setOpenZone] = useState('');

  useEffect(() => {
    loadFloors().then(setGroups).catch(() => setGroups([]));
  }, []);

  const bgItems = useMemo(
    () => [{ id: 'none', label: 'None' }, ...BG_IMAGES],
    [],
  );

  const keyOf = (f) => `${f.spec}:${f.fourcc}`;
  const hasFloor = !!selectedFloor;

  return (
    <div className="tool-pop-body">
      <h3>SCENE SETTINGS</h3>

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

      <div className="gfx-line">
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
        {groups === null && <div className="tool-pop-note">Loading…</div>}
        {groups?.length === 0 && <div className="tool-pop-note">No floors listed.</div>}
        {groups?.map(({ zone, floors }) => {
          const single = floors.length === 1;
          const open = openZone === zone || single;
          return (
            <div key={zone} className="tool-pop-group">
              {!single ? (
                <button
                  type="button"
                  className={`tool-pop-group-btn${open ? ' open' : ''}`}
                  onClick={() => setOpenZone((z) => (z === zone ? '' : zone))}
                >
                  <span className={`icon tool-pop-caret${open ? ' open' : ''}`}>chevron_right</span>
                  <span className="icon">grass</span>
                  <span className="tool-pop-group-name">{zone}</span>
                  <span className="tool-pop-badge">{floors.length}</span>
                </button>
              ) : null}
              {(open || single) && floors.map((f) => {
                const key = keyOf(f);
                const on = selectedFloor === key;
                return (
                  <Tooltip key={key} content={`${f.spec} · ${f.fourcc}`}>
                    <button
                      type="button"
                      className={`tool-pop-item${on ? ' on' : ''}${single ? ' alone' : ''}`}
                      onClick={() => onFloor?.(f.spec, f.fourcc)}
                    >
                      <span className="icon">{single ? 'grass' : 'texture'}</span>
                      <span className="tool-pop-item-label">
                        {single ? zone : f.fourcc}
                      </span>
                      {single ? (
                        <span className="mono tool-pop-item-meta">{f.fourcc}</span>
                      ) : null}
                      {on ? <span className="icon tool-pop-check">check</span> : null}
                    </button>
                  </Tooltip>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
