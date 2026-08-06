// Bakes AltanaViewer's List/Image CSVs into ui/public/lists/images.json.
//
//   node dev/bake-images.mjs [--src <ListsDir>] [--out <dir>]
//
// Defaults: --src D:\xidata\AltanaViewer-main\List, --out ui/public/lists.
//
// Source shape:
//   index.csv          `<stem>, <Category display name>`
//   <stem>.csv rows    `<pathSpec>, <Entry name>`
//
// A row whose spec expands to more than one DAT becomes that many entries,
// suffixed `Name - N` (1-based), which is how AltanaView presents them:
// `0/14-21, Window` gives Window - 1 … Window - 8, and the Tutorial row expands
// to exactly 378, matching its last entry `Tutorial - 378`.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandPathSpec } from '../ui/js/pclists.js';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const SRC = join(arg('src', 'D:\\xidata\\AltanaViewer-main\\List'), 'Image');
const OUT = arg('out', join(root, 'ui', 'public', 'lists'));

const rd = (p) => {
  const full = join(SRC, p);
  return existsSync(full) ? readFileSync(full, 'utf8') : null;
};

/** `a, b` rows, skipping blanks. Only the first comma splits — names contain none. */
const rows = (text) => text
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    const i = l.indexOf(',');
    return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  });

const indexCsv = rd('index.csv');
if (!indexCsv) {
  console.error(`No index.csv under ${SRC} — pass --src <AltanaViewer List dir>.`);
  process.exit(1);
}

const categories = [];
let totalEntries = 0;
let skipped = 0;

for (const [stem, label] of rows(indexCsv)) {
  const csv = rd(`${stem}.csv`);
  if (!csv) { console.warn(`  ! ${stem}.csv missing — skipping category "${label}"`); continue; }

  const entries = [];
  for (const [spec, name] of rows(csv)) {
    if (!spec) { skipped++; continue; }        // e.g. `, Al Zahbi` — no DAT known
    const paths = expandPathSpec(spec);
    if (!paths.length) { skipped++; continue; }
    // A row with no label at all (misc.csv's `1/172/90` block) is AltanaViewer's
    // "one entry per DAT, named by path" form. Those happen to be the PNG-in-DAT
    // flavour, which carries no internal name to fall back on.
    const label = (path) => name || path.replace(/\.DAT$/i, '').replace(/\\/g, '/');
    if (paths.length === 1) {
      entries.push({ name: label(paths[0]), path: paths[0] });
    } else {
      paths.forEach((path, i) => entries.push({
        name: name ? `${name} - ${i + 1}` : label(path),
        path,
      }));
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  totalEntries += entries.length;
  categories.push({ id: stem, name: label, entries });
}

writeFileSync(join(OUT, 'images.json'), `${JSON.stringify(categories, null, 1)}\n`);
console.log(`wrote images.json — ${categories.length} categories, ${totalEntries} entries`
  + (skipped ? `, ${skipped} rows skipped (no usable path spec)` : ''));
for (const c of categories) console.log(`  ${String(c.entries.length).padStart(4)}  ${c.name}`);
