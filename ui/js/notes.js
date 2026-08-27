// User notes for Data Struct inspect windows (UiMenu rows, etc.).
// Stored at %LOCALAPPDATA%\XiModelViewer\notes.json (Tauri) — editable, portable.
// Browser dev falls back to the same shape under dev/.user-data/notes.json,
// with a localStorage mirror so notes still work if the file is unavailable.

import { backend } from './backend.js';
import { normRel, relFromAbs } from './gamePath.js';

const LS_KEY = 'xiNotesV1';
const FILE_NAME = 'notes.json';

let cache = null;       // { version, notes: { [key]: string } }
let filePath = null;    // absolute path once resolved
let loadPromise = null;

function emptyDoc() {
  return { version: 1, notes: {} };
}

function fromStorage() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (raw && raw.notes && typeof raw.notes === 'object') return raw;
  } catch { /* ignore */ }
  return emptyDoc();
}

function toStorage(doc) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(doc)); } catch { /* quota */ }
}

/** Build a stable note key from path segments (filters empties). */
export function noteKey(...parts) {
  return parts
    .map((p) => (p == null ? '' : String(p).trim()))
    .filter(Boolean)
    .join(':');
}

/**
 * Whole-DAT notepad key. Uses game-relative path when under game/hd/pivot
 * so the same ROM\119\50.DAT shares notes across roots.
 * @param {string} path absolute or relative DAT path
 * @param {object} [settings] viewer settings (gamePath / hdPath / pivotPath)
 */
export function datFileKey(path, settings) {
  if (!path) return '';
  let rel = relFromAbs(path, settings);
  if (!rel || rel === path) {
    // still absolute outside roots — keep a stable tail if it looks like ROM\…
    const m = String(path).replace(/\//g, '\\').match(/(?:^|\\)((?:ROM\d*|sound\d*|maps)\\.+)$/i);
    rel = m ? m[1] : path;
  }
  return noteKey('dat', normRel(rel).toLowerCase());
}

/** UiMenu section key — path-independent (tag + bare name). */
export function uiMenuSectionKey(menu) {
  const tag = (menu?.id || '').trim() || '';
  const bare = (menu?.bareName || menu?.name || '').replace(/\s+/g, '') || '';
  return noteKey('uimenu', tag || bare, bare || tag);
}

/** UiElementGroup notepad key — section tag + set label. */
export function uiEgSectionKey(group) {
  const tag = (group?.id || '').trim() || '';
  const label = (group?.setLabel || group?.bareName || '').replace(/\s+/g, '') || '';
  return noteKey('uieg', tag || label, label || tag);
}

export function uiMenuRowKey(menu, row) {
  const base = uiMenuSectionKey(menu);
  if (!row) return base;
  if (row.elemIndex == null && row.role === 'frame') return noteKey(base, 'frame');
  if (row.elemIndex != null) return noteKey(base, 'elem', String(row.elemIndex));
  if (row.buttonId != null) return noteKey(base, 'btn', String(row.buttonId));
  return noteKey(base, row.role || 'row');
}

/** Absolute path to notes.json once resolved (may be null in pure browser). */
export function notesFilePath() {
  return filePath;
}

export async function loadNotes() {
  if (cache) return cache;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const doc = emptyDoc();
    const ls = fromStorage();
    Object.assign(doc.notes, ls.notes || {});

    try {
      const dir = await backend.userDataDir();
      if (dir) {
        const sep = dir.includes('\\') ? '\\' : '/';
        filePath = `${dir.replace(/[\\/]+$/, '')}${sep}${FILE_NAME}`;
        const text = await backend.readTextFile(filePath);
        if (text) {
          const file = JSON.parse(text);
          if (file?.notes && typeof file.notes === 'object') {
            // File wins over localStorage for the same key.
            Object.assign(doc.notes, file.notes);
          }
        }
      }
    } catch {
      /* keep LS */
    }

    cache = doc;
    toStorage(doc);
    return doc;
  })();
  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

export function getNote(key) {
  if (!key || !cache) return '';
  return cache.notes[key] || '';
}

export async function setNote(key, text) {
  if (!key) return;
  const doc = await loadNotes();
  const v = (text ?? '').trim();
  if (v) doc.notes[key] = v;
  else delete doc.notes[key];
  cache = doc;
  toStorage(doc);
  await persistFile(doc);
  notifyNotesChanged();
}

export async function setNotes(entries) {
  const doc = await loadNotes();
  for (const [key, text] of Object.entries(entries || {})) {
    if (!key) continue;
    const v = (text ?? '').trim();
    if (v) doc.notes[key] = v;
    else delete doc.notes[key];
  }
  cache = doc;
  toStorage(doc);
  await persistFile(doc);
  notifyNotesChanged();
}

function notifyNotesChanged() {
  try {
    window.dispatchEvent(new CustomEvent('xi-notes-changed'));
  } catch { /* ignore */ }
}

async function persistFile(doc) {
  try {
    if (!filePath) {
      const dir = await backend.userDataDir();
      if (!dir) return;
      const sep = dir.includes('\\') ? '\\' : '/';
      filePath = `${dir.replace(/[\\/]+$/, '')}${sep}${FILE_NAME}`;
    }
    const body = `${JSON.stringify(doc, null, 2)}\n`;
    await backend.writeTextFile(filePath, body);
  } catch (e) {
    console.warn('notes: could not write file', e);
  }
}

/** Reveal notes.json in Explorer (creates empty file if missing). */
export async function revealNotesFile() {
  await loadNotes();
  if (!filePath) throw new Error('User data folder unavailable');
  const text = await backend.readTextFile(filePath);
  if (text == null) {
    await backend.writeTextFile(filePath, `${JSON.stringify(emptyDoc(), null, 2)}\n`);
  }
  await backend.revealPath(filePath);
}
