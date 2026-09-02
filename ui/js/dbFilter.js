/**
 * Row filtering for the Database page: a rule list (field / operator /
 * value, joined by AND or OR) and a small SQL-ish query language
 * (`str > 20 and int > 20`, `name contains "haubert" or jobs has WAR`).
 * Both compile to a `(row) => boolean` predicate over the same field set.
 */

import { ITEM_LAYOUTS } from './database.js';

export const OPERATORS = [
  { key: 'eq', label: 'equals', sym: '=' },
  { key: 'ne', label: 'not equals', sym: '!=' },
  { key: 'lt', label: 'less than', sym: '<' },
  { key: 'le', label: 'less or equal', sym: '<=' },
  { key: 'gt', label: 'greater than', sym: '>' },
  { key: 'ge', label: 'greater or equal', sym: '>=' },
  { key: 'contains', label: 'contains', sym: 'contains' },
  { key: 'ncontains', label: "doesn't contain", sym: 'not contains' },
  { key: 'starts', label: 'starts with', sym: 'startswith' },
  { key: 'ends', label: 'ends with', sym: 'endswith' },
  { key: 'empty', label: 'is empty', sym: 'is empty', unary: true },
  { key: 'nempty', label: 'is not empty', sym: 'is not empty', unary: true },
];
const OP_BY_KEY = Object.fromEntries(OPERATORS.map((o) => [o.key, o]));

/** Extra names the query language accepts for a column key. */
const ALIASES = {
  id: ['itemid', 'item_id'],
  idx: ['index', 'row'],
  level: ['lvl', 'lv'],
  itemLevel: ['ilvl', 'ilevel', 'item_level'],
  skillName: ['skill'],
  damage: ['dmg'],
  delay: ['dly'],
  slotsText: ['slot', 'slots'],
  jobsText: ['job', 'jobs'],
  racesText: ['race', 'races'],
  typeName: ['type'],
  flagsText: ['flag', 'flags'],
  description: ['desc', 'text'],
  other: ['bonus', 'bonuses', 'effects'],
  stack: ['stacksize', 'stack_size'],
  castTime: ['cast'],
  summary: ['contents'],
  'stat:DEF': ['def', 'defense', 'defence'],
  'stat:DMG': ['dmg'],
  'stat:Delay': ['delay'],
  'stat:HP': ['hp'],
  'stat:MP': ['mp'],
  'stat:STR': ['str'],
  'stat:DEX': ['dex'],
  'stat:VIT': ['vit'],
  'stat:AGI': ['agi'],
  'stat:INT': ['int'],
  'stat:MND': ['mnd'],
  'stat:CHR': ['chr'],
};

const ALL_STATS = ['DEF', 'DMG', 'Delay', 'HP', 'MP', 'STR', 'DEX', 'VIT', 'AGI', 'INT', 'MND', 'CHR'];

/** Lowercase, no spaces/underscores — how field names are matched. */
export const normName = (s) => String(s || '').toLowerCase().replace(/[\s_]+/g, '');

/**
 * Filterable fields for a loaded table: the grid's columns plus the stat
 * values and a few raw fields that have no column of their own.
 * @returns {{ key, label, type: 'number'|'string', names: string[] }[]}
 */
export function fieldsFor(doc, columns) {
  const fields = [];
  const taken = new Set();
  const add = (key, label, type, extra = []) => {
    if (fields.some((f) => f.key === key)) return;
    const names = [];
    for (const n of [label, key, ...(ALIASES[key] || []), ...extra]) {
      const nn = normName(n);
      if (nn && !taken.has(nn)) { taken.add(nn); names.push(nn); }
    }
    fields.push({ key, label, type, names });
  };
  for (const c of columns) add(c.key, c.label, c.num ? 'number' : 'string');
  if (doc?.kind === 'items' && ITEM_LAYOUTS.has(doc.layout)) {
    for (const s of ALL_STATS) add(`stat:${s}`, s, 'number');
    add('description', 'Description', 'string');
    add('logName', 'Log name', 'string');
    add('logPlural', 'Log plural', 'string');
    add('level', 'Level', 'number');
    add('itemLevel', 'Item level', 'number');
    add('stack', 'Stack', 'number');
    add('typeName', 'Type', 'string');
    add('type', 'Type id', 'number', ['typeid']);
    add('flags', 'Flags (mask)', 'number', ['flagsmask']);
    add('jobs', 'Jobs (mask)', 'number', ['jobsmask']);
    add('slots', 'Slots (mask)', 'number', ['slotsmask']);
    add('races', 'Races (mask)', 'number', ['racesmask']);
    add('resourceId', 'Resource id', 'number', ['resource', 'icon']);
    add('idx', 'Block index', 'number');
  }
  if (doc?.kind === 'dmsg') {
    // Sub-string columns are `sub:i`; let their registry names resolve too.
    const names = doc.table?.subs || [];
    names.forEach((n, i) => {
      const f = fields.find((x) => x.key === `sub:${i}`);
      const nn = normName(n);
      if (f && nn && !taken.has(nn)) { taken.add(nn); f.names.push(nn); }
    });
  }
  return fields;
}

