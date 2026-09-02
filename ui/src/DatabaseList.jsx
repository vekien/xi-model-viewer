import { useMemo, useState } from 'react';
import { DB_TREE, tablePaths } from '../js/database.js';
import { Tooltip } from './Tooltip.jsx';

/**
 * Assets > Database explorer: the record DATs grouped as "tables" (Items per
 * DAT, Quests/Missions per region, and the d_msg name tables). Clicking a
 * table opens it in DatabaseViewer.
 */
export function DatabaseList({ selectedKey, onSelectTable, lang = 'en', counts }) {
  const [query, setQuery] = useState('');
  const [openGroups, setOpenGroups] = useState(() => new Set(['items']));

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => DB_TREE.map((g) => ({
    ...g,
    tables: q
      ? g.tables.filter((t) => t.label.toLowerCase().includes(q)
        || g.label.toLowerCase().includes(q)
        || tablePaths(t, lang).join(' ').toLowerCase().includes(q))
      : g.tables,
  })).filter((g) => g.tables.length), [q, lang]);

  const toggle = (key) => setOpenGroups((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const total = DB_TREE.reduce((n, g) => n + g.tables.length, 0);
  const shown = groups.reduce((n, g) => n + g.tables.length, 0);

  return (
    <div id="tree" className="panel list-panel">
      <div className="list-search-wrap">
        <input
          className="list-search"
          type="text"
          placeholder="Search tables…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="list-scroll">
        {shown === 0 && <div className="side-note">No tables match “{query}”.</div>}
        {groups.map((g) => {
          const open = !!q || openGroups.has(g.key);
          return (
            <div key={g.key} className={`node${open ? ' open' : ''}`}>
              <div className="row" onClick={() => toggle(g.key)}>
                <span className="caret icon">chevron_right</span>
                <span className="kind icon">{g.icon || 'folder'}</span>
                <span>{g.label}</span>
                <span className="badge">{g.tables.length}</span>
              </div>
              {open && (
                <div className="children">
                  {g.tables.map((t) => {
                    const n = counts?.[`${t.key}:${lang}`];
                    const tip = t.parts.map((p) => (
                      p.range ? `${p[lang] || p.en} · ids ${p.range[0]}–${p.range[1]}` : (p[lang] || p.en)
                    )).join('\n');
                    return (
                      <Tooltip key={t.key} content={tip} placement="right">
                        <div
                          className={`node db-table-row${selectedKey === t.key ? ' selected' : ''}`}
                        >
                          <div className="row" onClick={() => onSelectTable?.(t)}>
                            <span className="caret icon" />
                            <span className="kind icon">{t.kind === 'items' ? 'inventory_2' : 'table_rows'}</span>
                            <span className="db-name">{t.label}</span>
                            {n != null && <span className="mono-small db-count">{n.toLocaleString()}</span>}
                          </div>
                        </div>
                      </Tooltip>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="side-note zone-count">
        {q ? `${shown} / ${total}` : `${total}`} tables
      </div>
    </div>
  );
}
