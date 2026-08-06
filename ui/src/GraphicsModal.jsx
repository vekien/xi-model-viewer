import { useEffect, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { Combo } from './Combo.jsx';

/**
 * Render resolutions, by drawing-buffer height. `id` 0 follows the window at
 * native DPR (the default, and what the viewer did before this panel existed).
 *
 * The width is not part of the choice: #canvas covers the window under the
 * panels, so the buffer keeps the window's aspect and only its height is
 * pinned. The labels name the familiar 16:9 pairs; the readout under the
 * dropdown shows what the buffer actually ends up as.
 */
const RESOLUTIONS = [
  { id: 0, label: 'Window Size' },
  { id: 720, label: '1280 × 720 (720p)' },
  { id: 900, label: '1600 × 900 (900p)' },
  { id: 1080, label: '1920 × 1080 (1080p)' },
  { id: 1440, label: '2560 × 1440 (1440p)' },
  { id: 1800, label: '3200 × 1800 (1800p)' },
  { id: 2160, label: '3840 × 2160 (4K)' },
];

const SHADOW_MIN = 20;
const SHADOW_MAX = 600;

/**
 * Graphics settings dialog. Unlike Settings, edits apply live — these are
 * "drag it and watch" controls, and a Save round-trip would hide the effect
 * you're trying to judge. Draggable by its header, same as Settings.
 */
export function GraphicsModal({
  open, onClose,
  shadowDistance = 90, onShadowDistance,
  shadowsOn = false,
  renderHeight = 0, onRenderHeight,
  bufferSize = null,          // [w, h] the renderer is actually drawing at
}) {
  const [pos, setPos] = useState(null);           // null = centered
  const panelRef = useRef(null);
  const dragState = useRef(null);

  useEffect(() => { if (open) setPos(null); }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const clampNow = () => setPos((p) => (p ? clamp(p, panelRef.current) : p));
    window.addEventListener('resize', clampNow);
    return () => window.removeEventListener('resize', clampNow);
  }, [open]);

  if (!open) return null;

  const startDrag = (e) => {
    if (e.target.closest('button, input, a, [role="button"]')) return;
    const rect = panelRef.current.getBoundingClientRect();
    dragState.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDrag = (e) => {
    if (!dragState.current) return;
    setPos(clamp({ x: e.clientX - dragState.current.dx, y: e.clientY - dragState.current.dy }, panelRef.current));
  };
  const endDrag = () => { dragState.current = null; };

  const style = pos
    ? { left: pos.x, top: pos.y, transform: 'none' }
    : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };

  const dist = Math.round(shadowDistance);
  const distPct = ((dist - SHADOW_MIN) / (SHADOW_MAX - SHADOW_MIN)) * 100;
  // Two 2048px cascades: a sharp one over the near quarter of the radius and a
  // coarse one for the rest. Only the far figure degrades as the slider goes
  // up, which is the point of the split — keep both visible so it's obvious.
  // Mirrors shadowNearSplit / shadowNearMin in renderer.js.
  const nearRadius = Math.min(Math.max(dist * 0.25, 12), dist);
  const nearTexel = (2 * nearRadius) / 2048;
  const farTexel = (2 * dist) / 2048;
  const split = nearRadius < dist * 0.95;

  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal gfx-modal" ref={panelRef} style={style}>
        <div
          className="modal-header"
          onPointerDown={startDrag}
          onPointerMove={onDrag}
          onPointerUp={endDrag}
        >
          <span className="icon">display_settings</span>
          <span className="modal-title">Graphics Settings</span>
          <Button className="icon-btn modal-close" onClick={onClose} title="Close">
            <span className="icon">close</span>
          </Button>
        </div>

        <div className="modal-body">
          <div className="form-row">
            <label className="form-label">Shadow distance</label>
            <div className="gfx-slider-row">
              <input
                type="range"
                min={SHADOW_MIN} max={SHADOW_MAX} step="5"
                value={dist}
                disabled={!shadowsOn}
                onChange={(e) => onShadowDistance?.(+e.target.value)}
                className="vol-slider"
                style={{ '--fill': `${distPct}%` }}
              />
              <span className="gfx-val mono">{dist}</span>
            </div>
            <div className="form-hint">
              {shadowsOn
                ? (split
                  ? `How far from the camera zone terrain still receives shadows, in world units. Two cascades cover it: the nearest ${Math.round(nearRadius)} units stay sharp (${nearTexel.toFixed(2)} units per texel) and the rest is coarser (${farTexel.toFixed(2)}), cross-faded between. Model views fit the model instead and ignore this.`
                  : `How far from the camera zone terrain still receives shadows, in world units. At this distance a single cascade covers it at ${farTexel.toFixed(2)} units per texel. Model views fit the model instead and ignore this.`)
                : 'Turn on View > Shadows to use this.'}
            </div>
          </div>

          <div className="form-row">
            <label className="form-label">Render resolution</label>
            <Combo
              value={renderHeight}
              items={RESOLUTIONS}
              onChange={(id) => onRenderHeight?.(id)}
            />
            <div className="form-hint">
              {bufferSize ? `Drawing at ${bufferSize[0]} × ${bufferSize[1]}. ` : ''}
              The picture is scaled to the window either way — above the window
              height this is supersampling (sharper, slower), below it upscaling
              (softer, faster). Width follows the window's aspect.
            </div>
          </div>
        </div>

        <div className="modal-actions">
          <Button className="active" onClick={onClose}>Done</Button>
        </div>
      </div>
    </div>
  );
}

function clamp(p, panel) {
  const w = panel?.offsetWidth ?? 440;
  const h = panel?.offsetHeight ?? 280;
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}
