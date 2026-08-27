import { useEffect, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { backend } from '../js/backend.js';
import { RELEASES_URL } from '../js/update.js';
import { Tooltip } from './Tooltip.jsx';

const openLink = (e, url) => {
  e.preventDefault();
  backend.openUrl(url);
};

/** Format asset size from GitHub (bytes) for the download button. */
function fmtSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Update notice from boot check or File → Check for Updates.
 * `info.upToDate` shows a compact "All up to date!" panel (no download).
 *
 * @param info {{ upToDate?: boolean, version?, name?, url?, downloadUrl?, downloadName?, downloadBytes?, current?, latest? }}
 */
export function UpdateModal({ open, info, onClose }) {
  const [pos, setPos] = useState(null);
  const panelRef = useRef(null);
  const dragState = useRef(null);

  useEffect(() => {
    if (open) setPos(null);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const clampNow = () => setPos((p) => (p ? clamp(p, panelRef.current) : p));
    window.addEventListener('resize', clampNow);
    return () => window.removeEventListener('resize', clampNow);
  }, [open]);

  if (!open || !info) return null;

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

  if (info.upToDate) {
    const ver = info.current || info.latest || '';
    return (
      <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="modal update-modal update-modal-ok" ref={panelRef} style={style}>
          <div
            className="modal-header"
            onPointerDown={startDrag}
            onPointerMove={onDrag}
            onPointerUp={endDrag}
          >
            <span className="icon">check_circle</span>
            <span className="modal-title">Check for Updates</span>
            <Tooltip content="Close" placement="left">
              <Button className="icon-btn modal-close" aria-label="Close" onClick={onClose}>
                <span className="icon">close</span>
              </Button>
            </Tooltip>
          </div>

          <div className="modal-body update-body">
            <div className="update-ok-hero">
              <span className="icon update-ok-hero-icon">verified</span>
              <div className="update-ok-title">All up to date!</div>
              {ver ? (
                <div className="update-ok-ver mono">You're running v{ver}</div>
              ) : null}
            </div>
          </div>

          <div className="modal-actions">
            <Button className="update-dismiss" onClick={onClose}>OK</Button>
          </div>
        </div>
      </div>
    );
  }

  const url = info.url || RELEASES_URL;
  const downloadUrl = info.downloadUrl || '';
  const downloadLabel = info.downloadName
    || (downloadUrl ? downloadUrl.split('/').pop() : '')
    || `XI-Model-Viewer-v${info.version}.exe`;
  const sizeLabel = fmtSize(info.downloadBytes);

  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal update-modal" ref={panelRef} style={style}>
        <div
          className="modal-header"
          onPointerDown={startDrag}
          onPointerMove={onDrag}
          onPointerUp={endDrag}
        >
          <span className="icon">system_update_alt</span>
          <span className="modal-title">Update available</span>
          <Tooltip content="Close" placement="left">
            <Button className="icon-btn modal-close" aria-label="Close" onClick={onClose}>
              <span className="icon">close</span>
            </Button>
          </Tooltip>
        </div>

        <div className="modal-body update-body">
          <div className="update-lede">
            A new version of XI Model Viewer has been released.
            Click the button below to download, or click OK to continue and skip this update.
          </div>

          <div className="update-versions">
            <div className="update-ver">
              <div className="update-ver-label">Installed</div>
              <div className="update-ver-num mono">{info.current ? `v${info.current}` : 'unknown'}</div>
            </div>
            <span className="icon update-arrow">arrow_forward</span>
            <div className="update-ver latest">
              <div className="update-ver-label">Latest</div>
              <div className="update-ver-num mono">v{info.version}</div>
            </div>
          </div>

          {downloadUrl ? (
            <button
              type="button"
              className="update-dl-btn"
              onClick={(e) => openLink(e, downloadUrl)}
            >
              <span className="icon update-dl-icon">download</span>
              <span className="update-dl-text">
                <span className="update-dl-title">Download update</span>
                <span className="update-dl-meta mono">
                  {downloadLabel}
                  {sizeLabel ? ` · ${sizeLabel}` : ''}
                </span>
              </span>
            </button>
          ) : null}

          <a className="help-link update-link update-link-secondary" href={url} onClick={(e) => openLink(e, url)}>
            <span className="icon">open_in_new</span>
            <span>View release on GitHub</span>
          </a>
        </div>

        <div className="modal-actions">
          <Button onClick={onClose}>OK</Button>
        </div>
      </div>
    </div>
  );
}

function clamp(p, panel) {
  const w = panel?.offsetWidth ?? 420;
  const h = panel?.offsetHeight ?? 280;
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}
