import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@headlessui/react';
import { Tooltip } from './Tooltip.jsx';

/** Matches xi-tools export naming / the fixed Skeleton panel. */
const boneName = (i) => `bone${String(i).padStart(4, '0')}`;

/**
 * Draggable floating skeleton tree (Data Struct click). Bind-pose joints only —
 * no live pose scrubbing. Portaled to <body> so it stacks above Data Struct.
 */
export function SkeletonModal({
  joints, title = 'Skeleton', onClose, onFocus, cascadeOffset = 0, zIndex = 500,
}) {
  const panelRef = useRef(null);
  const dragState = useRef(null);
  const [pos, setPos] = useState(null);
  const [collapsed, setCollapsed] = useState(() => new Set());

  const { roots, children } = useMemo(() => {
    const js = joints ?? [];
    const kids = new Map();
    const rs = [];
    js.forEach((j, i) => {
      const p = j?.parent ?? -1;
      if (p < 0 || p >= js.length || p === i) { rs.push(i); return; }
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(i);
    });
    // Orphan any joint not reachable from a root (broken parent links).
    if (!rs.length && js.length) rs.push(0);
    return { roots: rs, children: kids };
  }, [joints]);

  if (!joints?.length) return null;

  const toggle = (i) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });

  const rows = [];
  const seen = new Set();
  const walk = (i, depth) => {
    if (seen.has(i) || i < 0 || i >= joints.length) return;
    seen.add(i);
    const kids = children.get(i) ?? [];
    const shut = collapsed.has(i);
    const t = joints[i]?.trans;
    rows.push(
      <div
        key={i}
        className={`skel-row${kids.length ? ' skel-branch' : ''}`}
        style={{ paddingLeft: `${8 + depth * 13}px` }}
        onClick={kids.length ? () => toggle(i) : undefined}
      >
        <span className="caret icon">{kids.length ? (shut ? 'chevron_right' : 'expand_more') : ''}</span>
        <span className="skel-idx">{boneName(i)}</span>
        {kids.length > 0 && <span className="skel-kids">{kids.length}</span>}
        {t && (
          <span className="skel-pos mono">
            {Number(t[0]).toFixed(2)}, {Number(t[1]).toFixed(2)}, {Number(t[2]).toFixed(2)}
          </span>
        )}
      </div>,
    );
    if (!shut) for (const k of kids) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  // Any joints not reached (cycles / bad parents) — list flat at the end.
  for (let i = 0; i < joints.length; i++) {
    if (!seen.has(i)) walk(i, 0);
  }

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

  const cascade = cascadeOffset * 28;
  const style = pos
    ? { left: pos.x, top: pos.y, transform: 'none', zIndex }
    : {
      left: `calc(50% + ${cascade}px)`,
      top: `calc(42% + ${cascade}px)`,
      transform: 'translate(-50%, -50%)',
      zIndex,
    };

  return createPortal(
    <div className="skel-modal" ref={panelRef} style={style} onPointerDown={onFocus}>
      <div
        className="modal-header"
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
      >
        <span className="icon">accessibility_new</span>
        <span className="modal-title mono">{title}</span>
        <span className="skel-count mono">{joints.length} joints</span>
        <Tooltip content="Close">
          <Button className="icon-btn modal-close" onClick={onClose}>
            <span className="icon">close</span>
          </Button>
        </Tooltip>
      </div>
      <div className="skel-modal-body">{rows}</div>
    </div>,
    document.body,
  );
}

function clamp(p, panel) {
  const w = panel?.offsetWidth ?? 360;
  const h = panel?.offsetHeight ?? 320;
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
    y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
  };
}