export function findField(fields, name) {
  const nn = normName(name);
  if (!nn) return null;
  return fields.find((f) => f.names.includes(nn)) || fields.find((f) => normName(f.key) === nn) || null;
}

export function valueOf(row, key) {
  if (key.startsWith('stat:')) return row.stats?.[key.slice(5)];
  if (key.startsWith('sub:')) return row.subs?.[+key.slice(4)];
  return row[key];
}

const str = (v) => (v == null ? '' : String(v)).toLowerCase();

/** One comparison. Numeric when both sides parse as numbers, else text (case-insensitive). */
export function compare(v, op, target) {
  const empty = v == null || v === '';
  if (op === 'empty') return empty;
  if (op === 'nempty') return !empty;
  const t = target == null ? '' : String(target).trim();
  const nv = typeof v === 'number' ? v : Number(v);
  const nt = Number(t);
  const numeric = !empty && t !== '' && Number.isFinite(nv) && Number.isFinite(nt)
    && (typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(String(v).trim()));
  switch (op) {
    case 'eq': return numeric ? nv === nt : str(v) === t.toLowerCase();
    case 'ne': return numeric ? nv !== nt : str(v) !== t.toLowerCase();
    case 'lt': return numeric ? nv < nt : (!empty && str(v) < t.toLowerCase());
    case 'le': return numeric ? nv <= nt : (!empty && str(v) <= t.toLowerCase());
    case 'gt': return numeric ? nv > nt : (!empty && str(v) > t.toLowerCase());
    case 'ge': return numeric ? nv >= nt : (!empty && str(v) >= t.toLowerCase());
    case 'contains': return str(v).includes(t.toLowerCase());
    case 'ncontains': return !str(v).includes(t.toLowerCase());
    case 'starts': return str(v).startsWith(t.toLowerCase());
    case 'ends': return str(v).endsWith(t.toLowerCase());
    default: return true;
  }
}

// ── rule list ───────────────────────────────────────────────────────────────

/**
 * @param {{ field: string, op: string, value: string }[]} rules  field = field key
 * @param {'and'|'or'} match
 * @returns {{ predicate: (row) => boolean, summary: string, count: number }}
 */
export function compileRules(rules, match, fields) {
  const live = [];
  for (const r of rules) {
    const f = fields.find((x) => x.key === r.field);
    const op = OP_BY_KEY[r.op];
    if (!f || !op) continue;
    if (!op.unary && String(r.value ?? '').trim() === '') continue;
    live.push({ field: f, op, value: r.value });
  }
  if (!live.length) return { predicate: null, summary: '', count: 0 };
  const tests = live.map(({ field, op, value }) => (row) => compare(valueOf(row, field.key), op.key, value));
  const predicate = match === 'or'
    ? (row) => tests.some((t) => t(row))
    : (row) => tests.every((t) => t(row));
  const summary = live
    .map(({ field, op, value }) => (op.unary ? `${field.label} ${op.sym}` : `${field.label} ${op.sym} ${quoteIfNeeded(value)}`))
    .join(match === 'or' ? ' or ' : ' and ');
  return { predicate, summary, count: live.length };
}

function quoteIfNeeded(v) {
  const s = String(v ?? '');
  return /^-?\d+(\.\d+)?$/.test(s) || /^[A-Za-z0-9_.+%-]+$/.test(s) ? s : JSON.stringify(s);
}

// ── query string ────────────────────────────────────────────────────────────

const KEYWORDS = new Set(['and', 'or', 'not', 'contains', 'has', 'like', 'startswith', 'endswith', 'is', 'empty', 'null']);
const SYMBOL_OPS = { '=': 'eq', '==': 'eq', '!=': 'ne', '<>': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };

class QueryError extends Error {
  constructor(msg, pos) { super(msg); this.pos = pos; }
}

function tokenize(text) {
  const toks = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')') { toks.push({ t: 'paren', v: c, pos: i }); i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < n && text[j] !== c) { s += text[j]; j++; }
      if (j >= n) throw new QueryError('unterminated string', i);
      toks.push({ t: 'str', v: s, pos: i });
      i = j + 1;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (SYMBOL_OPS[two]) { toks.push({ t: 'op', v: two, pos: i }); i += 2; continue; }
    if (SYMBOL_OPS[c]) { toks.push({ t: 'op', v: c, pos: i }); i++; continue; }
    const m = /^[^\s()<>=!"']+/.exec(text.slice(i));
    if (!m) throw new QueryError(`unexpected "${c}"`, i);
    const w = m[0];
    const lw = w.toLowerCase();
    toks.push({ t: KEYWORDS.has(lw) ? 'kw' : 'word', v: w, kw: lw, pos: i });
    i += w.length;
  }
  return toks;
}

