import { Tooltip } from './Tooltip.jsx';

/**
 * The weapon-skill slots table (`xi ability slots`): every number Publish can hand out
 * in a folder and what holds each. `#` is the number's place in its bank — 0–255 across
 * the plugin band. The row marked "next" is the one an automatic number would take from
 * `from`; a click on a free row asks for that number outright.
 */
export function SlotTable({ slots, from = '', animation = '', onPick }) {
  if (slots.loading) return <div className="mono-small mseq-slots-note">Reading the weapon-skill slots…</div>;
  if (slots.error) return <pre className="mono-small mseq-plan-err">{slots.error}</pre>;
  const rows = slots.slots ?? [];
  const start = from === '' || from == null ? 0 : Number(from);
  const next = animation === '' || animation == null ? rows.find((r) => r.free && r.animation >= start)?.animation : null;
  const free = rows.filter((r) => r.free).length;
  return (
    <div className="mseq-slots">
      <div className="mono-small mseq-slots-note">
        Weapon-skill slots in the {slots.target === 'pivot' ? 'pivot' : 'game'} folder: <b>{free}</b> free of {rows.length}
        {slots.band ? <> · plugin band {slots.band[0]}–{slots.band[1]}</> : <> · custom band off</>}
      </div>
      <div className="mseq-slots-scroll">
        <table className="mseq-plan mseq-slots-table">
          <thead><tr><th>#</th><th>animation</th><th>bank</th><th>file id</th><th>holds</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const picked = String(r.animation) === String(animation);
              return (
                <tr key={r.animation} className={`${r.free ? 'is-free' : 'is-taken'}${picked ? ' is-picked' : ''}`}
                  onClick={r.free ? () => onPick?.(r.animation) : undefined}>
                  <td className="dim">{r.index}</td>
                  <td><b>{r.animation}</b>{r.animation === next && <span className="mseq-slots-next">next</span>}{picked && <span className="mseq-slots-next">chosen</span>}</td>
                  <td className="dim">{r.plugin ? 'plugin band' : 'any client'}</td>
                  <td className="dim">{r.file_id}</td>
                  <td className={r.free ? 'dim' : 'warn'}>
                    {r.free ? 'free' : `${r.owner ? `${r.owner} — ` : ''}${r.dats.slice(0, 2).join(', ')}${r.dats.length > 2 ? ' …' : ''} (${r.races.length >= 8 ? 'every race' : r.races.join(', ')})`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The weapon-skill slots as its own window (a Floating host wraps it). Opened from the
 * Manage panel's Slots button, the mixer's right rail, or Assets › Database. A game /
 * pivot toggle re-lists that folder; a free row picks that number for the current mix.
 */
export function MixerSlotsPanel({ slots, pivot = false, onPivot, onRefresh, onClose, from = '', animation = '', onPick }) {
  const busy = !!slots?.loading;
  return (
    <div id="mixer-slots" className="panel">
      <div className="panel-head">
        <span className="icon">view_list</span>
        <span className="details-title">Weapon-skill slots</span>
        <Tooltip content="List these slots again" placement="top">
          <button type="button" className="icon-btn" disabled={busy} aria-label="Refresh" onClick={() => onRefresh?.(pivot)}>
            <span className={`icon${busy ? ' spin' : ''}`}>{busy ? 'progress_activity' : 'refresh'}</span>
          </button>
        </Tooltip>
        {onClose && (
          <button type="button" className="icon-btn details-close" aria-label="Close" onClick={onClose}>
            <span className="icon">close</span>
          </button>
        )}
      </div>

      <div className="seg-tabs mseq-slots-seg" role="tablist">
        <button type="button" role="tab" className={`seg-tab${pivot ? '' : ' on'}`} aria-selected={!pivot}
          disabled={busy} onClick={() => onPivot?.(false)}>Game folder</button>
        <button type="button" role="tab" className={`seg-tab${pivot ? ' on' : ''}`} aria-selected={pivot}
          disabled={busy} onClick={() => onPivot?.(true)}>Pivot folder</button>
      </div>

      <div className="mseq-slots-body">
        {slots
          ? <SlotTable slots={slots} from={from} animation={animation} onPick={onPick} />
          : <div className="mono-small mseq-slots-note">Loading the weapon-skill slots…</div>}
      </div>
    </div>
  );
}
