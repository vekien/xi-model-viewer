import { useEffect, useMemo, useState } from 'react';
import { fmtBytes } from '../js/dat/inspect.js';
import { ENTITY_MODEL_OFFSET, GEAR_SLOTS, GEAR_TABLES, RACE_LABELS, gearIndex } from '../js/dat/modelids.js';
import { Combo } from './Combo.jsx';

/** Cap on rendered file-table rows — the base table registers ~50k ids. */
const FT_MAX_ROWS = 1000;

/**
 * Assets > Data — DAT structure over the viewport. Left panel is the folder
 * tree the client walks (0x01/0x00 sections); right column is the file card
 * and a per-type census. Resources are listed with a header peek (dimensions,
 * joint counts, sound ids), never their payload.
 *
 * `sources` — optional multi-DAT set (PC parts, creation files). Dropdown
 * switches which file File/Contents/Structure describe.
 */
/** Zone multi-DAT tabs — fixed order, always visible while a zone bundle is loaded. */
const ZONE_TAB_ORDER = [
  { key: 'zone', label: 'Zone', icon: 'map' },
  { key: 'events', label: 'Events', icon: 'smart_display' },
  { key: 'dialog', label: 'Dialog', icon: 'chat' },
  { key: 'npclist', label: 'NPCs', icon: 'groups' },
];

function zoneTabKeyFromDoc(doc) {
  if (doc?.kind === 'events') return 'events';
  if (doc?.kind === 'dialog') return 'dialog';
  if (doc?.kind === 'npclist') return 'npclist';
  return 'zone';
}

function buildZoneTabs(sources) {
  if (!sources?.length) return null;
  const byKey = new Map(sources.map((s) => [s.id, s]));
  // Need at least mesh + one companion to treat as a zone bundle.
  if (!byKey.has('zone') || !ZONE_TAB_ORDER.some((t) => t.key !== 'zone' && byKey.has(t.key))) {
    return null;
  }
  // Always surface every companion tab that exists in the bundle — empty
  // event/NPC DATs still get a tab so the chrome doesn't collapse mid-switch.
  return ZONE_TAB_ORDER
    .filter((t) => byKey.has(t.key))
    .map((t) => ({ ...t, path: byKey.get(t.key).path, rel: byKey.get(t.key).rel }));
}

/** Centered empty-state for zone script tabs with nothing to list. */
function ZoneEmptyState({ icon, title, sub }) {
  return (
    <div className="data-empty data-zone-empty">
      <span className="icon">{icon}</span>
      <div className="data-empty-title">{title}</div>
      {sub && <div className="data-empty-sub">{sub}</div>}
    </div>
  );
}

