import { Button } from '@headlessui/react';
import { Tooltip } from './Tooltip.jsx';

/**
 * The banner that says the DAT lists were refreshed from xi-tools at boot.
 *
 * The lists are data — a new gear row or animation only ever adds to what the
 * app can show — so the download itself needs no permission. But it is not done
 * quietly either: something changed under the user, and the panels that were
 * already open are still showing the old copy. Hence a notice that names the
 * lists that moved, offers the reload that makes them take effect, and stays
 * until it is dismissed rather than fading like an export banner.
 *
 * @param info {{ files: string[], bytes: number, error: string | null } | null}
 */

/** `characters.json` → `Characters`; the extension is noise in a sentence. */
const pretty = (name) => String(name)
  .replace(/\.json$/i, '')
  .replace(/[_-]+/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());

const fmtSize = (bytes) => {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

export function ListsToast({ info, onClose }) {
  if (!info) return null;

  const names = (info.files ?? []).map(pretty);
  // Four names is about what fits on one line before it reads as a wall.
  const shown = names.slice(0, 4).join(', ');
  const rest = names.length - 4;
  const size = fmtSize(info.bytes);

  return (
    <div className="export-toast" role="status" aria-live="polite">
      <span className="icon export-toast-icon">cloud_download</span>
      <div className="export-toast-text">
        <div className="export-toast-head">
          <strong>DAT lists updated</strong>
          <span className="export-toast-kind">
            reload to use them{size ? ` · ${size}` : ''}
          </span>
        </div>
        <div className="export-toast-file">
          {shown}{rest > 0 ? ` and ${rest} more` : ''}
        </div>
        {info.error && <div className="export-toast-path">{info.error}</div>}
      </div>
      <Tooltip content="Reload the app so the new lists take effect">
        <Button className="export-toast-open" onClick={() => window.location.reload()}>
          <span className="icon">refresh</span>Reload
        </Button>
      </Tooltip>
      <Tooltip content="Dismiss">
        <Button className="icon-btn export-toast-close" aria-label="Dismiss" onClick={onClose}>
          <span className="icon">close</span>
        </Button>
      </Tooltip>
    </div>
  );
}
