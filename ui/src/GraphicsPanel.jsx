import { Combo } from './Combo.jsx';

const RESOLUTIONS = [
  { id: 0, label: 'Window Size' },
  { id: 720, label: '720p' },
  { id: 900, label: '900p' },
  { id: 1080, label: '1080p' },
  { id: 1440, label: '1440p' },
  { id: 1800, label: '1800p' },
  { id: 2160, label: '4K' },
];

const SHADOW_MIN = 20;
const SHADOW_MAX = 600;
export const RENDER_DIST_MIN = 250;
export const RENDER_DIST_MAX = 10000;
export const RENDER_DIST_DEFAULT = 5000;
export const FX_DIST_MIN = 1;
export const FX_DIST_MAX = 20;
export const FX_DIST_DEFAULT = 1;

const FPS_CAPS = [
  { id: '0', label: 'Uncapped' },
  { id: '120', label: '120' },
  { id: '60', label: '60' },
  { id: '30', label: '30' },
];

/** Toolbar graphics popover — same chrome as FOV (cam-panel). */
export function GraphicsPanel({
  shadowDistance = 90, onShadowDistance,
  shadowsOn = false,
  renderHeight = 0, onRenderHeight,
  fpsCap = 0, onFpsCap,
  fov = 45, onFov,
  renderDistance = RENDER_DIST_DEFAULT, onRenderDistance,
  effectDistanceScale = FX_DIST_DEFAULT, onEffectDistanceScale,
}) {
  const dist = Math.round(shadowDistance);
  const distPct = ((dist - SHADOW_MIN) / (SHADOW_MAX - SHADOW_MIN)) * 100;
  const rdist = Math.round(renderDistance);
  const rdistPct = ((rdist - RENDER_DIST_MIN) / (RENDER_DIST_MAX - RENDER_DIST_MIN)) * 100;
  const fxDist = Math.min(FX_DIST_MAX, Math.max(FX_DIST_MIN, Number(effectDistanceScale) || 1));
  const fxPct = ((fxDist - FX_DIST_MIN) / (FX_DIST_MAX - FX_DIST_MIN)) * 100;
  const fovPct = ((fov - 20) / 100) * 100;

  return (
    <div className="tool-pop-body">
      <h3>GRAPHICS SETTINGS</h3>
      

      <div className={`gfx-line${shadowsOn ? '' : ' dim'}`}>
        <span className="gfx-lab">Shadow Distance &nbsp; • &nbsp; <strong>{dist}</strong></span>
      </div>
      <input
        type="range"
        min={SHADOW_MIN}
        max={SHADOW_MAX}
        step="5"
        value={dist}
        disabled={!shadowsOn}
        onChange={(e) => onShadowDistance?.(+e.target.value)}
        className="vol-slider gfx-slider"
        style={{ '--fill': `${distPct}%` }}
      />

      <div className="gfx-line">
        <span className="gfx-lab">Render Distance &nbsp; • &nbsp; <strong>{rdist}</strong></span>
      </div>
      <input
        type="range"
        min={RENDER_DIST_MIN}
        max={RENDER_DIST_MAX}
        step="50"
        value={rdist}
        onChange={(e) => onRenderDistance?.(+e.target.value)}
        className="vol-slider gfx-slider"
        style={{ '--fill': `${rdistPct}%` }}
      />

      <div className="gfx-line">
        <span className="gfx-lab">Effects Distance &nbsp; • &nbsp; <strong>{fxDist.toFixed(1)}×</strong></span>
      </div>
      <input
        type="range"
        min={FX_DIST_MIN}
        max={FX_DIST_MAX}
        step={1}
        value={fxDist}
        onInput={(e) => onEffectDistanceScale?.(+e.target.value)}
        onChange={(e) => onEffectDistanceScale?.(+e.target.value)}
        className="vol-slider gfx-slider"
        style={{ '--fill': `${fxPct}%` }}
      />

      <hr />

      <div className="gfx-line">
        <span className="gfx-lab">Field of view &nbsp; • &nbsp; <strong>{fov}°</strong></span>
      </div>
      <input
        type="range"
        min="20"
        max="120"
        step="1"
        value={fov}
        onChange={(e) => onFov?.(+e.target.value)}
        className="vol-slider gfx-slider"
        style={{ '--fill': `${fovPct}%` }}
      />

      <hr />


      <div className="gfx-line">
        <span className="gfx-lab">Render Resolution</span>
        <div className="gfx-ctrl">
          <Combo
            value={renderHeight}
            items={RESOLUTIONS}
            onChange={(id) => onRenderHeight?.(id)}
          />
        </div>
      </div>

      <div className="gfx-line">
        <span className="gfx-lab">FPS Limit</span>
        <div className="gfx-ctrl">
          <Combo
            value={String(fpsCap ?? 0)}
            items={FPS_CAPS}
            onChange={(id) => onFpsCap?.(Number(id) || 0)}
          />
        </div>
      </div>
    </div>
  );
}
