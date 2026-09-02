import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { backend } from '../js/backend.js';
import { Combo } from './Combo.jsx';
import { Tooltip } from './Tooltip.jsx';

const FOLDER_KEY = 'dbExportFolder';

function loadFolder() {
  try { return localStorage.getItem(FOLDER_KEY) || ''; } catch { return ''; }
}

/** Column key → export field name (`stat:STR` → STR, `sub:1` → its registry name). */
function exportKey(col, table) {
  if (col.key.startsWith('stat:')) return col.key.slice(5);
  if (col.key.startsWith('sub:')) return table?.subs?.[+col.key.slice(4)] ?? col.label;
  return col.key;
}

function cellValue(row, key) {
  if (key.startsWith('stat:')) return row.stats?.[key.slice(5)];
  if (key.startsWith('sub:')) return row.subs?.[+key.slice(4)];
  return row[key];
}

const SKIP = new Set(['_search', '_block', 'special', 'layout', 'part']);

/** Every scalar on the row, nested objects flattened with dotted keys. */
function flatRow(row) {
  const out = {};
  const put = (k, v) => {
    if (v == null) return;
    if (typeof v === 'object') {
      if (Array.isArray(v)) { v.forEach((x, i) => put(`${k}.${i}`, x)); return; }
      for (const [kk, vv] of Object.entries(v)) put(`${k}.${kk}`, vv);
      return;
    }
    out[k] = v;
  };
  for (const [k, v] of Object.entries(row)) {
    if (SKIP.has(k)) continue;
    put(k, v);
  }
  return out;
}

