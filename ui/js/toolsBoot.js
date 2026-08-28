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
 * Boot: check GitHub; auto-install or update when not on a local checkout override.
 * Skips network work when the user already has a working custom xiPath that isn't
 * the managed AppData install (keeps D:\xi-tools etc. alone).
 *
 * @param {{ xiPath?: string }} opts
 * @returns {Promise<{ status: object|null, changed: boolean, message: string }>}
 */
export async function ensureXiToolsOnBoot(opts = {}) {
  if (!isTauri()) {
    return { status: null, changed: false, message: '' };
  }
  try {
    let st = await toolsStatus();
    const xiPath = (opts.xiPath || '').trim();
    const managed = (st.toolsDir || '').replace(/\\/g, '/').toLowerCase();
    const custom = xiPath.replace(/\\/g, '/').toLowerCase();
    const customIsManaged = custom && managed && (custom === managed || custom.startsWith(`${managed}/`));

    // Local checkout override — never auto-overwrite.
    if (st.usingLocalOverride && st.installed) {
      return { status: st, changed: false, message: `xi-tools ${st.localVersion} (local)` };
    }

    // User pointed at a custom folder that works — leave it; still report status.
    if (xiPath && !customIsManaged) {
      const ok = await backend.xiAvailable(xiPath);
      if (ok) {
        return { status: st, changed: false, message: `xi-tools ready (${xiPath})` };
      }
    }

    if (!st.installed || st.updateAvailable) {
      st = await toolsInstallOrUpdate();
      // uv venv so `xi` is runnable
      try {
        await backend.xiSetup(st.toolsDir, true);
      } catch { /* setup can be retried from Settings */ }
      return {
        status: st,
        changed: true,
        message: st.installed
          ? `xi-tools ${st.localVersion} installed`
          : (st.error || 'xi-tools install incomplete'),
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
