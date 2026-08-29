// Bakes the AltanaViewer-format effect CSVs into the viewer's own effects.json.
//
//   node dev/bake-effects.mjs [--src <ListDir>] [--out <dir>]
//
// Defaults: --src D:\xidata\AltanaViewer-main\List, --out ui/public/lists.
//
// Source layout (List/Effect/):
//   index.csv          `id[,label[,expansionNum]]` — category order + labels
//   <Category>.csv     `dir/file[-range],name` — one effect DAT per row
//
// Each `dir/file` maps to ROM/<dir>/<file>.DAT (the spell/ability/status effect
// DAT the particle runtime plays). Same-directory ranges (`16/101-115`) expand
// into one numbered entry per file; cross-directory ranges (`16/116-17/2`) keep
// only their first file, since the file count per directory isn't known here.
//
// Emits effects.json:
//   { "categories": [ { "id", "label",
//       "entries": [ { "name", "path": "ROM/d/f.DAT" }, … ] } ] }
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const SRC = join(arg('src', 'D:\\xidata\\AltanaViewer-main\\List'), 'Effect');
const OUT = arg('out', join(root, 'ui', 'public', 'lists'));

const rd = (p) => readFileSync(join(SRC, p), 'utf8');

// Minimal CSV row splitter: honours "double quoted" fields (which may contain
// commas) and strips surrounding quotes. Enough for these hand-authored lists.
function splitCsvRow(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (c === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

const rows = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/**
 * Expand a `dir/file[-range]` path spec into concrete DAT entries.
 * Returns [{ dir, file }] — one for a single, N for a same-dir range, and the
 * start only for a cross-dir range.
 */
function expandSpec(spec) {
  const m = spec.trim().match(/^(\d+)\/(\d+)(?:-(?:(\d+)\/)?(\d+))?$/);
  if (!m) return [];
  const dir = +m[1];
  const file0 = +m[2];
  const dir2 = m[3] != null ? +m[3] : null;
  const file1 = m[4] != null ? +m[4] : null;

  if (file1 == null) return [{ dir, file: file0 }];        // single
  if (dir2 != null && dir2 !== dir) return [{ dir, file: file0 }];  // cross-dir: start only

  const out = [];
  for (let f = file0; f <= file1; f++) out.push({ dir, file: f });  // same-dir range
  return out;
}

// index.csv: `id[,label[,num]]`. Label defaults to the id; trim stray spaces.
const index = rows(rd('index.csv')).map((line) => {
  const [id, label] = splitCsvRow(line);
  return { id: id.trim(), label: (label ?? '').trim() || id.trim() };
});

const categories = [];
let entryCount = 0;

for (const { id, label } of index) {
  let text;
  try { text = rd(`${id}.csv`); } catch { console.warn(`skip ${id}: no ${id}.csv`); continue; }

  const entries = [];
  for (const line of rows(text)) {
    const cols = splitCsvRow(line);
    const spec = cols[0].trim();
    const name = cols.slice(1).join(',').trim();
    const expanded = expandSpec(spec);
    if (!expanded.length) continue;
    const ranged = expanded.length > 1;
    expanded.forEach(({ dir, file }, i) => {
      entries.push({
        name: ranged ? `${name || spec} ${i + 1}` : (name || `${dir}/${file}`),
        path: `ROM/${dir}/${file}.DAT`,
        // No name in the CSV — the label above is invented from the spec, so
        // this row is a placeholder for a DAT nobody has identified yet.
        placeholder: !name,
      });
    });
  }

  // The CSVs occasionally list one DAT twice in a category — once named, once
  // blank (ChocoboRacing.csv has `181/55,Sandy Course Race` followed by a bare
  // `181/55`). The blank row bakes into a "181/55" placeholder that reads as a
  // second, separate effect sitting right under the real one.
  //
  // Drop a placeholder only when that exact path is already named in the SAME
  // category. Two genuine names for one DAT are left alone — Corsair's 164/61
  // really is listed as both Dancer's Roll and Double-Up, and that is the source
  // data saying they share a VFX, not a baking artefact.
  const namedPaths = new Set(entries.filter((e) => !e.placeholder).map((e) => e.path));
  const kept = entries
    .filter((e) => !(e.placeholder && namedPaths.has(e.path)))
    .map(({ name, path }) => ({ name, path }));

  if (kept.length) { categories.push({ id, label, entries: kept }); entryCount += kept.length; }
}

const outPath = join(OUT, 'effects.json');
// 1-space indent matches the other baked lists (sfx, characters); at 4k+ entries
// the extra column costs ~40KB of shipped JSON for nothing.
writeFileSync(outPath, `${JSON.stringify({ categories }, null, 1)}\n`);
console.log(`Wrote ${outPath}: ${categories.length} categories, ${entryCount} effects.`);
