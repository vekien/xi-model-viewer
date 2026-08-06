import { useEffect, useRef, useState } from 'react';
import { Combo } from './Combo.jsx';
import { CREATION_RACES, bumpDatIndex, CREATION_CLIPS, creationClipPaths } from '../js/creation.js';

// Assets > Character Creation — the high-poly character-creation preview
// models: a distinct asset family from ordinary player models (RT/SHAPE +
// DMB + SQLE), one body per race, four faces with A/B material variants,
// and matched body/head motion pairs (standing idle + the long authored
// character-creation presentation).

const CR_STATE_KEY = 'creationState';

function loadCrState() {
  try { return JSON.parse(localStorage.getItem(CR_STATE_KEY) || 'null') ?? {}; } catch { return {}; }
}

/**
 * Character-creation composer state. Owns race/face/variant/equipment and the
 * animation choice; assembles the DAT descriptor and calls onLoad whenever it
 * changes. Lives in App so the Animation panel shares one instance.
 */
export function useCreation({ enabled, onLoad, onError }) {
  const saved = useRef(loadCrState());
  const [race, setRace] = useState(() => (
    CREATION_RACES.some((r) => r.id === saved.current.race) ? saved.current.race : CREATION_RACES[0].id
  ));
  const [faceIdx, setFaceIdx] = useState(() => {
    const f = saved.current.faceIdx;
    return Number.isInteger(f) && f >= 0 && f < 4 ? f : 0;
  });
  const [variant, setVariant] = useState(saved.current.variant === 'B' ? 'B' : 'A');
  // Retail loads the +2 "initial equipment" body for every race on the creation
  // screen (confirmed by the ProcMon capture), so default to it.
  const [equip, setEquip] = useState(saved.current.equip === 0 ? 0 : 1);
  // '' = A-pose; otherwise a clip id from CREATION_CLIPS.
  const [anim, setAnim] = useState(() => (
    saved.current.anim === '' || CREATION_CLIPS.some((c) => c.id === saved.current.anim)
      ? saved.current.anim : 'idle'
  ));
  const lastKey = useRef('');
  const prevEnabled = useRef(false);
  const cbRef = useRef({});
  cbRef.current = { onLoad, onError };

  useEffect(() => {
    try { localStorage.setItem(CR_STATE_KEY, JSON.stringify({ race, faceIdx, variant, equip, anim })); }
    catch { /* quota */ }
  }, [race, faceIdx, variant, equip, anim]);

  // Re-entering the view must reload even with unchanged selections — another
  // view will have replaced the model in the meantime.
  useEffect(() => {
    if (enabled && !prevEnabled.current) lastKey.current = '';
    prevEnabled.current = enabled;
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const def = CREATION_RACES.find((r) => r.id === race) ?? CREATION_RACES[0];
    const face = def.faces[faceIdx] ?? def.faces[0];
    const clip = anim ? creationClipPaths(def, face, anim) : null;
    // "Initial Equipment" bodies sit two DAT indices after the no-equipment pair.
    const desc = {
      name: `${def.label} — Face ${faceIdx + 1}${variant}${equip ? ' · Initial Equipment' : ''}`,
      raceId: def.id,
      bodyMesh: equip ? bumpDatIndex(def.bodyMesh, 2) : def.bodyMesh,
      bodyMat: equip ? bumpDatIndex(def.bodyMat, 2) : def.bodyMat,
      // The other equipment variant. On Tarutaru/Mithra/Galka the two bodies
      // carry different skeletons and each clip is authored for exactly one of
      // them, so the loader falls back to this when the chosen one can't play
      // the selected clip — better than showing a frozen bind pose.
      altBodyMesh: equip ? def.bodyMesh : bumpDatIndex(def.bodyMesh, 2),
      altBodyMat: equip ? def.bodyMat : bumpDatIndex(def.bodyMat, 2),
      altLabel: equip ? 'No Equipment' : 'Initial Equipment',
      headMesh: face.mesh,
      headMat: variant === 'B' ? face.matB : face.matA,
      headY: face.headY ?? 0,
      motions: clip ? { body: clip.body, head: clip.head } : null,
      anim,
    };
    const key = [desc.bodyMesh, desc.bodyMat, desc.headMesh, desc.headMat, anim].join('|');
    if (key === lastKey.current) return;
    lastKey.current = key;
    cbRef.current.onLoad?.(desc);
  }, [enabled, race, faceIdx, variant, equip, anim]);

  return { race, setRace, faceIdx, setFaceIdx, variant, setVariant, equip, setEquip, anim, setAnim };
}

// ---------------------------------------------------------------------------

const FACE_ITEMS = [1, 2, 3, 4].map((n) => ({ id: String(n - 1), label: `Face ${n}` }));
const VARIANT_ITEMS = [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }];
const EQUIP_ITEMS = [{ id: '0', label: 'No Equipment' }, { id: '1', label: 'Initial Equipment' }];

const CAMERA_ITEMS = [{ id: '0', label: 'Camera 1' }, { id: '1', label: 'Camera 2' }];

export function CreationList({ cr, info, camera }) {
  const { race, setRace, faceIdx, setFaceIdx, variant, setVariant, equip, setEquip } = cr;
  const raceItems = CREATION_RACES.map((r) => ({ id: r.id, label: r.label }));

  // Tarutaru/Mithra/Galka carry a different skeleton per equipment body, and
  // each clip is authored against exactly one of them: the long creation
  // sequence against the Initial Equipment body (Tarutaru 251 channels, Mithra
  // 407, Galka 389) and every short motion against the No Equipment one
  // (299/335/349). Hume and Elvaan use 299 for both, which is why it only shows
  // up on these three. The loader swaps to whichever body can play the clip, so
  // this reports what happened rather than asking for a change.
  const def = CREATION_RACES.find((r) => r.id === race);
  const shownOn = info?.motion?.shownOn;
  const pairHint = shownOn
    ? `${def?.label ?? 'This race'} authors this clip for the ${shownOn} body, so it is shown on that one.`
    : null;

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
        {pairHint && <div className="side-note">{pairHint}</div>}

        {cr.anim === 'seq' && (
          <div className="side-note">
            This clip is the pose track only. The real screen plays it under an
            event track that fires per-race actions on authored frames — that
            layer isn’t decoded yet, so this looks stiff. Motions 1–3 and the
            idle are complete.
          </div>
        )}

        {camera?.available && (
          <>
            <div className="side-separator">Cinematic Camera</div>
            <div className="side-note">
              The sequence ships its own camera track — most of the movement you
              see in the real creation screen is the camera, not the character.
            </div>
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
                </div>
                {info.motion.compatible && (
                  <div className="side-note">
                    {info.motion.movingBones} of {info.motion.totalBones} bones rotate in this clip
                    {' '}— turn on View ▸ Skeleton to see them (red = never rotates).
                  </div>
                )}
                <div className="side-note mono">{info.motion.body}</div>
                <div className="side-note mono">{info.motion.head}</div>
                {!info.motion.compatible && (
                  <div className="side-note">
                    Motion channel counts don&apos;t match this skeleton pair — showing bind pose.
                  </div>
                )}
              </>
            )}
          </>
        )}

        <div className="side-separator">About</div>
        <div className="side-note">
          High-poly character-creation models. The creation sequence is the full
          authored presentation each race performs on the selection screen —
          lengths differ per race (41s to 100s) because they are unique
          performances, not shared locomotion cycles.
        </div>
      </div>
    </div>
  );
}
