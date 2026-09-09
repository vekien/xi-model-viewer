import { useEffect, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { backend } from '../js/backend.js';
import { Tooltip } from './Tooltip.jsx';

const GITHUB = 'https://github.com/vekien/xi-model-viewer';
const RELEASES = 'https://github.com/vekien/xi-model-viewer/releases';

const GENERAL_CONTROLS = [
  ['Left Mouse', 'Rotate'],
  ['Right Mouse', 'Pan'],
  ['Ctrl + Left Mouse', 'Pan'],
  ['Wheel', 'Zoom'],
];
const ZONE_CONTROLS = [
  ['WASD', 'Move around'],
  ['Shift', 'Speed up'],
  ['Q / E', 'Up and Down'],
  ['Wheel', 'Move speed'],
  ['W / S in Ortho', 'Zoom'],
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
  const [version, setVersion] = useState('');
  const panelRef = useRef(null);
  const dragState = useRef(null);

  useEffect(() => {
    if (open) setPos(null);
  }, [open]);

  // Asked of the shell rather than baked in, so a running build always names
  // its own version. Silence on failure — About is not the place for an error.
  useEffect(() => {
    if (!open || version) return;
    backend.appVersion().then((v) => setVersion(String(v || '').trim())).catch(() => {});
  }, [open, version]);

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
          <section className="help-about">
            <img className="help-logo" src="./icon.png" alt="" width={128} draggable={false} />
            <div className="help-title">XI Model Viewer</div>
            {version && <div className="help-version mono">v{version}</div>}
            <div className="help-badges">
              <span className="help-badge">Built by Vekien</span>
              <span className="help-badge">AI Assisted Dev</span>
            </div>
            <div className="help-links">
              <a className="help-link" href={GITHUB} onClick={(e) => openLink(e, GITHUB)}>
                <span className="icon">code</span>
                <span>Source on GitHub</span>
              </a>
              <a className="help-link" href={RELEASES} onClick={(e) => openLink(e, RELEASES)}>
                <span className="icon">system_update_alt</span>
                <span>Releases &amp; changelog</span>
              </a>
            </div>
          </section>

          <section className="help-controls">
            <div className="help-controls-group">
              <div className="help-controls-title">General Assets</div>
              {GENERAL_CONTROLS.map(([keys, action]) => (
                <div className="help-key-row" key={keys}>
                  <span className="help-keys">{keys}</span>
                  <span className="help-action">{action}</span>
                </div>
              ))}
            </div>
            <div className="help-controls-group">
              <div className="help-controls-title">Zones</div>
              {ZONE_CONTROLS.map(([keys, action]) => (
                <div className="help-key-row" key={keys}>
                  <span className="help-keys">{keys}</span>
                  <span className="help-action">{action}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

      </div>
    </div>
  );
}

function clamp(p, panel) {
  const w = panel?.offsetWidth ?? 640;
  const h = panel?.offsetHeight ?? 420;
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}
