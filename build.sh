#!/usr/bin/env bash
# XI Model Viewer - production build (embeds the Vite frontend into the binary).
# Unix counterpart of Build.bat.
# Do NOT use plain `cargo build` — that leaves the app pointed at localhost:5173.
#
# Usage: ./build.sh [--bundle] [--no-reveal]
#   --bundle      also produce a platform installer (.dmg / .AppImage / .deb).
#                 Requires "bundle.active": true in src-tauri/tauri.conf.json.
#   --no-reveal   skip opening the output folder when the build finishes.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RELDIR="$ROOT/src-tauri/target/release"
BIN="$RELDIR/xi-model-viewer"

BUNDLE=0
REVEAL=1
for arg in "$@"; do
    case "$arg" in
        --bundle)     BUNDLE=1 ;;
        --no-reveal)  REVEAL=0 ;;
        -h|--help)    sed -n '2,10p' "${BASH_SOURCE[0]}"; exit 0 ;;
        *) echo "Unknown option: $arg" >&2; exit 2 ;;
    esac
done

cd "$ROOT"

# Load .env (see .env.example). Existing environment variables win, so a one-off
# `XI_GAME_DIR=... ./build.sh` still overrides the file.
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
    echo "Build failed." >&2
    echo "Make sure Node.js and the Rust toolchain are installed." >&2
    case "$(uname -s)" in
        Darwin) echo "macOS also needs the Xcode command line tools: xcode-select --install" >&2 ;;
        Linux)  echo "Linux also needs the Tauri system deps (webkit2gtk 4.1, libsoup3," >&2
                echo "librsvg2, libappindicator3, patchelf) — see https://v2.tauri.app/start/prerequisites/" >&2 ;;
    esac
    exit 1
}
trap fail ERR

# ---------------------------------------------------------------------------
# Toolchain checks. Windows needs RC.EXE for icon resources; unix needs a C
# toolchain + (on Linux) the webkit2gtk stack that tauri links against.
# ---------------------------------------------------------------------------
for tool in cargo npm; do
    command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: '$tool' not found on PATH." >&2; fail; }
done

if [ "$(uname -s)" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then
    echo "ERROR: Xcode command line tools missing. Run: xcode-select --install" >&2
    fail
fi

if [ "$(uname -s)" = "Linux" ] && command -v pkg-config >/dev/null 2>&1; then
    pkg-config --exists webkit2gtk-4.1 || \
        echo "WARNING: webkit2gtk-4.1 not found via pkg-config; the link step may fail." >&2
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
echo "Building XI Model Viewer release (Vite + Tauri)..."
echo
# `tauri build` runs beforeBuildCommand (npm run build), embeds ui/dist, and
# produces a standalone binary that does not need a local dev server.
if [ "$BUNDLE" -eq 1 ]; then
    cargo tauri build
else
    cargo tauri build --no-bundle
fi

# Keep vgmstream next to the binary (dev fast-path; it's also embedded in the
# binary). The shipped vgmstream build is Windows-only — on unix the app falls
# back to a `vgmstream-cli` found on PATH (brew install vgmstream), so only copy
# the folder if it exists.
if [ ! -e "$RELDIR/vgmstream" ] && [ -d "$ROOT/src-tauri/vgmstream" ]; then
    cp -R "$ROOT/src-tauri/vgmstream" "$RELDIR/vgmstream"
fi

trap - ERR
echo
echo "Build complete: $BIN"

if [ "$REVEAL" -eq 1 ] && [ -t 1 ]; then
    case "$(uname -s)" in
        Darwin) open -R "$BIN" >/dev/null 2>&1 || true ;;
        Linux)  command -v xdg-open >/dev/null 2>&1 && xdg-open "$RELDIR" >/dev/null 2>&1 || true ;;
    esac
fi
