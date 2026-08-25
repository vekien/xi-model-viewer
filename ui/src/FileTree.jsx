import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { backend } from '../js/backend.js';
import { Tooltip } from './Tooltip.jsx';

const LISTABLE = /\.(dat|bgw|spw|png)$/i;
const MAX_SEARCH = 400;
const PIN_KEY = 'pinnedFiles';

/** Normalize for selection compares (case + slash direction). */
function normPath(p) {
  return String(p || '').toLowerCase().replace(/\//g, '\\');
}

/**
 * True when two paths name the same file — absolute, relative, or mixed
 * (tree uses abs under gamePath; loaders may store ROM\… or an HD resolve).
 */
function sameFile(a, b) {
  const na = normPath(a);
  const nb = normPath(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.endsWith('\\' + nb) || nb.endsWith('\\' + na)) return true;
  const tail = (p) => {
    const m = p.match(/(?:^|\\)((?:rom\d*|sound\d*|maps)\\.+)$/i);
    return m ? m[1] : p.split('\\').slice(-3).join('\\');
  };
  return tail(na) === tail(nb);
}

/** Prefer ROM\… relative key so pins survive game-path moves. */
function filePinKey(path, rootPath) {
  const n = normPath(path);
  if (!n) return '';
  const root = normPath(rootPath);
  if (root && (n === root || n.startsWith(root + '\\'))) {
    return n.slice(root.length + (n === root ? 0 : 1));
  }
  const m = n.match(/(?:^|\\)((?:rom\d*|sound\d*|maps)\\.+)$/i);
  return m ? m[1] : n;
}

function pinKeyMatch(skipKey, path, rootPath) {
  if (!skipKey) return false;
  return filePinKey(path, rootPath) === skipKey;
}

function loadPins() {
  try {
    const v = JSON.parse(localStorage.getItem(PIN_KEY) || '[]');
    return Array.isArray(v) ? v.map((k) => normPath(k)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function savePins(keys) {
  try { localStorage.setItem(PIN_KEY, JSON.stringify(keys)); } catch { /* quota */ }
}

function naturalCompare(a, b) {
  const na = parseInt(a, 10);
  const nb = parseInt(b, 10);
  const aNum = !isNaN(na) && /^\d+/.test(a);
  const bNum = !isNaN(nb) && /^\d+/.test(b);
  if (aNum && bNum) return na - nb;
  if (aNum) return -1;
  if (bNum) return 1;
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

function matchesTokens(hay, tokens) {
  const h = hay.toLowerCase();
  return tokens.every((t) => h.includes(t));
}

/**
 * @param {string} rootPath
 * @param {string} selectedPath
 * @param {string} [revealTarget]
 * @param {(path: string) => void} onSelectFile
 * @param {(msg: string) => void} [onError]
 * @param {string[]} [pathIndex]  FTABLE-relative paths (ROM\…\n.DAT) for global search
 */
export function FileTree({ rootPath, selectedPath, revealTarget, onSelectFile, onError, pathIndex = null }) {
  const [query, setQuery] = useState('');
  const [pinned, setPinned] = useState(loadPins);
  // When opening from the Pinned folder, don't expand/scroll to the original tree path.
  const [skipRevealKey, setSkipRevealKey] = useState('');

  const pinSet = useMemo(() => new Set(pinned), [pinned]);

  const togglePin = useCallback((path) => {
    const k = filePinKey(path, rootPath);
    if (!k) return;
    setPinned((prev) => {
      const next = prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k];
      savePins(next);
      return next;
    });
  }, [rootPath]);

  const selectFromTree = useCallback((path) => {
    setSkipRevealKey('');
    onSelectFile?.(path);
  }, [onSelectFile]);

  const selectFromPin = useCallback((path) => {
    setSkipRevealKey(filePinKey(path, rootPath));
    onSelectFile?.(path);
  }, [onSelectFile, rootPath]);

  const handleBrowse = async () => {
    try {
      const file = await backend.pickFile(rootPath || null);
      if (file) selectFromTree(file);
    } catch (err) {
      onError?.(`Browse failed: ${err.message ?? err}`);
    }
  };

  const tokens = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/\//g, '\\');
    return q ? q.split(/\s+/).filter(Boolean) : [];
  }, [query]);

  const searchHits = useMemo(() => {
    if (!tokens.length || !pathIndex?.length || !rootPath) return null;
    const hits = [];
    for (const rel of pathIndex) {
      const norm = String(rel).replace(/\//g, '\\');
      if (!matchesTokens(norm, tokens)) continue;
      hits.push(norm);
      if (hits.length >= MAX_SEARCH) break;
    }
    return hits;
  }, [tokens, pathIndex, rootPath]);

  // Pinned rows: keep stored order; resolve to abs under rootPath.
  const pinnedRows = useMemo(() => {
    if (!rootPath || !pinned.length) return [];
    return pinned.map((rel) => ({
      rel,
      abs: `${rootPath}\\${rel.replace(/\//g, '\\')}`,
      name: rel.replace(/\//g, '\\').split('\\').pop() || rel,
    }));
  }, [rootPath, pinned]);

  if (!rootPath) return <div id="tree" className="panel" />;
  const rootName = rootPath.split(/[\\/]/).filter(Boolean).pop() ?? rootPath;
  const searching = tokens.length > 0;

  return (
    <div id="tree" className="panel tree-panel">
      <div className="tree-browse">
        <Tooltip content="Open any game file" placement="right">
          <button type="button" className="tree-browse-btn" onClick={handleBrowse}>
            <span className="icon">folder_open</span>
            Browse…
          </button>
        </Tooltip>
      </div>
      <div className="list-search-wrap">
        <span className="icon">search</span>
        <input
          type="search"
          className="list-search"
          placeholder="Search files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        {query && (
          <button type="button" className="list-search-clear" title="Clear" onClick={() => setQuery('')}>
            <span className="icon">close</span>
          </button>
        )}
      </div>
      <div className="tree-scroll">
        {searching && searchHits && (
          <div className="tree-search-results">
            {searchHits.length === 0 && (
              <div className="side-note">No files match “{query.trim()}”.</div>
            )}
            {searchHits.map((rel) => {
              const abs = `${rootPath}\\${rel}`;
              const selected = sameFile(selectedPath, abs) || sameFile(selectedPath, rel);
              const key = filePinKey(rel, rootPath);
              const isPinned = pinSet.has(key);
              return (
                <div
                  key={rel}
                  className={`node zone-row${selected ? ' selected' : ''}${isPinned ? ' zone-is-pinned' : ''}`}
                >
                  <div
                    className="row"
                    title={rel}
                    onClick={() => selectFromTree(abs)}
                  >
                    <span className="caret icon" />
                    <span className="kind icon">deployed_code</span>
                    <span className="tree-hit-path">{rel}</span>
                    <PinBtn pinned={isPinned} onToggle={() => togglePin(abs)} />
                  </div>
                </div>
              );
            })}
            {searchHits.length >= MAX_SEARCH && (
              <div className="side-note">Showing first {MAX_SEARCH} matches.</div>
            )}
          </div>
        )}
        {searching && !searchHits && (
          <div className="side-note">Building file index…</div>
        )}
        {!searching && (
          <>
            {pinnedRows.length > 0 && (
              <PinnedFolder
                rows={pinnedRows}
                selectedPath={selectedPath}
                onSelectFile={selectFromPin}
                onTogglePin={togglePin}
              />
            )}
            <TreeNode
              key={rootPath}
              path={rootPath}
              name={rootName}
              isDir
              defaultOpen
              selectedPath={selectedPath}
              revealTarget={revealTarget}
              skipRevealKey={skipRevealKey}
              onSelectFile={selectFromTree}
              onError={onError}
              filterTokens={null}
              rootPath={rootPath}
              pinSet={pinSet}
              onTogglePin={togglePin}
            />
          </>
        )}
      </div>
      {searching && searchHits && searchHits.length > 0 && (
        <div className="side-note zone-count">
          {searchHits.length >= MAX_SEARCH ? `${MAX_SEARCH}+` : searchHits.length} matches
        </div>
      )}
      {!searching && pinned.length > 0 && (
        <div className="side-note zone-count">{pinned.length} pinned</div>
      )}
    </div>
  );
}

function PinBtn({ pinned, onToggle }) {
  return (
    <Tooltip content={pinned ? 'Unpin file' : 'Pin file'} placement="right">
      <button
        type="button"
        className={`zone-pin-btn${pinned ? ' on' : ''}`}
        aria-label={pinned ? 'Unpin file' : 'Pin file'}
        aria-pressed={pinned}
        onClick={(e) => {
          e.stopPropagation();
          onToggle?.();
        }}
      >
        <span className={`icon${pinned ? ' fill' : ''}`}>keep</span>
      </button>
    </Tooltip>
  );
}

function PinnedFolder({ rows, selectedPath, onSelectFile, onTogglePin }) {
  const [open, setOpen] = useState(true);
  return (
    <div className={`node${open ? ' open' : ''} zone-pinned-group`}>
      <div className="row" onClick={() => setOpen((v) => !v)}>
        <span className="caret icon">chevron_right</span>
        <span className="kind icon zone-pin-folder-icon">keep</span>
        <span>Pinned</span>
        <span className="badge">{rows.length}</span>
      </div>
      {open && (
        <div className="children">
          {rows.map((r) => {
            const selected = sameFile(selectedPath, r.abs) || sameFile(selectedPath, r.rel);
            return (
              <div
                key={r.rel}
                className={`node zone-row${selected ? ' selected' : ''} zone-is-pinned`}
              >
                <div
                  className="row"
                  title={r.rel}
                  onClick={() => onSelectFile(r.abs)}
                >
                  <span className="caret icon" />
                  <span className="kind icon">deployed_code</span>
                  <span className="tree-hit-path">{r.rel}</span>
                  <PinBtn pinned onToggle={() => onTogglePin(r.abs)} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TreeNode({
  path, name, isDir, defaultOpen, selectedPath, revealTarget, skipRevealKey,
  onSelectFile, onError, filterTokens, rootPath, pinSet, onTogglePin,
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [entries, setEntries] = useState(null);
  const rowRef = useRef(null);
  // User collapsed this folder — don't fight them by re-opening for the same selection.
  const pinnedClosedRef = useRef(false);
  const lastAutoRevealRef = useRef('');

  const lowerPath = normPath(path);
  const isSelected = !isDir && sameFile(selectedPath, path);
  const reveal = normPath(revealTarget);
  const revealKey = reveal ? filePinKey(reveal, rootPath) : '';
  // Pin-folder opens: don't expand ancestors or scroll to the original tree row.
  const suppressReveal = !!(skipRevealKey && (
    (!isDir && pinKeyMatch(skipRevealKey, path, rootPath))
    || (revealKey && revealKey === skipRevealKey)
  ));
  const onRevealChain = !suppressReveal && isDir && reveal
    && (reveal === lowerPath || reveal.startsWith(lowerPath + '\\'));
  const pinKey = !isDir ? filePinKey(path, rootPath) : '';
  const isPinned = !!(pinKey && pinSet?.has(pinKey));

  const loadEntries = useCallback(async () => {
    if (entries !== null) return;
    try {
      const list = await backend.listDir(path);
      const dirs = list.filter((e) => e.isDir).sort((a, b) => naturalCompare(a.name, b.name));
      const files = list
        .filter((e) => !e.isDir && LISTABLE.test(e.name))
        .sort((a, b) => naturalCompare(a.name, b.name));
      setEntries([...dirs, ...files]);
    } catch (err) {
      setEntries([]);
      onError?.(`Failed to list ${path}: ${err.message ?? err}`);
    }
  }, [entries, path, onError]);

  const openDir = useCallback(() => {
    pinnedClosedRef.current = false;
    setOpen(true);
    loadEntries();
  }, [loadEntries]);

  // Root default-open once (respects a later user collapse).
  useEffect(() => {
    if (!isDir || !defaultOpen || pinnedClosedRef.current) return;
    setOpen(true);
    loadEntries();
  }, [isDir, defaultOpen, loadEntries]);

  // Reveal auto-expand only when the target *changes* to something under us —
  // not on every render while a selected file still lives in this branch.
  useEffect(() => {
    if (!isDir || !onRevealChain) return;
    if (reveal === lastAutoRevealRef.current) return;
    lastAutoRevealRef.current = reveal;
    pinnedClosedRef.current = false;
    setOpen(true);
    loadEntries();
  }, [isDir, onRevealChain, reveal, loadEntries]);

  useEffect(() => {
    if (!isSelected || suppressReveal) return;
    rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [isSelected, suppressReveal]);

  const handleClick = () => {
    if (isDir) {
      if (open) {
        pinnedClosedRef.current = true;
        setOpen(false);
      } else {
        openDir();
      }
    } else onSelectFile(path);
  };

  const visible = useMemo(() => {
    if (!entries) return null;
    if (!filterTokens?.length) return entries;
    return entries.filter((e) => matchesTokens(e.name, filterTokens));
  }, [entries, filterTokens]);

  return (
    <div className={`node${open ? ' open' : ''}${isSelected ? ' selected' : ''}${!isDir ? ' zone-row' : ''}${isPinned ? ' zone-is-pinned' : ''}`}>
      <div className="row" ref={rowRef} onClick={handleClick}>
        <span className="caret icon">{isDir ? 'chevron_right' : ''}</span>
        <span className="kind icon">{isDir ? 'folder' : 'deployed_code'}</span>
        <span className={isDir ? undefined : 'tree-file-name'}>{name}</span>
        {!isDir && (
          <PinBtn pinned={isPinned} onToggle={() => onTogglePin?.(path)} />
        )}
      </div>
      {isDir && open && visible && (
        <div className="children">
          {visible.map((e) => (
            <TreeNode
              key={e.name}
              path={`${path}\\${e.name}`}
              name={e.name}
              isDir={e.isDir}
              selectedPath={selectedPath}
              revealTarget={revealTarget}
              skipRevealKey={skipRevealKey}
              onSelectFile={onSelectFile}
              onError={onError}
              filterTokens={filterTokens}
              rootPath={rootPath}
              pinSet={pinSet}
              onTogglePin={onTogglePin}
            />
          ))}
        </div>
      )}
    </div>
  );
}
