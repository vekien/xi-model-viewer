import { useEffect, useRef, useState } from 'react';
import { backend } from '../js/backend.js';
import { gameCandidates } from '../js/gamePath.js';
import { parseAudioHeader, toAudioBuffer, FMT_ATRAC3 } from '../js/audio.js';

// FFXI ships music across seven sound roots; each aligns with an expansion.
const ROOTS = [
  { root: 'sound', label: 'Base Game' },
  { root: 'sound2', label: 'Rise of the Zilart' },
  { root: 'sound3', label: 'Chains of Promathia' },
  { root: 'sound4', label: 'Treasures of Aht Urhgan' },
  { root: 'sound5', label: 'Wings of the Goddess' },
  { root: 'sound6', label: 'Abyssea' },
  { root: 'sound9', label: 'Seekers / Rhapsodies' },
];

// music.json names are keyed by `<root>_<NNN>` (e.g. sound2_135) — filename
// numbers are NOT globally unique (music181 differs between sound2 and sound5)
// and don't always equal the header track id, so the key includes the root.
async function loadNames() {
  try {
    const res = await fetch('lists/music.json');
    if (res.ok) return new Map(Object.entries((await res.json()).names ?? {}));
  } catch { /* names are optional */ }
  return new Map();
}

export function MusicList({ gamePath, hdPath = '', hdEnabled = false, onError, player }) {
  const [names, setNames] = useState(null);
  const [roots, setRoots] = useState(null);

  useEffect(() => {
    if (!gamePath) return;
    let cancelled = false;
    (async () => {
      const nameMap = await loadNames();
      const found = [];
      for (const { root, label } of ROOTS) {
        const dir = `${gamePath}\\${root}\\win\\music\\data`;
        const files = await backend.listFiles(dir);
        const tracks = files
          .filter((f) => f.toLowerCase().endsWith('.bgw'))
          .map((f) => {
            const raw = f.match(/(\d+)/)?.[1] ?? '0';
            const num = String(parseInt(raw, 10));
            return {
              file: f,
              path: `${dir}\\${f}`,
              root,
              num,
              name: nameMap.get(`${root}_${raw.padStart(3, '0')}`) ?? null,
            };
          })
          // Alphabetical by display name (ignoring leading quotes/brackets);
          // unnamed tracks (music###) sort last.
          .sort((a, b) => {
            const key = (t) => (t.name ? t.name.replace(/^[^\p{L}\p{N}]+/u, '') : `￿${t.num.padStart(4, '0')}`);
            return key(a).localeCompare(key(b), undefined, { sensitivity: 'base', numeric: true });
          });
        if (tracks.length) found.push({ root, label, tracks });
      }
      if (!cancelled) { setNames(nameMap); setRoots(found); }
    })();
    return () => { cancelled = true; };
  }, [gamePath]);

  return (
    <div id="tree" className="panel list-panel">
      <div className="list-scroll">
        {roots === null && <div className="side-note">Scanning music…</div>}
        {roots?.length === 0 && <div className="side-note">No music found under the game folder.</div>}
        {roots?.map((group) => (
          <MusicGroup
            key={group.root}
            group={group}
            player={player}
            onError={onError}
            settings={{ gamePath, hdPath, hdEnabled }}
          />
        ))}
      </div>
    </div>
  );
}

function MusicGroup({ group, player, onError, settings }) {
  const [open, setOpen] = useState(group.root === 'sound');
  return (
    <div className={`node${open ? ' open' : ''}`}>
      <div className="row" onClick={() => setOpen(!open)}>
        <span className="caret icon">chevron_right</span>
        <span className="kind icon">library_music</span>
        <span>{group.label}</span>
        <span className="badge">{group.tracks.length}</span>
      </div>
      {open && (
        <div className="children">
          {group.tracks.map((t) => (
            <TrackRow key={t.file} track={t} player={player} onError={onError} settings={settings} />
          ))}
        </div>
      )}
    </div>
  );
}

