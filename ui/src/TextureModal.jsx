import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { decodeTextureRGBA } from '../js/renderer.js';
import { Tooltip } from './Tooltip.jsx';

const VIEW_MAX = 640;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 8;
const BG_KEY = 'texViewerBg'; // '' = checker, else #rrggbb

function readTexBg() {
  try {
    const v = localStorage.getItem(BG_KEY);
    if (v && /^#[0-9a-fA-F]{6}$/.test(v)) return v;
  } catch { /* */ }
  return '';
}

// FFXI stores texture alpha at half scale — 128 is fully opaque (see ImageViewer).
// DXT3 dither peaks ~136, so anything ≤ that gets doubled for display.
const HALF_SCALE_MAX = 136;
const OPAQUE_ENOUGH = 230;

function rgbaForDisplay(tex) {
  const src = decodeTextureRGBA(tex);
  const out = new Uint8ClampedArray(src.length);
  out.set(src);
  let maxA = 0;
  for (let i = 3; i < src.length; i += 4) if (src[i] > maxA) maxA = src[i];
  if (maxA > 0 && maxA <= HALF_SCALE_MAX) {
    for (let i = 3; i < out.length; i += 4) {
      const a = src[i] * 2;
      out[i] = a >= OPAQUE_ENOUGH ? 255 : a;
    }
  }
  return out;
}

/**
 * Draggable floating window showing a single decoded texture on a checkerboard.
 * Viewport 640×640; zoom + pan; FFXI half-scale alpha expanded for display.
 */
export function TextureModal({ tex, onClose, onFocus, zIndex = 210, initialPos = null }) {
  const canvasRef = useRef(null);
  const panelRef = useRef(null);
  const viewRef = useRef(null);
  const headerDrag = useRef(null);
  const panDrag = useRef(null);
  const [pos, setPos] = useState(() => (
    initialPos && Number.isFinite(initialPos.x) && Number.isFinite(initialPos.y)
      ? { x: initialPos.x, y: initialPos.y }
      : null
  ));
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [bg, setBg] = useState(readTexBg); // '' = checkerboard

  const fitScale = useMemo(() => {
    if (!tex?.width || !tex?.height) return 1;
    return Math.min(1, VIEW_MAX / tex.width, VIEW_MAX / tex.height);
  }, [tex?.width, tex?.height]);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [tex?.name, tex?.width, tex?.height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!tex || !canvas) return;
    canvas.width = tex.width;
    canvas.height = tex.height;
    const rgba = rgbaForDisplay(tex);
    const img = new ImageData(rgba, tex.width, tex.height);
    canvas.getContext('2d').putImageData(img, 0, 0);
  }, [tex]);

  useEffect(() => {
    if (!initialPos || !Number.isFinite(initialPos.x) || !Number.isFinite(initialPos.y)) return;
    setPos({ x: initialPos.x, y: initialPos.y });
  }, [initialPos?.x, initialPos?.y, tex?.name]);

  if (!tex) return null;

  const startHeaderDrag = (e) => {
    onFocus?.();
    if (e.target.closest('button, input, a, [role="button"]')) return;
    const rect = panelRef.current.getBoundingClientRect();
    headerDrag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHeaderDrag = (e) => {
    if (!headerDrag.current) return;
    setPos(clampWin({
      x: e.clientX - headerDrag.current.dx,
      y: e.clientY - headerDrag.current.dy,
    }, panelRef.current));
  };
  const endHeaderDrag = () => { headerDrag.current = null; };

  const startPan = (e) => {
    if (e.button !== 0) return;
    onFocus?.();
    panDrag.current = { x: e.clientX, y: e.clientY, ox: pan.x, oy: pan.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPanMove = (e) => {
    if (!panDrag.current) return;
    const dx = e.clientX - panDrag.current.x;
    const dy = e.clientY - panDrag.current.y;
    setPan({ x: panDrag.current.ox + dx, y: panDrag.current.oy + dy });
  };
  const endPan = () => { panDrag.current = null; };

  const scale = fitScale * zoom;
  const dispW = Math.max(1, Math.round(tex.width * scale));
  const dispH = Math.max(1, Math.round(tex.height * scale));

  const zoomBy = (factor, cx = VIEW_MAX / 2, cy = VIEW_MAX / 2) => {
    setZoom((z) => {
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(z * factor).toFixed(3)));
      // Keep the point under the cursor stable when zooming via wheel.
      if (next !== z) {
        const k = next / z;
        setPan((p) => ({
          x: cx - (cx - p.x) * k,
          y: cy - (cy - p.y) * k,
        }));
      }
      return next;
    });
  };

  const onWheel = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = viewRef.current?.getBoundingClientRect();
    const cx = rect ? e.clientX - rect.left : VIEW_MAX / 2;
    const cy = rect ? e.clientY - rect.top : VIEW_MAX / 2;
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, cx, cy);
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const setBgPersist = (hex) => {
    setBg(hex);
    try {
      if (hex) localStorage.setItem(BG_KEY, hex);
      else localStorage.removeItem(BG_KEY);
    } catch { /* quota */ }
  };

  const style = pos
    ? { left: pos.x, top: pos.y, transform: 'none', zIndex }
    : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex };

  const pct = Math.round(zoom * 100);
  const panning = !!panDrag.current;
  const solidBg = !!bg;

  return (
    <div className="tex-modal" ref={panelRef} style={style} onPointerDown={onFocus}>
      <div
        className="modal-header"
        onPointerDown={startHeaderDrag}
        onPointerMove={onHeaderDrag}
        onPointerUp={endHeaderDrag}
      >
        <span className="icon">image</span>
        <span className="modal-title mono">{tex.name || '(unnamed)'}</span>
        <div className="tex-zoom-tools" onPointerDown={(e) => e.stopPropagation()}>
          <Tooltip content={solidBg ? 'Background colour (right-click = checker)' : 'Background colour'}>
            <label
              className={`tex-bg-swatch${solidBg ? ' solid' : ''}`}
              style={solidBg ? { '--tex-bg': bg } : undefined}
            >
              <input
                type="color"
                value={bg || '#23262a'}
                aria-label="Background colour"
                onChange={(e) => setBgPersist(e.target.value)}
                onContextMenu={(e) => { e.preventDefault(); setBgPersist(''); }}
              />
            </label>
          </Tooltip>
          <Tooltip content="Zoom out">
            <Button
              type="button"
              className="icon-btn"
              disabled={zoom <= ZOOM_MIN}
              onClick={() => zoomBy(1 / 1.25)}
            >
              <span className="icon">remove</span>
            </Button>
          </Tooltip>
          <Tooltip content="Reset fit">
            <button type="button" className="tex-zoom-pct mono" onClick={resetView}>
              {pct}%
            </button>
          </Tooltip>
          <Tooltip content="Zoom in">
            <Button
              type="button"
              className="icon-btn"
              disabled={zoom >= ZOOM_MAX}
              onClick={() => zoomBy(1.25)}
            >
              <span className="icon">add</span>
            </Button>
          </Tooltip>
        </div>
        <Tooltip content="Close">
          <Button className="icon-btn modal-close" onClick={onClose}>
            <span className="icon">close</span>
          </Button>
        </Tooltip>
      </div>
      <div className="tex-modal-body">
        <div
          ref={viewRef}
          className={`tex-checker${solidBg ? ' solid-bg' : ''}${panning ? ' panning' : ''}`}
          style={solidBg ? { '--tex-bg': bg } : undefined}
          onWheel={onWheel}
          onPointerDown={startPan}
          onPointerMove={onPanMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
        >
          <canvas
            ref={canvasRef}
            className="tex-canvas"
            style={{
              width: dispW,
              height: dispH,
              transform: `translate(${pan.x}px, ${pan.y}px)`,
            }}
          />
        </div>
        <div className="tex-modal-meta mono">
          {tex.width}×{tex.height} · {String(tex.format || '').toUpperCase()}
          {fitScale < 1 && zoom === 1 ? ` · fit ${Math.round(fitScale * 100)}%` : ''}
        </div>
      </div>
    </div>
  );
}

function clampWin(p, panel) {
  const w = panel?.offsetWidth ?? 280;
  const h = panel?.offsetHeight ?? 280;
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}
