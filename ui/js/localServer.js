// Settings › Local Server: the LandSandBoat checkout and its database, for the Ability
// Mixer's Manage switches (Database Update, Client Menu Record, Lua Stub) and the
// weapon-skill C++ patch.
//
// The viewer keeps none of it. The values live in xi-tools' own .env
// (<xi-tools>\.env), which every xi run reads for itself, and the tab reads and edits
// that file the way xi-tools' setup wizard does (xi_bridge._parse_env_file /
// _write_env_file): every other line and comment is kept, a changed key's line is
// rewritten in place, a cleared key's line is dropped, a new key goes at the end.
// Nothing is copied into localStorage and nothing is sent with every xi run.

import { backend } from './backend.js';
import { xiJson } from './mixer.js';

/** Settings field → the .env key xi reads, in the order a .env without them gets them. */
export const LOCAL_SERVER_KEYS = Object.freeze({
  dir: 'XI_SERVER_DIR',
  host: 'XI_DB_HOST',
  port: 'XI_DB_PORT',
  user: 'XI_DB_USER',
  password: 'XI_DB_PASSWORD',
  database: 'XI_DB_NAME',
});
export const LOCAL_SERVER_DEFAULT = Object.freeze({ dir: '', host: '', port: '', user: '', password: '', database: '' });
const FIELD_LABEL = { dir: 'Server folder', host: 'Host', port: 'Port', user: 'User', password: 'Password', database: 'Database' };

// ── .env text, as xi-tools reads and writes it ─────────────────────────────────

// Python's str.strip() set, not JS trim()'s: the two differ on U+FEFF, U+001C–U+001F and U+0085.
const PY_WS = '\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_STRIP_RX = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g');
const PY_LSTRIP_RX = new RegExp(`^[${PY_WS}]+`);
const PY_RSTRIP_RX = new RegExp(`[${PY_WS}]+$`);
const pyStrip = (s) => String(s ?? '').replace(PY_STRIP_RX, '');
// str.splitlines(): every line boundary Python knows, \r\n counted once.
const PY_LINES_RX = /\r\n|[\n\r\x0b\x0c\x1c-\x1e\x85\u2028\u2029]/;
const LINE_BREAK_RX = /[\n\r\x0b\x0c\x1c-\x1e\x85\u2028\u2029]/;

function splitLines(text) {
  const lines = String(text ?? '').split(PY_LINES_RX);
  // splitlines() has no empty entry after a final line break.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * KEY → value, exactly as xi_bridge._parse_env_file reads a .env: blank lines and
 * `#` lines skipped, an `export ` prefix dropped, split on the first `=`, both sides
 * stripped, one pair of matching quotes around the value removed. A key set twice
 * reads as its last line.
 */
export function parseEnvText(text) {
  const out = {};
  for (const raw of splitLines(text)) {
    let line = pyStrip(raw);
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).replace(PY_LSTRIP_RX, '');
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = pyStrip(line.slice(0, eq));
    let value = pyStrip(line.slice(eq + 1));
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) value = value.slice(1, -1);
    if (key) out[key] = value;
  }
  return out;
}

/** A value as its `KEY=value` line holds it: stripped (the reader strips it anyway), unquoted — unless
 *  the value is itself wrapped in matching quotes, which the reader would take off: then it goes in
 *  the other kind, so it reads back as typed. */
function envLineValue(v) {
  const s = pyStrip(v);
  if (s.length >= 2 && s[0] === s[s.length - 1] && (s[0] === '"' || s[0] === "'")) return s[0] === '"' ? `'${s}'` : `"${s}"`;
  return s;
}

/**
 * `text` with `updates` (KEY → value) merged in, exactly as xi_bridge._write_env_file
 * does it: every other line and comment kept as it is, each line of a key being
 * updated rewritten as `KEY=value` where it stands (every one, when the key is there
 * twice), dropped when the new value is blank, and a key the file lacks appended at the
 * end in the order given. LF line endings and one final newline. A value with a line
 * break in it throws: it would end its line early.
 */
