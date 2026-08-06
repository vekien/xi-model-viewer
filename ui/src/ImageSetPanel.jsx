import { useMemo, useState } from 'react';
import { Tooltip } from './Tooltip.jsx';
import { listArrowHandler, useScrollIntoView } from './useListArrows.js';

/**
 * The image sets inside the selected DAT — AltanaView's bottom list, moved to
 * the right so it sits where Zones > Objects does. Reuses the Objects panel's
 * chrome (`#placements`) so the two read as the same kind of surface.
 */
export function ImageSetPanel({ file, sets = [], selected, onSelect, onClose }) {
  const [minimized, setMinimized] = useState(false);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sets;
    return sets.filter((s) => s.name.toLowerCase().includes(q)
      || s.category.toLowerCase().includes(q));
  }, [sets, query]);

  return (
    <div id="placements" className={`panel${minimized ? ' minimized' : ''}`}>
      <div className="plc-header">
        <span className="icon">image</span>
        <span className="plc-title">Images</span>
        <span className="plc-meta mono">{sets.length.toLocaleString()}</span>
        <Tooltip content={minimized ? 'Restore' : 'Minimize'}>
          <button className="icon-btn plc-tool" onClick={() => setMinimized((v) => !v)}>
            <span className="icon">{minimized ? 'open_in_full' : 'remove'}</span>
          </button>
        </Tooltip>
        {onClose && (
          <Tooltip content="Close">
            <button className="icon-btn plc-tool" onClick={onClose}>
              <span className="icon">close</span>
            </button>
          </Tooltip>
        )}
      </div>

      {!minimized && (
        <>
          <div className="plc-search">
            <span className="icon">search</span>
            <input
              type="search"
              placeholder="Filter image set…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
            />
          </div>

          <div
            className="plc-body"
            tabIndex={0}
            onMouseDown={(e) => e.currentTarget.focus({ preventScroll: true })}
            onKeyDown={listArrowHandler(
              filtered,
              filtered.findIndex((s) => selected && s.raw === selected.raw),
              (s) => onSelect?.(s),
            )}
          >
            {!file && <div className="side-note">No image selected.</div>}
            {file && sets.length === 0 && <div className="side-note">No image sets in this file.</div>}
            {sets.length > 0 && filtered.length === 0 && (
              <div className="side-note">No matches for “{query}”.</div>
            )}
            {filtered.map((s) => (
              <SetRow
                key={s.raw}
                set={s}
                selected={!!selected && selected.raw === s.raw}
                onSelect={onSelect}
              />
            ))}
          </div>

          <div className="side-note plc-foot">
            {file ? file.name : ''}
          </div>
        </>
      )}
    </div>
  );
}

function SetRow({ set: s, selected, onSelect }) {
  const ref = useScrollIntoView(selected);
  return (
    <div className={`node${selected ? ' selected' : ''}`}>
      <div className="row" ref={ref} onClick={() => onSelect?.(s)} title={s.textureRef || s.raw}>
        <span className="caret icon" />
        <span className="kind icon">{s.texture ? 'image' : 'broken_image'}</span>
        <span className="img-cat mono-small">{s.category}</span>
        <span className="zone-name">{s.name}</span>
        {s.texture && (
          <span className="mono-small zone-id">
            {s.texture.width}×{s.texture.height}
          </span>
        )}
      </div>
    </div>
  );
}
