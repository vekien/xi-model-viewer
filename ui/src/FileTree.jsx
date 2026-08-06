import { useCallback, useEffect, useRef, useState } from 'react';
import { backend } from '../js/backend.js';
import { Tooltip } from './Tooltip.jsx';

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

export function FileTree({ rootPath, selectedPath, revealTarget, onSelectFile, onError }) {
  const handleBrowse = async () => {
    try {
      const file = await backend.pickFile(rootPath || null);
      if (file) onSelectFile(file);
    } catch (err) {
      onError?.(`Browse failed: ${err.message ?? err}`);
    }
  };

  if (!rootPath) return <div id="tree" className="panel" />;
  const rootName = rootPath.split(/[\\/]/).filter(Boolean).pop() ?? rootPath;
  return (
    <div id="tree" className="panel tree-panel">
      <div className="tree-browse">
        <Tooltip content="Open any .DAT file" placement="right">
          <button className="tree-browse-btn" onClick={handleBrowse}>
            <span className="icon">folder_open</span>
            Browse…
          </button>
        </Tooltip>
      </div>
      <div className="tree-scroll">
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
        />
      </div>
    </div>
  );
}

function TreeNode({ path, name, isDir, defaultOpen, selectedPath, revealTarget, onSelectFile, onError }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState(null);
  const rowRef = useRef(null);

  const lowerPath = path.toLowerCase();
  const isSelected = !isDir && selectedPath === lowerPath;
  const onRevealChain = isDir && revealTarget && revealTarget.startsWith(lowerPath + '\\');

  const openDir = useCallback(async () => {
    setOpen(true);
    if (entries !== null) return;
    try {
      const list = await backend.listDir(path);
      const dirs = list.filter((e) => e.isDir).sort((a, b) => naturalCompare(a.name, b.name));
      const files = list
        .filter((e) => !e.isDir && e.name.toUpperCase().endsWith('.DAT'))
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

  return (
    <div className={`node${open ? ' open' : ''}${isSelected ? ' selected' : ''}`}>
      <div className="row" ref={rowRef} onClick={handleClick}>
        <span className="caret icon">{isDir ? 'chevron_right' : ''}</span>
        <span className="kind icon">{isDir ? 'folder' : 'deployed_code'}</span>
        <span>{name}</span>
      </div>
      {isDir && open && entries && (
        <div className="children">
          {entries.map((e) => (
            <TreeNode
              key={e.name}
              path={`${path}\\${e.name}`}
              name={e.name}
              isDir={e.isDir}
              selectedPath={selectedPath}
              revealTarget={revealTarget}
              onSelectFile={onSelectFile}
              onError={onError}
            />
          ))}
        </div>
      )}
    </div>
  );
}
