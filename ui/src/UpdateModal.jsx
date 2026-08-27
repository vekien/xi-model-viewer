import { useEffect, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { backend } from '../js/backend.js';
import { RELEASES_URL } from '../js/update.js';
import { Tooltip } from './Tooltip.jsx';

// Auto-generated release notes open with a "What's Changed" heading and a
// changelog link nobody needs in a popup; show the middle and let the release
// page carry the rest.
const NOTES_LIMIT = 900;

const openLink = (e, url) => {
  e.preventDefault();
  backend.openUrl(url);
};

/**
 * "A new version is available" notice, raised by the boot update check
 * (js/update.js). OK dismisses it for this version — the next release asks again.
 *
 * @param info {{ version, name, url, notes, current }} from checkForUpdate()
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

  const url = info.url || RELEASES_URL;
  const notes = trimNotes(info.notes);

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

          {notes && <pre className="update-notes mono">{notes}</pre>}

          <a className="help-link" href={url} onClick={(e) => openLink(e, url)}>
            <span className="icon">download</span>
            <span>{info.name || `XI Model Viewer v${info.version}`} — open on GitHub</span>
          </a>
        </div>

        <div className="modal-actions">
          <Button className="active" onClick={onClose}>OK</Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Generated release notes as plain text: drop the boilerplate heading/footer,
 * turn markdown bullets into real ones, shrink the full PR URLs each line ends
 * with down to `#12`, and cap the length. No markdown renderer for four lines of
 * changelog — anyone wanting the real thing has the GitHub link below it.
 */
function trimNotes(body) {
  let text = String(body || '')
    .replace(/^#{1,6}\s*What's Changed\s*/i, '')
    .replace(/\*\*Full Changelog\*\*:.*$/is, '')
    .replace(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/g, '#$1')
    .replace(/^[ \t]*[*-][ \t]+/gm, '• ')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return '';
  if (text.length > NOTES_LIMIT) text = `${text.slice(0, NOTES_LIMIT).trimEnd()}…`;
  return text;
}

function clamp(p, panel) {
  const w = panel?.offsetWidth ?? 420;
  const h = panel?.offsetHeight ?? 320;
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}
