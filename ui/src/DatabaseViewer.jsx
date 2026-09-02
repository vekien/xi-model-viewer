import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { backend } from '../js/backend.js';
import { gameCandidates, normRel } from '../js/gamePath.js';
import {
  decodeItemIcon, dmsgTableFromJson, hexOf, itemBlockAt, itemTableFromJson, parseDmsgTable,
  parseItemTable, tablePaths, ITEM_FLAGS, ITEM_LAYOUTS,
} from '../js/database.js';
import { Tooltip } from './Tooltip.jsx';
import { DatabaseFilter } from './DatabaseFilter.jsx';
import { DatabaseExportModal } from './DatabaseExportModal.jsx';
import { fieldsFor } from '../js/dbFilter.js';

const ROW_H = 26;
const OVERSCAN = 12;

/** Loaded tables, keyed `${table.key}:${lang}`. */
const docCache = new Map();

/** Drop every loaded table (after `xi mv database` rewrites the JSON). */
export function invalidateDbCache() {
  docCache.clear();
}

/**
 * The viewer's own database folder: `%LOCALAPPDATA%\\XiModelViewer\\db`.
 * File › Update Database bakes straight into it and File › Import Database
 * copies a `mv/db` folder in, so it works whichever xi-tools checkout the
 * JSON came from.
 */
export async function dbDataDir() {
  const base = await backend.userDataDir();
  return `${String(base).replace(/[\\/]+$/, '')}\\db`;
}

/** Folders searched for `<table>.<lang>.json`, first hit wins. */
export async function prebuiltDirs(settings) {
  const dirs = [];
  try { dirs.push(await dbDataDir()); } catch { /* browser shim without user-data */ }
  const xi = (settings?.xiPath || '').trim();
  if (xi) dirs.push(`${xi.replace(/[\\/]+$/, '')}\\mv\\db`);
  return dirs;
}

/**
 * Prebuilt JSON from `xi mv database` — the app's db folder first, then the
 * connected xi-tools' mv/db. When it is there we skip the DAT reads
 * entirely; the DAT is only touched later, lazily, for a picked item's icon.
 */
async function readPrebuilt(table, lang, settings) {
  for (const dir of await prebuiltDirs(settings)) {
    const path = `${dir}\\${table.key}.${lang}.json`;
    if (!(await backend.fileExists(path))) continue;
    const data = await backend.readFile(path);
    const json = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(data)));
    return { json, path };
  }
  return null;
}

/**
 * Copy every `*.json` from a `mv/db` folder into the app's db folder.
 * @returns {{ copied: number, dir: string }}
 */
export async function importDbFolder(srcDir) {
  const dst = await dbDataDir();
  const src = String(srcDir).replace(/[\\/]+$/, '');
  const entries = await backend.listDir(src);
  const files = entries.filter((e) => !e.is_dir && /\.json$/i.test(e.name));
  if (!files.length) throw new Error(`no .json tables in ${src}`);
  for (const f of files) {
    const data = await backend.readFile(`${src}\\${f.name}`);
    await backend.writeFile(`${dst}\\${f.name}`, data);
  }
  return { copied: files.length, dir: dst };
}

async function loadTable(table, lang, settings) {
  const ck = `${table.key}:${lang}`;
  if (docCache.has(ck)) return docCache.get(ck);
  const rels = tablePaths(table, lang).map(normRel);
  const parts = rels.map((rel) => ({ rel, path: null, buffer: null }));

  let doc;
  let source;
  const pre = await readPrebuilt(table, lang, settings).catch(() => null);
  if (pre) {
    doc = table.kind === 'items'
      ? itemTableFromJson(pre.json, table)
      : dmsgTableFromJson(pre.json, table);
    source = { kind: 'prebuilt', path: pre.path, generated: pre.json.generated };
  } else {
    const buffers = [];
    for (const part of parts) {
      try {
        const { path, data } = await backend.readPrefer(gameCandidates(part.rel, settings));
        part.path = path;
        part.buffer = data;
        buffers.push(data);
      } catch (e) {
        // A missing expansion DAT just drops that part.
        if (parts.length === 1) throw e;
        buffers.push(null);
      }
    }
    if (table.kind === 'items') doc = parseItemTable(buffers, table, lang);
    else {
      doc = parseDmsgTable(buffers[0], table);
      if (!doc) throw new Error(`${parts[0].rel} is not a d_msg table`);
    }
    source = { kind: 'dat' };
  }
  const entry = { doc, parts, source, table, lang };
  docCache.set(ck, entry);
  return entry;
}