function TrackRow({ track, player, onError, settings }) {
  const active = player.current?.file === track.file && player.current?.root === track.root;
  const play = async () => {
    const path = await backend.resolvePrefer(gameCandidates(
      `${track.root}\\win\\music\\data\\${track.file}`,
      settings,
    ));
    await player.play({ ...track, path });
  };
  return (
    <div className={`node${active ? ' selected' : ''}`}>
      <div className="row" onClick={() => play().catch((e) => onError?.(String(e.message ?? e)))}>
        <span className="caret">
          {active && player.playing
            ? <span className="eq"><i /><i /><i /><i /></span>
            : <span className="icon" />}
        </span>
        <span className="kind icon">music_note</span>
        <span className="track-name">{track.name ?? `music${track.num.padStart(3, '0')}`}</span>
        {!track.name && <span className="mono-small track-num">#{track.num}</span>}
      </div>
    </div>
  );
}

/**
 * Full Web Audio player: decode-on-play, transport (play/pause/stop/seek),
 * persisted volume, and live progress. A single track is active at a time.
 */
export function useAudioPlayer() {
  const ctxRef = useRef(null);
  const gainRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceRef = useRef(null);
  const bufferRef = useRef(null);        // decoded AudioBuffer of current track
  const startedAtRef = useRef(0);        // ctx.currentTime when the source started
  const offsetRef = useRef(0);           // playback offset (seconds) at start
  const tickRef = useRef(0);             // setInterval id for the progress tick
  const playingRef = useRef(false);      // authoritative "is playing" for the tick
  const loopRef = useRef({ looped: false, loopStartSec: 0 });  // loop config for startFrom

  const [current, setCurrent] = useState(null);   // track
  const [playing, setPlaying] = useState(false);
  const [info, setInfo] = useState(null);          // { formatName, sampleRate, channels, durationSec, looped }
  const [position, setPosition] = useState(0);     // seconds
  const [volume, setVolumeState] = useState(() => {
    const v = parseFloat(localStorage.getItem('musicVolume'));
    return Number.isFinite(v) ? v : 0.8;
  });

  const ensureCtx = () => {
    if (!ctxRef.current) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const gain = ctx.createGain();
      gain.gain.value = volume;
      // gain -> analyser -> destination, so the visualizer sees the live signal.
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      gain.connect(analyser);
      analyser.connect(ctx.destination);
      ctxRef.current = ctx;
      gainRef.current = gain;
      analyserRef.current = analyser;
    }
    return ctxRef.current;
  };

  const clearTick = () => { if (tickRef.current) clearInterval(tickRef.current); tickRef.current = 0; };

  // Reads playingRef (a ref), NOT the `playing` state — the rAF tick captures a
  // closure once, so a state read here would go stale and freeze the progress.
  const currentOffset = () => {
    const ctx = ctxRef.current;
    if (!ctx || !playingRef.current) return offsetRef.current;
    return offsetRef.current + (ctx.currentTime - startedAtRef.current);
  };

  // Progress uses setInterval, not rAF: rAF is throttled/paused when the window
  // is hidden, minimized, or occluded (the reported "doesn't move" bug).
  const updatePosition = () => {
    const dur = bufferRef.current?.duration ?? 0;
    let pos = currentOffset();
    if (dur && pos > dur) pos = dur;
    setPosition(pos);
  };

  const disconnectSource = () => {
    if (sourceRef.current) {
      try { sourceRef.current.onended = null; sourceRef.current.stop(); } catch { /* already stopped */ }
      sourceRef.current = null;
    }
  };

  // Starts playback of the loaded buffer from `offset` seconds.
  const startFrom = (offset) => {
    const ctx = ensureCtx();
    disconnectSource();
    const src = ctx.createBufferSource();
    src.buffer = bufferRef.current;
    if (loopRef.current.looped) {
      src.loop = true;
      src.loopStart = loopRef.current.loopStartSec;
    }
    src.connect(gainRef.current);
    src.onended = () => {
      if (sourceRef.current !== src) return;   // superseded by a newer source
      sourceRef.current = null;
      playingRef.current = false;
      offsetRef.current = bufferRef.current?.duration ?? 0;
      setPlaying(false);
      clearTick();
      setPosition(offsetRef.current);
    };
    src.start(0, Math.max(0, offset));
    sourceRef.current = src;
    startedAtRef.current = ctx.currentTime;
    offsetRef.current = offset;
    playingRef.current = true;
    setPlaying(true);
    clearTick();
    updatePosition();
    tickRef.current = setInterval(updatePosition, 200);
  };

  /** Loads + plays a track. Toggling the already-active track pauses/resumes it. */
  const play = async (track) => {
    const ctx = ensureCtx();
    await ctx.resume();

    const same = current && (
      current.path === track.path
      || (current.file === track.file && current.root === track.root)
    );
    if (same && bufferRef.current) {
      playingRef.current ? pause() : startFrom(offsetRef.current >= (bufferRef.current.duration - 0.05) ? 0 : offsetRef.current);
      return;
    }

    disconnectSource();
    clearTick();
    bufferRef.current = null;
    setPosition(0);
    offsetRef.current = 0;

    const buffer = await backend.readFile(track.path);
    const header = parseAudioHeader(buffer);
    setCurrent(track);

    if (header.sampleFormat === FMT_ATRAC3) {
      // Not hand-decodable — route through bundled vgmstream and decode the
      // resulting WAV with the browser's native decoder. (The ATRAC3 header's
      // duration is meaningless — only the decoded buffer's is real.)
      setInfo({ formatName: 'ATRAC3', sampleRate: header.sampleRate, channels: header.channels,
        durationSec: 0, looped: header.looped, decoding: true });
      let wav;
      try {
        wav = await backend.decodeVgmstream(track.path);
      } catch (e) {
        setInfo({ formatName: 'ATRAC3', sampleRate: header.sampleRate, channels: header.channels,
          durationSec: header.durationSec, looped: header.looped, unsupported: true });
        setPlaying(false);
        throw new Error(`${track.name ?? track.file}: vgmstream unavailable — ${e.message ?? e}`);
      }
      const audioBuffer = await ctx.decodeAudioData(wav);
      bufferRef.current = audioBuffer;
      // The loop point comes from the .bgw header, not the decoder, so it
      // applies to the vgmstream output too.
      const loopStartSec = header.loopStartSec;
      loopRef.current = { looped: header.looped, loopStartSec };
      setInfo({ formatName: 'ATRAC3', sampleRate: header.sampleRate || audioBuffer.sampleRate,
        channels: audioBuffer.numberOfChannels, durationSec: audioBuffer.duration,
        looped: header.looped, loopStartSec });
      startFrom(0);
      return;
    }

    const { header: h, audioBuffer } = toAudioBuffer(ctx, buffer);
    bufferRef.current = audioBuffer;
    // loopStartSec handles the ADPCM-blocks / PCM-frames difference and rejects
    // out-of-range values; the open-coded blocks formula got both wrong.
    const loopStartSec = h.loopStartSec;
    loopRef.current = { looped: h.looped, loopStartSec };
    setInfo({
      formatName: h.formatName,
      sampleRate: h.sampleRate,
      channels: h.channels,
      durationSec: audioBuffer.duration,
      looped: h.looped,
      loopStartSec,
    });
    startFrom(0);
  };

  const pause = () => {
    if (!playingRef.current) return;
    offsetRef.current = currentOffset();
    playingRef.current = false;
    disconnectSource();
    setPlaying(false);
    clearTick();
    setPosition(offsetRef.current);
  };

  const resume = () => {
    if (playingRef.current || !bufferRef.current) return;
    startFrom(offsetRef.current >= (bufferRef.current.duration - 0.05) ? 0 : offsetRef.current);
  };

  const stop = () => {
    playingRef.current = false;
    disconnectSource();
    clearTick();
    bufferRef.current = null;
    setPlaying(false);
    setCurrent(null);
    setInfo(null);
    setPosition(0);
    offsetRef.current = 0;
  };

  const seek = (seconds) => {
    if (!bufferRef.current) return;
    const s = Math.min(Math.max(seconds, 0), bufferRef.current.duration);
    offsetRef.current = s;
    setPosition(s);
    if (playingRef.current) startFrom(s);
  };

  const setVolume = (v) => {
    const clamped = Math.min(Math.max(v, 0), 1);
    setVolumeState(clamped);
    localStorage.setItem('musicVolume', String(clamped));
    if (gainRef.current) gainRef.current.gain.value = clamped;
  };

  useEffect(() => () => { disconnectSource(); clearTick(); }, []);

  const getAnalyser = () => analyserRef.current;

  return { current, playing, info, position, volume, play, pause, resume, stop, seek, setVolume, getAnalyser };
}
