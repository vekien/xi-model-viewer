import { useEffect, useRef, useState } from 'react';
import { Combo } from './Combo.jsx';
import { CREATION_RACES, bumpDatIndex, CREATION_CLIPS, creationClipPaths } from '../js/creation.js';

// Assets > Character Creation — high-poly RT/SHAPE + DMB + SQLE models.
// Eight faces × A/B texture variants. Initial-equipment body is mesh/mat +2.

const CR_STATE_KEY = 'creationState';

function loadCrState() {
  try { return JSON.parse(localStorage.getItem(CR_STATE_KEY) || 'null') ?? {}; } catch { return {}; }
}

/**
 * Equipment ALWAYS picks the body mesh. Animator accepts prefix channel matches
 * (Mithra equip = naked bones + cloth), so Idle/Walk work on Initial Equipment
 * when the skeletons share a prefix. Taru equip is a different rig — loco clips
 * only pair with No Equipment there.
 */
export function useCreation({ enabled, onLoad, onError }) {
  const saved = useRef(loadCrState());
  const [race, setRace] = useState(() => (
    CREATION_RACES.some((r) => r.id === saved.current.race) ? saved.current.race : CREATION_RACES[0].id
  ));
  const [faceIdx, setFaceIdx] = useState(() => {
    const f = saved.current.faceIdx;
    return Number.isInteger(f) && f >= 0 && f < 8 ? f : 0;
  });
  const [variant, setVariant] = useState(saved.current.variant === 'B' ? 'B' : 'A');
  const [equip, setEquip] = useState(saved.current.equip === 0 ? 0 : 1);
  const [anim, setAnim] = useState(() => {
    const a = saved.current.anim;
    if (a === '' || CREATION_CLIPS.some((c) => c.id === a)) return a ?? 'seq';
    return 'seq';
  });
  const lastKey = useRef('');
  const prevEnabled = useRef(false);
  const cbRef = useRef({});
  cbRef.current = { onLoad, onError };

  useEffect(() => {
    try {
      localStorage.setItem(CR_STATE_KEY, JSON.stringify({ race, faceIdx, variant, equip, anim }));
    } catch { /* quota */ }
  }, [race, faceIdx, variant, equip, anim]);

  useEffect(() => {
    if (enabled && !prevEnabled.current) lastKey.current = '';
    prevEnabled.current = enabled;
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const def = CREATION_RACES.find((r) => r.id === race) ?? CREATION_RACES[0];
    const face = def.faces[faceIdx] ?? def.faces[0];
    const clip = anim ? creationClipPaths(def, face, anim) : null;

    const desc = {
      name: `${def.label} — Face ${faceIdx + 1}${variant}${equip ? ' · Initial Equipment' : ''}`,
      raceId: def.id,
      bodyMesh: equip ? bumpDatIndex(def.bodyMesh, 2) : def.bodyMesh,
      bodyMat: equip ? bumpDatIndex(def.bodyMat, 2) : def.bodyMat,
      allowAltBody: false,
      headMesh: face.mesh,
      headMat: face.mat,
      headY: face.headY ?? 0,
      headVariant: variant === 'B' ? 1 : 0,
      motions: clip ? { body: clip.body, head: clip.head } : null,
      anim,
      equip: !!equip,
    };
    const key = [desc.bodyMesh, desc.bodyMat, desc.headMesh, desc.headMat, desc.headVariant, anim].join('|');
    if (key === lastKey.current) return;
    lastKey.current = key;
    cbRef.current.onLoad?.(desc);
  }, [enabled, race, faceIdx, variant, equip, anim]);

  return {
    race, setRace, faceIdx, setFaceIdx, variant, setVariant,
    equip, setEquip, anim, setAnim,
  };
}

// ---------------------------------------------------------------------------

const FACE_ITEMS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: String(n - 1), label: `Face ${n}` }));
const VARIANT_ITEMS = [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }];
const EQUIP_ITEMS = [{ id: '0', label: 'No Equipment' }, { id: '1', label: 'Initial Equipment' }];
const CAMERA_ITEMS = [{ id: '0', label: 'Camera 1' }, { id: '1', label: 'Camera 2' }];

export function CreationList({ cr, info, camera }) {
  const {
    race, setRace, faceIdx, setFaceIdx, variant, setVariant, equip, setEquip,
  } = cr;
  const raceItems = CREATION_RACES.map((r) => ({ id: r.id, label: r.label }));

  const row = (label, node) => (
    <div className="pc-ctrl" key={label}>
      <span className="pc-ctrl-label">{label}</span>
      {node}
    </div>
  );

  return (
    <div id="tree" className="panel pc-panel">
      <div className="pc-scroll">
        {row('Race', <Combo value={race} items={raceItems} onChange={setRace} />)}
        {row('Face', <Combo value={String(faceIdx)} items={FACE_ITEMS} onChange={(id) => setFaceIdx(+id)} />)}
        {row('Variant', <Combo value={variant} items={VARIANT_ITEMS} onChange={setVariant} />)}
        {row('Equipment', <Combo value={String(equip)} items={EQUIP_ITEMS} onChange={(id) => setEquip(+id)} />)}

        {info?.motion && !info.motion.compatible && (
          <div className="side-note">
            This clip’s channels don’t fit this body skeleton (Tarutaru equip uses
            a different rig). Try No Equipment for Idle/Walk, or Creation sequence
            for Initial Equipment.
          </div>
        )}

        {cr.anim === 'seq' && (
          <div className="side-note">
            Creation sequence plays the full PB body+head timeline as authored
            (including staged floor poses). Use orbit view to inspect motion.
          </div>
        )}

        {camera?.available && (
          <>
            <div className="side-separator">Cinematic Camera</div>
            {row('Use camera', (
              <button
                type="button"
                className={`pc-play${camera.on ? ' on' : ''}`}
                onClick={() => camera.onToggle(!camera.on)}
              >
                <span className="icon fill">{camera.on ? 'videocam' : 'videocam_off'}</span>
                <span>{camera.on ? 'On' : 'Off'}</span>
              </button>
            ))}
            {camera.on && row('Shot', (
              <Combo
                value={String(camera.index)}
                items={CAMERA_ITEMS}
                onChange={(id) => camera.onIndex(+id)}
              />
            ))}
          </>
        )}

        {info && (
          <>
            <div className="side-separator">Model</div>
            <div className="side-note">
              {info.bones} bones · {info.verts.toLocaleString()} verts · {info.shapes} shapes
            </div>
            {info.motion && (
              <>
                <div className="side-separator">Motion</div>
                <div className="side-note">
                  {info.motion.kind === 'pb' ? 'PBChannel v.3' : 'FrameChannel v.4'} ·{' '}
                  {info.motion.frames.toLocaleString()} frames · {info.motion.duration.toFixed(2)}s
                  {' '}({info.motion.fps.toFixed(2)} fps)
                  {info.motion.compatible
                    ? ` · ${info.motion.movingBones}/${info.motion.totalBones} bones move`
                    : ' · incompatible'}
                  {info.motion.leadIn ? ` · skipped ${info.motion.leadIn}s lead-in` : ''}
                </div>
                <div className="side-note mono">{info.motion.body}</div>
                <div className="side-note mono">{info.motion.head}</div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
