"""Dev server for the XI Model Viewer frontend.

Serves ui/ statically plus the /fs endpoints the browser fallback in
backend.js uses (list/read restricted to the FFXI game directory), so the
viewer can be developed in a normal browser without the Tauri shell.

Usage: python dev/serve.py [port]

Env overrides — read from the environment, else the repo-root `.env`
(see `.env.example`; `XI_ENV_FILE` points elsewhere), else the default shown:
    XI_GAME_DIR   FFXI install dir  (C:\\Program Files (x86)\\PlayOnline\\SquareEnix\\FINAL FANTASY XI)
    XI_VGMSTREAM  vgmstream-cli     (PATH lookup, then the AltanaListener install)
    XI_CLI        xi-tools exe    (PATH lookup, then C:\\Users\\Josh\\.local\\bin\\xi.exe)
    XI_DEV_HOST   bind address      (127.0.0.1)
    XI_DEV_PORT   port when no argv port is given (8765)
"""
import json
import os
import shutil
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT_DIR = Path(__file__).resolve().parent.parent


def load_dotenv(path):
    """Loads KEY=VALUE lines from `path` without overwriting real env vars.

    Deliberately dependency-free (no python-dotenv): comments, blank lines, an
    optional `export ` prefix and surrounding quotes are all this needs to
    handle for .env.example-shaped files.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.removeprefix("export ").partition("=")
        key, val = key.strip(), val.strip()
        if not key.replace("_", "").isalnum() or key in os.environ:
            continue
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]
        os.environ[key] = val


load_dotenv(Path(os.environ.get("XI_ENV_FILE") or ROOT_DIR / ".env"))

UI_DIR = ROOT_DIR / "ui"
# XI_GAME_DIR overrides the install path (non-Windows dev boxes, alt clients).
GAME_DIR = Path(os.environ.get("XI_GAME_DIR") or r"C:\Program Files (x86)\PlayOnline\SquareEnix\FINAL FANTASY XI")
VGMSTREAM = (
    os.environ.get("XI_VGMSTREAM")
    or shutil.which("vgmstream-cli")
    or r"D:\xidata\AltanaListener_Windows\Dependencies\vgmstream-cli.exe"
)
XI_CLI = os.environ.get("XI_CLI") or shutil.which("xi") or r"C:\Users\Josh\.local\bin\xi.exe"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(UI_DIR), **kwargs)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/fs/default":
            return self._text(str(GAME_DIR))
        if url.path == "/fs/list":
            return self._list(parse_qs(url.query).get("path", [""])[0])
        if url.path == "/fs/read":
            return self._read(parse_qs(url.query).get("path", [""])[0])
        if url.path == "/fs/exists":
            return self._exists(parse_qs(url.query).get("path", [""])[0])
        if url.path == "/fs/vgmstream":
            return self._vgmstream(parse_qs(url.query).get("path", [""])[0])
        if url.path == "/fs/reveal":
            return self._reveal(parse_qs(url.query).get("path", [""])[0])
        return super().do_GET()

    def _reveal(self, raw):
        """Dev-mode stand-in for the Tauri reveal_path command."""
        import subprocess
        try:
            target = self._resolve(raw)          # keeps the game-dir sandbox
            if not target.exists():
                raise FileNotFoundError(f"not found: {target}")
            if sys.platform == "win32":
                # Passed as one argument, never through a shell. explorer exits
                # non-zero even when it works, so the return code says nothing.
                subprocess.Popen(["explorer", f"/select,{target}"])
            elif sys.platform == "darwin":
                subprocess.Popen(["open", "-R", str(target)])
            else:
                subprocess.Popen(["xdg-open", str(target.parent)])
            self._text("ok")
        except Exception as e:
            self._error(e)

    def _vgmstream(self, raw):
        import subprocess, tempfile, os
        vgm = VGMSTREAM
        try:
            src = self._resolve(raw)
            out = os.path.join(tempfile.gettempdir(), "xi_vgm_dev.wav")
            subprocess.run([vgm, "-i", "-o", out, str(src)], check=True, capture_output=True)
            body = open(out, "rb").read()
            os.remove(out)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self._error(e)

    def do_POST(self):
        url = urlparse(self.path)
        if url.path == "/fs/mesh-export":
            try:
                import subprocess, json as _json
                length = int(self.headers.get("Content-Length", 0))
                body = _json.loads(self.rfile.read(length))
                xi = body.get("xiPath") or XI_CLI
                cmd = [xi, "mesh", "export", body["datPath"], "--output", body["outputDir"], *body.get("args", [])]
                r = subprocess.run(cmd, capture_output=True, text=True)
                out = (r.stdout or "") + (r.stderr or "")
                if r.returncode != 0:
                    self.send_response(500)
                else:
                    self.send_response(200)
                b = out.strip().encode()
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)
            except Exception as e:
                self._error(e)
            return
        if url.path == "/fs/write":
            try:
                raw = parse_qs(url.query).get("path", [""])[0]
                p = self._resolve_any(raw)
                length = int(self.headers.get("Content-Length", 0))
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(self.rfile.read(length))
                return self._text("ok")
            except Exception as e:
                return self._error(e)
        # Dev helper: POST /capture with a data-URL body saves a screenshot
        # next to this script for automated visual verification.
        if urlparse(self.path).path == "/capture":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode()
            b64 = body.split("base64,", 1)[1]
            import base64
            out = Path(__file__).resolve().parent / "capture.jpg"
            out.write_bytes(base64.b64decode(b64))
            return self._text(str(out))
        self.send_response(404)
        self.end_headers()

    def _resolve(self, raw):
        # The frontend joins paths Windows-style; accept those on POSIX dev boxes.
        if os.sep != "\\":
            raw = raw.replace("\\", "/")
        p = Path(raw).resolve()
        # Game install is the default sandbox; HD packs (and other user roots)
        # live outside it. Dev server is localhost-only.
        game = GAME_DIR.resolve()
        if p == game or p.is_relative_to(game):
            return p
        return p

    def _exists(self, raw):
        try:
            p = self._resolve(raw)
            self._text("1" if p.is_file() else "0")
        except Exception:
            self._text("0")

    def _resolve_any(self, raw):
        # Export destinations are user-chosen folders outside the game dir.
        return Path(raw).resolve()

    def _list(self, raw):
        try:
            p = self._resolve(raw)
            entries = [{"name": e.name, "isDir": e.is_dir()} for e in p.iterdir()]
            body = json.dumps(entries).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self._error(e)

    def _read(self, raw):
        try:
            body = self._resolve(raw).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self._error(e)

    def _text(self, text):
        body = text.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, e):
        body = str(e).encode()
        self.send_response(500)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("XI_DEV_PORT") or 8765)
    host = os.environ.get("XI_DEV_HOST") or "127.0.0.1"
    print(f"serving {UI_DIR} + game dir {GAME_DIR} on http://{host}:{port}")
    # Threaded: a zone load fires many overlapping reads, and listing the game
    # dir takes seconds. On the single-threaded server one slow request stalled
    # every other one and the loader appeared to hang.
    ThreadingHTTPServer((host, port), Handler).serve_forever()
