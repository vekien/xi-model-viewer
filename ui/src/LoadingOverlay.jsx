/**
 * Full-viewport loading popup — blocks interaction and makes long zone/model
 * loads obvious (status bar alone is easy to miss).
 */
export function LoadingOverlay({ open, title, detail }) {
  if (!open) return null;
  return (
    <div className="loading-overlay" role="status" aria-live="polite" aria-busy="true">
      <div className="loading-card panel">
        <div className="loading-spinner" aria-hidden="true">
          <span className="loading-ring" />
        </div>
        <div className="loading-text">
          <div className="loading-title">{title || 'Loading…'}</div>
          {detail && <div className="loading-detail mono">{detail}</div>}
        </div>
      </div>
    </div>
  );
}
