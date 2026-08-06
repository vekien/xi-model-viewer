import { useEffect, useRef } from 'react';
import { Button } from '@headlessui/react';
import { Tooltip } from './Tooltip.jsx';

const fmtTime = (s) => {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

/**
 * Real-time frequency histogram driven by the player's Web Audio AnalyserNode.
 * Bars react to the actual audio; idles to a low shimmer when paused/silent.
 */
function Visualizer({ player }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    let raf = 0;
    const bars = 40;
    const smoothed = new Float32Array(bars);

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4da3ff';
    const accentDeep = getComputedStyle(document.documentElement).getPropertyValue('--accent-deep').trim() || '#2f7fdb';

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr; canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const analyser = player.getAnalyser?.();
      let freq = null;
      if (analyser) {
        freq = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(freq);
      }

      const t = performance.now() / 1000;
      const decoding = player.info?.decoding;
      const gap = 3;
      const bw = (w - gap * (bars - 1)) / bars;
      // A bright pulse sweeps back and forth across the bars while decoding.
      const sweep = decoding ? (0.5 - 0.5 * Math.cos(t * 3)) * (bars - 1) : 0;
      for (let i = 0; i < bars; i++) {
        let target;
        if (decoding) {
          const d = i - sweep;
          target = 0.12 + 0.88 * Math.exp(-(d * d) / (2 * 3.5 * 3.5));  // gaussian bump
        } else if (freq && player.playing) {
          // Sample the lower ~70% of the spectrum (most musical energy).
          const idx = Math.floor((i / bars) * freq.length * 0.7);
          target = (freq[idx] / 255) ** 1.4;
        } else {
          target = 0.06 + 0.05 * (0.5 + 0.5 * Math.sin(t * 2 + i * 0.5)); // idle shimmer
        }
        const responsiveness = decoding ? 0.3 : (target > smoothed[i] ? 0.5 : 0.14);
        smoothed[i] += (target - smoothed[i]) * responsiveness;
        const bh = Math.max(2, smoothed[i] * (h - 4));
        const x = i * (bw + gap);
        const y = h - bh;
        const grad = ctx.createLinearGradient(0, y, 0, h);
        grad.addColorStop(0, accent);
        grad.addColorStop(1, accentDeep);
        ctx.fillStyle = grad;
        const r = Math.min(bw / 2, 2);
        ctx.beginPath();
        ctx.roundRect(x, y, bw, bh, [r, r, 0, 0]);
        ctx.fill();
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [player]);

  return <canvas ref={canvasRef} className="viz-canvas" />;
}

/**
 * Centered "now playing" music player, shown in place of the 3D viewport while
 * a track is loaded. Transport, seekable progress, persisted volume, and the
 * decoded stream's format details.
 */
export function MusicPlayer({ player }) {
  const { current, playing, info, position, volume } = player;
  if (!current) return null;

  const title = current.name ?? `music${current.num.padStart(3, '0')}`;
  const duration = info?.durationSec ?? 0;
  const unsupported = info?.unsupported;
  const progress = duration ? Math.min(position / duration, 1) : 0;

  const onScrub = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    player.seek(((e.clientX - rect.left) / rect.width) * duration);
  };

  return (
    <div id="player">
      <div className="player-card panel">
        <div className="player-art">
          {unsupported ? <span className="icon">music_off</span> : <Visualizer player={player} />}
        </div>

        <div className="player-title">{title}</div>
        <div className="player-sub mono">
          {info && (
            <>
              {info.formatName}
              {info.sampleRate ? ` · ${(info.sampleRate / 1000).toFixed(1)} kHz` : ''}
              {info.channels ? ` · ${info.channels === 2 ? 'stereo' : info.channels === 1 ? 'mono' : info.channels + 'ch'}` : ''}
              {info.looped ? ' · loop' : ''}
            </>
          )}
        </div>

        {unsupported ? (
          <div className="player-note">ATRAC3 stream — needs vgmstream to decode (not playable in-app).</div>
        ) : info?.decoding ? (
          <div className="player-note decoding">
            <span className="icon spin">progress_activity</span>
            <span>Decoding ATRAC3 via vgmstream…</span>
          </div>
        ) : (
          <>
            <div className="player-progress" onClick={onScrub}>
              <div className="pp-track">
                <div className="pp-fill" style={{ width: `${progress * 100}%` }} />
                <div className="pp-knob" style={{ left: `${progress * 100}%` }} />
              </div>
            </div>
            <div className="player-times mono">
              <span>{fmtTime(position)}</span>
              <span>{fmtTime(duration)}</span>
            </div>

            <div className="player-controls">
              <Tooltip content="Restart">
                <Button className="icon-btn" onClick={() => player.seek(0)}>
                  <span className="icon fill">skip_previous</span>
                </Button>
              </Tooltip>
              <Tooltip content={playing ? 'Pause' : 'Play'}>
                <Button className="player-play"
                  onClick={() => (playing ? player.pause() : player.resume())}>
                  <span className="icon fill">{playing ? 'pause' : 'play_arrow'}</span>
                </Button>
              </Tooltip>
              <Tooltip content="Stop">
                <Button className="icon-btn" onClick={() => player.stop()}>
                  <span className="icon fill">stop</span>
                </Button>
              </Tooltip>
            </div>

            <div className="player-volume">
              <span className="icon">{volume === 0 ? 'volume_off' : volume < 0.5 ? 'volume_down' : 'volume_up'}</span>
              <input
                type="range" min="0" max="1" step="0.01" value={volume}
                onChange={(e) => player.setVolume(parseFloat(e.target.value))}
                className="vol-slider"
                style={{ '--fill': `${volume * 100}%` }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