/**
 * Parse a query string into a predicate.
 *
 *   expr   := and ('or' and)*
 *   and    := not ('and' not)*
 *   not    := 'not' not | '(' expr ')' | cmp
 *   cmp    := field OP value | field ('contains'|'has'|'like'|'startswith'|'endswith') value
 *           | field 'not' 'contains' value | field 'is' ['not'] ('empty'|'null')
 *   value  := number | "string" | bare words up to the next keyword / paren
 *
 * @returns {{ predicate: (row) => boolean, summary: string, count: number }}
 * @throws {QueryError} with `.pos` for the caret
 */
export function parseQuery(text, fields) {
  const toks = tokenize(text);
  let p = 0;
  let count = 0;
  const peek = () => toks[p];
  const isKw = (k) => peek()?.t === 'kw' && peek().kw === k;
  const fail = (msg, tok) => { throw new QueryError(msg, tok?.pos ?? text.length); };

  const parseOr = () => {
    let left = parseAnd();
    while (isKw('or')) { p++; const right = parseAnd(); const l = left; left = (row) => l(row) || right(row); }
    return left;
  };
  const parseAnd = () => {
    let left = parseNot();
    while (isKw('and')) { p++; const right = parseNot(); const l = left; left = (row) => l(row) && right(row); }
    return left;
  };
  const parseNot = () => {
    if (isKw('not')) { p++; const inner = parseNot(); return (row) => !inner(row); }
    if (peek()?.t === 'paren' && peek().v === '(') {
      p++;
      const inner = parseOr();
      if (!(peek()?.t === 'paren' && peek().v === ')')) fail('expected ")"', peek());
      p++;
      return inner;
    }
    return parseCmp();
  };
  const readValue = () => {
    const tok = peek();
    if (!tok) fail('expected a value', tok);
    if (tok.t === 'str') { p++; return tok.v; }
    if (tok.t === 'word') {
      // A number is one token; bare text runs on until the next keyword,
      // operator or paren so `slots = l.ring` and `name = hexed haubert` work.
      if (/^[+-]?\d+(\.\d+)?%?$/.test(tok.v)) { p++; return tok.v; }
      const words = [];
      while (peek()?.t === 'word') { words.push(peek().v); p++; }
      return words.join(' ');
    }
    fail(`expected a value, got "${tok.v}"`, tok);
    return '';
  };
  const parseCmp = () => {
    const ftok = peek();
    if (!ftok || (ftok.t !== 'word' && ftok.t !== 'str')) fail(ftok ? `expected a field name, got "${ftok.v}"` : 'expected a field name', ftok);
    const field = findField(fields, ftok.v);
    if (!field) fail(`unknown field "${ftok.v}"`, ftok);
    p++;
    const otok = peek();
    if (!otok) fail(`expected an operator after "${ftok.v}"`, otok);
    let op = null;
    if (otok.t === 'op') { op = SYMBOL_OPS[otok.v]; p++; }
    else if (otok.t === 'kw') {
      if (['contains', 'has', 'like'].includes(otok.kw)) { op = 'contains'; p++; }
      else if (otok.kw === 'startswith') { op = 'starts'; p++; }
      else if (otok.kw === 'endswith') { op = 'ends'; p++; }
      else if (otok.kw === 'not') {
        p++;
        const nx = peek();
        if (nx?.t === 'kw' && ['contains', 'has', 'like'].includes(nx.kw)) { op = 'ncontains'; p++; }
        else fail('expected "contains" after "not"', nx);
      } else if (otok.kw === 'is') {
        p++;
        let neg = false;
        if (isKw('not')) { neg = true; p++; }
        if (isKw('empty') || isKw('null')) { p++; count++; const k = neg ? 'nempty' : 'empty'; return (row) => compare(valueOf(row, field.key), k, ''); }
        fail('expected "empty" after "is"', peek());
      }
    }
    if (!op) fail(`expected an operator, got "${otok.v}"`, otok);
    const value = readValue();
    count++;
    return (row) => compare(valueOf(row, field.key), op, value);
  };

  if (!toks.length) return { predicate: null, summary: '', count: 0 };
  const predicate = parseOr();
  if (p < toks.length) fail(`unexpected "${toks[p].v}"`, toks[p]);
  return { predicate, summary: text.trim(), count };
}

export { QueryError };