/** The DAT bytes behind one part, read on demand (icons from prebuilt rows). */
async function partBuffer(entry, part, settings) {
  const p = entry.parts[part];
  if (!p) return null;
  if (!p.buffer) {
    const { path, data } = await backend.readPrefer(gameCandidates(p.rel, settings));
    p.path = path;
    p.buffer = data;
  }
  return p.buffer;
}

const STAT_COLS = ['HP', 'MP', 'STR', 'DEX', 'VIT', 'AGI', 'INT', 'MND', 'CHR'];

function columnsFor(doc) {
  if (doc.kind === 'items') {
    const L = doc.layout;
    const cols = [
      { key: 'id', label: 'ID', w: 64, num: true },
      { key: 'name', label: 'Name', w: 210 },
    ];
    if (!ITEM_LAYOUTS.has(L)) {
      cols.push({ key: 'summary', label: 'Contents', w: 200 });
      cols.push({ key: 'hex', label: 'Header (hex)', w: 620, mono: true });
      return cols;
    }
    if (L === 'armor' || L === 'weapon') {
      cols.push({ key: 'level', label: 'Lvl', w: 44, num: true });
      cols.push({ key: 'itemLevel', label: 'iLvl', w: 44, num: true });
      if (L === 'weapon') {
        cols.push({ key: 'skillName', label: 'Skill', w: 104 });
        cols.push({ key: 'damage', label: 'DMG', w: 48, num: true });
        cols.push({ key: 'delay', label: 'Delay', w: 52, num: true });
      }
      cols.push({ key: 'slotsText', label: 'Slots', w: 104 });
      cols.push({ key: 'jobsText', label: 'Jobs', w: 190 });
      cols.push({ key: 'racesText', label: 'Races', w: 96 });
      if (L === 'armor') cols.push({ key: 'stat:DEF', label: 'DEF', w: 48, num: true });
      for (const s of STAT_COLS) cols.push({ key: `stat:${s}`, label: s, w: 44, num: true });
      cols.push({ key: 'other', label: 'Other', w: 420 });
      cols.push({ key: 'flagsText', label: 'Flags', w: 220 });
      return cols;
    }
    cols.push({ key: 'typeName', label: 'Type', w: 110 });
    cols.push({ key: 'stack', label: 'Stack', w: 50, num: true });
    if (L === 'usable') cols.push({ key: 'castTime', label: 'Cast', w: 50, num: true });
    if (L === 'instinct') {
      cols.push({ key: 'level', label: 'Lvl', w: 44, num: true });
      cols.push({ key: 'instinctCost', label: 'Cost', w: 50, num: true });
      cols.push({ key: 'other', label: 'Effects', w: 300 });
    }
    if (L === 'puppet') {
      cols.push({ key: 'puppetSlot', label: 'Slot', w: 50, num: true });
      cols.push({ key: 'elementCharge', label: 'Elem', w: 90, num: true });
    }
    cols.push({ key: 'flagsText', label: 'Flags', w: 220 });
    cols.push({ key: 'description', label: 'Description', w: 460 });
    return cols;
  }
  const cols = [{ key: 'idx', label: '#', w: 56, num: true }];
  const names = doc.table?.subs || [];
  for (let i = 0; i < doc.maxSubs; i++) {
    const n = names[i] ?? `sub${i}`;
    const wide = /description|help|text|format/.test(n);
    cols.push({ key: `sub:${i}`, label: n, w: wide ? 520 : 170 });
  }
  return cols;
}

