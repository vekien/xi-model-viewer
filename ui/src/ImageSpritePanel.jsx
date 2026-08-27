import { useMemo, useState } from 'react';
import { Tooltip } from './Tooltip.jsx';
import { listArrowHandler, useScrollIntoView } from './useListArrows.js';
import { spritesForTexture } from '../js/images.js';

/** Drop placeholder / control payloads when listing unfiltered. */
function isListableSprite(s) {
  const w = s?.src?.w ?? 0;
  const h = s?.src?.h ?? 0;
  if (!(w > 0 && h > 0)) return false;
  if (w >= 2048 || h >= 2048) return false;
  const d = s?.dest;
  if (!d) return false;
  const max = Math.max(d.x0, d.x1, d.x2, d.x3, d.y0, d.y1, d.y2, d.y3);
  if (max >= 4096) return false;
  return true;
}

/**
 * Sprite rows from the open image DAT's 0x31 layout blob(s).
 *
 * Sits under the Images panel. When a local texture (or a set that resolves to
 * one) is selected, the list filters to sprites that sample that atlas.
 */
export function ImageSpritePanel({
  sprites = [],
  selectedSet,
  selectedSprite,
  onSelect,
  onClose,
}) {
  const [minimized, setMinimized] = useState(false);
  const [query, setQuery] = useState('');
  const [onlySelected, setOnlySelected] = useState(true);

  // Prefer the list row bare id (abxy360) — texture.name may still be the
  // 16-byte "menu    abxy360" field from the DAT.
  const texName = selectedSet?.name || selectedSet?.texture?.name || '';

  const texture = selectedSet?.texture || null;

  const rows = useMemo(() => {
    // Filtered: owner == this atlas (+ src fits texture).
    // Unfiltered: drop huge/non-sprite junk only.
    let list = onlySelected && texName
      ? spritesForTexture(sprites, texName, texture)
      : sprites.filter(isListableSprite);
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((s) => (
        (s.owner || '').toLowerCase().includes(q)
        || (s.header || '').toLowerCase().includes(q)
        || (s.parent || '').toLowerCase().includes(q)
        || String(s.offset).includes(q)
        || `0x${s.offset.toString(16)}`.includes(q)
      ));
    }
    return list;
  }, [sprites, onlySelected, texName, texture, query]);

  const selectedIdx = rows.findIndex((s) => selectedSprite && s.offset === selectedSprite.offset);

  if (!sprites.length) return null;

  return (
    <div id="img-sprites" className={`panel${minimized ? ' minimized' : ''}`}>
      <div className="plc-header">
        <span className="icon">grid_view</span>
        <span className="plc-title">Sprites</span>
        <span className="plc-meta mono">{rows.length.toLocaleString()}
          {rows.length !== sprites.length ? ` / ${sprites.length}` : ''}
        </span>
        <Tooltip content={onlySelected ? 'Showing sprites for the selected texture — click for all' : 'Showing all sprites — click to filter by selection'}>
          <button
            type="button"
            className={`icon-btn plc-tool${onlySelected ? ' on' : ''}`}
            onClick={() => setOnlySelected((v) => !v)}
          >
            <span className="icon">{onlySelected ? 'filter_alt' : 'filter_alt_off'}</span>
          </button>
        </Tooltip>
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
              placeholder="Filter owner / header / offset…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
            />
          </div>

          <div
            className="plc-body"
            tabIndex={0}
            onMouseDown={(e) => e.currentTarget.focus({ preventScroll: true })}
            onKeyDown={listArrowHandler(rows, selectedIdx, (s) => onSelect?.(s))}
          >
            {rows.length === 0 && (
              <div className="side-note">
                {onlySelected && texName
                  ? `No sprites owned by “${texName}”.`
                  : 'No sprites match.'}
              </div>
            )}
            {rows.map((s) => (
              <SpriteRow
                key={`${s.offset}-${s.index}`}
                sprite={s}
                selected={!!selectedSprite && selectedSprite.offset === s.offset}
                onSelect={onSelect}
              />
            ))}
          </div>

          <div className="side-note plc-foot img-sprite-detail">
            {selectedSprite ? formatSpriteDetail(selectedSprite) : (
              onlySelected && texName
                ? `Filtered to owner “${texName}”`
                : 'Select a sprite for dest / src detail'
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SpriteRow({ sprite: s, selected, onSelect }) {
  const ref = useScrollIntoView(selected);
  // Source size on the atlas (what the overlay draws), not dest screen box.
  const sw = s.src?.w ?? 0;
  const sh = s.src?.h ?? 0;
  return (
    <div className={`node${selected ? ' selected' : ''}`}>
      <div
        className="row img-sprite-row"
        ref={ref}
        onClick={() => onSelect?.(s)}
        title={`atlas “${s.owner}” · src ${sw}×${sh}@(${s.src?.x},${s.src?.y}) · @0x${s.offset.toString(16)}`}
      >
        <span className="caret icon" />
        <span className="kind icon">crop_free</span>
        <span className="zone-name">
          <span className="img-sprite-owner">{s.owner || '?'}</span>
          {s.header && s.header !== s.owner && (
            <span className="mono-small img-sprite-hdr"> · after {s.header}</span>
          )}
        </span>
        <span className="mono-small zone-id">
          {sw}×{sh}
        </span>
      </div>
    </div>
  );
}

function formatSpriteDetail(s) {
  const d = s.dest;
  const r = s.src;
  return (
    <>
      <div>
        <span className="mono-small">@{`0x${s.offset.toString(16)}`}</span>
        {' · '}owner <b>{s.owner}</b>
        {s.parent ? <> · parent <b>{s.parent}</b></> : null}
      </div>
      <div className="mono-small">
        dest ({d.x0},{d.y0})–({d.x3},{d.y3})
        {' · '}
        src {r.w}×{r.h} @ ({r.x},{r.y})
      </div>
    </>
  );
}
