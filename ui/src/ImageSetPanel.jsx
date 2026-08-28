import { useMemo, useState } from 'react';
import { Tooltip } from './Tooltip.jsx';
import { listArrowHandler, useScrollIntoView } from './useListArrows.js';

/**
 * The image sets inside the selected DAT — AltanaView's bottom list, moved to
 * the right so it sits where Zones > Objects does. Reuses the Objects panel's
 * chrome (`#placements`) so the two read as the same kind of surface.
 *
 * Title/lobby packs also inject bare 0x20 textures as `kind: 'texture'` rows
 * so logos and wardrb show up even when the only 0x31 set points elsewhere.
 */
export function ImageSetPanel({
  file, sets = [], selected, onSelect, onClose, titlePack = false, spriteCount = 0,
}) {
  const [minimized, setMinimized] = useState(false);
  const [query, setQuery] = useState('');

  const { setRows, texRows } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (s) => !q
      || s.name.toLowerCase().includes(q)
      || s.category.toLowerCase().includes(q)
      || (s.textureRef || '').toLowerCase().includes(q);
    return {
      setRows: sets.filter((s) => s.kind !== 'texture' && match(s)),
      texRows: sets.filter((s) => s.kind === 'texture' && match(s)),
    };
  }, [sets, query]);

  const flat = useMemo(() => [...setRows, ...texRows], [setRows, texRows]);
  const selectedIdx = flat.findIndex((s) => selected && s.raw === selected.raw);

  return (
    <div id="placements" className={`panel${minimized ? ' minimized' : ''}`}>
      <div className="plc-header">
        <span className="icon">image</span>
        <span className="plc-title">Images</span>
        <span className="plc-meta mono">{sets.length.toLocaleString()}</span>
        {titlePack && <span className="img-badge mono-small">title pack</span>}
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
              placeholder="Filter image set / texture…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
            />
          </div>

          <div
            className="plc-body"
            tabIndex={0}
            onMouseDown={(e) => e.currentTarget.focus({ preventScroll: true })}
            onKeyDown={listArrowHandler(flat, selectedIdx, (s) => onSelect?.(s))}
          >
            {!file && <div className="side-note">No image selected.</div>}
            {file && sets.length === 0 && <div className="side-note">No image sets in this file.</div>}
            {sets.length > 0 && flat.length === 0 && (
              <div className="side-note">No matches for “{query}”.</div>
            )}

            {setRows.length > 0 && (
              <>
                <div className="img-section-label">Image sets</div>
                {setRows.map((s) => (
                  <SetRow
                    key={s.raw}
                    set={s}
                    selected={!!selected && selected.raw === s.raw}
                    onSelect={onSelect}
                  />
                ))}
              </>
            )}

            {texRows.length > 0 && (
              <>
                <div className="img-section-label">
                  Textures
                  <span className="mono-small img-section-meta">in this DAT</span>
                </div>
                {texRows.map((s) => (
                  <SetRow
                    key={s.raw}
                    set={s}
                    selected={!!selected && selected.raw === s.raw}
                    onSelect={onSelect}
                  />
                ))}
              </>
            )}
          </div>

          <div className="side-note plc-foot">
            {file ? file.name : ''}
            {spriteCount > 0 && (
              <span className="mono-small"> · {spriteCount.toLocaleString()} sprites</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SetRow({ set: s, selected, onSelect }) {
  const ref = useScrollIntoView(selected);
  const isTex = s.kind === 'texture';
  return (
    <div className={`node${selected ? ' selected' : ''}`}>
      <Tooltip content={s.textureRef || s.raw}>
        <div
          className="row"
          ref={ref}
          onClick={() => onSelect?.(s)}
        >
          <span className="caret icon" />
          <span className="kind icon">
            {isTex ? 'texture' : (s.texture ? 'image' : 'broken_image')}
          </span>
          <span className="img-cat mono-small">{s.category}</span>
          <span className="zone-name">{s.name}</span>
          {s.texture && (
            <span className="mono-small zone-id">
              {s.texture.width}×{s.texture.height}
            </span>
          )}
          {!s.texture && !isTex && (
            <Tooltip content="Texture lives in another DAT">
              <span className="mono-small zone-id img-ext">ext</span>
            </Tooltip>
          )}
        </div>
      </Tooltip>
    </div>
  );
}
