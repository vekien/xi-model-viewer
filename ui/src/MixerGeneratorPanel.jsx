import { useEffect, useMemo, useRef, useState } from 'react';
import { Tooltip } from './Tooltip.jsx';
import { Combo } from './Combo.jsx';
import { ColorSwatch } from './ColorPicker.jsx';
import { parseHex, toHex } from '../js/color.js';
import { backend } from '../js/backend.js';
import { decodeTextureSection } from '../js/zone.js';
import { GROUPS, TICKS_PER_SECOND, allFields, curvesOf, describeGenerator, fromDisplay, hueRotate, references, toDisplay } from '../js/particle/fields.js';
import { clearCurveKeys, clearFieldEdit, clearGeneratorEdits, clearTexture, composedSection, curveKeys, encodePng, generatorEdits, pngBytes, pngDataUri, pngInfo, pngProblem, publishedSide, setCurveKeys, setFieldEdit, setTexture, textureOf, trackLabel, turnGeneratorHue } from '../js/mixer.js';
import { generatorTextures, textureUsers } from '../js/mixerLive.js';

// The Generator panel — what Edit generator on an effects block opens: every field of
// one particle generator of a track's source DAT, by group, with the mix's edits laid
// over it. The fields and their byte ranges come from particle/fields.js; an edit is
// an entry in the recipe (`generators`, `curves` for a curve's keys, `textures` for a
// PNG in place of a texture it draws), which compose and publish bake into the DAT.
// Nothing here touches a DAT: the panel reads the source, and App.jsx shows the
// recipe's edits on the stage (mixerSyncStage).

const FOLD_KEY = 'mixerGenFolded';
const readFolded = () => { try { return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) || '["Other"]')); } catch { return new Set(['Other']); } };
const writeFolded = (set) => { try { localStorage.setItem(FOLD_KEY, JSON.stringify([...set])); } catch { /* private mode */ } };

