# Agent notes — xi-model-viewer

## Running the app yourself (do this before theorising)

The app is normally launched with `Start.bat` (`cargo tauri dev`), which opens a
native window an agent cannot see into. To drive it from a browser instead —
click controls, take screenshots, poke at live state — start the two pieces the
Tauri shell would otherwise provide:

```bash
XI_GAME_DIR="D:\path\to\FINAL FANTASY XI" python scripts/serve.py 8766
```

```bash
cd ui && npm run dev
```

`vite.config.js` proxies `/fs` to `127.0.0.1:8766`, which is where `scripts/serve.py`
serves the filesystem API that `js/backend.js` falls back to outside Tauri. With
both running, `http://localhost:5173` is the real app with real game data.

**Without `serve.py` every `/fs/*` request 500s**, no model ever loads, and the
whole viewer looks superficially fine while being unable to open a single DAT.
**Stop both the moment you are done.** `Start.bat` now clears port 5173 for
itself (`scripts/free_dev_port.bat`, which stops a listening `node`/`cargo`/app
process and leaves anything else alone), so a leftover Vite server no longer
blocks the user — but do not lean on that. `serve.py` on 8766 is not cleared by
anything, and a leftover browser tab pointed at 5173 keeps requesting `/fs`,
filling the Tauri console with `ECONNREFUSED 127.0.0.1:8766` — noise that looks
like an app bug and is not. Leaving a dev server up also means the user's next
`Start.bat` silently kills your session out from under you.

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

## Panels (hard rules)

Every floating panel on the stage is one of the app's panels, not a bespoke box. A new
view adds panels the way the Animation, Actors, Details and Skeleton panels are built:

- **Header.** One `details-header` row: `<span className="icon">…</span>` (the accent
  glyph), a `details-title` (the panel's name, short, no state in it), then a spacer
  (`<span className="sp" />`) and any actions. Anything that changes — a recipe name, a
  count, a status note — is its own `span` after the title (`mono`, `mono-small`,
  `fx-actor-sec-title` for a section heading inside the body), never concatenated into
  the title text. `panel-title` is the older equivalent on `#animbar`; do not invent a
  third. Add the panel's id/class to the right-rail selector lists in `app.css`
  (`#animbar, #effect-actors, …` and the `.details-header` / `> .icon` lists) so it
  inherits the spacing contract (12px padding, 12px gap, 18px accent icon) instead of
  restyling it.
- **Buttons are glyphs.** Actions in a header, a transport, a row: a bare
  `button.pc-tbtn` with a Material `icon` inside, grouped in a `pc-tgroup`, each wrapped
  in `<Tooltip>` with an `aria-label`. `icon-btn` is the boxed variant for the odd
  standalone control (a search clear); `details-close` is the close/collapse glyph at the
  end of a header. The one labelled button is Play/Pause (`pc-play`), exactly as the
  Animation panel draws it. No text buttons, no `<select>` for a handful of options —
  that is a `seg-tabs` row — and no new `.foo-btn` classes.
- **Rows.** A labelled control is a `pc-ctrl` row: `pc-ctrl-label` then the control.
  Sliders are `vol-slider pc-frame-slider` with a `pc-frame-num` readout.
- **Placement.** A view's right-hand panels hang off the right rail (`RightRail.jsx`,
  `#right-rail`): one round glyph per panel, the view's main panel first, hover names
  it, a click opens or closes it, open glyphs are lit, and which are open is remembered
  per view (the mixer view is the pattern: `MIXER_RAIL` in App.jsx). Each open panel
  sits in a `Floating` host (`Floating.jsx`, `.float-host`): 320px wide unless told
  otherwise, placed by a `defaultPos` next to the rail (right 68px, top 60px under the
  menubar's row) until dragged by its own header, after which the spot is remembered.
  A panel's close glyph reports back through the view's open map so the rail stays in
  step. Anything wider than a panel is a window that borrows the Camera Sequencer's
  chrome (`#camseq` / `.cseq-*`: header dragged by its title bar, the inset track, the
  round Play / Stop, the frame readout, the edge resize handles — `#mixer-seq` in
  MixerTimeline.jsx is the second one) rather than a third column or a dock.
- **Keyboard.** Transport keys (Space) go through the one handler in `App.jsx` as a
  `leftView` branch; a panel registers only its own editing keys, in the bubble phase,
  and never a second Space listener.
- **Confirmation** is inline in the panel (a two-step chip row, like the mixer's
  publish plan) or a modal component; never `window.confirm` / `alert`. Cheap,
  recreatable things — a saved recipe — get no confirmation at all.
- No `console.log` / `console.info` left in a panel; the CLI output panel and the status
  bar are the user-facing channels.