function ZoneTabs({ tabs, activeKey, onSelect }) {
  if (!tabs?.length) return null;
  return (
    <div className="data-zone-tabs" role="tablist" aria-label="Zone DATs">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={activeKey === t.key}
          className={`data-zone-tab${activeKey === t.key ? ' on' : ''}`}
          title={t.rel || t.path}
          onClick={() => { if (activeKey !== t.key) onSelect?.(t.path); }}
        >
          <span className="icon">{t.icon}</span>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function DataViewer({
  doc, sources, onSelectSource, onOpenTexture, onOpenSkeleton, onOpenZoneDef,
  onOpenRoute, onOpenUiMenu, onOpenUiElementGroup, onOpenParticle, onPlaySound, playingSoundKey, onRevealPath, onOpenDat, onRenderFile,
}) {
  if (!doc) {
    return (
      <div className="data-viewer">
        <div className="panel data-main">
          <div className="data-empty">
            <span className="icon">database</span>
            <div className="data-empty-title">Data inspector</div>
            <div className="data-empty-sub">
              Pick a .DAT from the file list to see how it's structured —
              folders, sections, and what lives in each.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const zoneTabs = buildZoneTabs(sources);
  const zoneTabKey = zoneTabKeyFromDoc(doc);
  const sourceItems = (!zoneTabs && sources?.length > 1)
    ? sources.map((s) => ({ id: s.path, label: s.label }))
    : null;
  const activePath = doc.fullPath || '';
  const activeSource = sourceItems
    ? (sourceItems.find((s) => s.id.toLowerCase() === activePath.toLowerCase())?.id
      ?? sourceItems[0]?.id)
    : (sources?.find((s) => s.path?.toLowerCase() === activePath.toLowerCase())?.path
      || activePath);

  const zoneChrome = zoneTabs ? (
    <ZoneTabs tabs={zoneTabs} activeKey={zoneTabKey} onSelect={onSelectSource} />
  ) : null;

  if (doc.kind === 'ftable') return <FtableView doc={doc} onOpenDat={onOpenDat} />;
  if (doc.kind === 'npclist') {
    return (
      <NpcListView
        doc={doc}
        sources={sources}
        zoneChrome={zoneChrome}
        onSelectSource={onSelectSource}
        onRevealPath={onRevealPath}
      />
    );
  }
  if (doc.kind === 'events') {
    return (
      <EventsView
        doc={doc}
        sources={sources}
        zoneChrome={zoneChrome}
        onSelectSource={onSelectSource}
        onRevealPath={onRevealPath}
      />
    );
  }
  if (doc.kind === 'dialog') {
    return (
      <DialogView
        doc={doc}
        sources={sources}
        zoneChrome={zoneChrome}
        onSelectSource={onSelectSource}
        onRevealPath={onRevealPath}
      />
    );
  }

  if (doc.kind === 'other') {
    return (
      <div className="data-viewer">
        <div className="panel data-main">
          <div className="data-card-title">
            <span className="icon">data_array</span>Structure
          </div>
          {zoneChrome}
          <StructureToolbar
            sourceItems={sourceItems}
            activeSource={activeSource}
            onSelectSource={onSelectSource}
          />
          <div className="data-empty">
            <span className="icon">data_array</span>
            <div className="data-empty-title">{doc.label}</div>
            <div className="data-empty-sub">
              {doc.magic ? `Header magic: ${doc.magic} · ` : ''}{fmtBytes(doc.fileSize)}
            </div>
            <div className="data-empty-sub">
              This file has no 16-byte section headers to walk — it's a raw
              table, text, or stream DAT.
            </div>
          </div>
        </div>
        <div className="data-side">
          <FileCard
            doc={doc}
            isCreation={false}
            sourceItems={sourceItems}
            activeSource={activeSource}
            onSelectSource={onSelectSource}
            onRevealPath={onRevealPath}
          />
        </div>
      </div>
    );
  }

  return (
    <SectionsView
      doc={doc}
      sourceItems={sourceItems}
      activeSource={activeSource}
      zoneChrome={zoneChrome}
      onSelectSource={onSelectSource}
      onOpenTexture={onOpenTexture}
      onOpenSkeleton={onOpenSkeleton}
      onOpenZoneDef={onOpenZoneDef}
      onOpenRoute={onOpenRoute}
      onOpenUiMenu={onOpenUiMenu}
      onOpenUiElementGroup={onOpenUiElementGroup}
      onOpenParticle={onOpenParticle}
      onPlaySound={onPlaySound}
      playingSoundKey={playingSoundKey}
      onRevealPath={onRevealPath}
      onRenderFile={onRenderFile}
    />
  );
}

/** DAT dropdown + structure search row. Search is optional (other/empty views). */
function StructureToolbar({
  sourceItems, activeSource, onSelectSource, query, setQuery, matchCount, totalHint,
}) {
  const hasSources = !!sourceItems?.length;
  const hasSearch = typeof setQuery === 'function';
  if (!hasSources && !hasSearch) return null;
  return (
    <div className={`data-struct-bar${hasSources && hasSearch ? ' dual' : ''}`}>
      {hasSources && (
        <div className="data-source-combo">
          <Combo
            value={activeSource}
            items={sourceItems}
            onChange={(id) => onSelectSource?.(id)}
          />
        </div>
      )}
      {hasSearch && (
        <div className="data-struct-search">
          <span className="icon">search</span>
          <input
            className="list-search"
            type="search"
            placeholder="Filter name or type (e.g. EffectRoutine)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className="list-search-clear"
              onClick={() => setQuery('')}
              title="Clear"
            >
              <span className="icon">close</span>
            </button>
          )}
          {query.trim() && matchCount != null && (
            <span className="data-struct-match mono" title={totalHint || ''}>
              {matchCount.toLocaleString()}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Match resource/folder text against the structure filter. */
function nodeMatchesQuery(node, q) {
  if (!q) return true;
  const hay = [
    node.id,
    node.name,
    node.detail,
    node.textureName,
    ...(node.flags ?? []),
    node.type != null && node.type >= 0 ? `0x${node.type.toString(16)}` : '',
    node.type != null && node.type >= 0 ? String(node.type) : '',
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

/**
 * Filter the structure tree: keep a resource if it matches; keep a folder if
 * its id matches or any descendant is kept. Returns a shallow-cloned tree.
 */
function filterStructureTree(root, query) {
  const q = query.trim().toLowerCase();
  if (!q) return { root, matchCount: null };

  let matchCount = 0;
  const filter = (node) => {
    if (node.kind === 'res') {
      if (nodeMatchesQuery(node, q)) { matchCount++; return node; }
      return null;
    }
    // dir
    const kids = [];
    for (const c of node.children ?? []) {
      const kept = filter(c);
      if (kept) kids.push(kept);
    }
    const selfHit = nodeMatchesQuery(node, q);
    if (!kids.length && !selfHit) return null;
    if (selfHit && !kids.length) matchCount++; // empty matching folder
    return { ...node, children: kids };
  };

  const next = filter(root) || { kind: 'dir', id: '(root)', children: [] };
  return { root: next, matchCount };
}

function countRes(node) {
  if (!node) return 0;
  if (node.kind === 'res') return 1;
  let n = 0;
  for (const c of node.children ?? []) n += countRes(c);
  return n;
}

function SectionsView({
  doc, sourceItems, activeSource, zoneChrome, onSelectSource,
  onOpenTexture, onOpenSkeleton, onOpenZoneDef, onOpenRoute, onOpenUiMenu,
  onOpenUiElementGroup,
  onOpenParticle, onPlaySound, playingSoundKey,
  onRevealPath, onRenderFile,
}) {
  const [query, setQuery] = useState('');
  // Reset filter when switching DAT / reloading structure.
  const docKey = doc.fullPath || doc.path || '';
  useEffect(() => { setQuery(''); }, [docKey]);

  const { root: shownRoot, matchCount } = useMemo(
    () => filterStructureTree(doc.root, query),
    [doc.root, query],
  );
  const totalRes = useMemo(() => countRes(doc.root), [doc.root]);

  const isCreation = doc.format === 'creation';
  const structureNote = isCreation
    ? (doc.formatLabel || doc.magic || 'creation')
    : `${doc.sectionCount.toLocaleString()} sections`;

  return (
    <div className="data-viewer">
      <div className="panel data-main">
        <div className="data-card-title">
          <span className="icon">account_tree</span>Structure
          {doc.zoneName && <span className="data-zone-tag">{doc.zoneName}</span>}
          <span className="data-card-note mono">{structureNote}</span>
        </div>
        {zoneChrome}
        <StructureToolbar
          sourceItems={sourceItems}
          activeSource={activeSource}
          onSelectSource={onSelectSource}
          query={query}
          setQuery={setQuery}
          matchCount={matchCount}
          totalHint={`${totalRes.toLocaleString()} total`}
        />
        <div className="data-tree">
          {query.trim() && matchCount === 0 ? (
            <div className="data-filter-empty">No sections match “{query.trim()}”.</div>
          ) : (
            <DirNode
              dir={shownRoot}
              depth={0}
              forceOpen={!!query.trim()}
              onOpenTexture={onOpenTexture}
              onOpenSkeleton={onOpenSkeleton}
              onOpenZoneDef={onOpenZoneDef}
              onOpenRoute={onOpenRoute}
              onOpenUiMenu={onOpenUiMenu}
              onOpenUiElementGroup={onOpenUiElementGroup}
              onOpenParticle={onOpenParticle}
              onPlaySound={onPlaySound}
              playingSoundKey={playingSoundKey}
            />
          )}
        </div>
      </div>

      <div className="data-side">
        <FileCard
          doc={doc}
          isCreation={isCreation}
          sourceItems={sourceItems}
          activeSource={activeSource}
          onSelectSource={onSelectSource}
          onRevealPath={onRevealPath}
          onRenderFile={onRenderFile}
        />

        <div className="panel data-card data-census">
          <div className="data-card-title"><span className="icon">category</span>Contents</div>
          <div className="data-census-rows">
            {(doc.summary ?? []).map((row) => {
              const q = query.trim().toLowerCase();
              const dim = q && !row.name.toLowerCase().includes(q);
              return (
                <div
                  key={row.type}
                  className={`data-census-row${dim ? ' data-census-dim' : ''}`}
                >
                  <span className="icon">{row.icon}</span>
                  <span className="data-census-name">{row.name}</span>
                  <span className="data-census-count mono">{row.count.toLocaleString()}</span>
                  <span className="data-census-bytes mono">{row.bytes ? fmtBytes(row.bytes) : ''}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * FTABLE/VTABLE pair: every registered file id and the DAT it resolves to.
 * The search box narrows by id (numeric query) or by path substring; rows
 * click through to inspect the named DAT.
 */
const FT_CATS = [
  { id: 'all', label: 'All ids' },
  { id: 'gear', label: 'Gear' },
  { id: 'entity', label: 'Mobs & NPCs' },
];

function FtableView({ doc, onOpenDat }) {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState('all');

  const entryById = useMemo(() => new Map(doc.entries.map((e) => [e.id, e])), [doc]);

  // Gear rows in table order (race → slot → model id), registered ids only.
  const gearRows = useMemo(() => {
    const rows = [];
    for (const [id, g] of gearIndex()) {
      const e = entryById.get(id);
      if (!e) continue;
      rows.push({
        ...e,
        modelId: g.modelId,
        slot: g.slot,
        races: g.races,
        raceLabel: g.races.map((r) => RACE_LABELS[r] ?? r).join(' / '),
      });
    }
    return rows;
  }, [entryById]);

  // Everything in the monster/NPC range that the gear tables don't claim.
  const entityRows = useMemo(() => {
    const gi = gearIndex();
    return doc.entries
      .filter((e) => e.id >= ENTITY_MODEL_OFFSET && !gi.has(e.id))
      .map((e) => ({ ...e, modelId: e.id - ENTITY_MODEL_OFFSET }));
  }, [doc]);

  const rows = cat === 'gear' ? gearRows : cat === 'entity' ? entityRows : doc.entries;

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return rows;
    // Every space-separated token must match something on the row: a number
    // matches the model id (gear/mob views) or the file id; text matches the
    // DAT path, race, or slot ("mithra body", "ROM/303/", "172").
    const tokens = q.toLowerCase().split(/\s+/);
    return rows.filter((e) => tokens.every((t) => {
      if (/^\d+$/.test(t)) {
        const n = parseInt(t, 10);
        if (e.modelId != null) return e.modelId === n || e.id === n;
        return e.id === n || String(e.id).startsWith(t);
      }
      if (e.dat.toLowerCase().includes(t)) return true;
      if (e.raceLabel && (e.raceLabel.toLowerCase().includes(t) || e.races.some((r) => r.toLowerCase().includes(t)))) return true;
      if (e.slot && e.slot.startsWith(t)) return true;
      return false;
    }));
  }, [rows, query]);

  // Race → slot → registered DATs, for the browsable tree (no query). Taru ♂/♀
  // each get their full set here — shared file_ids appear under both, which is
  // what a per-race browse should show.
  const gearTree = useMemo(() => {
    const races = [];
    for (const [race, slots] of Object.entries(GEAR_TABLES)) {
      const slotNodes = [];
      let raceCount = 0;
      for (const slot of GEAR_SLOTS) {
        const groups = slots[slot];
        if (!groups) continue;
        const slotRows = [];
        let modelId = 0;
        for (const [base, count] of groups) {
          for (let i = 0; base !== 0 && i < count; i++) {
            const e = entryById.get(base + i);
            if (e) slotRows.push({ ...e, modelId: modelId + i, slot });
          }
          modelId += count;
        }
        if (slotRows.length) {
          slotNodes.push({ slot, rows: slotRows });
          raceCount += slotRows.length;
        }
      }
      races.push({ race, label: RACE_LABELS[race] ?? race, slots: slotNodes, count: raceCount });
    }
    return races;
  }, [entryById]);

  // Gear view: census per race; otherwise per ROM root.
  const census = useMemo(() => {
    if (cat !== 'gear') return null;
    const bySlot = new Map(GEAR_SLOTS.map((s) => [s, 0]));
    const byRace = new Map();
    for (const r of gearRows) {
      bySlot.set(r.slot, (bySlot.get(r.slot) ?? 0) + 1);
      for (const race of r.races) byRace.set(race, (byRace.get(race) ?? 0) + 1);
    }
    return {
      races: [...byRace.entries()].map(([race, count]) => ({ label: RACE_LABELS[race] ?? race, count })),
      slots: [...bySlot.entries()].filter(([, c]) => c).map(([slot, count]) => ({ label: slot, count })),
    };
  }, [cat, gearRows]);

  const shown = filtered.length > FT_MAX_ROWS ? filtered.slice(0, FT_MAX_ROWS) : filtered;
  const label = doc.romIdx === 1 ? 'FTABLE / VTABLE' : `FTABLE${doc.romIdx} / VTABLE${doc.romIdx}`;

  return (
    <div className="data-viewer">
      <div className="panel data-main">
        <div className="data-card-title">
          <span className="icon">table_rows</span>File table
          <span className="data-card-note mono">
            {filtered.length === rows.length
              ? `${rows.length.toLocaleString()} entries`
              : `${filtered.length.toLocaleString()} of ${rows.length.toLocaleString()}`}
          </span>
        </div>
        <div className="list-search-wrap">
          <div className="data-cats">
            {FT_CATS.map((c) => (
              <button
                key={c.id}
                className={`data-cat${cat === c.id ? ' on' : ''}`}
                onClick={() => setCat(c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>
          <span className="icon">search</span>
          <input
            className="list-search"
            placeholder={cat === 'gear' ? 'Filter by race, slot, model id or path…'
              : cat === 'entity' ? 'Filter by model id or DAT path…'
                : 'Filter by file id or DAT path…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="list-search-clear" onClick={() => setQuery('')} title="Clear">
              <span className="icon">close</span>
            </button>
          )}
        </div>
        <div className="data-tree">
          {cat === 'gear' && !query.trim() ? (
            gearTree.map((r) => <GearRaceNode key={r.race} node={r} onOpenDat={onOpenDat} />)
          ) : (
            <>
              {shown.map((e) => <FtRow key={e.id} e={e} onOpenDat={onOpenDat} />)}
              {filtered.length > FT_MAX_ROWS && (
                <div className="data-ft-more">
                  Showing the first {FT_MAX_ROWS.toLocaleString()} of {filtered.length.toLocaleString()} — narrow the filter to see the rest.
                </div>
              )}
              {filtered.length === 0 && (
                <div className="data-ft-more">No entries match “{query}”.</div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="data-side">
        <div className="panel data-card">
          <div className="data-card-title"><span className="icon">description</span>File</div>
          <Row label="Tables" value={label} mono />
          <Row label="Path" value={doc.path} mono />
          <Row label="Sizes" value={`${fmtBytes(doc.fileSize)} + ${fmtBytes(doc.siblingSize)}`} />
          <Row label="Capacity" value={doc.capacity.toLocaleString()} />
          <Row label="Registered" value={doc.registered.toLocaleString()} />
          <Row label="Free" value={(doc.capacity - doc.registered).toLocaleString()} />
        </div>

        <div className="panel data-card data-census">
          <div className="data-card-title">
            <span className="icon">category</span>{census ? 'Gear models' : 'By ROM root'}
          </div>
          <div className="data-census-rows">
            {census ? (
              <>
                {census.races.map((r) => (
                  <div key={r.label} className="data-census-row">
                    <span className="icon">person</span>
                    <span className="data-census-name">{r.label}</span>
                    <span className="data-census-count mono">{r.count.toLocaleString()}</span>
                  </div>
                ))}
                <div className="data-census-sep" />
                {census.slots.map((s) => (
                  <div key={s.label} className="data-census-row">
                    <span className="icon">checkroom</span>
                    <span className="data-census-name">{s.label}</span>
                    <span className="data-census-count mono">{s.count.toLocaleString()}</span>
                  </div>
                ))}
              </>
            ) : doc.romCounts.map((r) => (
              <div key={r.rom} className="data-census-row">
                <span className="icon">folder</span>
                <span className="data-census-name mono">{r.rom === 1 ? 'ROM' : `ROM${r.rom}`}</span>
                <span className="data-census-count mono">{r.count.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Shared search box for the zone-script views. `children` = leading chips. */
function SearchWrap({ query, setQuery, placeholder, children }) {
  return (
    <div className="list-search-wrap">
      {children}
      <span className="icon">search</span>
      <input
        className="list-search"
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {query && (
        <button className="list-search-clear" onClick={() => setQuery('')} title="Clear">
          <span className="icon">close</span>
        </button>
      )}
    </div>
  );
}

/** Zone NPC list: index · name · server id, with event counts when known. */
function NpcListView({ doc, sources, zoneChrome, onSelectSource, onRevealPath }) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return doc.npcs;
    return doc.npcs.filter((n) =>
      n.name.toLowerCase().includes(q)
      || String(n.id) === q
      || n.id.toString(16).toLowerCase().includes(q)
      || String(n.id & 0xfff) === q);
  }, [doc, query]);

  return (
    <div className="data-viewer">
      <div className="panel data-main">
        <div className="data-card-title">
          <span className="icon">groups</span>NPCs
          {doc.zoneName && <span className="data-zone-tag">{doc.zoneName}</span>}
          <span className="data-card-note mono">
            {filtered.length === doc.npcs.length
              ? `${doc.npcs.length.toLocaleString()} NPCs`
              : `${filtered.length.toLocaleString()} of ${doc.npcs.length.toLocaleString()}`}
          </span>
        </div>
        {zoneChrome}
        {!doc.npcs.length ? (
          <ZoneEmptyState
            icon="groups"
            title="No NPCs for this Zone"
            sub="This zone's NPC DAT has no entity records."
          />
        ) : (
          <>
            <SearchWrap query={query} setQuery={setQuery} placeholder="Filter by name or id…" />
            <div className="data-tree">
              {filtered.map((n) => (
                <div key={n.index} className="data-row" title={`record ${n.index} · target index ${n.id & 0x3ff}`}>
                  <span className="data-ft-id mono">{n.index}</span>
                  <span className="data-id mono">{n.name}</span>
                  {n.events > 0 && <span className="data-ev-badge mono">{n.events} event{n.events === 1 ? '' : 's'}</span>}
                  <span className="data-size mono">0x{n.id.toString(16).toUpperCase().padStart(8, '0')}</span>
                </div>
              ))}
              {filtered.length === 0 && <div className="data-ft-more">No NPCs match “{query}”.</div>}
            </div>
          </>
        )}
      </div>
      <div className="data-side">
        <FileCard
          doc={doc}
          activeSource={doc.fullPath || ''}
          onSelectSource={onSelectSource}
          onRevealPath={onRevealPath}
          extraRows={<Row label="NPCs" value={doc.npcs.length.toLocaleString()} />}
        />
      </div>
    </div>
  );
}

const CAT_ICONS = {
  Cutscene: 'movie', Menu: 'menu_open', Dialogue: 'chat', Door: 'door_front',
  Magic: 'auto_fix_high', Script: 'code', Empty: 'block',
};

/** Zone events: actor → event → opcode disassembly. */
function EventsView({ doc, sources, zoneChrome, onSelectSource, onRevealPath }) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return doc.actors;
    return doc.actors
      .map((a) => {
        if (a.label.toLowerCase().includes(q)) return a;
        const events = a.events.filter((e) =>
          String(e.eventId) === q || e.category.toLowerCase() === q
          || e.opcodes.some((o) => o.name.includes(q)));
        return events.length ? { ...a, events } : null;
      })
      .filter(Boolean);
  }, [doc, query]);

  return (
    <div className="data-viewer">
      <div className="panel data-main">
        <div className="data-card-title">
          <span className="icon">smart_display</span>Events
          {doc.zoneName && <span className="data-zone-tag">{doc.zoneName}</span>}
          <span className="data-card-note mono">
            {doc.actors.length.toLocaleString()} actors · {doc.stats.events.toLocaleString()} events
          </span>
        </div>
        {zoneChrome}
        {!doc.actors.length ? (
          <ZoneEmptyState
            icon="smart_display"
            title="No Events"
            sub="This zone's Event DAT has no actor scripts."
          />
        ) : (
          <>
            <SearchWrap query={query} setQuery={setQuery} placeholder="Filter by NPC, event id, category or opcode…" />
            <div className="data-tree">
              {filtered.map((a) => (
                <EventActorNode key={a.actorId} actor={a} dialogTexts={doc.dialogTexts} forceOpen={!!query.trim()} />
              ))}
              {filtered.length === 0 && <div className="data-ft-more">Nothing matches “{query}”.</div>}
            </div>
          </>
        )}
      </div>
      <div className="data-side">
        <FileCard
          doc={doc}
          activeSource={doc.fullPath || ''}
          onSelectSource={onSelectSource}
          onRevealPath={onRevealPath}
          extraRows={(
            <>
              <Row label="Actors" value={doc.actors.length.toLocaleString()} />
              <Row label="Events" value={doc.stats.events.toLocaleString()} />
              <Row label="Cutscenes" value={doc.stats.cutscenes.toLocaleString()} />
            </>
          )}
        />
        <div className="panel data-card data-census">
          <div className="data-card-title"><span className="icon">category</span>By category</div>
          <div className="data-census-rows">
            {Object.entries(doc.stats.categories).filter(([, c]) => c > 0).map(([cat, count]) => (
              <div key={cat} className="data-census-row">
                <span className="icon">{CAT_ICONS[cat] ?? 'code'}</span>
                <span className="data-census-name">{cat}</span>
                <span className="data-census-count mono">{count.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function EventActorNode({ actor, dialogTexts, forceOpen }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="data-node">
      <div className="data-row data-dir-row" onClick={() => setOpen((v) => !v)}>
        <span className={`icon data-caret${open ? ' open' : ''}`}>chevron_right</span>
        <span className="icon data-kind">person_pin</span>
        <span className="data-id mono">{actor.label}</span>
        <span className="data-dir-counts mono">
          {actor.events.length} event{actor.events.length === 1 ? '' : 's'}
          {actor.refFourccs.length > 0 && ` · ${actor.refFourccs.slice(0, 4).join(' ')}`}
        </span>
      </div>
      {open && actor.events.map((e) => (
        <EventNode key={`${e.eventId}:${e.offset}`} ev={e} dialogTexts={dialogTexts} defaultOpen={forceOpen && actor.events.length === 1} />
      ))}
    </div>
  );
}

function EventNode({ ev, dialogTexts, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="data-node">
      <div className="data-row data-dir-row" style={{ paddingLeft: 22 }} onClick={() => setOpen((v) => !v)}>
        <span className={`icon data-caret${open ? ' open' : ''}`}>chevron_right</span>
        <span className="icon data-kind">{CAT_ICONS[ev.category] ?? 'code'}</span>
        <span className="data-id mono">Event {ev.eventId}</span>
        <span className="data-dir-counts mono">
          {ev.category} · {ev.opcodes.length} ops
          {ev.dialogIds.length > 0 && ` · ${ev.dialogIds.length} lines`}
        </span>
      </div>
      {open && ev.opcodes.map((o, i) => (
        <div key={i} className="data-row data-op-row" title={o.args ? `args: ${o.args}` : undefined}>
          <span className="data-op-off mono">{o.offset.toString(16).toUpperCase().padStart(4, '0')}</span>
          <span className="data-op-hex mono">{o.op.toString(16).toUpperCase().padStart(2, '0')}</span>
          <span className="data-op-name mono">{o.name}</span>
          <span className="data-op-extra mono">
            {o.dialogRef >= 0 && dialogTexts?.[o.dialogRef] != null
              ? `#${o.dialogRef} “${dialogTexts[o.dialogRef].replace(/\s+/g, ' ').slice(0, 70)}${dialogTexts[o.dialogRef].length > 70 ? '…' : ''}”`
              : o.dialogRef >= 0 ? `dialog #${o.dialogRef}`
                : o.zoneRef >= 0 ? `zone ${o.zoneRef}`
                  : o.actors.length ? o.actors.map((x) => x.label).join(' → ')
                    : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Zone dialog. Two ways in: "By event" groups lines under the actor + event
 * that prints them, in playback order (the level editor's Lines-tab shape);
 * "All lines" is the flat indexed table. Lines no event references (system
 * messages, quest text fired server-side) sit in a collapsed bucket.
 */
function DialogView({ doc, sources, zoneChrome, onSelectSource, onRevealPath }) {
  const [query, setQuery] = useState('');
  const canGroup = !!doc.conversations?.length;
  const [mode, setMode] = useState(canGroup ? 'events' : 'all');

  const referenced = useMemo(() => {
    const s = new Set();
    for (const g of doc.conversations ?? []) {
      for (const ev of g.events) for (const l of ev.lines) s.add(l.index);
    }
    return s;
  }, [doc]);

  const filteredConvos = useMemo(() => {
    if (!canGroup) return [];
    const q = query.trim().toLowerCase();
    if (!q) return doc.conversations;
    const textOf = (i) => doc.entries[i]?.text?.toLowerCase() ?? '';
    return doc.conversations
      .map((g) => {
        if (g.label.toLowerCase().includes(q)) return g;
        const events = g.events
          .map((ev) => {
            if (String(ev.eventId) === q) return ev;
            const lines = ev.lines.filter((l) =>
              textOf(l.index).includes(q) || l.speaker.toLowerCase().includes(q));
            return lines.length ? { ...ev, lines } : null;
          })
          .filter(Boolean);
        return events.length ? { ...g, events } : null;
      })
      .filter(Boolean);
  }, [doc, query, canGroup]);

  const filteredFlat = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return doc.entries;
    return doc.entries.filter((e) =>
      String(e.index) === q
      || e.text.toLowerCase().includes(q)
      || e.speakers?.some((s) => s.toLowerCase().includes(q)));
  }, [doc, query]);

  const unreferenced = useMemo(
    () => (canGroup ? doc.entries.filter((e) => !referenced.has(e.index)) : []),
    [doc, referenced, canGroup],
  );

  const shown = filteredFlat.length > FT_MAX_ROWS ? filteredFlat.slice(0, FT_MAX_ROWS) : filteredFlat;
  const groupedCount = filteredConvos.reduce((s, g) => s + g.events.reduce((t, e) => t + e.lines.length, 0), 0);

  return (
    <div className="data-viewer">
      <div className="panel data-main">
        <div className="data-card-title">
          <span className="icon">chat</span>Dialog
          {doc.zoneName && <span className="data-zone-tag">{doc.zoneName}</span>}
          <span className="data-card-note mono">
            {mode === 'events'
              ? `${groupedCount.toLocaleString()} event lines · ${doc.entries.length.toLocaleString()} total`
              : filteredFlat.length === doc.entries.length
                ? `${doc.entries.length.toLocaleString()} entries`
                : `${filteredFlat.length.toLocaleString()} of ${doc.entries.length.toLocaleString()}`}
          </span>
        </div>
        {zoneChrome}
        {!doc.entries.length ? (
          <ZoneEmptyState
            icon="chat"
            title="No Dialog"
            sub="This zone's Dialog DAT has no message lines."
          />
        ) : (
          <>
            <SearchWrap query={query} setQuery={setQuery} placeholder="Filter by text, speaker or index…">
              {canGroup && (
                <div className="data-cats">
                  <button className={`data-cat${mode === 'events' ? ' on' : ''}`} onClick={() => setMode('events')}>By event</button>
                  <button className={`data-cat${mode === 'all' ? ' on' : ''}`} onClick={() => setMode('all')}>All lines</button>
                </div>
              )}
            </SearchWrap>
            <div className="data-tree">
              {mode === 'events' ? (
                <>
                  {filteredConvos.map((g) => (
                    <DlgActorNode key={g.actorId} group={g} entries={doc.entries} />
                  ))}
                  {filteredConvos.length === 0 && query && (
                    <div className="data-ft-more">Nothing matches “{query}”.</div>
                  )}
                  {!query && unreferenced.length > 0 && (
                    <DlgUnreferencedNode entries={unreferenced} />
                  )}
                </>
              ) : (
                <>
                  {shown.map((e) => <DlgLine key={e.index} entry={e} speaker={e.speakers?.length ? e.speakers.join(', ') : '—'} />)}
                  {filteredFlat.length > FT_MAX_ROWS && (
                    <div className="data-ft-more">
                      Showing the first {FT_MAX_ROWS.toLocaleString()} of {filteredFlat.length.toLocaleString()} — narrow the filter to see the rest.
                    </div>
                  )}
                  {filteredFlat.length === 0 && <div className="data-ft-more">No entries match “{query}”.</div>}
                </>
              )}
            </div>
          </>
        )}
      </div>
      <div className="data-side">
        <FileCard
          doc={doc}
          activeSource={doc.fullPath || ''}
          onSelectSource={onSelectSource}
          onRevealPath={onRevealPath}
          extraRows={(
            <>
              <Row label="Entries" value={doc.entries.length.toLocaleString()} />
              {canGroup && <Row label="In events" value={referenced.size.toLocaleString()} />}
              {canGroup && <Row label="Unreferenced" value={unreferenced.length.toLocaleString()} />}
              <Row label="Obfuscated" value={doc.obfuscated ? 'yes (XOR 0x80)' : 'no'} />
            </>
          )}
        />
      </div>
    </div>
  );
}

/** One dialog line (speaker + text), optionally indented under an event. */
function DlgLine({ entry, speaker, indent = 0 }) {
  if (!entry) return null;
  return (
    <div
      className="data-dlg-entry"
      style={indent ? { paddingLeft: 8 + indent * 14 } : undefined}
      title={`line ${entry.index} · offset 0x${entry.offset.toString(16).toUpperCase()} · ${entry.length} bytes`}
    >
      <div className="data-dlg-head">
        <span className="data-ft-id mono">{entry.index}</span>
        <span className="data-dlg-speaker">{speaker}</span>
      </div>
      <div className="data-dlg-text">{entry.text || <span className="data-dlg-empty">(empty)</span>}</div>
    </div>
  );
}

function DlgActorNode({ group, entries }) {
  const [open, setOpen] = useState(true);
  const lineCount = group.events.reduce((s, e) => s + e.lines.length, 0);
  return (
    <div className="data-node">
      <div className="data-row data-dir-row" onClick={() => setOpen((v) => !v)}>
        <span className={`icon data-caret${open ? ' open' : ''}`}>chevron_right</span>
        <span className="icon data-kind">person_pin</span>
        <span className="data-id mono">{group.label}</span>
        <span className="data-dir-counts mono">
          {group.events.length} event{group.events.length === 1 ? '' : 's'} · {lineCount} line{lineCount === 1 ? '' : 's'}
        </span>
      </div>
      {open && group.events.map((ev) => (
        <DlgEventNode key={`${ev.eventId}:${ev.lines[0]?.index}`} ev={ev} entries={entries} />
      ))}
    </div>
  );
}

function DlgEventNode({ ev, entries }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="data-node">
      <div className="data-row data-dir-row" style={{ paddingLeft: 22 }} onClick={() => setOpen((v) => !v)}>
        <span className={`icon data-caret${open ? ' open' : ''}`}>chevron_right</span>
        <span className="icon data-kind">{CAT_ICONS[ev.category] ?? 'code'}</span>
        <span className="data-id mono">Event {ev.eventId}</span>
        <span className="data-dir-counts mono">{ev.category} · {ev.lines.length} line{ev.lines.length === 1 ? '' : 's'}</span>
      </div>
      {open && ev.lines.map((l, i) => (
        <DlgLine key={`${l.index}:${i}`} entry={entries[l.index]} speaker={l.speaker} indent={3} />
      ))}
    </div>
  );
}

/** Lines no event prints — server-fired messages, quest text, menu strings. */
function DlgUnreferencedNode({ entries }) {
  const [open, setOpen] = useState(false);
  const shown = entries.length > FT_MAX_ROWS ? entries.slice(0, FT_MAX_ROWS) : entries;
  return (
    <div className="data-node">
      <div className="data-row data-dir-row" onClick={() => setOpen((v) => !v)}>
        <span className={`icon data-caret${open ? ' open' : ''}`}>chevron_right</span>
        <span className="icon data-kind">inbox</span>
        <span className="data-id mono">Not printed by any event</span>
        <span className="data-dir-counts mono">{entries.length.toLocaleString()} lines — system/server messages</span>
      </div>
      {open && shown.map((e) => <DlgLine key={e.index} entry={e} speaker="—" indent={2} />)}
      {open && entries.length > FT_MAX_ROWS && (
        <div className="data-ft-more">
          Showing the first {FT_MAX_ROWS.toLocaleString()} of {entries.length.toLocaleString()} — use All lines with a filter for the rest.
        </div>
      )}
    </div>
  );
}

/** One file-table row: model/file id, optional race+slot, DAT path. */
function FtRow({ e, onOpenDat, indent = 0, tableRace = null }) {
  return (
    <div
      className="data-row data-ft-row"
      style={indent ? { paddingLeft: 8 + indent * 14 } : undefined}
      title={`file id ${e.id} · FTABLE 0x${e.ftVal.toString(16).toUpperCase().padStart(4, '0')} (subdir ${e.ftVal >> 7} · file ${e.ftVal & 0x7f}) — click to inspect`}
      onClick={() => onOpenDat?.(e.dat, {
        tableRace: tableRace || e.tableRace || null,
        races: e.races,
      })}
    >
      <span className="data-ft-id mono">{e.modelId ?? e.id}</span>
      {e.raceLabel && <span className="data-type">{e.raceLabel} {e.slot}</span>}
      <span className="data-id mono">{e.dat}</span>
      <span className="data-size mono">{e.modelId != null ? `id ${e.id}` : `ROM ${e.rom}`}</span>
    </div>
  );
}

/** Gear tree: race → slot → DAT rows. Races open flat; slots expand on click. */
function GearRaceNode({ node, onOpenDat }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="data-node">
      <div className="data-row data-dir-row" onClick={() => setOpen((v) => !v)}>
        <span className={`icon data-caret${open ? ' open' : ''}`}>chevron_right</span>
        <span className="icon data-kind">person</span>
        <span className="data-id mono">{node.label}</span>
        <span className="data-dir-counts mono">{node.count.toLocaleString()} models</span>
      </div>
      {open && node.slots.map((s) => (
        <GearSlotNode key={s.slot} node={s} onOpenDat={onOpenDat} tableRace={node.race} />
      ))}
    </div>
  );
}

function GearSlotNode({ node, onOpenDat, tableRace }) {
  const [open, setOpen] = useState(false);
  const label = node.slot[0].toUpperCase() + node.slot.slice(1);
  return (
    <div className="data-node">
      <div className="data-row data-dir-row" style={{ paddingLeft: 22 }} onClick={() => setOpen((v) => !v)}>
        <span className={`icon data-caret${open ? ' open' : ''}`}>chevron_right</span>
        <span className="icon data-kind">checkroom</span>
        <span className="data-id mono">{label}</span>
        <span className="data-dir-counts mono">{node.rows.length.toLocaleString()} models</span>
      </div>
      {open && node.rows.map((e) => (
        <FtRow
          key={e.id}
          e={{ ...e, raceLabel: null }}
          onOpenDat={onOpenDat}
          indent={3}
          tableRace={tableRace}
        />
      ))}
    </div>
  );
}

function DirNode({ dir, depth, forceOpen, onOpenTexture, onOpenSkeleton, onOpenZoneDef, onOpenRoute, onOpenUiMenu, onOpenUiElementGroup, onOpenParticle, onPlaySound, playingSoundKey }) {
  const [open, setOpen] = useState(depth < 4 || !!forceOpen);
  // While filtering, keep matching branches expanded.
  const expanded = forceOpen || open;
  // Folder rows summarise what's inside so a collapsed tree still reads.
  const counts = useMemo(() => {
    let dirs = 0, res = 0;
    const walk = (d) => {
      for (const c of d.children) {
        if (c.kind === 'dir') { dirs++; walk(c); } else res++;
      }
    };
    walk(dir);
    return { dirs, res };
  }, [dir]);

  const isRoot = depth === 0;
  return (
    <div className="data-node">
      {!isRoot && (
        <div
          className="data-row data-dir-row"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => setOpen((v) => !v)}
        >
          <span className={`icon data-caret${expanded ? ' open' : ''}`}>chevron_right</span>
          <span className="icon data-kind">folder</span>
          <span className="data-id mono">{dir.id || '(unnamed)'}</span>
          <span className="data-dir-counts mono">
            {counts.dirs > 0 && `${counts.dirs} folders · `}{counts.res} items
          </span>
        </div>
      )}
      {(isRoot || expanded) && dir.children.map((c, i) => (
        c.kind === 'dir'
          ? (
            <DirNode
              key={`d${i}`}
              dir={c}
              depth={depth + 1}
              forceOpen={forceOpen}
              onOpenTexture={onOpenTexture}
              onOpenSkeleton={onOpenSkeleton}
              onOpenZoneDef={onOpenZoneDef}
              onOpenRoute={onOpenRoute}
              onOpenUiMenu={onOpenUiMenu}
              onOpenUiElementGroup={onOpenUiElementGroup}
              onOpenParticle={onOpenParticle}
              onPlaySound={onPlaySound}
              playingSoundKey={playingSoundKey}
            />
          )
          : (
            <ResRow
              key={`r${i}`}
              res={c}
              depth={depth + 1}
              onOpenTexture={onOpenTexture}
              onOpenSkeleton={onOpenSkeleton}
              onOpenZoneDef={onOpenZoneDef}
              onOpenRoute={onOpenRoute}
              onOpenUiMenu={onOpenUiMenu}
              onOpenUiElementGroup={onOpenUiElementGroup}
              onOpenParticle={onOpenParticle}
              onPlaySound={onPlaySound}
              playingSoundKey={playingSoundKey}
            />
          )
      ))}
    </div>
  );
}

function ResRow({ res, depth, onOpenTexture, onOpenSkeleton, onOpenZoneDef, onOpenRoute, onOpenUiMenu, onOpenUiElementGroup, onOpenParticle, onPlaySound, playingSoundKey }) {
  const isTex = !!(res.isTexture || res.textureName
    || res.type === 0x20 || res.type === 0x5D
    || res.name === 'Texture' || res.name === 'BumpMap');
  // 0x29 Skeleton — accept numeric 41 or hex, name, or inspect flag.
  const isSkel = !!(res.isSkeleton
    || res.type === 0x29 || res.type === 41
    || res.name === 'Skeleton'
    || res.skeletonKind);
  const isSound = !!(res.isSound || res.type === 0x3D || res.type === 61
    || res.name === 'SoundEffectPointer');
  const isZoneDef = !!(res.isZoneDef || res.type === 0x1C || res.type === 28
    || res.name === 'ZoneDef');
  const isRoute = !!(res.isRoute || res.type === 0x06 || res.type === 6
    || res.name === 'Route');
  const isUiMenu = !!(res.isUiMenu || res.type === 0x30 || res.type === 48
    || res.name === 'UiMenu');
  const isUiElementGroup = !!(res.isUiElementGroup || res.type === 0x31 || res.type === 49
    || res.name === 'UiElementGroup');
  const isParticle = !!(res.isParticleGenerator || res.type === 0x05 || res.type === 5
    || res.name === 'ParticleGenerator');
  const soundKey = isSound && res.soundId != null
    ? `${res.offset ?? ''}:${res.soundId}`
    : null;
  const soundPlaying = !!(soundKey && playingSoundKey === soundKey);
  const texClick = isTex && !!onOpenTexture;
  const skelClick = isSkel && !!onOpenSkeleton;
  // ZoneDef / Particle / Route / Ui* stay activatable so a missing handler still logs.
  const zdefClick = isZoneDef;
  const routeClick = isRoute;
  const uiMenuClick = isUiMenu;
  const uiEgClick = isUiElementGroup;
  const particleClick = isParticle;
  const soundClick = isSound && res.soundId != null && !!onPlaySound;
  const clickable = texClick || skelClick || soundClick || zdefClick || particleClick || routeClick || uiMenuClick || uiEgClick;
  const openKey = res.textureName || res.id?.trim() || null;
  const onActivate = (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if (soundClick) onPlaySound(res);
    else if (particleClick) {
      if (typeof onOpenParticle === 'function') onOpenParticle(res);
      else console.error('ParticleGenerator click: onOpenParticle handler missing', res);
    } else if (uiEgClick) {
      if (typeof onOpenUiElementGroup === 'function') onOpenUiElementGroup(res);
      else console.error('UiElementGroup click: onOpenUiElementGroup handler missing', res);
    } else if (uiMenuClick) {
      if (typeof onOpenUiMenu === 'function') onOpenUiMenu(res);
      else console.error('UiMenu click: onOpenUiMenu handler missing', res);
    } else if (routeClick) {
      if (typeof onOpenRoute === 'function') onOpenRoute(res);
      else console.error('Route click: onOpenRoute handler missing', res);
    } else if (zdefClick) {
      if (typeof onOpenZoneDef === 'function') onOpenZoneDef(res);
      else console.error('ZoneDef click: onOpenZoneDef handler missing', res);
    } else if (skelClick) onOpenSkeleton(res);
    else if (texClick && openKey) onOpenTexture(openKey);
  };
  const flags = res.flags ?? [];
  const hint = soundClick ? (soundPlaying ? 'click to stop' : 'click to play')
    : particleClick ? 'click to play'
      : uiEgClick ? 'click to view sprites'
        : uiMenuClick ? 'click to view layout'
          : routeClick ? 'click to view path'
            : zdefClick ? 'click to view placements'
              : 'click to view';
  return (
    <div
      className={`data-row data-res-row${isTex ? ' data-res-tex' : ''}${isSkel ? ' data-res-skel' : ''}${isZoneDef ? ' data-res-zdef' : ''}${isRoute ? ' data-res-route' : ''}${isUiMenu ? ' data-res-uimenu' : ''}${isUiElementGroup ? ' data-res-uieg' : ''}${isParticle ? ' data-res-fx' : ''}${isSound ? ' data-res-sfx' : ''}${soundPlaying ? ' data-res-sfx-play' : ''}${clickable ? ' data-res-click' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      title={soundClick
        ? (soundPlaying ? `Click to stop se ${res.soundId}` : `Click to play se ${res.soundId}`)
        : particleClick
          ? `Click to play particle · ${String(res.id || '').trim() || 'generator'}`
          : uiEgClick
            ? `Click to view element group / sprites · offset 0x${(res.offset ?? 0).toString(16).toUpperCase()}`
            : uiMenuClick
              ? `Click to view menu layout · offset 0x${(res.offset ?? 0).toString(16).toUpperCase()}`
              : routeClick
                ? `Click to view camera path · offset 0x${(res.offset ?? 0).toString(16).toUpperCase()}`
                : zdefClick
                  ? `Click to view placements · offset 0x${(res.offset ?? 0).toString(16).toUpperCase()}`
                  : skelClick
                    ? `Click to view skeleton tree · offset 0x${(res.offset ?? 0).toString(16).toUpperCase()}`
                    : texClick
                      ? `Click to view texture · offset 0x${(res.offset ?? 0).toString(16).toUpperCase()}`
                      : `offset 0x${(res.offset ?? 0).toString(16).toUpperCase()}${flags.length ? ` · ${flags.join(', ')}` : ''}`}
      onClick={clickable ? onActivate : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(e); }
      } : undefined}
    >
      <span className="data-caret-pad" />
      <span className={`icon data-kind${soundPlaying ? ' data-sfx-icon-play' : ''}`}>{res.icon}</span>
      <span className="data-id mono">{res.id || '····'}</span>
      <span className="data-type">{res.name}</span>
      {res.detail && <span className="data-detail mono">{res.detail}</span>}
      {clickable && !res.detail && (
        <span className="data-detail data-tex-hint">{hint}</span>
      )}
      {flags.length > 0 && <span className="data-flags mono">{flags.join(' ')}</span>}
      <span className="data-size mono">{fmtBytes(res.size)}</span>
    </div>
  );
}

function Row({ label, value, mono }) {
  return (
    <div className="details-row">
      <span className="details-row-label">{label}</span>
      <span className={`details-row-value${mono ? ' mono' : ''}`}>{value}</span>
    </div>
  );
}

function FileSubhead({ children }) {
  return <div className="data-file-subhead">{children}</div>;
}

/** Clickable path row — opens the OS file manager on that DAT. */
function PathRow({ label, value, mono, onClick, ellipsis }) {
  if (!value) return null;
  if (!onClick) {
    return (
      <div className="details-row">
        <span className="details-row-label">{label}</span>
        <span
          className={`details-row-value${mono ? ' mono' : ''}${ellipsis ? ' details-path-ellipsis' : ''}`}
          title={ellipsis ? value : undefined}
        >
          {value}
        </span>
      </div>
    );
  }
  return (
    <div className="details-row">
      <span className="details-row-label">{label}</span>
      <button
        type="button"
        className={`details-row-value details-path-link${mono ? ' mono' : ''}${ellipsis ? ' details-path-ellipsis' : ''}`}
        title={value}
        onClick={onClick}
      >
        {value}
      </button>
    </div>
  );
}

/**
 * Right-hand File card: zone identity, this DAT's stats, related zone DATs,
 * full path (ellipsis) at the bottom.
 */
function FileCard({
  doc, isCreation, sourceItems, activeSource, onSelectSource, onRevealPath, onRenderFile, extraRows,
}) {
  const zoneDats = doc.zoneDats ?? [];
  const hasZoneBundle = zoneDats.length > 1;
  // Prefer gamePath + rel when we know the install root from fullPath.
  const absOf = (rel) => {
    if (!rel) return null;
    const r = String(rel).replace(/\//g, '\\');
    if (!doc.fullPath || !doc.path) return r;
    const full = String(doc.fullPath).replace(/\//g, '\\');
    const cur = String(doc.path).replace(/\//g, '\\');
    const idx = full.toLowerCase().lastIndexOf(cur.toLowerCase());
    if (idx < 0) return r;
    return `${full.slice(0, idx)}${r}`;
  };

  // Dropdown only when multi-DAT and NOT the zone bundle (Zone DATs list is the switcher).
  const showCombo = sourceItems?.length > 1 && !hasZoneBundle;

  return (
    <div className="panel data-card">
      <div className="data-card-title"><span className="icon">description</span>File</div>
      {showCombo && (
        <div className="data-source-combo data-source-combo-side">
          <Combo value={activeSource} items={sourceItems} onChange={(id) => onSelectSource?.(id)} />
        </div>
      )}

      {(doc.zoneName || doc.zoneId != null || doc.fileId != null) && (
        <>
          <FileSubhead>Zone</FileSubhead>
          {doc.zoneName && <Row label="Name" value={doc.zoneName} />}
          {doc.zoneId != null && <Row label="Zone ID" value={String(doc.zoneId)} mono />}
          {doc.fileId != null && <Row label="File ID" value={doc.fileId.toLocaleString()} mono />}
        </>
      )}

      <FileSubhead>This DAT</FileSubhead>
      <PathRow
        label="Path"
        value={doc.path}
        mono
        onClick={onRevealPath ? () => onRevealPath(doc.fullPath || doc.path) : undefined}
      />
      {doc.fileSize != null && <Row label="Size" value={fmtBytes(doc.fileSize)} />}
      {isCreation ? (
        <>
          <Row label="Format" value={doc.formatLabel || doc.magic || 'creation'} />
          {doc.magic && <Row label="Magic" value={doc.magic} mono />}
          {doc.sectionCount != null && (
            <Row label="Entries" value={doc.sectionCount.toLocaleString()} />
          )}
        </>
      ) : doc.kind === 'sections' ? (
        <>
          <Row label="Sections" value={doc.sectionCount.toLocaleString()} />
          <Row label="Folders" value={doc.dirCount.toLocaleString()} />
          <Row label="Depth" value={doc.maxDepth} />
        </>
      ) : doc.kind === 'other' ? (
        <>
          {doc.label && <Row label="Kind" value={doc.label} />}
          {doc.magic && <Row label="Magic" value={doc.magic} mono />}
        </>
      ) : null}
      {extraRows}

      {zoneDats.length > 0 && (
        <>
          <FileSubhead>Zone DATs</FileSubhead>
          <div className="data-zone-dat-list">
            {zoneDats.map((d) => {
              const abs = absOf(d.rel);
              const active = !!(activeSource && abs
                && activeSource.toLowerCase() === abs.toLowerCase());
              return (
                <button
                  key={d.key}
                  type="button"
                  className={`data-zone-dat${active ? ' on' : ''}`}
                  title={abs || d.rel}
                  onClick={() => {
                    if (abs && onSelectSource) onSelectSource(abs);
                  }}
                >
                  <span className="data-zone-dat-label">{d.label}</span>
                  <span className="data-zone-dat-path mono">{d.rel}</span>
                  {d.fileId != null && (
                    <span className="data-zone-dat-fid mono">{d.fileId}</span>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}

      {(doc.warnings ?? []).map((w, i) => (
        <div key={i} className="data-warning">
          <span className="icon">warning</span>{w}
        </div>
      ))}

      {onRenderFile && (
        <div className="data-card-actions">
          <button type="button" className="data-open-btn" onClick={onRenderFile}>
            <span className="icon">view_in_ar</span>
            Open in 3D viewer
          </button>
        </div>
      )}
    </div>
  );
}