/** Full row as JSON-friendly object (nested strings/stats kept). */
function fullRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (SKIP.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function csvCell(v) {
  if (v == null) return '';
  const s = typeof v === 'number' ? String(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(objects, headers) {
  const lines = [headers.map(csvCell).join(',')];
  for (const o of objects) lines.push(headers.map((h) => csvCell(o[h])).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/**
 * File › Export Database: writes the open table as JSON or CSV — either the
 * rows as filtered on screen or the whole table, with the grid's columns or
 * every decoded field.
 */
export function DatabaseExportModal({
  table, lang, doc, rows, columns, filterActive, settings, onClose, onStatus,
}) {
  const [format, setFormat] = useState('json');
  const [scope, setScope] = useState(filterActive ? 'filtered' : 'all');
  const [fieldsMode, setFieldsMode] = useState('grid');
  const [folder, setFolder] = useState(loadFolder);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const nameTouched = useRef(false);

  const ext = format === 'csv' ? 'csv' : 'json';
  const defaultName = `${table.key}.${lang}.${ext}`;
  useEffect(() => {
    if (!nameTouched.current) setName(defaultName);
  }, [defaultName]);

  const exportRows = scope === 'all' ? doc.rows : rows;

  const preview = useMemo(() => {
    const n = exportRows.length;
    const cols = fieldsMode === 'grid' ? columns.length : null;
    return `${n.toLocaleString()} row${n === 1 ? '' : 's'}${cols != null ? ` × ${cols} columns` : ' · all fields'}`;
  }, [exportRows, fieldsMode, columns]);

  const browse = async () => {
    const picked = await backend.pickFolder(folder || settings?.gamePath || '');
    if (picked) {
      setFolder(picked);
      try { localStorage.setItem(FOLDER_KEY, picked); } catch { /* quota */ }
    }
  };

  const doExport = async () => {
    if (!folder) { onStatus?.('Choose an export folder first.'); return; }
    const fileName = (name || defaultName).trim();
    const path = `${folder.replace(/[\\/]+$/, '')}\\${fileName}`;
    setBusy(true);
    try {
      let text;
      if (fieldsMode === 'grid') {
        const keys = columns.map((c) => exportKey(c, table));
        const objects = exportRows.map((r) => {
          const o = {};
          columns.forEach((c, i) => { o[keys[i]] = cellValue(r, c.key) ?? null; });
          return o;
        });
        text = format === 'csv' ? toCsv(objects, keys) : JSON.stringify(objects, null, 2);
      } else if (format === 'csv') {
        const flat = exportRows.map(flatRow);
        const headers = [];
        const seen = new Set();
        for (const o of flat) for (const k of Object.keys(o)) if (!seen.has(k)) { seen.add(k); headers.push(k); }
        text = toCsv(flat, headers);
      } else {
        text = JSON.stringify({
          table: table.key, label: table.label, lang, kind: doc.kind, layout: doc.layout ?? null,
          rows: exportRows.map(fullRow),
        }, null, 2);
      }
      await backend.writeFile(path, new TextEncoder().encode(text));
      onStatus?.(`Exported ${exportRows.length.toLocaleString()} rows → ${path}`);
      onClose();
    } catch (e) {
      onStatus?.(`Export failed: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  const seg = (value, onChange, items, label) => (
    <div className="seg-tabs dbx-seg" role="radiogroup" aria-label={label}>
      {items.map(([id, text, disabled]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          className={`seg-tab${value === id ? ' on' : ''}`}
          disabled={disabled}
          onClick={() => onChange(id)}
        >
          {text}
        </button>
      ))}
    </div>
  );

  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal dbx-modal" style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}>
        <div className="modal-header">
          <span className="icon">download</span>
          <span className="modal-title">Export Database</span>
          <Tooltip content="Close">
            <Button className="icon-btn modal-close" onClick={onClose}>
              <span className="icon">close</span>
            </Button>
          </Tooltip>
        </div>

        <div className="modal-body">
          <div className="export-summary">
            <span className="icon export-glyph">{doc.kind === 'items' ? 'inventory_2' : 'table_rows'}</span>
            <div>
              <div className="export-name">{table.groupLabel} › {table.label}</div>
              <div className="export-details mono">{lang.toUpperCase()} · {preview}</div>
            </div>
          </div>

          <div className="form-row">
            <label className="form-label">Format</label>
            {seg(format, setFormat, [['json', 'JSON'], ['csv', 'CSV']], 'Format')}
          </div>

          <div className="form-row">
            <label className="form-label">Rows</label>
            {seg(scope, setScope, [
              ['filtered', `As shown (${rows.length.toLocaleString()})`, !filterActive && rows.length === doc.rows.length],
              ['all', `Whole table (${doc.rows.length.toLocaleString()})`],
            ], 'Rows')}
          </div>

          <div className="form-row">
            <label className="form-label">Fields</label>
            {seg(fieldsMode, setFieldsMode, [
              ['grid', `Grid columns (${columns.length})`],
              ['all', 'Every decoded field'],
            ], 'Fields')}
            <div className="form-hint">
              {fieldsMode === 'grid'
                ? 'The columns the table shows, in order.'
                : (format === 'csv'
                  ? 'Nested values flattened to dotted headers (strings.name, stats.STR, …).'
                  : 'Full row objects, including strings and parsed stats.')}
            </div>
          </div>

          <div className="form-row">
            <label className="form-label">File name</label>
            <input
              type="text"
              value={name}
              spellCheck={false}
              onChange={(e) => { nameTouched.current = true; setName(e.target.value); }}
            />
          </div>

          <div className="form-row">
            <label className="form-label">Export folder</label>
            <div className="form-inline">
              <input
                type="text"
                value={folder}
                spellCheck={false}
                placeholder="Choose a destination…"
                onChange={(e) => {
                  setFolder(e.target.value);
                  try { localStorage.setItem(FOLDER_KEY, e.target.value); } catch { /* quota */ }
                }}
              />
              <Button onClick={browse}><span className="icon">folder_open</span>Browse</Button>
            </div>
          </div>
        </div>

        <div className="modal-actions">
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button className={`active export-go${busy ? ' busy' : ''}`} onClick={doExport} disabled={busy || !folder}>
            {busy
              ? <><span className="icon spin">progress_activity</span>Exporting…</>
              : <><span className="icon">download</span>Export</>}
          </Button>
        </div>
      </div>
    </div>
  );
}
