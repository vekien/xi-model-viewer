import { useMemo, useState } from 'react';
import { Button } from '@headlessui/react';
import { Tooltip } from './Tooltip.jsx';

/** Matches xi-tools' export naming (`f"bone{joint.index:04d}"`), so a row here
 *  reads the same as the node it becomes in a glTF/FBX export. Zero-based. */
const boneName = (i) => `bone${String(i).padStart(4, '0')}`;

/**
 * Bone hierarchy for the loaded model.
 *
 * FFXI skeletons carry no joint names — a joint is an index plus a parent index
 * (dat.js: `{ parent, rot, trans }`) — so the index *is* the identity, and the
 * shape has to do the rest. Roots are joints whose parent is -1; a DAT can have
 * several.
 *
 * Reads the pose rather than holding its own copy, so the live positions are
 * whatever frame the scrubber is on.
 */
export function SkeletonPanel({ pose, onClose }) {
  const [collapsed, setCollapsed] = useState(() => new Set());

  const { roots, children, joints } = useMemo(() => {
    const js = pose?.skeleton?.joints ?? [];
    const kids = new Map();
    const rs = [];
    js.forEach((j, i) => {
      if (j.parent < 0) { rs.push(i); return; }
      if (!kids.has(j.parent)) kids.set(j.parent, []);
      kids.get(j.parent).push(i);
    });
    return { roots: rs, children: kids, joints: js };
  }, [pose]);

  if (!joints.length) return null;

  const toggle = (i) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });

  const rows = [];
  const walk = (i, depth) => {
    const kids = children.get(i) ?? [];
    const shut = collapsed.has(i);
    const t = pose.trans?.[i];
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
            {t[0].toFixed(2)}, {t[1].toFixed(2)}, {t[2].toFixed(2)}
          </span>
        )}
      </div>,
    );
    if (!shut) for (const k of kids) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);

  return (
    <div id="skeleton" className="panel">
      <div className="details-header">
        <span className="icon">accessibility_new</span>
        <span className="details-title">Skeleton</span>
        <span className="skel-count mono">{joints.length} joints</span>
        <Tooltip content="Close">
          <Button className="icon-btn details-close" onClick={onClose}>
            <span className="icon">close</span>
          </Button>
        </Tooltip>
      </div>
      <div className="skel-body">{rows}</div>
    </div>
  );
}
