// Toolbar volume popover — the same chrome as Graphics (tool-pop). Three sliders
// for the whole app: Volume is every sound an animation, effect or mix plays;
// Music is the zone's track and the music player; Ambient is a zone's weather
// and environment sound, so it is only live while a zone is loaded.

function Slider({ label, value, onChange, disabled = false, note = null }) {
  const pct = Math.round((value ?? 0) * 100);
  return (
    <>
      <div className={`gfx-line${disabled ? ' dim' : ''}`}>
        <span className="gfx-lab">{label} &nbsp; • &nbsp; <strong>{disabled && note ? note : (pct > 0 ? `${pct}%` : 'muted')}</strong></span>
      </div>
      <input
        type="range" min="0" max="100" step="1"
        value={pct}
        disabled={disabled}
        onChange={(e) => onChange?.(+e.target.value / 100)}
        className="vol-slider gfx-slider"
        style={{ '--fill': `${pct}%` }}
      />
    </>
  );
}

export function VolumePanel({
  effectVolume = 1, onEffectVolume,
  musicVolume = 0.8, onMusicVolume,
  ambientVolume = 0.6, onAmbientVolume,
  zoneLoaded = false,
}) {
  return (
    <div className="tool-pop-body vol-pop">
      <h3>VOLUME</h3>
      <Slider label="Volume" value={effectVolume} onChange={onEffectVolume} />
      <Slider label="Music" value={musicVolume} onChange={onMusicVolume} />
      <Slider label="Ambient" value={ambientVolume} onChange={onAmbientVolume} disabled={!zoneLoaded} note="zones only" />
    </div>
  );
}