export function mergeEnvText(text, updates) {
  const entries = Object.entries(updates ?? {});
  for (const [key, v] of entries) {
    if (LINE_BREAK_RX.test(String(v ?? ''))) throw new Error(`${key}: a value can't contain a line break`);
  }
  const want = new Map(entries);
  const seen = new Set();
  const out = [];
  for (const raw of splitLines(text)) {
    const stripped = pyStrip(raw);
    if (!stripped || stripped.startsWith('#') || !stripped.includes('=')) { out.push(raw); continue; }
    let key = pyStrip(stripped.split('=', 1)[0]);
    if (key.startsWith('export ')) key = key.slice('export '.length);
    key = pyStrip(key);
    if (!want.has(key)) { out.push(raw); continue; }
    const val = envLineValue(want.get(key));
    if (val) out.push(`${key}=${val}`);
    seen.add(key);
  }
  for (const [key, v] of entries) {
    if (seen.has(key)) continue;
    const val = envLineValue(v);
    if (val) out.push(`${key}=${val}`);
  }
  return `${out.join('\n').replace(PY_RSTRIP_RX, '')}\n`;
}

// ── The Settings fields ─────────────────────────────────────────────────────────

/** Every field a string, stripped as xi-tools strips what it reads back. */
export function normalizeLocalServer(raw) {
  const out = { ...LOCAL_SERVER_DEFAULT };
  for (const k of Object.keys(LOCAL_SERVER_DEFAULT)) out[k] = pyStrip(raw?.[k] ?? '');
  return out;
}

/** The fields from a parsed .env (parseEnvText). */
export function localServerFromEnv(env) {
  const out = { ...LOCAL_SERVER_DEFAULT };
  for (const [k, key] of Object.entries(LOCAL_SERVER_KEYS)) out[k] = String(env?.[key] ?? '');
  return out;
}

/** What is wrong with the fields before they are saved, as a sentence; null when nothing is. */
export function localServerProblem(values) {
  for (const [k, label] of Object.entries(FIELD_LABEL)) {
    if (LINE_BREAK_RX.test(String(values?.[k] ?? ''))) return `Local Server: the ${label} can't contain a line break.`;
  }
  const port = pyStrip(values?.port ?? '');
  if (port && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) {
    return 'Local Server: the port must be a number from 1 to 65535.';
  }
  return null;
}

/** The .env updates (KEY → value) for the fields that differ from `base` (what the file held), blank = remove. */
export function localServerChanges(values, base = null) {
  const now = normalizeLocalServer(values);
  const was = normalizeLocalServer(base);
  const out = {};
  for (const [k, key] of Object.entries(LOCAL_SERVER_KEYS)) if (now[k] !== was[k]) out[key] = now[k];
  return out;
}

/** The fields as env vars for one xi run (Test connection, the patch): non-blank only, as xi's .env loader skips blanks. */
export function localServerEnv(values) {
  const now = normalizeLocalServer(values);
  const env = {};
  for (const [k, key] of Object.entries(LOCAL_SERVER_KEYS)) if (now[k]) env[key] = now[k];
  return env;
}

/** <xi-tools>\.env: the file xi reads first (xi_config._candidate_env_files, the repo root). */
export function envFilePath(xiPath) {
  return `${String(xiPath ?? '').trim().replace(/[\\/]+$/, '')}\\.env`;
}

/**
 * The .env's text, '' when the folder has no .env. A file that is there but can't be
 * read throws, so nothing is ever written over it from an empty start.
 */
async function readEnvText(xiPath) {
  const path = envFilePath(xiPath);
  const text = await backend.readTextFile(path);
  if (text != null) return { path, text, exists: true };
  let names;
  try {
    names = await backend.listDir(String(xiPath).trim().replace(/[\\/]+$/, ''));
  } catch (e) {
    throw new Error(`couldn't read the xi-tools folder (${e?.message ?? e})`);
  }
  if ((names ?? []).some((e) => !e.isDir && String(e.name).toLowerCase() === '.env')) throw new Error(`couldn't read ${path}`);
  return { path, text: '', exists: false };
}

/** Settings › Local Server as xi-tools' .env holds it now: `{ path, exists, values }`. A missing file is all blank. */
export async function readLocalServer(xiPath) {
  const { path, text, exists } = await readEnvText(xiPath);
  return { path, exists, values: localServerFromEnv(parseEnvText(text)) };
}

/**
 * Save the fields that differ from `base` (the values the tab read) into xi-tools' .env,
 * merged into the file as it is on disk now, so a line anything else wrote since is
 * kept. Returns `{ path, written, keys }` — the keys it changed.
 */
export async function writeLocalServer(xiPath, values, base = null) {
  const updates = localServerChanges(values, base);
  const keys = Object.keys(updates);
  const path = envFilePath(xiPath);
  if (!keys.length) return { path, written: false, keys };
  const { text } = await readEnvText(xiPath);
  const next = mergeEnvText(text, updates);
  if (next === text) return { path, written: false, keys };
  await backend.writeTextFile(path, next);
  return { path, written: true, keys };
}

