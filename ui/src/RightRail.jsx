import { Tooltip } from './Tooltip.jsx';

// The right rail: one round glyph per panel the view offers, in the view's own
// order (the main one first). Hover names the panel; a click opens or closes it,
// and an open panel's glyph is lit. The panels themselves are Floating hosts.

export function RightRail({ items, open, onToggle, top = 12 }) {
  return (
    <div id="right-rail" role="toolbar" aria-label="Panels" style={{ top }}>
      {items.map((it) => (
        <Tooltip key={it.id} content={it.label} placement="left">
          <button type="button" className={`rail-btn${open?.[it.id] ? ' on' : ''}`}
            aria-label={it.label} aria-pressed={open?.[it.id] ? 'true' : 'false'}
            onClick={() => onToggle(it.id)}>
            <span className="icon">{it.icon}</span>
          </button>
        </Tooltip>
      ))}
    </div>
  );
}
