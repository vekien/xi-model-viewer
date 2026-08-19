# Agent notes — xi-model-viewer

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
