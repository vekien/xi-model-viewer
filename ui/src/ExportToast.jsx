import { useEffect, useRef } from 'react';
import { Button } from '@headlessui/react';
import { backend } from '../js/backend.js';
import { Tooltip } from './Tooltip.jsx';

/**
 * The banner that says a File > Export finished. The status line alone is easy
 * to miss — and the xi exports close their dialog the moment they start, so
 * until this there was nothing on screen to say the run had landed.
 *
 * A success fades itself out; a failure stays until it is dismissed, so the
 * message can be read.
 */
const DISMISS_MS = 9000;

export function ExportToast({ result, onClose, onStatus }) {
  // Through a ref, not the dep list: App re-renders several times a second while
  // a track plays, and a fresh `onClose` identity each time restarted the timer
  // so the banner never actually went away.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!result?.ok) return undefined;
    const t = window.setTimeout(() => closeRef.current?.(), DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [result]);

  if (!result) return null;

  // xi names its own output, so the file we predicted may not be the file it
  // wrote — fall back to the folder, which is the part we do know.
  const reveal = async () => {
    for (const p of [result.path, result.folder]) {
      if (!p) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await backend.revealPath(p);
        return;
      } catch { /* try the folder */ }
    }
    onStatus?.('Could not open the export folder.');
  };

  return (
    <div className={`export-toast${result.ok ? '' : ' fail'}`} role="status" aria-live="polite">
      <span className="icon export-toast-icon">{result.ok ? 'check_circle' : 'error'}</span>
      <div className="export-toast-text">
        <div className="export-toast-head">
          <strong>{result.ok ? 'Export complete' : 'Export failed'}</strong>
          {result.kind && <span className="export-toast-kind">{result.kind}</span>}
        </div>
        <div className="export-toast-file mono">{result.ok ? result.file : result.error}</div>
        {result.ok && result.folder && <div className="export-toast-path mono">{result.folder}</div>}
      </div>
      {result.ok && (
        <Tooltip content="Show in Explorer">
          <Button className="export-toast-open" onClick={reveal}>
            <span className="icon">folder_open</span>Open folder
          </Button>
        </Tooltip>
      )}
      <Tooltip content="Dismiss">
        <Button className="icon-btn export-toast-close" aria-label="Dismiss" onClick={onClose}>
          <span className="icon">close</span>
        </Button>
      </Tooltip>
    </div>
  );
}
