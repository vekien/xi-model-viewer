import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { backend } from '../js/backend.js';
import { Tooltip } from './Tooltip.jsx';

const LISTABLE = /\.(dat|bgw|spw|png)$/i;
const MAX_SEARCH = 400;

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

  const handleBrowse = async () => {
    try {
      const file = await backend.pickFile(rootPath || null);
      if (file) onSelectFile(file);
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
              return (
                <div key={rel} className={`node${selected ? ' selected' : ''}`}>
                  <div
                    className="row"
                    title={rel}
                    onClick={() => onSelectFile(abs)}
                  >
                    <span className="caret icon" />
                    <span className="kind icon">deployed_code</span>
                    <span className="tree-hit-path">{rel}</span>
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
          <TreeNode
            key={rootPath}
            path={rootPath}
            name={rootName}
            isDir
            defaultOpen
            selectedPath={selectedPath}
            revealTarget={revealTarget}
            onSelectFile={onSelectFile}
            onError={onError}
            filterTokens={null}
          />
        )}
      </div>
      {searching && searchHits && searchHits.length > 0 && (
        <div className="side-note zone-count">
          {searchHits.length >= MAX_SEARCH ? `${MAX_SEARCH}+` : searchHits.length} matches
        </div>
      )}
    </div>
  );
}

function TreeNode({ path, name, isDir, defaultOpen, selectedPath, revealTarget, onSelectFile, onError, filterTokens }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState(null);
  const rowRef = useRef(null);

  const lowerPath = normPath(path);
  const isSelected = !isDir && sameFile(selectedPath, path);
  const reveal = normPath(revealTarget);
  const onRevealChain = isDir && reveal && (reveal === lowerPath || reveal.startsWith(lowerPath + '\\'));

  const openDir = useCallback(async () => {
    setOpen(true);
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

  useEffect(() => {
    if (isDir && (defaultOpen || onRevealChain)) openDir();
  }, [isDir, defaultOpen, onRevealChain, openDir]);

  useEffect(() => {
    if (isSelected) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [isSelected]);

  const handleClick = () => {
    if (isDir) (open ? setOpen(false) : openDir());
    else onSelectFile(path);
  };

  const visible = useMemo(() => {
    if (!entries) return null;
    if (!filterTokens?.length) return entries;
    return entries.filter((e) => matchesTokens(e.name, filterTokens));
  }, [entries, filterTokens]);

  return (
    <div className={`node${open ? ' open' : ''}${isSelected ? ' selected' : ''}`}>
      <div className="row" ref={rowRef} onClick={handleClick}>
        <span className="caret icon">{isDir ? 'chevron_right' : ''}</span>
        <span className="kind icon">{isDir ? 'folder' : 'deployed_code'}</span>
        <span>{name}</span>
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
              onSelectFile={onSelectFile}
              onError={onError}
              filterTokens={filterTokens}
            />
          ))}
        </div>
      )}
    </div>
  );
}
