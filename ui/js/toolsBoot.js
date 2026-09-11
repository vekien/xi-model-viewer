// Ensure xi-tools is present / up to date (same policy as xi-zone-editor).
// Runs in the background on boot; Settings can call the same helpers manually.

import { backend } from './backend.js';

function isTauri() {
  return !!window.__TAURI__;
}

/**
 * @returns {Promise<{
 *   installed: boolean,
 *   localVersion: string,
 *   latestVersion: string|null,
 *   updateAvailable: boolean,
 *   toolsDir: string,
 *   usingLocalOverride: boolean,
 *   error?: string|null,
 * }|null>}
 */
export async function toolsStatus() {
  if (!isTauri()) {
    return {
      installed: true,
      localVersion: 'dev',
      latestVersion: null,
      updateAvailable: false,
      toolsDir: '',
      usingLocalOverride: false,
      error: null,
    };
  }
  return backend.toolsStatus();
}

export async function toolsInstallOrUpdate() {
  if (!isTauri()) throw new Error('Install only available in the desktop app');
  return backend.toolsInstallOrUpdate();
}

/**
 * Boot (once): disk status first. Network only when self-managed needs an
 * install or a deliberate latest-release compare — never on every Settings open.
 *
 * @param {{ xiPath?: string }} opts
 * @returns {Promise<{ status: object|null, changed: boolean, message: string }>}
 */
export async function ensureXiToolsOnBoot(opts = {}) {
  if (!isTauri()) {
    return { status: null, changed: false, message: '' };
  }
  try {
    let st = await toolsStatus(); // disk only
    const xiPath = (opts.xiPath || '').trim();
    const managed = (st.toolsDir || '').replace(/\\/g, '/').toLowerCase();
    const custom = xiPath.replace(/\\/g, '/').toLowerCase();
    const customIsManaged = custom && managed && (custom === managed || custom.startsWith(`${managed}/`));

    // Custom install — never download over it.
    if (st.usingLocalOverride) {
      return {
        status: st,
        changed: false,
        message: st.installed
          ? `xi-tools custom (${st.toolsDir})`
          : 'xi-tools custom path set',
      };
    }

    // Legacy: xiPath points at a working checkout that is not the managed dir.
    if (xiPath && !customIsManaged) {
      const ok = await backend.xiAvailable(xiPath);
      if (ok) {
        return { status: st, changed: false, message: `xi-tools ready (${xiPath})` };
      }
    }

    // Self-managed: missing → install. Present → one GitHub check, update if newer.
    if (!st.installed) {
      st = await toolsInstallOrUpdate();
      try { await backend.xiSetup(st.toolsDir, true); } catch { /* Settings can retry */ }
      return {
        status: st,
        changed: true,
        message: st.installed
          ? `xi-tools ${st.localVersion} installed`
          : (st.error || 'xi-tools install incomplete'),
      };
    }

    try {
      st = await backend.toolsCheckUpdates();
    } catch {
      return { status: st, changed: false, message: `xi-tools ${st.localVersion}` };
    }
    if (st.updateAvailable) {
      st = await toolsInstallOrUpdate();
      try { await backend.xiSetup(st.toolsDir, true); } catch { /* */ }
      return {
        status: st,
        changed: true,
        message: st.installed
          ? `xi-tools ${st.localVersion} updated`
          : (st.error || 'xi-tools update incomplete'),
      };
    }

    return {
      status: st,
      changed: false,
      message: st.installed ? `xi-tools ${st.localVersion}` : '',
    };
  } catch (e) {
    return {
      status: null,
      changed: false,
      message: e?.message || String(e),
    };
  }
}

/**
 * One line of `tools-progress` detail: bytes for a download, files for an
 * extract, whatever the payload carried otherwise.
 */
export function formatProgressDetail(p) {
  const unit = p.unit || 'bytes';
  const loaded = Number(p.loaded) || 0;
  const total = p.total == null ? null : Number(p.total);
  const pct = Number(p.pct);
  if (unit === 'bytes' && (loaded > 0 || total > 0)) {
    if (total > 0) return `${fmtBytes(loaded)} / ${fmtBytes(total)}  ·  ${Math.round(pct)}%`;
    return `${fmtBytes(loaded)} downloaded`;
  }
  if (unit === 'files' && total > 0) {
    return `${loaded} / ${total} files  ·  ${Math.round(pct)}%`;
  }
  if (p.detail) return p.detail;
  return Number.isFinite(pct) && pct > 0 ? `${Math.round(pct)}%` : '';
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