// ── xi server check / ws-widen ──────────────────────────────────────────────────

/**
 * `xi server check --json` (xi.server-check.v1): read-only. `db: false` makes no
 * connection (--no-db), `binary: false` skips the xi_map.pdb probe (--no-binary).
 * `env` is the one run's environment: the Settings draft on Test connection, which beats
 * the .env for that run only; null leaves xi to its .env.
 */
export const serverCheck = (xiPath, env, { db = true, binary = true } = {}) =>
  xiJson(['server', 'check', '--json', ...(db ? [] : ['--no-db']), ...(binary ? [] : ['--no-binary'])], xiPath, env);

/**
 * `xi server ws-widen --json` (xi.server-ws-widen.v1).
 * - default: writes the patch, SQL and README into xi-tools' projects\patches\ws_animation_16bit.
 * - `install` (--install --apply-db): places the patch in the server's modules\catseyexi, widens
 *   xi_map's source in place and widens the database column. Idempotent; never builds or restarts.
 * - `print` (--print): writes nothing and returns the text.
 */
export const wsWiden = (xiPath, env, { print = false, install = false } = {}) =>
  xiJson(['server', 'ws-widen', '--json',
    ...(install ? ['--install', '--apply-db'] : print ? ['--print'] : [])], xiPath, env);

export const LOCAL_SERVER_TOO_OLD = 'This xi-tools is too old for Local Server — update it in Settings › XI Tools.';

