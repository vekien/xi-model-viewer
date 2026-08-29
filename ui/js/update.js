// Background update check.
//
// On boot the app asks the native backend for the latest GitHub release (Tauri
// IPC or serve.py /fs/app-latest-release — never browser→github.com, which is
// CORS-blocked) and compares its tag against the running build. A newer one
// raises a one-time notice the user dismisses with OK; the dismissed version is
// remembered, so the notice stays gone until the *next* release ships.
//
// Every failure path here resolves to null: the check runs detached from
// startup, and being offline or behind a proxy must never surface as an error
// the user has to deal with.

import { backend } from './backend.js';

const REPO = 'vekien/xi-model-viewer';
export const RELEASES_URL = `https://github.com/${REPO}/releases`;

// The version the user last clicked OK on. Kept out of the settings object —
// like `booted`, it is install state rather than something Settings edits.
const DISMISSED_KEY = 'updateDismissedVersion';

/** `v1.0.8` / ` 1.0.8 ` → `1.0.8`. */
export const normalizeVersion = (v) => String(v ?? '').trim().replace(/^v/i, '');

/**
 * `1.0.8` → `{ nums: [1, 0, 8], suffix: '' }`. Missing minor/patch count as 0,
 * and the release workflow's `1.0.8-rc1` form keeps its suffix for comparison.
 */
function parseVersion(v) {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(.*)$/.exec(normalizeVersion(v));
  if (!m) return null;
  return {
    nums: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)],
    suffix: (m[4] || '').replace(/^[._-]/, '').toLowerCase(),
  };
}

/**
 * -1 / 0 / 1, semver-style. A suffixed build sorts *below* the plain release of
 * the same number (`1.0.8-rc1` < `1.0.8`). Unparseable input compares equal, so
 * a version string we don't understand never claims an update exists.
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (pa.suffix === pb.suffix) return 0;
  if (!pa.suffix) return 1;
  if (!pb.suffix) return -1;
  return pa.suffix < pb.suffix ? -1 : 1;
}

/** The version the user dismissed a notice for, or '' if none. */
export function dismissedVersion() {
  try { return localStorage.getItem(DISMISSED_KEY) || ''; } catch { return ''; }
}

/** Remembers `version` as seen — no notice for it (or anything older) again. */
export function dismissUpdate(version) {
  const v = normalizeVersion(version);
  if (!v) return;
  try { localStorage.setItem(DISMISSED_KEY, v); } catch { /* quota */ }
}

/**
 * Newest release via native backend (Tauri / serve.py). Browser fetch of
 * github.com is blocked by CORS on localhost — never call GitHub from the page.
 */
async function fetchLatestRelease() {
  try {
    const info = await backend.appLatestRelease();
    if (!info?.version && !info?.tag) return null;
    const tag = String(info.tag || info.version || '').trim();
    const version = normalizeVersion(info.version || tag);
    if (!version) return null;
    return {
      version,
      tag: tag || `v${version}`,
      name: info.name || tag || version,
      url: info.url || `https://github.com/${REPO}/releases/tag/${tag || version}`,
      downloadUrl: info.downloadUrl || '',
      downloadName: info.downloadName || '',
      downloadBytes: info.downloadBytes || 0,
      notes: info.notes || '',
      publishedAt: info.publishedAt || '',
    };
  } catch {
    return null;
  }
}

/**
 * Resolves to `{ version, tag, name, url, notes, publishedAt, current }` when a
 * newer release than the running build exists and the user hasn't dismissed it,
 * otherwise null. Never throws.
 */
export async function checkForUpdate() {
  try {
    const current = await backend.appVersion();
    const latest = await fetchLatestRelease();
    if (!latest) return null;
    if (compareVersions(latest.version, current) <= 0) return null;
    // Dismissing 1.0.8 also silences it if that release is later unpublished and
    // the API falls back to an older tag. Guard on the value first: an empty
    // (never dismissed) string compares equal to everything.
    const dismissed = dismissedVersion();
    if (dismissed && compareVersions(latest.version, dismissed) <= 0) return null;
    return { ...latest, current };
  } catch {
    return null;
  }
}

/**
 * File → Check for Updates. Ignores prior dismissals so the panel can reopen.
 * Never throws.
 *
 * @returns {{
 *   upToDate: true, current: string, latest: string
 * } | {
 *   upToDate: false, info: object
 * } | {
 *   error: true, message: string, current?: string
 * }}
 */
export async function checkForUpdateManual() {
  try {
    const current = await backend.appVersion();
    const latest = await fetchLatestRelease();
    if (!latest) {
      return {
        error: true,
        current,
        message: 'Could not reach GitHub for updates (rate limit or offline). Try again in a few minutes, or open Releases in the browser.',
      };
    }
    if (compareVersions(latest.version, current) <= 0) {
      return { upToDate: true, current, latest: latest.version };
    }
    return { upToDate: false, info: { ...latest, current } };
  } catch {
    return {
      error: true,
      message: 'Could not check for updates.',
    };
  }
}
