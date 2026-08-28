import { useEffect, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { backend } from '../js/backend.js';
import { Tooltip } from './Tooltip.jsx';

const GITHUB = 'https://github.com/vekien/xi-model-viewer';

const GENERAL_CONTROLS = [
  ['Left Mouse', 'Rotate'],
  ['Right Mouse', 'Pan'],
  ['Wheel', 'Zoom'],
];
const ZONE_CONTROLS = [
  ['WASD', 'Move around'],
  ['Q / E', 'Up and Down'],
  ['Wheel', 'Move speed'],
];

const openLink = (e, url) => {
  e.preventDefault();
  backend.openUrl(url);
};

/**
 * About / Help dialog — logo, credits, short blurb, and support links.
 */
export function HelpModal({ open, onClose }) {
  const [pos, setPos] = useState(null);
  const panelRef = useRef(null);
  const dragState = useRef(null);

  useEffect(() => {
    if (open) setPos(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
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

  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal help-modal" ref={panelRef} style={style}>
        <div
          className="modal-header"
          onPointerDown={startDrag}
          onPointerMove={onDrag}
          onPointerUp={endDrag}
        >
          <span className="icon">star</span>
          <span className="modal-title">About</span>
          <Tooltip content="Close">
            <Button className="icon-btn modal-close" onClick={onClose}>
              <span className="icon">close</span>
            </Button>
          </Tooltip>
        </div>

        <div className="modal-body help-body">
          <img className="help-logo" src="./icon.png" alt="XI Model Viewer" width={140} draggable={false} />
          <div className="help-title">XI Model Viewer</div>
          <div className="help-badges">
            <span className="help-badge">Built by Vekien</span>
            <span className="help-badge">AI Assisted Dev</span>
          </div>

          <div className="help-controls">
            <div className="help-controls-group">
              <div className="help-controls-title">General Assets</div>
              {GENERAL_CONTROLS.map(([keys, action]) => (
                <div className="help-key-row" key={action}>
                  <span className="help-keys">{keys}</span>
                  <span className="help-action">{action}</span>
                </div>
              ))}
            </div>
            <div className="help-controls-group">
              <div className="help-controls-title">Zones</div>
              {ZONE_CONTROLS.map(([keys, action]) => (
                <div className="help-key-row" key={action}>
                  <span className="help-keys">{keys}</span>
                  <span className="help-action">{action}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="help-links">
            <a className="help-link" href={GITHUB} onClick={(e) => openLink(e, GITHUB)}>
              <span className="icon">code</span>
              <span>GitHub — vekien/xi-model-viewer</span>
            </a>
          </div>
        </div>

      </div>
    </div>
  );
}

function clamp(p, panel) {
  const w = panel?.offsetWidth ?? 380;
  const h = panel?.offsetHeight ?? 420;
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}
