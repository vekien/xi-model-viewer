#!/usr/bin/env bash
# XI Model Viewer - DEV / watch mode. Unix counterpart of Start.bat.
#   Runs the app against the Vite dev server: frontend edits hot-reload
#   instantly, and Rust edits trigger an automatic rebuild + restart.
#   For a standalone release binary instead, use ./build.sh.
#
# Usage: ./start.sh [extra args passed through to `cargo tauri dev`]
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Load .env (see .env.example). Existing environment variables win, so a one-off
# `XI_GAME_DIR=... ./start.sh` still overrides the file.
load_env_file() {
    local file="$1" line key val
    [ -f "$file" ] || return 0
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in ''|'#'*) continue ;; *=*) ;; *) continue ;; esac
        line="${line#export }"
        key="${line%%=*}"; val="${line#*=}"
        key="${key%"${key##*[![:space:]]}"}"          # trim trailing space
        case "$key" in ''|*[!A-Za-z_]*[!A-Za-z0-9_]*|[0-9]*) continue ;; esac
        case "$val" in
            \"*\") val="${val#\"}"; val="${val%\"}" ;;
            \'*\') val="${val#\'}"; val="${val%\'}" ;;
        esac
        [ -n "${!key+x}" ] && continue                # real env wins
        export "$key=$val"
    done < "$file"
}
load_env_file "$ROOT/.env"

fail() {
    echo
    echo "Setup failed. Make sure Node.js and the Rust toolchain are installed." >&2
    case "$(uname -s)" in
        Darwin) echo "macOS also needs the Xcode command line tools: xcode-select --install" >&2 ;;
        Linux)  echo "Linux also needs the Tauri system deps (webkit2gtk 4.1, libsoup3," >&2
                echo "librsvg2, libappindicator3) — see https://v2.tauri.app/start/prerequisites/" >&2 ;;
    esac
    exit 1
}
trap fail ERR

for tool in cargo npm; do
    command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: '$tool' not found on PATH." >&2; fail; }
done

if [ "$(uname -s)" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then
    echo "ERROR: Xcode command line tools missing. Run: xcode-select --install" >&2
    fail
fi

# First-run frontend dependencies.
if [ ! -d "$ROOT/ui/node_modules" ]; then
    echo "Installing frontend dependencies (one-time)..."
    (cd "$ROOT/ui" && npm install)
fi

# Ensure the Tauri CLI is available (one-time install).
if ! cargo tauri --version >/dev/null 2>&1; then
    echo "Installing Tauri CLI (one-time, a few minutes)..."
    cargo install tauri-cli --version "^2" --locked
fi

echo
echo "Starting XI Model Viewer in dev mode - hot reload enabled."
echo "Close the app window (or press Ctrl+C here) to stop."
echo
trap - ERR
# beforeDevCommand ("cd ../ui && npm run dev") runs with src-tauri as its cwd.
exec cargo tauri dev "$@"
