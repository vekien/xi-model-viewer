import { useEffect, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { ZoneMeshPreviewHost } from '../js/zoneMeshPreview.js';
import { bgToHex, parseBgHex } from '../js/particlePreview.js';
import { Tooltip } from './Tooltip.jsx';

const MIN_W = 360;
const MIN_H = 280;
const DEFAULT_W = 480;
const DEFAULT_H = 420;
const DEFAULT_BG = '#0f141c';

export function ZoneMeshPreviewModal({
  title = 'ZoneMesh',
  mesh = null,
  textures = null,
  error = '',
  loading = false,
  onClose,
  onFocus,
  cascadeOffset = 0,
  zIndex = 2010,
}) {
  const panelRef = useRef(null);
  const canvasRef = useRef(null);
  const hostRef = useRef(null);
  const dragState = useRef(null);
  const resizeState = useRef(null);
  const [pos, setPos] = useState(null);
  const [size, setSize] = useState({ w: DEFAULT_W, h: DEFAULT_H });
  const [showGrid, setShowGrid] = useState(true);
  const [bgHex, setBgHex] = useState(DEFAULT_BG);
  const [stats, setStats] = useState('');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || error || !mesh) return undefined;
    let host;
    try {
      host = new ZoneMeshPreviewHost(canvas);
      host.setScene(mesh, textures);
      host.setShowGrid(showGrid);
      host.setBgColor(bgHex);
      host.start();
      hostRef.current = host;
      const tris = host.triCount.toLocaleString();
      const subs = host.subCount.toLocaleString();
      setStats(`${tris} tris · ${subs} submesh${host.subCount === 1 ? '' : 'es'}`);
    } catch (e) {
      console.error('ZoneMesh preview host failed', e);
      return undefined;
    }
    return () => {
      hostRef.current = null;
      host.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mesh, textures, error]);

  useEffect(() => {
    hostRef.current?.setShowGrid(showGrid);
  }, [showGrid]);

  useEffect(() => {
    hostRef.current?.setBgColor(bgHex);
  }, [bgHex]);

  const startDrag = (e) => {
    onFocus?.();
    if (e.target.closest('button, input, a, [role="button"], canvas, .fx-modal-resize')) return;
    const rect = panelRef.current.getBoundingClientRect();
    dragState.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDrag = (e) => {
    if (!dragState.current) return;
    setPos(clampPos({
      x: e.clientX - dragState.current.dx,
      y: e.clientY - dragState.current.dy,
    }, size.w, size.h));
  };
  const endDrag = () => { dragState.current = null; };

  const startResize = (e) => {
    onFocus?.();
    e.preventDefault();
    e.stopPropagation();
    const rect = panelRef.current.getBoundingClientRect();
    if (!pos) setPos({ x: rect.left, y: rect.top });
    resizeState.current = {
      x0: e.clientX, y0: e.clientY, w0: rect.width, h0: rect.height,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e) => {
    if (!resizeState.current) return;
    const { x0, y0, w0, h0 } = resizeState.current;
    const maxW = Math.max(MIN_W, window.innerWidth - 16);
    const maxH = Math.max(MIN_H, window.innerHeight - 16);
    setSize({
      w: Math.min(maxW, Math.max(MIN_W, w0 + (e.clientX - x0))),
      h: Math.min(maxH, Math.max(MIN_H, h0 + (e.clientY - y0))),
    });
  };
  const endResize = () => { resizeState.current = null; };

  const cascade = cascadeOffset * 28;
  const style = {
    width: size.w,
    height: size.h,
    zIndex,
    ...(pos
      ? { left: pos.x, top: pos.y, transform: 'none' }
      : {
        left: `calc(58% + ${cascade}px)`,
        top: `calc(38% + ${cascade}px)`,
        transform: 'translate(-50%, -50%)',
      }),
  };

  return (
    <div className="fx-modal zmesh-modal" ref={panelRef} style={style} onPointerDown={onFocus}>
      <div
        className="modal-header"
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
      >
        <span className="icon">landscape</span>
        <span className="modal-title mono">{title}</span>
        <Tooltip content="Close">
          <Button className="icon-btn modal-close" onClick={onClose}>
            <span className="icon">close</span>
          </Button>
        </Tooltip>
      </div>
      {error ? (
        <div className="fx-modal-body">
          <div className="fx-modal-error">{error}</div>
        </div>
      ) : loading || !mesh ? (
        <div className="fx-modal-body">
          <div className="fx-modal-note">Reading mesh…</div>
        </div>
      ) : (
        <>
          <div className="fx-modal-canvas-wrap">
            <canvas ref={canvasRef} className="fx-modal-canvas" />
          </div>
          <div className="fx-modal-body fx-modal-bar">
            <div className="fx-modal-meta">
              <span className="fx-modal-id mono">{mesh.meshName || title}</span>
              <span className="fx-modal-stats mono">{stats} · unlit</span>
            </div>
            <div className="fx-modal-actions">
              <Tooltip content="Viewport background">
                <label className="fx-modal-bg">
                  <span className="icon">palette</span>
                  <input
                    type="color"
                    value={normalizeColorInput(bgHex)}
                    onChange={(e) => setBgHex(e.target.value)}
                  />
                </label>
              </Tooltip>
              <Tooltip content="Toggle world grid">
                <Button
                  className={`btn${showGrid ? ' active' : ''}`}
                  onClick={() => setShowGrid((v) => !v)}
                >
                  <span className="icon">grid_on</span>
                  Grid
                </Button>
              </Tooltip>
            </div>
          </div>
        </>
      )}
      <Tooltip content="Resize">
        <div
          className="fx-modal-resize"
          onPointerDown={startResize}
          onPointerMove={onResizeMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        />
      </Tooltip>
    </div>
  );
}

function clampPos(p, w, h) {
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}

function normalizeColorInput(hex) {
  return bgToHex(parseBgHex(hex, parseBgHex(DEFAULT_BG)));
}
