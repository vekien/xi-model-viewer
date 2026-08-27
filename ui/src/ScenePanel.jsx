import { useEffect, useState } from 'react';

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
 * Compact scene controls (toolbar popover, FOV-style): background colour,
 * clear floor, and a short floor picker.
 */
export function ScenePanel({
  bgColor = '#1a1a24',
  onBg,
  onFloor,
  onClearFloor,
  selectedFloor = '',
}) {
  const [groups, setGroups] = useState(null);
  const [openZone, setOpenZone] = useState('');

  useEffect(() => {
    loadFloors().then(setGroups).catch(() => setGroups([]));
  }, []);

  const keyOf = (f) => `${f.spec}:${f.fourcc}`;
  const hasFloor = !!selectedFloor;

  return (
    <div className="scene-pop">
      <div className="scene-pop-bg">
        <span className="cam-label">Background</span>
        <input
          type="color"
          className="scene-pop-color"
          value={bgColor}
          onChange={(e) => onBg?.(e.target.value)}
          title="Viewport background"
        />
      </div>

      <div className="scene-pop-actions">
        <button
          type="button"
          className="cam-reset"
          disabled={!hasFloor}
          onClick={() => onClearFloor?.()}
          title={hasFloor ? 'Remove the ground plane' : 'No floor loaded'}
        >
          <span className="icon">layers_clear</span>
          Remove floor
        </button>
      </div>

      <div className="scene-pop-floors-label">Floor texture</div>
      <div className="scene-pop-floors">
        {groups === null && <div className="scene-pop-note">Loading…</div>}
        {groups?.length === 0 && <div className="scene-pop-note">No floors listed.</div>}
        {groups?.map(({ zone, floors }) => {
          const single = floors.length === 1;
          const open = openZone === zone || single;
          return (
            <div key={zone} className="scene-pop-zone">
              {!single ? (
                <button
                  type="button"
                  className={`scene-pop-zone-btn${open ? ' open' : ''}`}
                  onClick={() => setOpenZone((z) => (z === zone ? '' : zone))}
                >
                  <span className={`icon scene-pop-caret${open ? ' open' : ''}`}>chevron_right</span>
                  <span className="icon">grass</span>
                  <span className="scene-pop-zone-name">{zone}</span>
                  <span className="scene-pop-badge">{floors.length}</span>
                </button>
              ) : null}
              {(open || single) && floors.map((f) => {
                const key = keyOf(f);
                const on = selectedFloor === key;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`scene-pop-floor${on ? ' on' : ''}${single ? ' alone' : ''}`}
                    onClick={() => onFloor?.(f.spec, f.fourcc)}
                    title={`${f.spec} · ${f.fourcc}`}
                  >
                    <span className="icon">{single ? 'grass' : 'texture'}</span>
                    <span className="scene-pop-floor-label">
                      {single ? zone : f.fourcc}
                    </span>
                    {single ? (
                      <span className="mono scene-pop-fourcc">{f.fourcc}</span>
                    ) : null}
                    {on ? <span className="icon scene-pop-check">check</span> : null}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
