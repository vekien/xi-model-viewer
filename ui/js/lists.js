// One door for `lists/*.json` — the copy baked into this build, or a newer one
// downloaded from xi-tools.
//
// xi-tools authors the lists (`xi mv update`) and publishes them with a manifest
// of sha256s. This app ships a copy of both, and on boot asks the backend to
// replace any list whose contents have moved (src-tauri/src/lists.rs,
// scripts/serve.py). `loadList('characters.json')` is what makes those downloads
// visible: it reads the downloaded copy when there is one and falls back to the
// baked file otherwise.
//
// Panels read their list when they first open, so a file replaced during the
// boot sync is picked up by anything opened afterwards — but not by a panel
// already showing, and not by data already parsed. That is why the notice asks
// for a reload rather than trying to be clever about it.

import { backend } from './backend.js';

/** Names present in the download folder, resolved once per session. */
let downloadedPromise = null;

/** Join a directory and a name with whichever separator the path already uses. */
const join = (dir, name) => `${dir}${dir.includes('\\') ? '\\' : '/'}${name}`;

/**
 * `{ dir, names }` for the download folder — `names` empty when nothing has been
 * downloaded, which is the normal case for a fresh install.
 *
 * One directory listing, not a probe per list: `loadList` is called from a dozen
 * panels and a miss is the common path.
 */
function downloaded() {
  downloadedPromise ??= (async () => {
    try {
      const dir = await backend.listsDir();
      if (!dir) return { dir: '', names: new Set() };
      return { dir, names: new Set(await backend.listFiles(dir)) };
    } catch {
      return { dir: '', names: new Set() };
    }
  })();
  return downloadedPromise;
}

/**
 * Parsed `lists/<name>`, downloaded copy first, baked copy otherwise.
 *
 * Throws like the `fetch` it replaces when the baked list is missing too, so
 * callers that report that keep reporting it. A downloaded file that will not
 * parse falls back rather than failing the panel: downloads are verified by hash
 * before they replace anything, so this is the belt to that braces.
 */
export async function loadList(name) {
  const { dir, names } = await downloaded();
  if (names.has(name)) {
    try {
      const text = await backend.readTextFile(join(dir, name));
      if (text) return JSON.parse(text);
    } catch { /* fall through to the baked copy */ }
  }
  const res = await fetch(`lists/${name}`);
  if (!res.ok) throw new Error(`${res.status} lists/${name}`);
  return res.json();
}

/**
 * `loadList`, but `null` instead of throwing when the list is missing.
 * For the panels that treat an absent list as "nothing to show".
 */
export async function loadListOrNull(name) {
  try {
    return await loadList(name);
  } catch {
    return null;
  }
}

/**
 * Boot sync: replace any list xi-tools has moved on from.
 *
 * Resolves to `{ files, bytes }` worth telling the user about, or null when
 * there was nothing to do — including every failure path, since being offline or
 * behind a proxy must not surface as an error anyone has to deal with. The
 * backend gives the check ten seconds and then gives up quietly.
 *
 * The session's source is pinned *before* the sync runs, so a download landing
 * mid-boot cannot change what this session reads. That is the point: a panel
 * opened at second three and one opened at second thirty then show the same
 * data, and the reload in the notice is what actually switches over. Without
 * the pin, whether you saw the new list depended on how fast you clicked.
 */
export async function updateListsOnBoot() {
  try {
    await downloaded();
    const done = await backend.listsUpdate();
    if (!done?.updated?.length) return null;
    return { files: done.updated, bytes: done.bytes || 0, error: done.error || null };
  } catch {
    return null;
  }
}
