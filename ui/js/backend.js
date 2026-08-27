// File access backend. In the Tauri app this uses IPC commands; when opened in
// a plain browser it falls back to the dev server's /fs endpoints (dev/serve.py).

const isTauri = () => !!window.__TAURI__;

// Build version, injected by vite from ui/package.json. Only used in browser dev
// mode — the Tauri shell reports its own (release-stamped) version instead.
const BUILD_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';

async function tauriInvoke(cmd, args) {
  return window.__TAURI__.core.invoke(cmd, args);
}

export const backend = {
  async listDir(path) {
    if (isTauri()) return tauriInvoke('list_dir', { path });
    const res = await fetch(`/fs/list?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async readFile(path) {
    if (isTauri()) {
      const data = await tauriInvoke('read_file', { path });
      return data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer;
    }
    const res = await fetch(`/fs/read?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(await res.text());
    return res.arrayBuffer();
  },

  /** True if a file (not directory) exists at path. */
  async fileExists(path) {
    if (isTauri()) return tauriInvoke('file_exists', { path });
    const res = await fetch(`/fs/exists?path=${encodeURIComponent(path)}`);
    if (!res.ok) return false;
    return (await res.text()) === '1';
  },

  /**
   * First existing path among candidates, or the last non-empty candidate
   * (so a subsequent read still surfaces a useful missing-file error).
   */
  async resolvePrefer(candidates) {
    let fallback = '';
    for (const p of candidates) {
      if (!p) continue;
      fallback = p;
      if (await this.fileExists(p)) return p;
    }
    return fallback;
  },

  /** Try each candidate path until a read succeeds. */
  async readPrefer(candidates) {
    let lastErr;
    for (const p of candidates) {
      if (!p) continue;
      try {
        return { path: p, data: await this.readFile(p) };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr ?? new Error('file not found');
  },

  async defaultGamePath() {
    if (isTauri()) return tauriInvoke('default_game_path');
    const res = await fetch('/fs/default');
    return res.text();
  },

  /** Native folder picker. Returns the chosen path, or null (cancelled / browser mode). */
  async pickFolder(initial) {
    if (!isTauri()) return null;
    return tauriInvoke('pick_folder', { initial: initial || null });
  },

  /** Decodes any .bgw/.spw (incl. ATRAC3) to WAV bytes via bundled vgmstream. */
  async decodeVgmstream(path) {
    if (isTauri()) {
      const data = await tauriInvoke('decode_vgmstream', { path });
      return data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer;
    }
    const res = await fetch(`/fs/vgmstream?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(await res.text());
    return res.arrayBuffer();
  },

  /** Runs `xi mesh export DAT --output DIR [args]`. Returns the CLI output text. */
  async xiMeshExport(datPath, outputDir, args, xiPath) {
    if (isTauri()) return tauriInvoke('xi_mesh_export', { datPath, outputDir, args, xiPath: xiPath || null });
    const res = await fetch('/fs/mesh-export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ datPath, outputDir, args, xiPath }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text);
    return text;
  },

  /** Runs `xi <args…>` with the configured xi-tools. Returns stdout/stderr text. */
  async xiRun(args, xiPath) {
    if (isTauri()) {
      return tauriInvoke('xi_run', { args: args || [], xiPath: xiPath || null });
    }
    const res = await fetch('/fs/xi-run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args, xiPath }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text);
    return text;
  },

  /** True if a runnable xi is resolvable from the configured path (or PATH). */
  async xiAvailable(xiPath) {
    if (isTauri()) return tauriInvoke('xi_available', { xiPath: xiPath || null });
    return !!(xiPath && xiPath.trim());   // dev shim can't check; trust the field
  },

  /**
   * Validate xi-tools folder; optionally run uv python install 3.14 + uv sync.
   * @returns {{ ok, status, message, detail, uv?, python?, xiExe?, didSync }}
   */
  async xiSetup(folder, install = true) {
    if (isTauri()) {
      return tauriInvoke('xi_setup', { folder: folder || '', install: !!install });
    }
    // Browser dev: ask serve.py
    const res = await fetch('/fs/xi-setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder, install: !!install }),
    });
    const data = await res.json().catch(async () => ({ ok: false, message: await res.text() }));
    if (!res.ok && data.ok == null) {
      return { ok: false, status: 'error', message: data.message || 'xi setup failed', detail: '', didSync: false };
    }
    return data;
  },

  /** Native file picker (Tauri only). Returns the chosen path or null. */
  async pickFile(initial) {
    if (!isTauri()) return null;
    return tauriInvoke('pick_file', { initial: initial || null });
  },

  /** Writes bytes to a file (creates parent dirs). */
  async writeFile(path, bytes) {
    const arr = Array.from(new Uint8Array(bytes));
    if (isTauri()) return tauriInvoke('write_file', { path, contents: arr });
    const res = await fetch(`/fs/write?path=${encodeURIComponent(path)}`, {
      method: 'POST', body: new Uint8Array(bytes),
    });
    if (!res.ok) throw new Error(await res.text());
  },

  /**
   * Persistent user data folder (`%LOCALAPPDATA%\\XiModelViewer`).
   * Browser dev: `dev/.user-data` under the repo.
   */
  async userDataDir() {
    if (isTauri()) return tauriInvoke('user_data_dir');
    const res = await fetch('/fs/user-data');
    if (!res.ok) throw new Error(await res.text());
    return (await res.text()).trim();
  },

  /** Read a UTF-8 text file; returns null if missing. */
  async readTextFile(path) {
    try {
      const buf = await this.readFile(path);
      const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf);
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
      return null;
    }
  },

  /** Write a UTF-8 text file (creates parents). */
  async writeTextFile(path, text) {
    const bytes = new TextEncoder().encode(text ?? '');
    return this.writeFile(path, bytes);
  },


  /** Lists filenames (not dirs) directly in a directory. Returns [] if missing. */
  async listFiles(path) {
    try {
      const entries = await this.listDir(path);
      return entries.filter((e) => !e.isDir).map((e) => e.name);
    } catch {
      return [];
    }
  },

  /**
   * The running app version ("1.0.8"), for the update check. Browser dev mode
   * has no shell to ask, so the vite-injected build version stands in.
   */
  async appVersion() {
    if (isTauri()) {
      try {
        const v = await tauriInvoke('app_version');
        if (v) return String(v).trim();
      } catch { /* older shell without the command — fall through */ }
    }
    return BUILD_VERSION;
  },

  /** Opens a URL in the system browser. */
  async openUrl(url) {
    if (isTauri()) return tauriInvoke('open_url', { url });
    window.open(url, '_blank', 'noopener,noreferrer');
  },

  /**
   * The command line the app was launched with (argv[0] dropped). Browser dev
   * mode has no argv — the same options arrive as a query string there, which
   * js/launch.js reads directly.
   */
  async launchArgs() {
    if (!isTauri()) return [];
    try {
      const argv = await tauriInvoke('launch_args');
      return Array.isArray(argv) ? argv : [];
    } catch {
      return [];   // older shell without the command — no launch options
    }
  },

  /** Shows a file in the system file manager (Explorer/Finder), selected. */
  async revealPath(path) {
    if (isTauri()) return tauriInvoke('reveal_path', { path });
    const res = await fetch(`/fs/reveal?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(await res.text());
  },
};
