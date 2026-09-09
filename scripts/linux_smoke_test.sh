#!/usr/bin/env bash
# Headless launch check for a Linux build — proves the packaged app reaches a
# working WebView, not merely that the process failed to die.
#
# Usage: scripts/linux_smoke_test.sh <binary|AppImage> [--timeout N] [--screenshot out.png]
#
# The evidence is the data directory. App.jsx calls updateListsOnBoot() on
# mount, which invokes the `lists_update` command, and that creates
# <XI_DATA_DIR>/XiModelViewer before doing anything else. Watching that
# directory appear proves the whole stack in one check: the ELF loaded against
# the distro's libraries, GTK opened a window, WebKit loaded the frontend
# embedded in the binary, React mounted, and an IPC call round-tripped back into
# Rust. "Still running after 10 seconds" proves none of that — a Tauri process
# whose WebView never painted sits there quite happily. And since JS can run
# behind a black screen, the frame it grabs at the end has to actually vary
# before this reports a pass.
#
# Needs Xvfb and xdotool. ImageMagick's `import` is optional and only used for
# --screenshot.
set -uo pipefail

APP=""
TIMEOUT=90
SHOT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --timeout)    TIMEOUT="${2:?--timeout needs a value}"; shift 2 ;;
        --screenshot) SHOT="${2:?--screenshot needs a path}";  shift 2 ;;
        -h|--help)    sed -n '2,17p' "$0"; exit 0 ;;
        -*)           echo "Unknown option: $1" >&2; exit 2 ;;
        *)            APP="$1"; shift ;;
    esac
done

[ -n "$APP" ] || { sed -n '5p' "$0"; exit 2; }
[ -f "$APP" ] || { echo "not found: $APP" >&2; exit 2; }
chmod +x "$APP" 2>/dev/null || true
APP="$(cd -- "$(dirname -- "$APP")" && pwd)/$(basename -- "$APP")"

for tool in Xvfb xdotool; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "ERROR: '$tool' not found. Install xvfb and xdotool." >&2; exit 2; }
done

WORK="$(mktemp -d)"
APP_PID=""
XVFB_PID=""

cleanup() {
    [ -n "$APP_PID" ]  && kill -TERM "$APP_PID"  2>/dev/null
    [ -n "$XVFB_PID" ] && kill -TERM "$XVFB_PID" 2>/dev/null
    # WebKit forks a network and a web process per view; they outlive a TERM to
    # the parent and would keep the container's PID 1 waiting on them.
    if command -v pkill >/dev/null 2>&1; then
        pkill -TERM -f WebKitNetworkProcess 2>/dev/null
        pkill -TERM -f WebKitWebProcess     2>/dev/null
    fi
    sleep 1
    [ -n "$APP_PID" ] && kill -KILL "$APP_PID" 2>/dev/null
    # XDG_RUNTIME_DIR picks up portal mounts that root cannot unlink; the dir is
    # under mktemp anyway, so a failure here is noise, not a leak.
    rm -rf "$WORK" 2>/dev/null
    return 0
}
trap cleanup EXIT

# A throwaway HOME as well as a throwaway XI_DATA_DIR: the WebView keeps its
# profile (every setting and saved scene) under XDG_DATA_HOME, and a smoke test
# must not read or write the running user's.
export HOME="$WORK/home"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_CACHE_HOME="$HOME/.cache"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_RUNTIME_DIR="$WORK/run"
export XI_DATA_DIR="$WORK/data"
export XI_CACHE_DIR="$WORK/cache"
mkdir -p "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$XDG_RUNTIME_DIR" \
         "$XI_DATA_DIR" "$XI_CACHE_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
MARKER="$XI_DATA_DIR/XiModelViewer"

# There is no GPU here. Left to itself WebKit 2.42+ tries the DMABUF renderer,
# finds no device, and renders nothing at all while the window still maps — the
# exact failure this test exists to catch, arriving as a false pass.
export GDK_BACKEND=x11
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
# Type-2 AppImages mount themselves with FUSE, which containers and minimal
# runners do not have. This asks the runtime to unpack to a temp dir instead.
export APPIMAGE_EXTRACT_AND_RUN=1

# Pick a free display rather than assuming :99 is idle.
DISP=99
while [ -e "/tmp/.X11-unix/X$DISP" ] && [ "$DISP" -lt 128 ]; do DISP=$((DISP + 1)); done
export DISPLAY=":$DISP"

Xvfb "$DISPLAY" -screen 0 1600x1000x24 -nolisten tcp >"$WORK/xvfb.log" 2>&1 &
XVFB_PID=$!
for _ in $(seq 1 100); do
    xdotool getdisplaygeometry >/dev/null 2>&1 && break
    sleep 0.1
done
if ! xdotool getdisplaygeometry >/dev/null 2>&1; then
    echo "ERROR: Xvfb never came up on $DISPLAY" >&2
    sed -n '1,20p' "$WORK/xvfb.log" >&2
    exit 1