const INT_RANGE = { u8: [0, 0xff], u16: [0, 0xffff], u32: [0, 0xffffffff], i16: [-0x8000, 0x7fff], i32: [-0x80000000, 0x7fffffff] };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmt = (v) => (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6))));
const hex2 = (v) => `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A shown number as the value the field stores, kept inside what its bytes (or bits) hold. */
function toStored(field, shown) {
  const raw = fromDisplay(field, shown);
  // A typed "-0" is +0: JSON carries it to compose as 0, so the preview must write 0 as well.
  if (field.wire === 'f32') return raw === 0 ? 0 : raw;
  const [lo, hi] = field.mask != null ? [0, field.mask >>> field.shift] : (INT_RANGE[field.wire] ?? [0, 0xff]);
  return clamp(raw, lo, Math.min(hi, field.display.max ?? hi));
}

// A colour byte of 0x80 is full brightness, so the picker works on twice the byte
// (0xFF, twice as bright, is only reachable through the numbers beside it).
const bytesToHex = ([r, g, b]) => toHex({ r: Math.min(255, r * 2), g: Math.min(255, g * 2), b: Math.min(255, b * 2) });
const hexToBytes = (hex) => { const c = parseHex(hex); return c ? [c.r, c.g, c.b].map((v) => Math.round(v / 2)) : null; };

// The section types a generator's linked id can be re-pointed at, by what it draws
// (0x01 linked type). Only what compose carries along is offered (fields.js datIds).
const LINKED_SECTIONS = { 0x0b: [0x1f, 0x2e], 0x0e: [0x21], 0x39: [0x21], 0x3d: [0x3d] };
const TEXTURED = new Set([0x0b, 0x0e, 0x1d, 0x39]);

const whereOf = (f) => (f.sec === 0 ? `header +${hex2(f.at)}` : `sec${f.sec} ${hex2(f.op)}${f.nth ? ` #${f.nth + 1}` : ''} +${hex2(f.at)}`);
const whyLocked = (f) => (f.display.hex ? 'Shown as stored: nothing is known to read it.'
  : f.type === 'datid' ? 'Read-only: it names another section, and re-pointing it is not known to be safe.'
    : 'Read-only: xim and the PS2 build do not agree on it, or nothing reads it.');

/** A number typed freely: what is typed stays while the box has focus; every value that parses is committed. */
function NumBox({ value, onCommit, disabled = false, label = null }) {
  const [draft, setDraft] = useState(null);
  return (
    <label className="mgen-num">
      {label && <span>{label}</span>}
      <input type="text" inputMode="decimal" className="cseq-text mixer-num" spellCheck={false} disabled={disabled}
        value={draft ?? fmt(value)}
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          const v = Number(text);
          if (text.trim() !== '' && Number.isFinite(v)) onCommit(v);
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
    </label>
  );
}

function IdCombo({ value, ids, onChange }) {
  const items = [...new Set([value, ...ids].filter(Boolean))].map((id) => ({ id, label: id }));
  return <div className="cseq-load mgen-combo"><Combo value={value} items={items} onChange={(id) => id && id !== value && onChange(id)} /></div>;
}

/** The control for one field, by what the field holds. `idOptions` is what a datid may be re-pointed at. */
function FieldControl({ field, onSet, idOptions }) {
  const d = field.display;
  if (!field.editable) return <span className="mono-small mgen-ro">{d.text}</span>;
  if (field.type === 'rgba') {
    const setByte = (i, shown) => onSet(field.value.map((v, k) => (k === i ? clamp(Math.round(shown / d.scale), 0, 255) : v)));
    return (
      <div className="mgen-vec">
        <ColorSwatch className="tool-pop-color" value={bytesToHex(field.value)} tooltip="Pick the colour (0x80 is 100%)"
          onChange={(hex) => { const rgb = hexToBytes(hex); if (rgb) onSet([...rgb, field.value[3]]); }} />
        {/* Unrounded (NumBox shows 6 digits): a whole percent is 1.28 bytes, so committing a rounded one could move the byte. */}
        {['r', 'g', 'b', 'a'].map((c, i) => <NumBox key={c} label={`${c} %`} value={field.value[i] * d.scale} onCommit={(v) => setByte(i, v)} />)}
      </div>
    );
  }
  if (field.type === 'datid') {
    if (!idOptions?.length) return <span className="mono-small mgen-ro">{d.text} · nothing else of its kind in this DAT</span>;
    return <IdCombo value={field.value} ids={idOptions} onChange={onSet} />;
  }
  if (field.type === 'flags') {
    return (
      <div className="mgen-flags">
        {d.bits.map((b) => (b.value != null
          ? <span key={b.mask} className="mono-small mgen-ro">{b.label}: {b.value}</span>
          : (
            <label key={b.mask} className={`switch cseq-switch${b.editable ? '' : ' mgen-locked'}`}>
              <input type="checkbox" checked={b.on} disabled={!b.editable} onChange={() => onSet((field.value ^ b.mask) >>> 0)} />
              <span className="track" />
              <span className="cseq-switch-label">{b.label}{b.editable ? '' : ' · read-only'}</span>
            </label>
          )))}
      </div>
    );
  }
  if (d.enum) {
    const items = Object.entries(d.enum).map(([k, label]) => ({ id: String(Number(k)), label: `${label} (${hex2(Number(k))})` }));
    if (!(field.value in d.enum)) items.push({ id: String(field.value), label: `${hex2(field.value)} (unknown)` });
    return <div className="cseq-load mgen-combo"><Combo value={String(field.value)} items={items} onChange={(id) => id != null && Number(id) !== field.value && onSet(Number(id))} /></div>;
  }
  const unit = d.unit ? <span className="mono-small mgen-unit">{d.unit}{d.unit === 'ticks' && field.count === 1 ? ` · ${fmt(Number((toDisplay(field, field.value) / TICKS_PER_SECOND).toFixed(3)))} s` : ''}</span> : null;
  if (field.count > 1) {
    const axes = d.axes ?? '';
    return (
      <div className="mgen-vec">
        {field.value.map((v, i) => (
          <NumBox key={i} label={axes[i] ?? String(i)} value={toDisplay(field, v)}
            onCommit={(shown) => onSet(field.value.map((x, k) => (k === i ? toStored(field, shown) : x)))} />
        ))}
        {unit}
      </div>
    );
  }
  return <div className="mgen-vec"><NumBox value={toDisplay(field, field.value)} onCommit={(shown) => onSet(toStored(field, shown))} />{unit}</div>;
}

function FieldRow({ field, opName, edited, onSet, onRevert, idOptions }) {
  const tip = [field.note, field.editable ? null : whyLocked(field), `${whereOf(field)}${opName ? ` · ${opName}` : ''} · ${field.type}${field.count > 1 ? ` ×${field.count}` : ''} · stored ${field.raw}`]
    .filter(Boolean).join('\n');
  return (
    <div className={`mgen-row${edited ? ' edited' : ''}${field.editable ? '' : ' locked'}`}>
      <Tooltip content={<span className="mgen-tip">{tip}</span>} placement="left">
        <span className="mgen-label">
          {!field.editable && <span className="icon">lock</span>}
          {field.driven && <span className="icon">show_chart</span>}
          {field.label}
        </span>
      </Tooltip>
      <FieldControl field={field} onSet={onSet} idOptions={idOptions} />
      {edited && (
        <Tooltip content="Back to what the source DAT holds" placement="top">
          <button type="button" className="pc-tbtn mgen-undo" aria-label="Revert" onClick={onRevert}><span className="icon">undo</span></button>
        </Tooltip>
      )}
    </div>
  );
}

/** A curve's keys: times and values, as many as the source has, the last key's time fixed. */
function CurveTable({ id, keys, sourceKeys, users, self, onKeys, onRevert }) {
  const edited = !sameValue(keys.map(([t, v]) => [Math.fround(t), Math.fround(v)]), sourceKeys.map(([t, v]) => [Math.fround(t), Math.fround(v)]));
  const last = keys.length - 1;
  // A value of -0 is kept as +0, as JSON carries it to compose (the time column is clamped already).
  const set = (k, col, v) => onKeys(keys.map((row, i) => (i === k ? (col === 0 ? [clamp(v, 0, 0.999999), row[1]] : [row[0], v === 0 ? 0 : v]) : row)));
  const others = users.filter((u) => u !== self);
  return (
    <div className={`mgen-curve${edited ? ' edited' : ''}`}>
      <div className="mgen-curve-head">
        <span className="mono-small">{id} · {keys.length} keys</span>
        <Tooltip content={others.length
          ? `Curves are shared: ${others.join(', ')} also name${others.length === 1 ? 's' : ''} ${id}, and each of them this track fires plays the edited keys.`
          : 'No other generator of this DAT names this curve.'} placement="top">
          <span className={`mono-small ${others.length ? 'mgen-shared' : 'mgen-ro'}`}>used by {users.length} generator{users.length === 1 ? '' : 's'}</span>
        </Tooltip>
        <span className="sp" />
        {edited && (
          <Tooltip content="Back to the keys the source DAT holds" placement="top">
            <button type="button" className="pc-tbtn mgen-undo" aria-label="Revert the curve" onClick={onRevert}><span className="icon">undo</span></button>
          </Tooltip>
        )}
      </div>
      <div className="mgen-keys">
        {keys.map(([t, v], k) => (
          <div key={k} className="mgen-key">
            <Tooltip content={k === last ? 'The last key ends the curve: its time stays as the source has it.' : 'When, as a share of the particle’s life (0 to 1)'} placement="top">
              <span><NumBox label={k < 2 ? 'time' : null} value={t} disabled={k === last} onCommit={(x) => set(k, 0, x)} /></span>
            </Tooltip>
            <NumBox label={k < 2 ? 'value' : null} value={v} onCommit={(x) => set(k, 1, x)} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Textures ──────────────────────────────────────────────────────────────────
// What the generator draws with, one tile per texture, at the top of Texture & mesh.
// A replacement is a PNG the recipe carries (`textures`), per texture of the track: every
// generator drawing it changes with it. App.jsx puts it on the stage (mixerSyncStage).

const TEX_DIR_KEY = 'mixerTextureDir';   // localStorage: the folder a PNG was last picked from or saved to
const readTexDir = () => { try { return localStorage.getItem(TEX_DIR_KEY); } catch { return null; } };
const keepTexDir = (path) => { try { localStorage.setItem(TEX_DIR_KEY, path.replace(/[\\/][^\\/]*$/, '')); } catch { /* quota */ } };

/** A PNG the user picks: `{ name, bytes }`, or null on cancel. */
async function pickPng(title) {
  if (window.__TAURI__) {
    const dir = readTexDir();
    // pick_file opens in the parent of `initial`, so name a file inside the folder.
    const path = await backend.pickFile(dir ? `${dir}\\x` : null, { title, exts: ['png'] }).catch(() => null);
    if (!path) return null;
    const bytes = new Uint8Array(await backend.readFile(path));
    keepTexDir(path);
    return { name: path.split(/[\\/]/).pop(), bytes };
  }
  // Browser dev mode has no native dialog: the browser's own chooser hands over the bytes.
  const file = await backend.browseBinaryFile('.png,image/png');
  return file ? { name: file.name, bytes: new Uint8Array(file.bytes) } : null;
}

/** PNG bytes saved where the user says: where they went, or null on cancel. */
async function savePng(fileName, bytes, title) {
  if (!window.__TAURI__) {
    // Browser dev mode has no save dialog: the file goes to the browser's downloads.
    backend.downloadFile(fileName, bytes, 'image/png');
    return 'the browser downloads';
  }
  const dest = await backend.saveFileDialog(readTexDir(), { title, exts: ['png'], fileName }).catch(() => null);
  if (!dest) return null;
  await backend.writeFile(dest, bytes);
  keepTexDir(dest);
  return dest;
}

/** FFXI's half-scale alpha (0x80 opaque) doubled, as the game draws it and a PNG holds it. */
function fullAlpha(rgba) {
  const out = rgba.slice();
  for (let i = 3; i < out.length; i += 4) out[i] = Math.min(255, out[i] * 2);
  return out;
}

const THUMB = 64;
/** A texture fitted into THUMB px: the replacement PNG as it is, else the source's pixels. */
function TexThumb({ img, png }) {
  const ref = useRef(null);
  const size = png ?? img;
  useEffect(() => {
    const canvas = ref.current;
    if (png || !img || !canvas) return;
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(fullAlpha(img.rgba).buffer), img.width, img.height), 0, 0);
  }, [img, png]);
  if (!size?.width || !size?.height) return <span className="icon mgen-tex-none">hide_image</span>;
  const k = THUMB / Math.max(size.width, size.height);
  const style = { width: Math.max(1, Math.round(size.width * k)), height: Math.max(1, Math.round(size.height * k)) };
  return png ? <img className="mgen-tex-img" src={png.uri} alt="" style={style} draggable={false} /> : <canvas ref={ref} className="mgen-tex-img" style={style} />;
}

const VIA = { mesh: 'mesh', sprites: 'sprite sheet', ring: 'ring', specular: 'specular op', weighted: 'weighted mesh' };

/** One texture the generator draws: what the source DAT holds or the PNG in its place, and the ways to change it. */
function TextureTile({ tex, png, users, self, onReplace, onReset }) {
  const [msg, setMsg] = useState(null);   // { text, error }
  const img = useMemo(() => (tex.bytes ? decodeTextureSection(tex.bytes, tex.start) : null), [tex.bytes, tex.start]);
  const rep = useMemo(() => {
    const bytes = png ? pngBytes(png) : null;
    const info = bytes ? pngInfo(bytes) : null;
    return info && !info.error ? { uri: png, ...info } : null;
  }, [png]);
  // A PNG the mix holds that xi-tools refuses (a hand-edited file): Reset still takes it out.
  const bad = png && !rep ? pngProblem(png) ?? 'cannot be used' : null;
  const canReplace = !tex.note && !!tex.ref;
  const name = img?.name || tex.name || tex.from;

  const replace = async () => {
    if (!canReplace) return;
    setMsg(null);
    let file;
    try { file = await pickPng(`Replace texture · ${name}`); } catch (e) { setMsg({ text: `Could not read the PNG: ${e?.message ?? e}`, error: true }); return; }
    if (!file) return;
    const info = pngInfo(file.bytes);
    if (info.error) { setMsg({ text: `Not replaced: ${file.name} ${info.error}.`, error: true }); return; }
    onReplace(pngDataUri(file.bytes));
  };
  const save = async () => {
    if (!img) return;
    setMsg(null);
    const fileName = `${name.trim().replace(/[^A-Za-z0-9_-]+/g, '_') || tex.ref}.png`;
    try {
      const where = await savePng(fileName, await encodePng(img.width, img.height, fullAlpha(img.rgba)), `Save texture · ${name}`);
      if (where) setMsg({ text: `Saved ${fileName} to ${where}.` });
    } catch (e) {
      setMsg({ text: `Could not save ${fileName}: ${e?.message ?? e}`, error: true });
    }
  };

  const others = users.filter((u) => u !== self);
  const pub = rep ? [publishedSide(rep.width), publishedSide(rep.height)] : null;
  const resized = rep && (pub[0] !== rep.width || pub[1] !== rep.height);
  return (
    <div className={`mgen-tex${rep ? ' replaced' : ''}`}>
      <Tooltip content={canReplace ? 'Replace it with a PNG' : null} placement="left">
        <button type="button" className="mgen-tex-thumb" disabled={!canReplace} aria-label={`Replace ${name}`} onClick={replace}>
          <TexThumb img={img} png={rep} />
          {rep && <span className="mgen-tex-mark">replaced</span>}
        </button>
      </Tooltip>
      <div className="mgen-tex-info">
        <span className="mono-small mgen-tex-name">{name}</span>
        <span className="mono-small mgen-ro">
          {tex.ref ?? tex.from} · {VIA[tex.via]} {tex.from}
          {img ? ` · ${img.width}×${img.height} ${img.format}` : ''}
          {rep ? ` → PNG ${rep.width}×${rep.height}` : ''}
        </span>
        {canReplace && (
          <Tooltip content={others.length
            ? `Textures are shared: ${others.join(', ')} also draw${others.length === 1 ? 's' : ''} it, and each of them this track fires shows the replacement.`
            : 'No other generator of this DAT draws this texture.'} placement="left">
            <span className={`mono-small ${others.length ? 'mgen-shared' : 'mgen-ro'}`}>used by {users.length} generator{users.length === 1 ? '' : 's'}</span>
          </Tooltip>
        )}
        {tex.note && <div className="side-note mgen-tex-note">{tex.note}</div>}
        {bad && <div className="side-note mgen-tex-note mgen-error">The PNG this mix holds for it {bad}: Play mix and Publish refuse it. Replace… it, or Reset.</div>}
        {resized && <div className="side-note mgen-tex-note">Published as {pub[0]}×{pub[1]} DXT3: compose makes each side a power of two from 4 to 256.</div>}
        {canReplace && tex.via === 'sprites' && <div className="side-note mgen-tex-note">A sprite sheet is an atlas: its frames are cut from set places in the image, so a replacement must keep the original’s frame layout.</div>}
        {canReplace && tex.stage && <div className="side-note mgen-tex-note">{tex.stage}</div>}
        {msg && <div className={`side-note mgen-tex-note${msg.error ? ' mgen-error' : ''}`}>{msg.text}</div>}
        {canReplace && (
          <div className="mgen-tex-acts">
            <Tooltip content="Pick a PNG to use in its place: it goes into the mix, and compose puts it in the DAT on Play mix and Publish" placement="top">
              <button type="button" className="cseq-btn mgen-tex-btn" onClick={replace}>Replace…</button>
            </Tooltip>
            {img && (
              <Tooltip content="Save the source DAT’s texture as a PNG, alpha at full scale as shown here, to edit and pick back with Replace…" placement="top">
                <button type="button" className="cseq-btn mgen-tex-btn" onClick={save}>Save PNG</button>
              </Tooltip>
            )}
            <span className="sp" />
            {png && (
              <Tooltip content="Back to the texture the source DAT holds" placement="top">
                <button type="button" className="pc-tbtn mgen-undo" aria-label="Reset the texture" onClick={onReset}><span className="icon">undo</span></button>
              </Tooltip>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Shell({ label = '', sub = '', actions = null, onClose, children }) {
  return (
    <div id="mixer-generator" className="panel mixer-panel mixer-generator">
      <div className="panel-head">
        <span className="icon">bubble_chart</span>
        <span className="details-title">Generator</span>
        {label && <span className="mono-small">{label}</span>}
        {sub && <span className="mono-small mgen-src">{sub}</span>}
        <span className="sp" />
        {actions}
        <button type="button" className="icon-btn details-close" aria-label="Close" onClick={onClose}>
          <span className="icon">close</span>
        </button>
      </div>
      {children}
    </div>
  );
}

/**
 * The editor proper: one generator section of a track's source DAT (`data`, as
 * mixerLive.js sourceOf reads it) with the mix's edits over it. Keyed by its
 * generator, so the hue slider starts at 0 for each.
 */
export function GeneratorEditor({ data, section, recipe, onRecipe, lane, genId, label, sub, onPreview, onClose, shared = null }) {
  const [folded, setFolded] = useState(readFolded);
  // The hue slider turns the colours from where they stood when it left 0: the
  // edit lists it started from, and the lists it last wrote (anyone else's change
  // to them starts it over).
  const [hue, setHue] = useState(null);
  const hueWrote = useRef(null);

  const base = useMemo(() => describeGenerator(data.bytes, section.start, section.size), [data, section]);
  const baseByKey = useMemo(() => new Map(base ? allFields(base).map((f) => [f.key, f]) : []), [base]);
  const sourceCurves = useMemo(() => curvesOf(data.bytes), [data]);
  const edits = generatorEdits(recipe, lane, genId);
  // The generator as the mix has it: the source section with the recipe's edits on it.
  const now = useMemo(() => {
    if (!base) return { desc: null, error: null };
    try {
      const bytes = composedSection(data.bytes, section, { recipe: { generators: [{ lane, ref: genId, edits }] }, lane, ids: data.ids });
      return { desc: describeGenerator(bytes, 0, section.size), error: null };
    } catch (e) {
      return { desc: base, error: String(e?.message ?? e) };
    }
  }, [base, data, section, lane, genId, edits]);
  const curveNow = (id, from = recipe) => {
    const c = sourceCurves.get(id);
    if (!c) return null;
    const keys = curveKeys(from, lane, id);
    return keys && keys.length === c.keys.length ? { ...c, keys } : c;
  };
  // The generators of this track's source that name a curve, as the mix has them (this
  // lane's edits on each): a curve id re-pointed here moves that generator's use too.
  const usersOf = useMemo(() => {
    let refs = null;
    const build = () => data.sections.filter((s) => s.type === 0x05).map((s) => {
      let d;
      try { d = describeGenerator(composedSection(data.bytes, s, { recipe: { generators: recipe.generators }, lane, ids: data.ids }), 0, s.size); }
      catch { d = describeGenerator(data.bytes, s.start, s.size); }
      return { id: s.id, curves: new Set(d ? references(d).filter((r) => r.kind === 'curve').map((r) => r.id) : []) };
    });
    return (id) => (refs ??= build()).filter((g) => g.curves.has(id)).map((g) => g.id);
  }, [data, lane, recipe.generators]);

  const desc = now.desc;
  const ops = useMemo(() => new Map((desc?.streams ?? []).flatMap((s) => s.ops.map((o) => [`${o.sec}.${o.op}.${o.nth}`, o]))), [desc]);
  const opOf = (f) => (f.sec ? ops.get(`${f.sec}.${f.op}.${f.nth}`) ?? null : null);
  const fields = useMemo(() => (desc ? allFields(desc) : []), [desc]);
  const curveIds = useMemo(() => [...new Set([...(desc ? references(desc) : []), ...(base ? references(base) : [])].filter((r) => r.kind === 'curve').map((r) => r.id))], [desc, base]);
  const editedCurves = curveIds.filter((id) => curveKeys(recipe, lane, id));
  const isEdited = (f) => !sameValue(f.value, baseByKey.get(f.key)?.value);
  const editedCount = fields.filter(isEdited).length;
  // The textures it draws as the mix has it, so re-pointing "Draws" changes them too.
  const textures = useMemo(() => generatorTextures(desc, data, shared), [desc, data, shared]);
  // Per texture section, not id: several textures of a DAT may share one id.
  const texUsers = useMemo(() => {
    let users = null;
    return (t) => (users ??= textureUsers(data, { recipe: { generators: recipe.generators }, lane })).get(t.start) ?? [];
  }, [data, lane, recipe.generators]);
  const replacedCount = textures.filter((t) => {
    const png = t.ref && !t.note ? textureOf(recipe, lane, t) : null;
    return png && !pngProblem(png);
  }).length;

  const edit = (next) => { setHue(null); onRecipe(next); };
  const setField = (f, value) => edit(setFieldEdit(recipe, lane, genId, baseByKey.get(f.key), value));
  const revertField = (f) => edit(clearFieldEdit(recipe, lane, genId, baseByKey.get(f.key)));
  const revertAll = () => edit(curveIds.reduce((r, id) => clearCurveKeys(r, lane, id), clearGeneratorEdits(recipe, lane, genId)));

  /** What a datid field may be re-pointed at: the sections of the right kind in the same DAT. */
  const idOptions = (f) => {
    if (!f.editable) return [];
    const types = f.ref === 'curve' ? [0x19]
      : f.ref === 'linked' ? LINKED_SECTIONS[opOf(f)?.fields.find((x) => x.name === 'linkedType')?.value] ?? [] : [];
    return [...new Set(data.sections.filter((s) => types.includes(s.type) && data.ids.has(s.id)).map((s) => s.id))];
  };

  // ── Hue ─────────────────────────────────────────────────────────────────────
  const curveLookup = (from) => (id) => curveNow(id, from);
  const hueProbe = useMemo(() => (desc ? hueRotate(desc, 120, curveLookup(recipe)) : null), [desc, recipe.curves, sourceCurves, lane]);   // eslint-disable-line react-hooks/exhaustive-deps
  const linkedType = fields.find((f) => f.key === 's2.0x01.0.linkedType')?.value;
  const canTurn = !!hueProbe && !now.error && (hueProbe.edits.length > 0 || hueProbe.curves.length > 0);
  const hasHue = canTurn || (!!hueProbe && !now.error && (hueProbe.notRotatable.length > 0 || fields.some((f) => f.type === 'rgba' && f.editable)));
  const turnHue = (deg) => {
    // Someone else changed the edit lists since the slider last wrote them: the colours as they stand are the new 0°.
    const mine = hue && hueWrote.current && hueWrote.current.generators === recipe.generators && hueWrote.current.curves === recipe.curves;
    const from = mine ? hue.from : { generators: recipe.generators, curves: recipe.curves };
    const next = turnGeneratorHue(recipe, { lane, ref: genId, source: data.bytes, section, curves: sourceCurves, ids: data.ids, degrees: deg, from });
    hueWrote.current = { generators: next.generators, curves: next.curves };
    setHue({ deg, from });
    onRecipe(next);
  };

  const toggle = (g) => setFolded((prev) => {
    const next = new Set(prev);
    if (next.has(g)) next.delete(g); else next.add(g);
    writeFolded(next);
    return next;
  });

  // ── Body ────────────────────────────────────────────────────────────────────
  let body;
  if (!desc) body = <div className="side-note">{genId} is too short to be a generator.</div>;
  else {
    const seenCurves = new Set();
    const group = (name) => {
      const own = fields.filter((f) => f.group === name);
      const showHue = name === 'Colour' && hasHue;
      const showTex = name === 'Texture & mesh' && textures.length > 0;
      if (!own.length && !showHue && !showTex) return null;
      const open = !folded.has(name);
      const changed = own.filter(isEdited).length + (name === 'Curves' ? editedCurves.length : 0) + (showTex ? replacedCount : 0);
      // The curves group goes op by op: the op's own fields, then the keys of the curve it names.
      const byOp = name === 'Curves' ? [...new Set(own.map((f) => `${f.sec}.${f.op}.${f.nth}`))] : [null];
      return (
        <div key={name} className={`mixer-lib-group mgen-group${open ? ' open' : ''}`}>
          <div className="mixer-lib-cat" onClick={() => toggle(name)}>
            <span className="caret icon">chevron_right</span>
            <span className="mixer-lib-cat-name">{name}</span>
            {changed > 0 && <span className="badge mgen-badge">{changed} edited</span>}
            <span className="badge">{own.length}</span>
          </div>
          {open && name === 'Other' && <div className="side-note mgen-note">Pointer slots, operands nothing reads and ops only the PS2 build handles: shown as stored, never written.</div>}
          {open && showHue && (
            <div className="mgen-hue">
              <Tooltip content="Turns every colour of this generator round the colour wheel, from where they stand now: its colour operands, and its red / green / blue curves when their keys line up." placement="left">
                <span className="gfx-lab mgen-hue-lab">Hue shift &nbsp; • &nbsp; <strong>{hue?.deg ?? 0}°</strong></span>
              </Tooltip>
              <input type="range" min="0" max="360" step="1" value={hue?.deg ?? 0} disabled={!canTurn} className="vol-slider gfx-slider"
                style={{ '--fill': `${(hue?.deg ?? 0) / 3.6}%` }} onChange={(e) => turnHue(+e.target.value)} />
              {!canTurn && !hueProbe.notRotatable.length && <div className="side-note mgen-note">Every colour here is grey, so there is no hue to turn.</div>}
              {hueProbe.notRotatable.map((n) => <div key={n.what} className="side-note mgen-note">Not turned: {n.what} — {n.why}.</div>)}
              {TEXTURED.has(linkedType) && <div className="side-note mgen-note">The texture and the mesh’s own vertex colours keep their hue: a generator’s colour only tints them.</div>}
            </div>
          )}
          {open && showTex && (
            <div className="mgen-texs">
              {textures.map((t) => (
                <TextureTile key={`${t.via}|${t.ref ?? ''}|${t.name16}|${t.from}`} tex={t} self={genId}
                  png={t.ref && !t.note ? textureOf(recipe, lane, t) : null} users={t.ref && !t.note ? texUsers(t) : []}
                  // A PNG arrives after its picker closes, maybe after this editor has gone: it goes
                  // onto the mix as it is then, unless the track's source changed meanwhile.
                  onReplace={(png) => onRecipe((cur) => (cur.sources?.[lane]?.spec === recipe.sources?.[lane]?.spec ? setTexture(cur, lane, t, png) : cur))}
                  onReset={() => onRecipe(clearTexture(recipe, lane, t))} />
              ))}
            </div>
          )}
          {open && byOp.map((opKey) => {
            const rows = opKey == null ? own : own.filter((f) => `${f.sec}.${f.op}.${f.nth}` === opKey);
            const op = opKey == null ? null : ops.get(opKey);
            const curveId = op?.fields.find((f) => f.ref === 'curve')?.value || null;
            const curve = curveId ? curveNow(curveId) : null;
            const first = curveId && !seenCurves.has(curveId);
            if (curveId) seenCurves.add(curveId);
            return (
              <div key={opKey ?? name} className={op ? 'mgen-op' : undefined}>
                {op && (
                  <div className="mono-small mgen-op-head">
                    {op.what ?? rows[0]?.label.replace(/^Curve · /, '')} · sec{op.sec} {hex2(op.op)}
                    {op.drives.length > 0 && ` → ${op.drives.map((d) => `sec3 ${hex2(d.op)}`).join(', ')}`}
                  </div>
                )}
                {rows.map((f) => (
                  <FieldRow key={f.key} field={f} opName={opOf(f)?.name ?? null} edited={isEdited(f)} idOptions={f.type === 'datid' ? idOptions(f) : null}
                    onSet={(v) => setField(f, v)} onRevert={() => revertField(f)} />
                ))}
                {curveId && !curve && <div className="side-note mgen-note">{curveId} is not in this DAT (a shared curve of ROM/0/0.DAT), so its keys cannot be edited.</div>}
                {curve && !first && <div className="side-note mgen-note">Keys of {curveId}: above.</div>}
                {curve && first && (
                  <CurveTable id={curveId} keys={curve.keys} sourceKeys={sourceCurves.get(curveId).keys} users={usersOf(curveId)} self={genId}
                    onKeys={(keys) => edit(setCurveKeys(recipe, lane, curveId, keys, sourceCurves.get(curveId).keys))}
                    onRevert={() => edit(clearCurveKeys(recipe, lane, curveId))} />
                )}
              </div>
            );
          })}
        </div>
      );
    };
    const opCount = desc.streams.reduce((n, s) => n + s.ops.length, 0);
    const unknown = desc.streams.reduce((n, s) => n + s.ops.filter((o) => !o.known || !o.layoutOk).length, 0);
    body = (
      <>
        <div className="mono-small mgen-status">
          {opCount} ops{unknown ? ` · ${unknown} shown raw` : ''} · {editedCount || editedCurves.length
            ? `${editedCount} field${editedCount === 1 ? '' : 's'}${editedCurves.length ? ` and ${editedCurves.length} curve${editedCurves.length === 1 ? '' : 's'}` : ''} edited`
            : replacedCount ? '' : 'as the source DAT has it'}
          {replacedCount > 0 && `${editedCount || editedCurves.length ? ' · ' : ''}${replacedCount} texture${replacedCount === 1 ? '' : 's'} replaced`}
        </div>
        {now.error && <div className="side-note mgen-note mgen-error">An edit in the mix does not fit this generator, so none of them is shown: {now.error}. Revert all clears them.</div>}
        {desc.warnings.map((w) => <div key={w} className="side-note mgen-note mgen-error">{w}</div>)}
        <div className="mgen-body">{GROUPS.map(group)}</div>
      </>
    );
  }

  const actions = (
    <>
      {onPreview && (
        <Tooltip content="Play just this generator, once, with its edits">
          <button type="button" className="pc-tbtn" aria-label="Preview" onClick={onPreview}><span className="icon">play_arrow</span></button>
        </Tooltip>
      )}
      {(edits.length > 0 || editedCurves.length > 0) && (
        <Tooltip content="Revert all: every field of this generator, and the curves it names, back to what the source DAT holds. Replaced textures stay: a replacement belongs to the texture, which other generators may draw too, so each has its own Reset under Texture & mesh.">
          <button type="button" className="pc-tbtn" aria-label="Revert all" onClick={revertAll}><span className="icon">restart_alt</span></button>
        </Tooltip>
      )}
    </>
  );
  return <Shell label={label} sub={sub} actions={actions} onClose={onClose}>{body}</Shell>;
}

/**
 * The window: reads the track's source DAT (App.jsx keeps one read per file) and hands
 * the generator's section to the editor, or says why there is nothing to edit.
 */
export function MixerGeneratorPanel({ recipe, onRecipe, target = null, onLaneSource, onSharedSource = null, onPreview, onClose }) {
  const lane = target?.lane ?? null;
  const genId = target?.ref ?? null;
  const spec = lane ? recipe.sources?.[lane]?.spec ?? null : null;
  const [src, setSrc] = useState({ status: 'idle' });
  // ROM/0/0.DAT, for a texture the generator draws from there: shown, never replaced.
  const [shared, setShared] = useState(null);
  const wantShared = !!target && !!onSharedSource;
  useEffect(() => {
    if (!wantShared) return undefined;
    let live = true;
    onSharedSource().then((d) => { if (live) setShared(d ?? null); }, () => {});
    return () => { live = false; };
  }, [wantShared, onSharedSource]);
  useEffect(() => {
    if (!lane || !spec || !onLaneSource) { setSrc({ status: 'idle' }); return undefined; }
    let live = true;
    setSrc({ status: 'loading' });
    onLaneSource(lane).then(
      (data) => { if (live) setSrc(data ? { status: 'ready', data } : { status: 'none' }); },
      (e) => { if (live) setSrc({ status: 'error', error: String(e?.message ?? e) }); },
    );
    return () => { live = false; };
  }, [lane, spec, onLaneSource]);

  // The header's title stays "Generator"; which generator and track sit in their own span.
  const label = target ? `${genId} · ${trackLabel(lane)}` : '';
  const sub = target ? recipe.sources?.[lane]?.name ?? spec ?? '' : '';
  const say = (text) => <Shell label={label} sub={sub} onClose={onClose}><div className="side-note">{text}</div></Shell>;
  if (!target) return say('Select an effects block on the timeline and press Edit generator.');
  if (!spec) return say(`${trackLabel(lane)} has no source any more.`);
  if (src.status === 'error') return say(`Could not read the source DAT of ${trackLabel(lane)}: ${src.error}`);
  if (src.status === 'none') return say(`No DAT is known for ${spec}: the catalog does not list it, so its generators cannot be read.`);
  if (src.status !== 'ready') return say('Reading the source DAT…');
  const section = src.data.sections.find((s) => s.type === 0x05 && s.id === genId);
  if (!section) {
    return say(`${genId} is not in the source DAT of ${trackLabel(lane)} (${src.data.path}). A generator the game runs from the shared ROM/0/0.DAT — what a linked routine such as mdam or eis1 fires — is not carried by a mix, so it cannot be edited.`);
  }
  return (
    <GeneratorEditor key={`${lane}:${genId}:${src.data.path}`} data={src.data} section={section} recipe={recipe} onRecipe={onRecipe}
      lane={lane} genId={genId} label={label} sub={sub} onPreview={onPreview} onClose={onClose} shared={shared} />
  );
}
