import { useEffect, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { ParticlePreviewHost, bgToHex, parseBgHex } from '../js/particlePreview.js';

const MIN_W = 360;
const MIN_H = 280;
const DEFAULT_W = 480;
const DEFAULT_H = 420;
const DEFAULT_BG = '#0f141c';

/**
 * Floating particle preview — own WebGL canvas, independent of the main view.
 * Drag header to move; drag canvas to orbit; wheel to zoom; corner to resize.
 */
export function ParticlePreviewModal({
  title = 'ParticleGenerator',
  genId = '',
  system = null,
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
  const [playing, setPlaying] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [bgHex, setBgHex] = useState(DEFAULT_BG);
  const [liveCount, setLiveCount] = useState(0);
  const [drawnCount, setDrawnCount] = useState(0);
  const [genInfo, setGenInfo] = useState('');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || error || !system) return undefined;
    let host;
    let poll;
    try {
      host = new ParticlePreviewHost(canvas);
      host.setScene(system, textures, genId);
      host.setPlaying(true);
      host.setShowGrid(showGrid);
      host.setBgColor(bgHex);
      host.start();
      hostRef.current = host;
      setLiveCount(host.getLiveCount());
      setDrawnCount(host.getDrawStats().drawn);
      poll = window.setInterval(() => {
        if (!hostRef.current) return;
        const st = hostRef.current.getStatus();
        setLiveCount(st.live);
        setDrawnCount(st.drawn);
        const g = st.gens?.[0];
        setGenInfo(g
          ? `${g.invalid ? 'invalid ' : ''}${g.culled ? 'culled ' : ''}emitted ${g.emitted} · active ${g.active}`
          : 'no generator');
      }, 250);
    } catch (e) {
      console.error('Particle preview host failed', e);
      return undefined;
    }
    return () => {
      if (poll) window.clearInterval(poll);
      hostRef.current = null;
      host.dispose();
    };
    // showGrid / bgHex applied via separate effects so host isn't rebuilt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [system, textures, error, genId]);

  useEffect(() => {
    hostRef.current?.setPlaying(playing);
  }, [playing]);

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
    // Pin top-left so resize grows down/right from current screen position.
    if (!pos) setPos({ x: rect.left, y: rect.top });
    resizeState.current = {
      x0: e.clientX,
      y0: e.clientY,
      w0: rect.width,
      h0: rect.height,
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
    <div className="fx-modal" ref={panelRef} style={style} onPointerDown={onFocus}>
      <div
        className="modal-header"
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
      >
        <span className="icon">auto_awesome</span>
        <span className="modal-title mono">{title || genId || 'ParticleGenerator'}</span>
        <Button className="icon-btn modal-close" onClick={onClose} title="Close">
          <span className="icon">close</span>
        </Button>
      </div>
      {error ? (
        <div className="fx-modal-body">
          <div className="fx-modal-error">{error}</div>
        </div>
      ) : loading || !system ? (
        <div className="fx-modal-body">
          <div className="fx-modal-note">Loading generator…</div>
        </div>
      ) : (
        <>
          <div className="fx-modal-canvas-wrap">
            <canvas ref={canvasRef} className="fx-modal-canvas" />
          </div>
          <div className="fx-modal-body fx-modal-bar">
            <div className="fx-modal-meta">
              <span className="fx-modal-id mono">{genId}</span>
              <span className="fx-modal-stats mono">
                {liveCount.toLocaleString()} live · {drawnCount.toLocaleString()} drawn
                {genInfo ? ` · ${genInfo}` : ''}
              </span>
            </div>
            <div className="fx-modal-actions">
              <label className="fx-modal-bg" title="Viewport background">
                <span className="icon">palette</span>
                <input
                  type="color"
                  value={normalizeColorInput(bgHex)}
                  onChange={(e) => setBgHex(e.target.value)}
                />
              </label>
              <Button
                className={`btn${showGrid ? ' active' : ''}`}
                onClick={() => setShowGrid((v) => !v)}
                title="Toggle world grid"
              >
                <span className="icon">grid_on</span>
                Grid
              </Button>
              <Button className="btn" onClick={() => setPlaying((p) => !p)}>
                <span className="icon">{playing ? 'pause' : 'play_arrow'}</span>
                {playing ? 'Pause' : 'Play'}
              </Button>
              <Button
                className="btn"
                onClick={() => {
                  hostRef.current?.restart();
                  setPlaying(true);
                }}
              >
                <span className="icon">replay</span>
                Restart
              </Button>
            </div>
          </div>
        </>
      )}
      <div
        className="fx-modal-resize"
        title="Resize"
        onPointerDown={startResize}
        onPointerMove={onResizeMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
      />
    </div>
  );
}

function clampPos(p, w, h) {
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}

/** `<input type="color">` needs a full #rrggbb value. */
function normalizeColorInput(hex) {
  return bgToHex(parseBgHex(hex, parseBgHex(DEFAULT_BG)));
}
