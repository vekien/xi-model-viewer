import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Shows the selected image over the viewport. Image DATs have nothing to do
 * with the WebGL scene, so this is a plain overlay rather than anything drawn
 * by the renderer.
 *
 * Textures decode to straight RGBA32 (`parseDatTextures`), so a 2D canvas is
 * enough; the PNG flavour goes to an <img> via a blob URL.
 */
// FFXI stores texture alpha at half scale — 128 is fully opaque. Textures that
// genuinely use the full 0-255 range exist too (character skins), so the doubling
// is decided per texture from its own maximum rather than applied blindly.
//
// DXT3 carries 4-bit alpha, so it cannot encode 128 at all: encoders dither
// between nibble 7 (119) and nibble 8 (136) to average out at half scale. An
// "opaque" map therefore peaks at 136, which is why the ceiling is 136 and not
// 128 — at 128 every DXT3 image failed the test and drew at half opacity.
const HALF_SCALE_MAX = 136;

// Doubling leaves the 119s at 238, so the dither survives as a ~7% ripple. Both
// nibbles mean "opaque", so anything that lands near the top after scaling is
// snapped the rest of the way.
const OPAQUE_ENOUGH = 230;

function toImageData(texture) {
  const src = texture.data;
  const out = new Uint8ClampedArray(src.length);
  out.set(src);
  let maxAlpha = 0;
  for (let i = 3; i < src.length; i += 4) if (src[i] > maxAlpha) maxAlpha = src[i];
  if (maxAlpha > 0 && maxAlpha <= HALF_SCALE_MAX) {
    for (let i = 3; i < out.length; i += 4) {
      const a = src[i] * 2;
      out[i] = a >= OPAQUE_ENOUGH ? 255 : a;
    }
  }
  return new ImageData(out, texture.width, texture.height);
}

export function ImageViewer({ doc, set }) {
  const canvasRef = useRef(null);
  const [zoom, setZoom] = useState(1);
  const [checker, setChecker] = useState(true);

  const pngUrl = useMemo(() => {
    if (doc?.kind !== 'png') return null;
    return URL.createObjectURL(new Blob([doc.png], { type: 'image/png' }));
  }, [doc]);
  useEffect(() => () => { if (pngUrl) URL.revokeObjectURL(pngUrl); }, [pngUrl]);

  const texture = set?.texture ?? null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !texture) return;
    canvas.width = texture.width;
    canvas.height = texture.height;
    canvas.getContext('2d').putImageData(toImageData(texture), 0, 0);
  }, [texture]);

  if (!doc) return null;

  const label = doc.kind === 'png'
    ? 'PNG'
    : texture
      ? `${set.category} / ${set.name} — ${texture.width}×${texture.height}`
      : set
        ? `${set.category} / ${set.name} — texture not in this file`
        : 'No image set selected';

  return (
    <div className={`img-viewer${checker ? ' checker' : ''}`}>
      <div className="img-stage">
        {doc.kind === 'png' && pngUrl && (
          <img src={pngUrl} alt="" style={{ transform: `scale(${zoom})` }} />
        )}
        {doc.kind === 'sets' && texture && (
          <canvas ref={canvasRef} style={{ transform: `scale(${zoom})` }} />
        )}
        {doc.kind === 'sets' && !texture && (
          <div className="side-note">
            {set ? 'This set draws from a texture stored in another DAT.' : 'Select an image set.'}
          </div>
        )}
        {doc.kind === 'empty' && <div className="side-note">Nothing readable in this file.</div>}
      </div>

      <div className="img-bar">
        <span className="img-label">{label}</span>
        <button
          type="button"
          className={`view-tool${checker ? ' on' : ''}`}
          title="Checkerboard behind transparency"
          onClick={() => setChecker((v) => !v)}
        >
          <span className="icon">grid_on</span>
        </button>
        <input
          type="range" min="25" max="400" step="5" value={Math.round(zoom * 100)}
          onChange={(e) => setZoom(+e.target.value / 100)}
          className="vol-slider"
          style={{ '--fill': `${((zoom * 100 - 25) / 375) * 100}%` }}
        />
        <span className="mono img-zoom">{Math.round(zoom * 100)}%</span>
      </div>
    </div>
  );
}
