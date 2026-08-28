import { useEffect, useMemo, useState } from 'react';
import { Tooltip } from './Tooltip.jsx';
import { Combo } from './Combo.jsx';
import { BG_IMAGES } from './bgs.js';

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
  bgImage = '',
  onBgImage,
  onFloor,
  onClearFloor,
  selectedFloor = '',
}) {
  const [groups, setGroups] = useState(null);
  const [openZone, setOpenZone] = useState('');

  useEffect(() => {
    loadFloors().then(setGroups).catch(() => setGroups([]));
  }, []);

  const bgItems = useMemo(
    () => [{ id: '', label: 'None' }, ...BG_IMAGES.map((b) => ({ id: b.url, label: b.label }))],
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
            value={bgImage || ''}
            items={bgItems}
            onChange={(id) => onBgImage?.(id || '')}
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
