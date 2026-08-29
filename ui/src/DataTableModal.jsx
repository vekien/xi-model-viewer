import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { Tooltip } from './Tooltip.jsx';

/**
 * Draggable inspector for menu data tables: SpellList (mgc_), AbilityList (comm),
 * and generic Table (mnc2 / mon_ / levc).
 */
export function DataTableModal({
  table, title = 'Table', onClose, onFocus, zIndex = 2100, initialPos = null,
}) {
  const panelRef = useRef(null);
  const dragState = useRef(null);
  const [pos, setPos] = useState(() => (
    initialPos && Number.isFinite(initialPos.x) && Number.isFinite(initialPos.y)
      ? { x: initialPos.x, y: initialPos.y }
      : null
  ));
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!initialPos || !Number.isFinite(initialPos.x) || !Number.isFinite(initialPos.y)) return;
    setPos({ x: initialPos.x, y: initialPos.y });
  }, [initialPos?.x, initialPos?.y, table?.offset, table?.id]);

  const columns = table?.columns ?? [];
  const allRows = table?.rows ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter((row) => columns.some((c) => {
      const v = row[c.key];
      return v != null && String(v).toLowerCase().includes(q);
    }));
  }, [allRows, columns, query]);

  const shown = filtered.length > 800 ? filtered.slice(0, 800) : filtered;

  if (!table) return null;

  const startDrag = (e) => {
    onFocus?.();
    if (e.target.closest('button, input, a, [role="button"]')) return;
    const rect = panelRef.current.getBoundingClientRect();
    dragState.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDrag = (e) => {
    if (!dragState.current) return;
    setPos(clamp({
      x: e.clientX - dragState.current.dx,
      y: e.clientY - dragState.current.dy,
    }, panelRef.current));
  };
  const endDrag = () => { dragState.current = null; };

  const sheetPair = table?.kind === 'spriteSheet' || table?.kind === 'particleMesh' || table?.kind === 'weightedMesh';
  const tableW = sheetPair ? 'min(560px, 52vw)' : 'min(960px, 96vw)';
  const style = pos
    ? {
      position: 'fixed', left: pos.x, top: pos.y, transform: 'none', zIndex,
      width: tableW, maxHeight: 'min(78vh, 640px)',
    }
    : {
      position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex,
      width: tableW, maxHeight: 'min(78vh, 640px)',
    };

  const icon = table.kind === 'spellList' ? 'auto_fix_high'
    : table.kind === 'abilityList' ? 'bolt'
      : table.kind === 'effectRoutine' ? 'schedule'
        : table.kind === 'spriteSheet' ? 'grid_view'
          : table.kind === 'particleMesh' ? 'change_history'
            : table.kind === 'keyFrame' ? 'timeline'
              : table.kind === 'weightedMesh' ? 'animation'
                : 'table_rows';

  return (
    <div className="zdef-modal datatable-modal" ref={panelRef} style={style} onPointerDown={onFocus}>
      <div
        className="modal-header"
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
      >
        <span className="icon">{icon}</span>
        <span className="modal-title mono">{title}</span>
        <span className="route-count mono">{table.subtitle || ''}</span>
        <Button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="Close">
          <span className="icon">close</span>
        </Button>
      </div>

      {table.note ? (
        <div className="datatable-note">{table.note}</div>
      ) : null}

      <div className="datatable-toolbar">
        <input
          type="search"
          className="list-search datatable-search"
          placeholder="Filter rows…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="datatable-count mono">
          {filtered.length === allRows.length
            ? `${allRows.length.toLocaleString()} rows`
            : `${filtered.length.toLocaleString()} of ${allRows.length.toLocaleString()}`}
        </span>
      </div>

      <div className="zdef-table-wrap">
        <table className="zdef-table">
          <thead>
            <tr>
              {columns.map((c) => {
                if (c.external && c.externalDat) {
                  const tip = [
                    `Name ← ${c.externalDat}`,
                    table.nameDatLabel ? `(${table.nameDatLabel})` : null,
                    table.namesAttached != null
                      ? `${table.namesAttached.toLocaleString()} matched`
                      : 'loading…',
                  ].filter(Boolean).join(' · ');
                  return (
                    <Tooltip key={c.key} content={tip} placement="top">
                      <th className="mono datatable-ext-col">
                        <span className="icon datatable-ext-icon">link</span>
                        {c.label}
                      </th>
                    </Tooltip>
                  );
                }
                return (
                  <th key={c.key} className="mono">{c.label}</th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={Math.max(columns.length, 1)} className="zdef-empty">
                  {allRows.length ? 'No rows match the filter.' : 'No records'}
                </td>
              </tr>
            )}
            {shown.map((row, i) => {
              const offsetTip = row._offset != null ? `0x${row._offset.toString(16)}` : '';
              const tr = (
                <tr key={row.idx ?? row.base ?? i}>
                  {columns.map((c) => {
                    const cell = (
                      <td
                        key={c.key}
                        className={`mono${c.key === 'raw' ? ' zdef-vec' : ''}${c.external ? ' datatable-ext-cell' : ''}`}
                      >
                        {row[c.key] ?? (c.external ? '…' : '')}
                      </td>
                    );
                    if (c.external && row[c.key]) {
                      return (
                        <Tooltip
                          key={c.key}
                          content={`${c.externalDat || 'd_msg'} #${row.idx}`}
                          placement="top"
                        >
                          {cell}
                        </Tooltip>
                      );
                    }
                    return cell;
                  })}
                </tr>
              );
              if (!offsetTip) return tr;
              return (
                <Tooltip key={row.idx ?? row.base ?? i} content={offsetTip} placement="left">
                  {tr}
                </Tooltip>
              );
            })}
          </tbody>
        </table>
        {filtered.length > shown.length && (
          <div className="datatable-more mono">
            Showing first {shown.length.toLocaleString()} — narrow the filter for more.
          </div>
        )}
      </div>
    </div>
  );
}

function clamp(p, panel) {
  const w = panel?.offsetWidth ?? 640;
  const h = panel?.offsetHeight ?? 420;
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}
