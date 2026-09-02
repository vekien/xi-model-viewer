import { useEffect, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { backend } from '../js/backend.js';
import { Tooltip } from './Tooltip.jsx';

function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T'));
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch { return iso; }
}

/**
 * File › Database Manager: where the prebuilt Database tables live, when they
 * were baked, and the two ways to refresh them — run `xi mv database` through
 * the connected xi-tools, or import a folder baked elsewhere.
 */
export function DatabaseManagerModal({
  dbDir, xiConnected, updating, refreshTick = 0, onUpdate, onImport, onClose, zIndex = 2170,
}) {
  const panelRef = useRef(null);
  const dragState = useRef(null);
  const [pos, setPos] = useState(null);
  const [manifest, setManifest] = useState(null);
  const [manifestState, setManifestState] = useState('loading');

  // manifest.json is written by every bake; it names the tables and the time.
  useEffect(() => {
    let alive = true;
    setManifestState('loading');
    if (!dbDir) { setManifest(null); setManifestState('none'); return undefined; }
    backend.readTextFile(`${dbDir}\\manifest.json`)
      .then((text) => {
        if (!alive) return;
        if (!text) { setManifest(null); setManifestState('none'); return; }
        try { setManifest(JSON.parse(text)); setManifestState('ok'); } catch { setManifest(null); setManifestState('bad'); }
      })
      .catch(() => { if (alive) { setManifest(null); setManifestState('none'); } });
    return () => { alive = false; };
  }, [dbDir, refreshTick, updating]);

  const startDrag = (e) => {
    if (e.target.closest('button, input, a, [role="button"]')) return;
    const rect = panelRef.current.getBoundingClientRect();
    dragState.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDrag = (e) => {
    if (!dragState.current) return;
    const w = panelRef.current?.offsetWidth ?? 460;
    const h = panelRef.current?.offsetHeight ?? 400;
    setPos({
      x: Math.min(Math.max(e.clientX - dragState.current.dx, 0), Math.max(window.innerWidth - w, 0)),
      y: Math.min(Math.max(e.clientY - dragState.current.dy, 0), Math.max(window.innerHeight - h, 0)),
    });
  };
  const endDrag = () => { dragState.current = null; };
  const style = pos
    ? { position: 'fixed', left: pos.x, top: pos.y, transform: 'none', zIndex }
    : { position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex };

  const tables = manifest?.tables ? Object.keys(manifest.tables) : [];
  const langs = new Set(tables.map((k) => k.split('.').pop()));
  const rows = tables.reduce((n, k) => n + (manifest.tables[k]?.rows ?? 0), 0);

  return (
    <div className="zdef-modal datatable-modal actor-modal dbm-modal" ref={panelRef} style={style}>
      <div className="modal-header" onPointerDown={startDrag} onPointerMove={onDrag} onPointerUp={endDrag}>
        <span className="icon">database</span>
        <span className="modal-title">Database Manager</span>
        <span className="route-count mono">{manifestState === 'ok' ? `${tables.length} tables` : ''}</span>
        <Button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="Close">
          <span className="icon">close</span>
        </Button>
      </div>

      <div className="actor-modal-body">
        <div className="actor-section">Prebuilt tables</div>
        <div className="db-kv">
          <div className="db-kv-k">Folder</div>
          <div className="db-kv-v mono">
            {dbDir || '—'}
            {dbDir && (
              <Tooltip content="Show in Explorer" placement="top">
                <button type="button" className="actor-btn dbm-inline-btn" aria-label="Show folder" onClick={() => backend.revealPath(dbDir).catch(() => {})}>
                  <span className="icon">folder_open</span>
                </button>
              </Tooltip>
            )}
          </div>
          <div className="db-kv-k">Status</div>
          <div className="db-kv-v">
            {manifestState === 'loading' && 'Checking…'}
            {manifestState === 'none' && 'No bake yet — the Database page parses the DATs directly until one exists.'}
            {manifestState === 'bad' && 'manifest.json could not be read.'}
            {manifestState === 'ok' && `${tables.length} table file${tables.length === 1 ? '' : 's'} (${[...langs].map((l) => l.toUpperCase()).join(' + ')}), ${rows.toLocaleString()} rows`}
          </div>
          {manifestState === 'ok' && (
            <>
              <div className="db-kv-k">Baked</div>
              <div className="db-kv-v">{fmtDate(manifest.generated)}{manifest.game ? <span className="dbm-dim"> · from {manifest.game}</span> : null}</div>
            </>
          )}
        </div>

        <div className="actor-section">Update</div>
        <div className="form-hint">
          Runs <code>xi mv database</code> through the connected xi-tools and bakes every table, in both
          languages, straight into the folder above. Output streams to the console panel.
          {!xiConnected && ' Connect xi-tools in Settings › XI Tools first.'}
        </div>
        <div className="actor-actions">
          <button type="button" className="dbf-btn primary" disabled={!xiConnected || updating} onClick={onUpdate}>
            <span className={`icon${updating ? ' spin' : ''}`}>{updating ? 'progress_activity' : 'refresh'}</span>
            {updating ? 'Updating…' : 'Update Database'}
          </button>
        </div>

        <div className="actor-section">Import</div>
        <div className="form-hint">
          Already baked somewhere else (for example <code>xi mv database</code> in a checkout, which writes to
          its <code>mv\db</code>)? Pick that folder and its <code>*.json</code> tables are copied in.
        </div>
        <div className="actor-actions">
          <button type="button" className="dbf-btn" disabled={updating} onClick={onImport}>
            <span className="icon">drive_folder_upload</span>
            Import folder…
          </button>
        </div>
      </div>
    </div>
  );
}
