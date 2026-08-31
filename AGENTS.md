# Agent notes — xi-model-viewer

## Running the app yourself (do this before theorising)

The app is normally launched with `Start.bat` (`cargo tauri dev`), which opens a
native window an agent cannot see into. To drive it from a browser instead —
click controls, take screenshots, poke at live state — start the two pieces the
Tauri shell would otherwise provide:

```bash
XI_GAME_DIR="D:\path\to\FINAL FANTASY XI" python dev/serve.py 8766
```

```bash
cd ui && npm run dev
```

`vite.config.js` proxies `/fs` to `127.0.0.1:8766`, which is where `dev/serve.py`
serves the filesystem API that `js/backend.js` falls back to outside Tauri. With
both running, `http://localhost:5173` is the real app with real game data.

**Without `serve.py` every `/fs/*` request 500s**, no model ever loads, and the
whole viewer looks superficially fine while being unable to open a single DAT.
Stop both when finished: Vite uses `strictPort`, so a leftover dev server makes
`Start.bat` fail, and a leftover browser tab pointed at 5173 keeps requesting
`/fs` and fills the Tauri console with `ECONNREFUSED 127.0.0.1:8766` — noise that
looks like an app bug and is not.

## Debug hooks

Two globals exist for exactly this (see `App.jsx`):

- `window.__xiRendererRef.current` — the live `Renderer`: `pose`, `batches`,
  `currentAnimation`, `model`, `setMeshSourceFilter`, …
- `window.xi` — `{ renderer, getModel(), loadDat(path), loadZone }`

Useful moves from the console:

- `xi.getModel()` then walk `meshGroups` / `skeleton.references` / `jointOverrides`.
- `__xiRendererRef.current.setMeshSourceFilter(['ROM\\28\\52.DAT'])` to isolate a
  single DAT's meshes. **This is the fastest way to tell "the hand is broken"
  from "a weapon is drawn on top of the hand"** — isolate each and look.
- Re-pose without a reload:
  `r.pose.parentOverrides = null; r.pose.evaluate(r.currentAnimation, r.animFrame); r.poseDirty = true;`
- Drive the composer deterministically instead of fighting the two-step combo:
  write `localStorage.pcState` (`{race, sel:{slot: itemId}, actionGroup, action}`)
  — item ids come from `ui/public/lists/characters.json` — then reload.

Parsers are plain ES modules, so you can also `await import('/js/dat.js')` and
`parseEntity`/`mergeModels` DATs you `fetch()` yourself. Copy the DATs somewhere
under `ui/public/` first so Vite serves them, and delete them afterwards.

## Measure before concluding

Bounding boxes and centroids are weak evidence — they are invariant under a wrong
rigid transform, and a hand can be mangled while keeping the same extent. Compare
per-vertex positions, or isolate the mesh and look at it. Several dead ends in the
hand-deformation hunt came from trusting a centroid that was correct the whole
time; the actual cause (`withBaseIdle` underlaying the battle stance beneath idle,
so the weapon-grip pose drove the fingers) was obvious within a minute of getting
the app on screen and isolating `ROM\28\52.DAT`.

`vite build` succeeding proves very little: bundlers do not resolve free
identifiers, so an out-of-scope variable builds cleanly and throws at runtime.
Load the page and read the console.

## Tooltips (hard rule)

**Always use Tippy via `ui/src/Tooltip.jsx`. Never use the native browser tooltip.**

- Do **not** put user-facing hover text on the HTML `title` attribute.
- Wrap the control in `<Tooltip content="…">…</Tooltip>` (or `title=` prop on `Tooltip`, which maps to Tippy content).
- `aria-label` is fine for accessibility; it is not a substitute for Tippy when the user should see a hover tip.
- Exception: non-UI props named `title` that are not HTML attributes (e.g. modal header strings, export option labels passed as component props) are OK.

```jsx
// BAD
<button title="Close" onClick={onClose}>…</button>
<label title="Snap to every 15 frames">…</label>

// GOOD
import { Tooltip } from './Tooltip.jsx';

<Tooltip content="Close" placement="left">
  <button type="button" aria-label="Close" onClick={onClose}>…</button>
</Tooltip>
```
