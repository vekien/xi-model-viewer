import { useState } from 'react';
import { Button } from '@headlessui/react';
import { Combo } from './Combo.jsx';

const fmtDur = (frames, kfd) => {
  // Clip length in game-frames (30fps) → seconds.
  const gameFrames = Math.max(frames - 1, 1) / (kfd || 1);
  return `${(gameFrames / 30).toFixed(2)}s`;
};

/**
 * Floating bottom-right info panel: model geometry, the current animation, and
 * the current schedule (its clips, blend, loop). Opened from the status bar.
 * For composed characters (info.parts), a selector switches between the merged
 * character and each equipment slot's own DAT(s).
 */
export function DetailsPanel({ info, animClip, animId, schedule, onClose, onOpenTexture, onPlayClip }) {
  const [partKey, setPartKey] = useState('all');
  const parts = info.parts ?? [];
  const part = partKey === 'all' ? null : parts.find((p) => p.key === partKey) ?? null;
  const shown = part ?? info;

  return (
    <div id="details" className="panel">
      <div className="details-header">
        <span className="icon">info</span>
        <span className="details-title">Details</span>
        <Button className="icon-btn details-close" onClick={onClose} title="Close">
          <span className="icon">close</span>
        </Button>
      </div>

      <div className="details-body">
        {parts.length > 0 && (
          <div className="details-part-combo">
            <Combo
              value={partKey}
              items={[
                { id: 'all', label: 'Character (merged)' },
                ...parts.map((p) => ({ id: p.key, label: p.label })),
              ]}
              onChange={setPartKey}
            />
          </div>
        )}

        <Section
          title={info.zone ? 'Zone' : info.effect ? 'Effect' : 'Model'}
          icon={info.zone ? 'map' : info.effect ? 'auto_awesome' : 'deployed_code'}
        >
          <Row label="Source" value={part ? part.itemLabel || part.label : info.name} mono />
          {part && <Row label="DAT" value={part.relPaths.join(' + ')} mono />}
          {info.zone?.path && <Row label="DAT" value={info.zone.path} mono />}
          {info.zone?.id != null && <Row label="Zone ID" value={info.zone.id} />}
          {info.effect && (
            <>
              <Row label="DAT" value={info.effect.path} mono />
              <Row label="Category" value={info.effect.category} />
              <Row label="Generators" value={info.effect.generators} />
              {info.effect.sounds > 0 && <Row label="Sounds" value={info.effect.sounds} />}
              <Row label="Sprite sheets" value={info.effect.spriteSheets} />
              {info.effect.particleMeshes > 0 && (
                <Row label="Particle meshes" value={info.effect.particleMeshes} />
              )}
            </>
          )}
          {info.zone ? (
            <>
              <Row label="Placements" value={fmtNum(info.zone.placementCount)} />
              <Row label="Object types" value={fmtNum(info.zone.objectTypes)} />
              {info.zone.meshCount != null && <Row label="Meshes" value={fmtNum(info.zone.meshCount)} />}
              {info.zone.envCount > 0 && <Row label="Sky / water" value={fmtNum(info.zone.envCount)} />}
            </>
          ) : (
            shown.joints != null && <Row label="Joints" value={shown.joints} />
          )}
          <Row label="Vertices" value={shown.verts.toLocaleString()} />
          <Row label="Triangles" value={shown.tris.toLocaleString()} />
          {info.zone?.collTris > 0 && <Row label="Collision tris" value={fmtNum(info.zone.collTris)} />}
          {(info.zone?.skippedWild > 0 || info.zone?.skippedMissing > 0) && (
            <Row
              label="Skipped"
              value={`${info.zone.skippedWild || 0} wild / ${info.zone.skippedMissing || 0} missing`}
            />
          )}
          {shown.animCount > 0 && <Row label="Animations" value={shown.animCount} />}
          {shown.scheduleCount > 0 && <Row label="Schedules" value={shown.scheduleCount} />}
        </Section>

        {shown.textures.length > 0 && (
          <Section title={`Textures (${shown.textures.length})`} icon="texture">
            {shown.textures.map((t, i) => (
              <button key={`${t.name}:${i}`} className="details-tex details-tex-btn" onClick={() => onOpenTexture?.(t)} title="View texture">
                <span className="icon">image</span>
                <span className="details-tex-name mono">{t.name || '(unnamed)'}</span>
                <span className="details-tex-meta mono">{t.width}×{t.height} {t.format.toUpperCase()}</span>
              </button>
            ))}
          </Section>
        )}

        {animClip && (
          <Section title="Animation" icon="animation">
            <Row label="Clip" value={animId} mono />
            {animClip.parts && <Row label="Body parts" value={animClip.parts.join(' + ')} mono />}
            <Row label="Frames" value={animClip.numFrames} />
            <Row label="Duration" value={fmtDur(animClip.numFrames, animClip.keyFrameDuration)} />
          </Section>
        )}

        {schedule && (
          <Section title="Schedule" icon="schedule">
            <Row label="Routine" value={schedule.id} mono />
            <div className="details-row">
              <span className="details-row-label">Clips</span>
              <span className="details-clip-list">
                {schedule.clipIds.map((c) => (
                  <button key={c} className="clip-link mono" onClick={() => onPlayClip?.(c)} title={`Play ${c}`}>{c}</button>
                ))}
              </span>
            </div>
            <Row label="Blend in / out" value={`${schedule.transIn} / ${schedule.transOut} frames`} />
            <Row label="Loop" value={schedule.maxLoops === 0 ? 'forever' : `${schedule.maxLoops}× then hold`} />
            {schedule.dur ? <Row label="Window" value={`${schedule.dur} frames`} /> : null}
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({ title, icon, children }) {
  return (
    <div className="details-section">
      <div className="details-section-title">
        <span className="icon">{icon}</span>{title}
      </div>
      <div className="details-rows">{children}</div>
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

function fmtNum(n) {
  return n == null ? '—' : Number(n).toLocaleString();
}
