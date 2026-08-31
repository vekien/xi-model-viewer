import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Build version for browser dev mode (js/backend.js). The Tauri shell answers
// with its own version instead — that is the one the release workflow stamps.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// envDir '..' so the repo-root .env (see .env.example) is the single source for
// XI_* vars; the '' prefix opts the unprefixed names into loadEnv. process.env
// wins so `XI_FS_PROXY=... npm run dev` still overrides the file.
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, '..', ''), ...process.env };

  return {
    plugins: [react()],
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    base: './',                       // relative asset paths for Tauri embedding
    envDir: '..',
    build: { target: 'esnext' },
    server: {
      port: 5173,        // fixed so tauri.conf.json devUrl stays valid
      strictPort: true,  // fail loudly rather than drift to another port
      proxy: {
        // Browser dev mode: python scripts/serve.py provides the /fs API.
        // XI_FS_PROXY repoints it (remote dev box, alternate port).
        '/fs': env.XI_FS_PROXY || 'http://127.0.0.1:8766',
      },
    },
  };
});