/** An `xi server …` failure as a sentence: a missing command means xi-tools needs updating. */
export function localServerErrorText(e) {
  const msg = String(e?.message ?? e ?? '');
  if (/No such command:?\s+['"]?(check|ws-widen)\b/.test(msg)) return LOCAL_SERVER_TOO_OLD;
  return msg;
}

/** "xidb@127.0.0.1:3306 as xi · server folder D:\…" for a configured check; null when no database is set. */
export function describeServer(c) {
  if (!c?.configured) return null;
  const who = c.user ? ` as ${c.user}` : '';
  const folder = c.serverDir
    ? ` · server folder ${c.serverDir}${c.serverDirValid === false ? ' (no scripts/actions there)' : ''}`
    : ' · no server folder';
  return `${c.database ?? '?'}@${c.host ?? '?'}:${c.port ?? '?'}${who}${folder}`;
}

/**
 * A folder path as a key to compare two spellings of one folder: / and \ alike, repeated
 * separators and `.` parts dropped, no trailing separator, case ignored. xi reports the
 * folder as Python's str(Path(dir)) does, which rewrites the one typed or kept in the .env
 * (D:/cexi-server/catseyexi, D:\cexi-server\catseyexi\).
 */
export function serverDirKey(p) {
  let s = pyStrip(p).replace(/\//g, '\\');
  const unc = /^\\\\/.test(s) ? '\\\\' : '';
  s = s.slice(unc.length).split(/\\+/).filter((part, i) => part !== '.' || i === 0).join('\\');
  return `${unc}${s.replace(/\\+$/, '')}`.toLowerCase();
}

/** Whether two server-folder paths name the same folder (serverDirKey); never for a blank one. */
export function sameServerDir(a, b) {
  const ka = serverDirKey(a);
  return !!ka && ka === serverDirKey(b);
}

/** The Server folder's badge from a check: `{ tone, text }`, null with no folder set. */
export function serverFolderLine(c) {
  if (!c?.serverDir) return null;
  return c.serverDirValid
    ? { tone: 'ok', text: 'LandSandBoat checkout · scripts/actions found' }
    : { tone: 'err', text: 'Not a LandSandBoat checkout (no scripts/actions)' };
}

/** Test connection's badge from a check: `{ tone, text }`. */
export function connectionLine(c) {
  if (!c) return null;
  if (!c.configured) return { tone: 'warn', text: 'No database set — fill in Host, User and Database.' };
  if (c.connected === true) {
    const text = `Connected · ${c.version ?? '?'} · ${c.database ?? '?'}@${c.host ?? '?'}:${c.port ?? '?'}${c.user ? ` as ${c.user}` : ''}`;
    const missing = Object.entries(c.tables ?? {}).filter(([, t]) => t && t.present === false).map(([n]) => n);
    return missing.length
      ? { tone: 'warn', text: `${text} · no ${missing.join(', ')} table${missing.length === 1 ? '' : 's'}` }
      : { tone: 'ok', text };
  }
  if (c.connected === false) return { tone: 'err', text: c.error || "Couldn't connect." };
  return { tone: 'neutral', text: 'Not tested yet.' };
}

/** One line: what weapon skills need. The long version lives in the patch's README. */
export const WS_WHY = 'Weapon-skill animations above 255 need a small server change — a 16-bit column and four '
  + 'C++ spots. Retail weapon skills (all below 256) are untouched.';

/** An edit's place, `file:line` — the file alone when its line wasn't found (or no folder was read). */
const editWhere = (e) => (Number.isInteger(e?.line) && e.line > 0 ? `${e.file}:${e.line}` : String(e?.file ?? '?'));

/**
 * The weapon-skill state line from a check's `weaponSkills`: `{ tone, text, command }`
 * (command: the xi_map build command to copy, when a rebuild is what is left).
 */
export function wsStateLine(ws) {
  if (!ws) return null;
  const st = ws.source?.state;
  if (!st || st === 'no-server-dir') return { tone: 'neutral', text: 'Set the server folder first.', command: null };
  if (st === 'stock') return { tone: 'warn', text: 'Not set up — 0–255 only.', command: null };
  if (st === 'partial' || st === 'unrecognised') {
    const e = (ws.source?.edits ?? []).find((x) => x && x.state !== 'wide');
    const where = e ? ` (${editWhere(e)})` : '';
    return { tone: 'err', text: `Source ${st === 'partial' ? 'partly changed' : 'not recognised'}${where} — fix it by hand (Show the code).`, command: null };
  }
  if (ws.ready === true) return { tone: 'ok', text: 'Ready (16-bit).', command: null };
  if (ws.columnWide === false) return { tone: 'warn', text: 'Source done; database column still 0–255 — run the SQL.', command: null };
  if (ws.columnWide == null) return { tone: 'neutral', text: 'Source done; database not checked — Test connection.', command: null };
  const bin = ws.binary ?? {};
  if (bin.rebuilt === false) return { tone: 'warn', text: 'Done — now rebuild xi_map and restart it.', command: ws.buildCommand ?? null };
  if (bin.rebuilt == null) return { tone: 'warn', text: 'Done — rebuild xi_map and restart it (can’t confirm the build).', command: ws.buildCommand ?? null };
  return { tone: 'ok', text: 'Ready (16-bit).', command: null };
}

/** The file Explorer should select after Get the C++ patch: the patch, or the README when the patch was refused. */
export function wsRevealTarget(res) {
  if (res?.patch?.path && res.patch.action !== 'refused') return res.patch.path;
  return res?.readme?.path ?? null;
}

/** After Apply to server (--install): the placed patch to select in Explorer, else the server folder. */
export function wsInstallReveal(res) {
  const cpp = res?.install?.cppPatch;
  if (cpp?.path && (cpp.action === 'written' || cpp.action === 'already')) return cpp.path;
  return res?.serverDir ?? null;
}

/** A one-line result of Apply to server: `{ tone, text }`. */
export function wsInstallSummary(res) {
  if (res?.error) return { tone: 'err', text: res.error };
  const inst = res?.install ?? {};
  if (inst.sourceApply?.action === 'refused') {
    return { tone: 'err', text: 'Couldn’t apply — the source is partly changed or unrecognised. Show the code has the four lines.' };
  }
  const bits = [];
  if (inst.sourceApply?.action === 'applied') bits.push('source patched');
  else if (inst.sourceApply?.action === 'already') bits.push('source already 16-bit');
  if (inst.db?.action === 'altered') bits.push('column widened');
  else if (inst.db?.action === 'already-wide') bits.push('column already 16-bit');
  else if (inst.db?.action === 'skipped') bits.push('column: run the SQL / dbtool');
  const tail = (res?.next ?? []).includes('rebuild') ? ' — now rebuild xi_map and restart it' : '';
  return { tone: res?.ok ? 'ok' : 'err', text: `${bits.join(' · ') || 'Done'}${tail}.` };
}

/** Show the code: the patch and the SQL as one text, or the four edits when there is no patch to show. */
export function wsCodeText(res) {
  const parts = [];
  if (res?.patch?.text) parts.push(res.patch.text.replace(/\s+$/, ''));
  else {
    const edits = res?.source?.edits ?? [];
    if (edits.length) {
      parts.push(edits.map((e) => `${editWhere(e)}\n  ${e.before ?? '?'}${e.after ? `\n→ ${e.after}` : ''}`).join('\n'));
    }
  }
  if (res?.sql?.text) parts.push(res.sql.text.replace(/\s+$/, ''));
  return parts.join('\n\n');
}
