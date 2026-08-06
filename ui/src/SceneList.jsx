import { useEffect, useState } from 'react';
import { Button } from '@headlessui/react';


// floors.json rows: { zone, spec: "rom/dir/file", fourcc } — the fourcc names a
// 0x20 texture section that becomes the tiled ground plane.
async function loadFloors() {
  const groups = new Map();   // zone -> [{ spec, fourcc }]
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

// Fog lives in the Zone Scene panel, not here: this panel's controls pushed to
// the renderer on mount, which meant opening Assets > Scene overwrote whatever
// fog the zone's 0x2F environment had set.
export function SceneList({ bgColor, onBg, onFloor, onClearFloor, selectedFloor, onError }) {
  const [groups, setGroups] = useState(null);

  useEffect(() => { loadFloors().then(setGroups).catch(() => setGroups([])); }, []);

  return (
    <div id="tree" className="panel scene-panel">
      <div className="scene-controls">
        <div className="scene-ctrl">
          <span className="scene-ctrl-label">Background</span>
          <input type="color" value={bgColor} onChange={(e) => onBg?.(e.target.value)} />
        </div>

        <Button className="scene-clear" onClick={onClearFloor}>
          <span className="icon">layers_clear</span>Remove floor
        </Button>
      </div>

      <div className="scene-floors">
        {groups === null && <div className="side-note">Loading floors…</div>}
        {groups?.map(({ zone, floors }) => (
          <SceneZone key={zone} zone={zone} floors={floors}
            selectedFloor={selectedFloor} onFloor={onFloor} onError={onError} />
        ))}
      </div>
    </div>
  );
}

function SceneZone({ zone, floors, selectedFloor, onFloor }) {
  const [open, setOpen] = useState(false);
  const single = floors.length === 1;

  const load = (f) => onFloor?.(f.spec, f.fourcc);
  const keyOf = (f) => `${f.spec}:${f.fourcc}`;

  if (single) {
    const f = floors[0];
    return (
      <div className={`node${selectedFloor === keyOf(f) ? ' selected' : ''}`}>
        <div className="row" onClick={() => load(f)}>
          <span className="caret icon"></span>
          <span className="kind icon">grass</span>
          <span>{zone}</span>
          <span className="mono-small scene-fourcc">{f.fourcc}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`node${open ? ' open' : ''}`}>
      <div className="row" onClick={() => setOpen(!open)}>
        <span className="caret icon">chevron_right</span>
        <span className="kind icon">grass</span>
        <span>{zone}</span>
        <span className="badge">{floors.length}</span>
      </div>
      {open && (
        <div className="children">
          {floors.map((f) => (
            <div key={keyOf(f)} className={`node${selectedFloor === keyOf(f) ? ' selected' : ''}`}>
              <div className="row" onClick={() => load(f)}>
                <span className="caret icon"></span>
                <span className="kind icon">texture</span>
                <span className="mono-small">{f.fourcc}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