fi

# GTK and WebKit both want a session bus. Without one they still start, but each
# emits pages of warnings that bury whatever the real failure was.
if command -v dbus-daemon >/dev/null 2>&1; then
    if addr="$(dbus-daemon --session --fork --print-address 2>/dev/null)"; then
        export DBUS_SESSION_BUS_ADDRESS="$addr"
    fi
fi

# Always grab a frame, whether or not one was asked to be kept: it is the
# evidence on the way out of a failure, and the paint check below reads it on
# the way out of a success. A blank window and a window that never appeared look
# identical in a log and nothing alike in a picture.
capture() {
    command -v import >/dev/null 2>&1 || {
        echo "  screenshot: skipped (ImageMagick's 'import' not installed)" >&2; return 0; }
    import -window root -display "$DISPLAY" "$WORK/frame.png" 2>/dev/null || {
        echo "  screenshot: import failed" >&2; return 0; }
    [ -n "$SHOT" ] || return 0
    mkdir -p "$(dirname "$SHOT")" && cp "$WORK/frame.png" "$SHOT" \
        && echo "  screenshot: $SHOT"
}

# The last way to pass while being broken. A window that maps and a frontend
# that reaches the backend still leaves WebKit free to paint nothing at all, and
# the app then sits there looking perfectly healthy: this is not hypothetical,
# the AppImage did exactly that on a container without libGLESv2, running JS and
# IPC the whole time behind a black screen. So grade the frame rather than
# merely filing it. A real render of this UI scores about 0.06; a flat image
# scores 0, and ImageMagick reports a uniform non-black one as "-nan", which the
# filter below folds into the same answer.
BLANK_FLOOR=0.01
painted() {
    [ -s "$WORK/frame.png" ] || return 0          # no frame, nothing to claim
    command -v convert >/dev/null 2>&1 || return 0
    sd="$(convert "$WORK/frame.png" -colorspace Gray \
          -format '%[fx:standard_deviation]' info: 2>/dev/null)"
    case "$sd" in ''|*[!0-9.eE+-]*) sd=0 ;; esac
    if awk -v v="$sd" -v f="$BLANK_FLOOR" 'BEGIN { exit !(v + 0 >= f) }'; then
        echo "  painted:  yes (frame varies, sigma $sd)"
        return 0
    fi
    echo "FAIL: the window opened and the frontend ran, but nothing was painted." >&2
    echo "  The frame is flat (sigma $sd). WebKit came up and rendered nothing —" >&2
    echo "  usually a missing GL library. Check the output below." >&2
    return 1
}

echo "Launching $(basename "$APP") on $DISPLAY (timeout ${TIMEOUT}s)"
"$APP" >"$WORK/app.log" 2>&1 &
APP_PID=$!

win=""
booted=0
deadline=$(( $(date +%s) + TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! kill -0 "$APP_PID" 2>/dev/null; then
        wait "$APP_PID"; code=$?
        echo "FAIL: the app exited after $code before it finished booting." >&2
        capture
        echo "--- output ---" >&2; tail -n 40 "$WORK/app.log" >&2
        exit 1
    fi
    [ -n "$win" ] || win="$(xdotool search --name '^XI Model Viewer$' 2>/dev/null | head -n 1)"
    if [ -n "$win" ] && [ -d "$MARKER" ]; then booted=1; break; fi
    sleep 1
done

if [ "$booted" -ne 1 ]; then
    echo "FAIL: gave up after ${TIMEOUT}s." >&2
    [ -n "$win" ] && echo "  window:   yes ($win)" >&2 || echo "  window:   never appeared" >&2
    [ -d "$MARKER" ] && echo "  frontend: reached the backend" >&2 \
                     || echo "  frontend: never called into the backend ($MARKER absent)" >&2
    capture
    echo "--- output ---" >&2; tail -n 40 "$WORK/app.log" >&2
    exit 1
fi

# Give it a moment past first paint so the screenshot shows the UI rather than a
# grey window, and so a crash on the very next frame is still caught below.
sleep 5
if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "FAIL: the app died moments after opening its window." >&2
    capture
    echo "--- output ---" >&2; tail -n 40 "$WORK/app.log" >&2
    exit 1
fi

geom="$(xdotool getwindowgeometry "$win" 2>/dev/null | tr '\n' ' ' | tr -s ' ')"
echo "  window:   $win — $geom"
echo "  frontend: created $MARKER ($(ls -A "$MARKER" | wc -l) entries)"
capture

if ! painted; then
    echo "--- output ---" >&2; tail -n 40 "$WORK/app.log" >&2
    exit 1
fi

echo "PASS"
if [ -s "$WORK/app.log" ]; then
    echo "--- output ---"
    tail -n 20 "$WORK/app.log"
fi
exit 0
