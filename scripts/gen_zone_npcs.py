"""Bake ui/public/lists/zone_npcs.json from the CatsEyeXI server's npc_list.

Reads the server's SQL dump (no database needed) and writes one compact row per
NPC, grouped by zone id, plus the model-id -> DAT map the viewer needs to draw
the "standard" (non-equipped) looks. Equipped looks (size 1: race + gear model
ids) are resolved in the viewer against lists/characters.json.

Usage: python scripts/gen_zone_npcs.py [--sql PATH] [--game-dir DIR] [--out FILE]

Env overrides — read from the environment, else the repo-root `.env`:
    XI_GAME_DIR   FFXI install dir (FTABLE/VTABLE, to map file ids -> ROM paths)
    CEXI_DIR      catseyexi checkout (default D:\\cexi-server\\catseyexi)

Row layout (see `fields` in the output):
    [npcid, name, x, y, z, rot, status, flags, look]
    x/y/z   server (= DAT) game space: Y down, X east, Z north
    rot     u8 heading, 256 = full turn
    status  STATUS_TYPE: 0 NORMAL / 1 UPDATE are visible, 2 DISAPPEAR hidden
    flags   entityFlags (ENTITYFLAGS: 0x80 = hide model)
    look    40 hex chars of look_t: u16 size, then face/race or u16 modelid,
            then u16 head, body, hands, legs, feet, main, sub, ranged
            (each (slot<<12) | model id)
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR / "scripts"))
from serve import load_dotenv  # noqa: E402  (dependency-free .env reader)

load_dotenv(Path(os.environ.get("XI_ENV_FILE") or ROOT_DIR / ".env"))

DEFAULT_GAME_DIR = r"C:\Program Files (x86)\PlayOnline\SquareEnix\FINAL FANTASY XI"
DEFAULT_CEXI_DIR = r"D:\cexi-server\catseyexi"

# NPC/monster model id -> file id, the client's NpcTable.getNpcModelIndex
# (FFXiMain.dll), as ported by cexi-tools `model_file_id`.
def model_file_id(model_id: int) -> int:
    if model_id < 1500:
        return model_id + 1300
    if model_id < 3000:
        return model_id + 50295
    if model_id < 3193:
        return model_id + 96907
    return model_id + 98546


def load_file_tables(game_dir: Path) -> dict[int, str]:
    """file id -> 'ROM\\dir\\file.DAT' across FTABLE/VTABLE pairs (ROM1-10).

    Lowest table wins, the way the viewer's loadMergedTables resolves them.
    """
    by_fid: dict[int, str] = {}
    for rom in range(1, 11):
        ft_path = game_dir / ("FTABLE.DAT" if rom == 1 else f"ROM{rom}/FTABLE{rom}.DAT")
        vt_path = game_dir / ("VTABLE.DAT" if rom == 1 else f"ROM{rom}/VTABLE{rom}.DAT")
        try:
            ft = ft_path.read_bytes()
            vt = vt_path.read_bytes()
        except OSError:
            continue
        n = min(len(ft) // 2, len(vt))
        root = "ROM" if rom == 1 else f"ROM{rom}"
        for fid in range(n):
            r = vt[fid]
            if r == 0 or fid in by_fid:
                continue
            v = ft[fid * 2] | (ft[fid * 2 + 1] << 8)
            by_fid[fid] = f"{root}\\{v >> 7}\\{v & 0x7F}.DAT"
    return by_fid


def parse_values(text: str) -> list:
    """One `(...)` tuple of a MySQL INSERT: strings, 0xHEX blobs, NULL, numbers."""
    out = []
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c in " ,":
            i += 1
            continue
        if c == "'":
            i += 1
            buf = []
            while i < n and text[i] != "'":
                if text[i] == "\\" and i + 1 < n:
                    buf.append(text[i + 1])
                    i += 2
                else:
                    buf.append(text[i])
                    i += 1
            i += 1
            out.append("".join(buf))
        elif text.startswith("0x", i) or text.startswith("0X", i):
            j = i + 2
            while j < n and text[j] in "0123456789abcdefABCDEF":
                j += 1
            hx = text[i + 2:j]
            out.append(bytes.fromhex(("0" + hx) if len(hx) % 2 else hx))
            i = j
        elif text.startswith("NULL", i):
            out.append(None)
            i += 4
        else:
            j = i
            while j < n and text[j] not in ",":
                j += 1
            tok = text[i:j].strip()
            out.append(float(tok) if "." in tok else int(tok))
            i = j
    return out


# Some rows carry a trailing `-- comment` (the BCNM an Armoury Crate belongs to).
INSERT_RE = re.compile(r"^INSERT INTO `npc_list` VALUES \((.*)\);\s*(?:--.*)?$")
ZONE_RE = re.compile(r"^INSERT INTO `zone_settings` VALUES \((\d+),\d+,'[^']*',\d+,'([^']*)'")


def display_name(name, polutils) -> str:
    if isinstance(polutils, str) and polutils.strip():
        return polutils.strip()
    if isinstance(name, bytes):
        # A handful of rows store the internal name as a raw byte (ships).
        try:
            s = name.decode("ascii")
        except UnicodeDecodeError:
            return ""
        return s if s.isprintable() else ""
    return (name or "").replace("_", " ").strip()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--sql", help="npc_list.sql (default $CEXI_DIR/sql/npc_list.sql)")
    ap.add_argument("--zones", help="zone_settings.sql (default next to npc_list.sql)")
    ap.add_argument("--game-dir", help="FFXI install dir (default $XI_GAME_DIR)")
    ap.add_argument("--out", help="output JSON (default ui/public/lists/zone_npcs.json)")
    args = ap.parse_args()

    cexi = Path(os.environ.get("CEXI_DIR") or DEFAULT_CEXI_DIR)
    sql_path = Path(args.sql) if args.sql else cexi / "sql" / "npc_list.sql"
    zones_path = Path(args.zones) if args.zones else sql_path.parent / "zone_settings.sql"
    game_dir = Path(args.game_dir or os.environ.get("XI_GAME_DIR") or DEFAULT_GAME_DIR)
    out_path = Path(args.out) if args.out else ROOT_DIR / "ui" / "public" / "lists" / "zone_npcs.json"

    if not sql_path.is_file():
        print(f"npc_list.sql not found: {sql_path}", file=sys.stderr)
        return 1

    file_tables = load_file_tables(game_dir)
    if not file_tables:
        print(f"warning: no FTABLE/VTABLE under {game_dir}; model DAT paths left null", file=sys.stderr)

    zone_names: dict[int, str] = {}
    if zones_path.is_file():
        for line in zones_path.read_text(encoding="utf-8", errors="replace").splitlines():
            m = ZONE_RE.match(line)
            if m:
                zone_names[int(m.group(1))] = m.group(2).replace("_", " ")

    zones: dict[int, list] = {}
    model_ids: set[int] = set()
    rows = 0
    skipped = 0
    for line in sql_path.read_text(encoding="utf-8", errors="replace").splitlines():
        m = INSERT_RE.match(line)
        if not m:
            continue
        v = parse_values(m.group(1))
        if len(v) != 19:
            skipped += 1
            continue
        (npcid, name, polutils, rot, x, y, z, _flag, _speed, _speedsub, _anim, _animsub,
         _namevis, status, entity_flags, look, _prefix, _content, _widescan) = v
        if not isinstance(look, bytes) or len(look) != 20:
            skipped += 1
            continue
        zone_id = (npcid >> 12) & 0xFFF
        look_hex = look.hex()
        if look[0] == 0 and look[1] == 0:
            model_ids.add(look[2] | (look[3] << 8))
        zones.setdefault(zone_id, []).append([
            npcid, display_name(name, polutils),
            round(float(x), 3), round(float(y), 3), round(float(z), 3),
            int(rot), int(status), int(entity_flags), look_hex,
        ])
        rows += 1

    models = {}
    for mid in sorted(model_ids):
        fid = model_file_id(mid)
        models[str(mid)] = {"fileId": fid, "dat": file_tables.get(fid)}
    unresolved = sum(1 for m in models.values() if m["dat"] is None)

    doc = {
        "schema": "xi-model-viewer zone_npcs v1",
        "source": "catseyexi npc_list.sql",
        "fields": ["npcid", "name", "x", "y", "z", "rot", "status", "flags", "look"],
        "zoneNames": {str(k): zone_names[k] for k in sorted(zone_names)},
        "models": models,
        "zones": {str(k): zones[k] for k in sorted(zones)},
    }

    # One row per line: readable diffs without the whitespace of indent=2.
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="\n") as f:
        f.write("{\n")
        head = ["schema", "source", "fields", "zoneNames", "models"]
        for k in head:
            f.write(f"{json.dumps(k)}: {json.dumps(doc[k], separators=(',', ':'))},\n")
        f.write('"zones": {\n')
        zone_keys = list(doc["zones"].keys())
        for zi, zk in enumerate(zone_keys):
            f.write(f"{json.dumps(zk)}: [\n")
            rws = doc["zones"][zk]
            for ri, row in enumerate(rws):
                f.write(json.dumps(row, separators=(",", ":"), ensure_ascii=False))
                f.write(",\n" if ri + 1 < len(rws) else "\n")
            f.write("]" + (",\n" if zi + 1 < len(zone_keys) else "\n"))
        f.write("}\n}\n")

    print(f"{rows} NPCs in {len(zones)} zones -> {out_path} "
          f"({out_path.stat().st_size // 1024} KB); {len(models)} standard models, "
          f"{unresolved} without a DAT; {skipped} rows skipped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