function cellValue(row, key) {
  if (key.startsWith('stat:')) return row.stats?.[key.slice(5)];
  if (key.startsWith('sub:')) return row.subs?.[+key.slice(4)];
  return row[key];
}

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  return String(v).replace(/\s*\n\s*/g, ' ');
}

function rowSearchText(row, columns) {
  if (row._search == null) {
    row._search = columns.map((c) => cellText(cellValue(row, c.key))).join('').toLowerCase();
  }
  return row._search;
}

function compareBy(key, dir) {
  const sign = dir === 'desc' ? -1 : 1;
  return (a, b) => {
    const va = cellValue(a, key);
    const vb = cellValue(b, key);
    const ea = va == null || va === '';
    const eb = vb == null || vb === '';
    if (ea && eb) return 0;
    if (ea) return 1;
    if (eb) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return sign * (va - vb);
    return sign * String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
  };
}

/**
 * Assets > Database page: one record table rendered as a searchable, sortable
 * grid with a detail card for the picked row. Sits over the viewport the way
 * the DAT structure inspector does.
 */
export function DatabaseViewer({
  table, settings, lang = 'en', onLang, fileIdOf, onLoaded, onRevealPath, onStatus, reloadTick = 0,
  exportTick = 0,
}) {
  const [entry, setEntry] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(null);
  const [selected, setSelected] = useState(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const scrollRef = useRef(null);
  // Advanced filter: the popover's form state (kept across tables) and the
  // compiled predicate currently applied to the grid.
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterDraft, setFilterDraft] = useState({ tab: 'advanced', rules: [], match: 'and', query: '' });
  const [activeFilter, setActiveFilter] = useState(null);
  // File › Export Database bumps exportTick; the modal needs the loaded rows.
  const [exportOpen, setExportOpen] = useState(false);
  const exportTickSeen = useRef(exportTick);
  useEffect(() => {
    if (exportTick === exportTickSeen.current) return;
    exportTickSeen.current = exportTick;
    if (entry) setExportOpen(true);
    else onStatus?.('Pick a table to export first.');
  }, [exportTick, entry, onStatus]);

  // Load (or pull from cache) whenever the table or language changes.
  useEffect(() => {
    let alive = true;
    setEntry(null); setError(null); setSelected(null); setSort(null); setScrollTop(0);
    setQuery('');
    if (!table) return undefined;
    if (!settings?.gamePath) { setError('Game path not set — open Settings first.'); return undefined; }
    setLoading(true);
    loadTable(table, lang, settings)
      .then((e) => {
        if (!alive) return;
        // A cached table resolves before the intermediate render commits, so
        // the grid never unmounts — put the view back at the top by hand.
        setSort(null); setQuery(''); setSelected(null); setScrollTop(0); setActiveFilter(null);
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
        setEntry(e);
        onLoaded?.(table, lang, e.doc.rows.length);
      })
      .catch((err) => { if (alive) setError(err?.message ?? String(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [table?.key, lang, settings?.gamePath, settings?.hdPath, settings?.pivotPath, settings?.xiPath, reloadTick]);

  const doc = entry?.doc ?? null;
  const columns = useMemo(() => (doc ? columnsFor(doc) : []), [doc]);
  const filterFields = useMemo(() => (doc ? fieldsFor(doc, columns) : []), [doc, columns]);

  const rows = useMemo(() => {
    if (!doc) return [];
    let out = doc.rows;
    const q = query.trim().toLowerCase();
    if (q) {
      const idm = q.match(/^(?:id:|#)(\d+)$/);
      if (idm) {
        const id = +idm[1];
        out = out.filter((r) => r.id === id || r.idx === id);
      } else {
        const terms = q.split(/\s+/).filter(Boolean);
        out = out.filter((r) => {
          const s = rowSearchText(r, columns);
          return terms.every((t) => s.includes(t));
        });
      }
    }
    if (activeFilter?.predicate) out = out.filter(activeFilter.predicate);
    if (sort) out = out.slice().sort(compareBy(sort.key, sort.dir));
    return out;
  }, [doc, columns, query, sort, activeFilter]);

  // Viewport height for the virtual window.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, [doc]);

  const gridTemplate = useMemo(
    () => columns.map((c) => `${c.w}px`).join(' '),
    [columns],
  );
  const totalW = columns.reduce((n, c) => n + c.w, 0);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const visible = rows.slice(first, last);

  const toggleSort = (key) => setSort((prev) => {
    if (!prev || prev.key !== key) return { key, dir: 'asc' };
    if (prev.dir === 'asc') return { key, dir: 'desc' };
    return null;
  });

  const pick = useCallback((row) => setSelected(row), []);

  // Arrow keys step through the filtered rows and keep the pick in view.
  const onKeyDown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (!rows.length) return;
    e.preventDefault();
    const i = selected ? rows.indexOf(selected) : -1;
    const next = i < 0
      ? (e.key === 'ArrowDown' ? 0 : rows.length - 1)
      : Math.min(Math.max(i + (e.key === 'ArrowDown' ? 1 : -1), 0), rows.length - 1);
    setSelected(rows[next]);
    const el = scrollRef.current;
    if (el) {
      const top = next * ROW_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
    }
  };

  const rels = table ? tablePaths(table, lang).map(normRel) : [];

  if (!table) {
    return (
      <div className="data-viewer db-viewer">
        <div className="panel data-main">
          <div className="data-empty">
            <span className="icon">database</span>
            <div className="data-empty-title">Database</div>
            <div className="data-empty-sub">
              Pick a table on the left — items, quests, missions, key items and the
              other record DATs, decoded into rows.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const sourceTip = entry?.source?.kind === 'prebuilt'
    ? `Prebuilt by xi mv database${entry.source.generated ? ` (${entry.source.generated})` : ''}\n${entry.source.path}`
    : 'Parsed from the DATs — run `xi mv database` to prebuild';

  return (
    <div className="data-viewer db-viewer">
      <div className="panel data-main dbf-anchor">
        {filterOpen && doc && (
          <DatabaseFilter
            fields={filterFields}
            draft={filterDraft}
            onDraft={setFilterDraft}
            active={activeFilter}
            onApply={(f) => setActiveFilter(f.predicate ? f : null)}
            onClear={() => setActiveFilter(null)}
            onClose={() => setFilterOpen(false)}
          />
        )}
        <div className="db-header">
          <span className="icon db-header-icon">{table.kind === 'items' ? 'inventory_2' : 'table_rows'}</span>
          <div className="db-title">
            <span className="db-title-group">{table.groupLabel}</span>
            <span className="db-title-sep">›</span>
            <span className="db-title-name">{table.label}</span>
          </div>
          <div className="db-paths">
            {rels.map((rel) => (
              <Tooltip key={rel} content="Reveal in DAT Browser" placement="bottom">
                <button
                  type="button"
                  className="db-path mono"
                  onClick={() => onRevealPath?.(rel)}
                  disabled={!onRevealPath}
                >
                  {rel}
                </button>
              </Tooltip>
            ))}
          </div>
          <div className="db-lang" role="radiogroup" aria-label="Client language">
            {['en', 'jp'].map((l) => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={lang === l}
                className={`db-lang-btn${lang === l ? ' on' : ''}`}
                onClick={() => onLang?.(l)}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>
          <input
            type="search"
            className="list-search db-search"
            placeholder={table.kind === 'items' ? 'Filter rows… (id:1234 for an exact id)' : 'Filter rows…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          <Tooltip content={activeFilter?.summary ? `Filter: ${activeFilter.summary}` : 'Advanced filters'} placement="bottom">
            <button
              type="button"
              className={`icon-btn db-filter-btn${activeFilter?.predicate ? ' on' : ''}${filterOpen ? ' open' : ''}`}
              aria-label="Advanced filters"
              aria-expanded={filterOpen}
              onClick={() => setFilterOpen((v) => !v)}
              disabled={!doc}
            >
              <span className="icon">filter_alt</span>
              {activeFilter?.count > 0 && <span className="db-filter-count">{activeFilter.count}</span>}
            </button>
          </Tooltip>
          {entry && (
            <Tooltip content={sourceTip} placement="bottom">
              <span className={`icon db-source${entry.source.kind === 'prebuilt' ? ' on' : ''}`}>
                {entry.source.kind === 'prebuilt' ? 'bolt' : 'schedule'}
              </span>
            </Tooltip>
          )}
          <span className="datatable-count mono">
            {doc
              ? (rows.length === doc.rows.length
                ? `${doc.rows.length.toLocaleString()} rows`
                : `${rows.length.toLocaleString()} of ${doc.rows.length.toLocaleString()}`)
              : ''}
          </span>
        </div>

        {error && (
          <div className="data-empty">
            <span className="icon">error</span>
            <div className="data-empty-title">Couldn't open {table.label}</div>
            <div className="data-empty-sub mono">{error}</div>
          </div>
        )}
        {!error && loading && (
          <div className="data-empty">
            <span className="icon">hourglass_top</span>
            <div className="data-empty-title">Reading {rels.join(', ')}…</div>
          </div>
        )}
        {doc && !loading && (
          <div
            key={`${table.key}:${lang}`}
            className="db-grid-scroll"
            ref={scrollRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            <div className="db-grid-head" style={{ gridTemplateColumns: gridTemplate, width: totalW }}>
              {columns.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className={`db-head-cell${c.num ? ' num' : ''}${sort?.key === c.key ? ' sorted' : ''}`}
                  onClick={() => toggleSort(c.key)}
                >
                  <span>{c.label}</span>
                  {sort?.key === c.key && (
                    <span className="icon db-sort-icon">{sort.dir === 'asc' ? 'arrow_drop_up' : 'arrow_drop_down'}</span>
                  )}
                </button>
              ))}
            </div>
            {rows.length === 0 && (
              <div className="db-grid-empty">
                {doc.rows.length ? 'No rows match the filter.' : 'No records'}
              </div>
            )}
            <div className="db-grid-body" style={{ height: rows.length * ROW_H, width: totalW }}>
              {visible.map((row, k) => {
                const i = first + k;
                return (
                  <div
                    key={`${row.part ?? 0}:${row.idx}`}
                    className={`db-row${row === selected ? ' selected' : ''}${i % 2 ? ' odd' : ''}`}
                    style={{ top: i * ROW_H, gridTemplateColumns: gridTemplate }}
                    onClick={() => pick(row)}
                  >
                    {columns.map((c) => (
                      <div key={c.key} className={`db-cell${c.num ? ' num' : ''}${c.mono ? ' mono' : ''}`}>
                        {cellText(cellValue(row, c.key))}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {exportOpen && doc && (
        <DatabaseExportModal
          table={table}
          lang={lang}
          doc={doc}
          rows={rows}
          columns={columns}
          filterActive={!!(activeFilter?.predicate || query.trim())}
          settings={settings}
          onClose={() => setExportOpen(false)}
          onStatus={onStatus}
        />
      )}

      <div className="data-side">
        <div className="panel data-card db-detail">
          {selected
            ? (
              <DetailCard
                row={selected}
                entry={entry}
                table={table}
                lang={lang}
                settings={settings}
                fileIdOf={fileIdOf}
                onStatus={onStatus}
              />
            )
            : (
              <div className="data-empty">
                <span className="icon">info</span>
                <div className="data-empty-title">No row picked</div>
                <div className="data-empty-sub">Click a row to see every decoded field, the icon and the raw header bytes.</div>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

// ── detail card ─────────────────────────────────────────────────────────────

const ITEM_FIELDS = [
  ['id', 'Item ID'], ['type', 'Type'], ['flags', 'Flags'], ['stack', 'Stack size'],
  ['resourceId', 'Resource ID'], ['targets', 'Valid targets'], ['level', 'Level'],
  ['itemLevel', 'Item level'], ['superiorLevel', 'Superior level'], ['slots', 'Slots'],
  ['races', 'Races'], ['jobs', 'Jobs'], ['skill', 'Skill'], ['damage', 'Damage'],
  ['delay', 'Delay'], ['dps', 'DPS ×100'], ['jugSize', 'Jug size'], ['shieldSize', 'Shield size'],
  ['baseItemId', 'Base item id'],
  ['maxCharges', 'Max charges'], ['castTime', 'Cast time'], ['useDelay', 'Use delay'],
  ['reuseDelay', 'Reuse delay'], ['puppetSlot', 'Puppet slot'], ['elementCharge', 'Element charge'],
  ['instinctCost', 'Instinct cost'],
];

function fieldDisplay(row, key) {
  const v = row[key];
  if (v == null) return null;
  switch (key) {
    case 'type': return `${row.typeName} (${v})`;
    case 'flags': return `0x${v.toString(16).padStart(4, '0')}${row.flagsText ? ` — ${row.flagsText}` : ''}`;
    case 'slots': return `0x${v.toString(16).padStart(4, '0')}${row.slotsText ? ` — ${row.slotsText}` : ''}`;
    case 'races': return `0x${v.toString(16).padStart(4, '0')}${row.racesText ? ` — ${row.racesText}` : ''}`;
    case 'jobs': return `0x${v.toString(16).padStart(8, '0')}${row.jobsText ? ` — ${row.jobsText}` : ''}`;
    case 'skill': return `${row.skillName} (${v})`;
    case 'baseItemId': return v ? String(v) : null;
    default: return String(v);
  }
}

function DetailCard({ row, entry, table, lang, settings, fileIdOf, onStatus }) {
  const canvasRef = useRef(null);
  const [fileId, setFileId] = useState(null);
  const [block, setBlock] = useState(null);
  const isItem = entry?.doc?.kind === 'items';
  const isRecord = isItem && ITEM_LAYOUTS.has(entry.doc.layout);
  const part = entry?.parts?.[row.part ?? 0];
  const rel = part?.rel ?? '';

  // FTABLE id for the DAT (async — the index is built on first use).
  useEffect(() => {
    let alive = true;
    setFileId(null);
    if (!fileIdOf || !rel) return undefined;
    Promise.resolve(fileIdOf(rel)).then((id) => { if (alive) setFileId(id ?? null); }).catch(() => {});
    return () => { alive = false; };
  }, [fileIdOf, rel]);

  // The decoded block: carried on the row for the special tables, otherwise
  // pulled from the DAT (read once per part, then cached on the entry).
  useEffect(() => {
    let alive = true;
    if (row._block) { setBlock(row._block); return undefined; }
    if (!isItem) { setBlock(null); return undefined; }
    setBlock(null);
    partBuffer(entry, row.part ?? 0, settings)
      .then((buf) => { if (alive && buf) setBlock(itemBlockAt(buf, row.idx)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [row, entry, isItem, settings]);

  const icon = useMemo(() => (block && isRecord ? safeIcon(block) : null), [block, isRecord]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !icon) return;
    cv.width = icon.width;
    cv.height = icon.height;
    const ctx = cv.getContext('2d');
    ctx.putImageData(new ImageData(icon.data, icon.width, icon.height), 0, 0);
  }, [icon]);

  const copyJson = async () => {
    const out = { ...row };
    delete out._search;
    delete out._block;
    try {
      await navigator.clipboard.writeText(JSON.stringify(out, null, 2));
      onStatus?.(`Copied ${row.name || `row ${row.idx}`} as JSON`);
    } catch (e) {
      onStatus?.(`Copy failed: ${e.message ?? e}`);
    }
  };

  const headerHex = block
    ? hexOf(block, 0, Math.min(0x80, row.stringOffset ?? 0x40) || 0x40)
    : null;

  const subNames = table?.subs || [];

  return (
    <>
      <div className="db-detail-head">
        {isRecord && (
          <div className="db-icon-wrap">
            {icon
              ? <canvas ref={canvasRef} className="db-icon" />
              : <span className="icon db-icon-missing">{block ? 'image_not_supported' : 'hourglass_empty'}</span>}
          </div>
        )}
        <div className="db-detail-title">
          <div className="db-detail-name">{row.name || (isItem ? `Item ${row.id}` : `Row ${row.idx}`)}</div>
          <div className="db-detail-sub mono">
            {isItem ? `id ${row.id}` : `#${row.idx}`}
            {' · '}
            {rel}
            {fileId != null ? ` · file ${fileId}` : ''}
          </div>
        </div>
        <Tooltip content="Copy row as JSON" placement="left">
          <Button type="button" className="icon-btn" onClick={copyJson} aria-label="Copy row as JSON">
            <span className="icon">content_copy</span>
          </Button>
        </Tooltip>
      </div>

      <div className="db-detail-scroll">
        <div className="db-kv">
          <div className="db-kv-k">DAT</div>
          <div className="db-kv-v mono">{rel}{fileId != null ? ` (file id ${fileId})` : ''}</div>
          <div className="db-kv-k">Block</div>
          <div className="db-kv-v mono">
            {row.idx} @ 0x{(row.offset ?? 0).toString(16)}
            {row.length != null ? ` · ${row.length} bytes` : ''}
          </div>
          <div className="db-kv-k">Language</div>
          <div className="db-kv-v">{lang.toUpperCase()}</div>
        </div>

        {isRecord && (
          <>
            <div className="db-section">Fields</div>
            <div className="db-kv">
              {ITEM_FIELDS.map(([k, label]) => {
                const v = fieldDisplay(row, k);
                if (v == null) return null;
                return <FieldRow key={k} label={label} value={v} />;
              })}
            </div>

            {row.flags != null && row.flagsText && (
              <div className="db-chips">
                {ITEM_FLAGS.filter(([bit]) => row.flags & bit).map(([bit, name]) => (
                  <span key={bit} className="db-chip">{name}</span>
                ))}
              </div>
            )}

            {(Object.keys(row.stats || {}).length > 0 || row.other) && (
              <>
                <div className="db-section">Stats</div>
                <div className="db-chips">
                  {Object.entries(row.stats).map(([k, v]) => (
                    <span key={k} className="db-chip stat">
                      {k}{k === 'DEF' || k === 'DMG' || k === 'Delay' ? ':' : (v < 0 ? '' : '+')}{v}
                    </span>
                  ))}
                  {row.other.split(/ {2}/).filter(Boolean).map((s, i) => (
                    <span key={`o${i}`} className="db-chip">{s}</span>
                  ))}
                </div>
              </>
            )}

            <div className="db-section">Strings</div>
            <div className="db-kv">
              {Object.entries(row.strings || {}).map(([k, v]) => (
                <FieldRow key={k} label={k} value={typeof v === 'number' ? `#${v}` : v} pre />
              ))}
            </div>
          </>
        )}

        {isItem && !isRecord && row.special && (
          <>
            <div className="db-section">{row.summary || 'Contents'}</div>
            <SpecialTable special={row.special} />
          </>
        )}

        {isItem && headerHex && (
          <>
            <div className="db-section">Header bytes</div>
            <div className="db-hex mono">{headerHex}</div>
          </>
        )}

        {!isItem && (
          <>
            <div className="db-section">Sub-strings</div>
            <div className="db-kv">
              {(row.subs || []).map((s, i) => (
                <FieldRow
                  key={i}
                  label={subNames[i] ?? `sub${i}`}
                  value={s == null ? '' : (typeof s === 'number' ? `#${s}` : s)}
                  pre
                />
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function SpecialTable({ special }) {
  if (!special.rows?.length) return <div className="side-note">No entries.</div>;
  return (
    <div className="db-special-wrap">
      <table className="zdef-table db-special">
        <thead>
          <tr>{special.columns.map((c) => <th key={c.key} className="mono">{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {special.rows.map((r, i) => (
            <tr key={i}>
              {special.columns.map((c) => <td key={c.key} className="mono">{String(r[c.key] ?? '')}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FieldRow({ label, value, pre }) {
  return (
    <>
      <div className="db-kv-k">{label}</div>
      <div className={`db-kv-v${pre ? ' pre' : ''}`}>{value}</div>
    </>
  );
}

function safeIcon(block) {
  try { return decodeItemIcon(block); } catch { return null; }
}
