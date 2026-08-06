import { useEffect, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { decodeTextureRGBA } from '../js/renderer.js';

/**
 * Draggable floating window showing a single decoded texture on a checkerboard
 * (so alpha is visible). Opened from the Details panel's texture list; title is
 * the texture's name. Small textures are upscaled with crisp nearest-neighbour.
 * Multiple instances can be open at once (cascadeOffset + zIndex from App).
 */
export function TextureModal({ tex, onClose, onFocus, cascadeOffset = 0, zIndex = 210 }) {
  const canvasRef = useRef(null);
  const panelRef = useRef(null);
  const dragState = useRef(null);
  const [pos, setPos] = useState(null);   // null = centered (+ cascade)

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!tex || !canvas) return;
    canvas.width = tex.width;
    canvas.height = tex.height;
    const rgba = decodeTextureRGBA(tex);
    const img = new ImageData(new Uint8ClampedArray(rgba), tex.width, tex.height);
    canvas.getContext('2d').putImageData(img, 0, 0);
  }, [tex]);

  if (!tex) return null;

  const startDrag = (e) => {
    onFocus?.();
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

  // Upscale small textures to ~256px on the long edge; leave large ones ~1:1.
  const scale = Math.max(1, Math.round(256 / Math.max(tex.width, tex.height)));
  const dispW = tex.width * scale, dispH = tex.height * scale;
  const cascade = cascadeOffset * 28;

  const style = pos
    ? { left: pos.x, top: pos.y, transform: 'none', zIndex }
    : { left: `calc(50% + ${cascade}px)`, top: `calc(44% + ${cascade}px)`, transform: 'translate(-50%, -50%)', zIndex };

  return (
    <div className="tex-modal" ref={panelRef} style={style} onPointerDown={onFocus}>
      <div className="modal-header" onPointerDown={startDrag} onPointerMove={onDrag} onPointerUp={endDrag}>
        <span className="icon">image</span>
        <span className="modal-title mono">{tex.name || '(unnamed)'}</span>
        <Button className="icon-btn modal-close" onClick={onClose} title="Close">
          <span className="icon">close</span>
        </Button>
      </div>
      <div className="tex-modal-body">
        <div className="tex-checker">
          <canvas ref={canvasRef} className="tex-canvas" style={{ width: dispW, height: dispH }} />
        </div>
        <div className="tex-modal-meta mono">{tex.width}×{tex.height} · {tex.format.toUpperCase()}</div>
      </div>
    </div>
  );
}

function clamp(p, panel) {
  const w = panel?.offsetWidth ?? 280;
  const h = panel?.offsetHeight ?? 280;
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}
