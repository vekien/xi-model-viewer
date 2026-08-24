import { useLayoutEffect, useRef } from 'react';
import { Combo } from './Combo.jsx';
import { Tooltip } from './Tooltip.jsx';

// FFXI weather ids → display names (only those present in a zone are listed).
export const WEATHER_NAMES = {
  fine: 'Clear', suny: 'Sunshine', clod: 'Clouds', mist: 'Fog',
  dryw: 'Hot Spell', heat: 'Heat Wave', rain: 'Rain', squl: 'Squall',
  dust: 'Dust Storm', sand: 'Sand Storm', wind: 'Wind', stom: 'Gales',
  snow: 'Snow', bliz: 'Blizzards', thdr: 'Thunder', bolt: 'Thunderstorms',
  aura: 'Auroras', ligt: 'Stellar Glare', fogd: 'Gloom', dark: 'Darkness',
};
export const weatherName = (id) => WEATHER_NAMES[id] ?? id;

const fmtTime = (min) => {
  const h = Math.floor(min / 60) % 24;
  const m = Math.floor(min % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

/**
 * Zone scene controls (top-right): weather/time when the zone has a skybox,
 * plus always-on background colour and lighting brightness (default → unlit).
 * `heading` names the panel — "Zone" in the app, the zone's own name when this
 * is the only panel on screen (the --minimal preview launch).
 */
export function WeatherPanel({
  weathers = [], weather, timeMinutes, onChange, heading = 'Zone',
  todPlaying = false, onToggleTod,
  skyboxOn, onToggleSkybox, hasSkybox = false, objectsOpen,
  bgColor, onBg,
  brightness = 0, onBrightness,
  fogOn = true, onFogOn, fogScale = 1, onFogScale,
  musicVolume = 0.8, onMusicVolume, sfxVolume = 0.6, onSfxVolume,
  sfxOn = true, onToggleSfx,
  zoneTrack = null, zoneTrackPlaying = false, onToggleZoneMusic,
}) {
  const showSkyControls = hasSkybox && weathers.length > 0;
  const brightPct = Math.round((brightness ?? 0) * 100);
  const musicPct = Math.round((musicVolume ?? 0) * 100);
  const sfxPct = Math.round((sfxVolume ?? 0) * 100);
  // Fog distance spans 0.1x to 20x the authored range. A zone is authored for a
  // camera standing in it (Altepa fogs out at 450 units), so the fitted overview
  // camera sits well beyond that and everything washes to fog — pushing the
  // multiplier up is how you see the whole zone. Log scale so both the "thick
  // fog" and "see everything" ends stay controllable.
  const FOG_MIN = 0.1, FOG_MAX = 20;
  const fogToSlider = (s) => Math.round(
    ((Math.log(Math.min(FOG_MAX, Math.max(FOG_MIN, s))) - Math.log(FOG_MIN))
      / (Math.log(FOG_MAX) - Math.log(FOG_MIN))) * 100,
  );
  const sliderToFog = (t) => Math.exp(
    Math.log(FOG_MIN) + (t / 100) * (Math.log(FOG_MAX) - Math.log(FOG_MIN)),
  );
  const fogSlider = fogToSlider(fogScale ?? 1);
  const fogLabel = (fogScale ?? 1) >= 10 ? `${(fogScale ?? 1).toFixed(0)}x`
    : `${(fogScale ?? 1).toFixed(1)}x`;
  // The track name lives in the button's tooltip rather than its own row.
  const trackLabel = zoneTrack
    ? `${zoneTrack.name ?? `music${String(zoneTrack.id).padStart(3, '0')}`}${zoneTrack.isNight ? ' (night)' : ''}`
    : '';

  // Objects is positioned below this panel, whose height depends on which rows
  // a zone shows. Publish the measured height so the CSS can follow it instead
  // of assuming a fixed offset and overlapping.
  const rootRef = useRef(null);
  // offsetHeight, not contentRect: the panel has a border and Objects is offset
  // from its outer edge. Measured on every render because that's when rows come
  // and go (loading a zone adds the weather and time controls) — a
  // ResizeObserver alone only settles on the next rendering step, which leaves
  // Objects overlapping until then.
  useLayoutEffect(() => {
    if (rootRef.current) {
      document.documentElement.style.setProperty('--wx-h', `${rootRef.current.offsetHeight}px`);
    }
  });
  // ...and an observer for height changes that don't come from a render, such
  // as a late font load or the panel's own scrollbar appearing.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const root = document.documentElement;
    const ro = new ResizeObserver(() => {
      root.style.setProperty('--wx-h', `${el.offsetHeight}px`);
    });
    ro.observe(el);
    return () => { ro.disconnect(); root.style.removeProperty('--wx-h'); };
  }, []);

  return (
    <div id="weather" ref={rootRef} className={`panel${objectsOpen ? ' with-objects' : ''}`}>
      <div className="wx-header">
        <span className="icon">landscape</span>
        <span className="wx-title">{heading}</span>
        {showSkyControls && <span className="wx-time mono">{fmtTime(timeMinutes)}</span>}
        {showSkyControls && (
          <Tooltip content="Show sky" placement="bottom">
            <label className="switch wx-switch">
              <input type="checkbox" checked={!!skyboxOn} onChange={(e) => onToggleSkybox(e.target.checked)} />
              <span className="track" />
            </label>
          </Tooltip>
        )}
      </div>

      <div className="wx-body">
        {showSkyControls ? (
          <div className={`wx-weather${skyboxOn ? '' : ' wx-off'}`}>
            <div className="wx-row">
              <Combo
                value={weather}
                items={weathers.map((w) => ({ id: w, label: weatherName(w) }))}
                onChange={(w) => onChange(w, timeMinutes)}
              />
            </div>

            {/* Same pattern as the music row: the row's leading control is the
                transport, here running the clock through a full day in about a
                minute. Step 1 rather than 15 so the thumb tracks the sweep — a
                range input snaps its value to the step grid. */}
            <div className="wx-row wx-time-row">
              <Tooltip content={todPlaying ? 'Stop the clock' : 'Run a day in a minute'} placement="top">
                <button
                  className={`wx-audio-btn${todPlaying ? ' playing' : ''}`}
                  aria-pressed={todPlaying}
                  aria-label={todPlaying ? 'Stop time of day' : 'Play time of day'}
                  onClick={() => onToggleTod?.(!todPlaying)}
                >
                  <span className="icon">{todPlaying ? 'stop' : 'play_arrow'}</span>
                </button>
              </Tooltip>
              <input
                type="range" min="0" max="1439" step="1" value={Math.round(timeMinutes)}
                onChange={(e) => onChange(weather, +e.target.value)}
                className="vol-slider"
                style={{ '--fill': `${(timeMinutes / 1439) * 100}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="wx-nosky">No Skybox for Indoor Zone</div>
        )}

        <div className="wx-row wx-bg-row">
          <span className="wx-bg-label">Scene Background Colour</span>
          <Tooltip content="Scene background colour" placement="left">
            <input
              type="color"
              className="wx-bg-swatch"
              value={bgColor || '#303438'}
              onChange={(e) => onBg?.(e.target.value)}
            />
          </Tooltip>
        </div>

        <div className="wx-row wx-fog-row">
          <Tooltip content="Fog" placement="top">
            <span className="icon wx-tod-icon">foggy</span>
          </Tooltip>
          <Tooltip content="Fog distance — multiplies the zone's authored range (0.1x – 20x)" placement="top">
            <input
              type="range" min="0" max="100" step="1" value={fogSlider}
              disabled={!fogOn}
              onChange={(e) => onFogScale?.(sliderToFog(+e.target.value))}
              className="vol-slider"
              style={{ '--fill': `${fogSlider}%` }}
            />
          </Tooltip>
          <span className="wx-bright-val mono">{fogLabel}</span>
          <Tooltip content={fogOn ? 'Disable fog' : 'Enable fog'} placement="left">
            <label className="switch wx-switch">
              <input type="checkbox" checked={!!fogOn} onChange={(e) => onFogOn?.(e.target.checked)} />
              <span className="track" />
            </label>
          </Tooltip>
        </div>

        {/* The leading icon *is* the transport control — a separate play button
            on its own row read as stray UI. Zone BGM is decoded on demand
            (ATRAC3 shells out to vgmstream), so it only starts on a press. */}
        <div className="wx-row wx-bright-row">
          <Tooltip
            content={zoneTrack
              ? `${zoneTrackPlaying ? 'Pause' : 'Play'} ${trackLabel}`
              : 'This zone has no music'}
            placement="top"
          >
            <button
              className={`wx-audio-btn${zoneTrackPlaying ? ' playing' : ''}`}
              disabled={!zoneTrack}
              aria-pressed={zoneTrackPlaying}
              onClick={() => onToggleZoneMusic?.()}
            >
              <span className="icon">music_note</span>
            </button>
          </Tooltip>
          <input
            type="range" min="0" max="100" step="1" value={zoneTrack ? musicPct : 0}
            disabled={!zoneTrack}
            onChange={(e) => onMusicVolume?.(+e.target.value / 100)}
            className="vol-slider"
            style={{ '--fill': `${zoneTrack ? musicPct : 0}%` }}
          />
          <span className="wx-bright-val mono">{zoneTrack ? `${musicPct}%` : '—'}</span>
        </div>

        <div className="wx-row wx-bright-row">
          <Tooltip content={sfxOn ? 'Mute ambient / weather sound' : 'Enable ambient / weather sound'} placement="top">
            <button
              className={`wx-audio-btn${sfxOn ? ' playing' : ''}`}
              aria-pressed={sfxOn}
              onClick={() => onToggleSfx?.(!sfxOn)}
            >
              <span className="icon eq">airwave</span>
            </button>
          </Tooltip>
          <input
            type="range" min="0" max="100" step="1" value={sfxPct}
            disabled={!sfxOn}
            onChange={(e) => onSfxVolume?.(+e.target.value / 100)}
            className="vol-slider"
            style={{ '--fill': `${sfxPct}%` }}
          />
          <span className="wx-bright-val mono">{sfxPct}%</span>
        </div>

        <div className="wx-row wx-bright-row">
          <Tooltip content="Brightness" placement="top">
            <span className="icon wx-tod-icon">light_mode</span>
          </Tooltip>
          <Tooltip content="Unlit" placement="top">
            <input
              type="range" min="0" max="100" step="1" value={brightPct}
              onChange={(e) => onBrightness?.(+e.target.value / 100)}
              className="vol-slider"
              style={{ '--fill': `${brightPct}%` }}
            />
          </Tooltip>
          <span className="wx-bright-val mono">{brightPct}%</span>
        </div>
      </div>
    </div>
  );
}
