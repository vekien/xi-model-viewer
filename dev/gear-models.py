"""Bakes the PC gear model-id table (`dev/gear-models.json`) from the game's own data.

The AltanaViewer-format CSVs the viewer's lists come from name a DAT and a label, but
carry **no model id** — and a look string encodes each worn slot as
``(slotIndex << 12) | modelId``. Without this map the composer has nothing to put in a
look but the row index, which silently produces a look for the wrong gear (e.g. Weaver's
Apron, model 119, encoded as 12).

The authoritative mapping lives in FFXiMain.dll's per-race equipment tables + FTABLE.
`xi-tools` already parses both, so this script just re-shapes its output:

    {"<raceId>": {"lookRace": 2, "slots": {"<slotKey>": {"ROM/137/11.DAT": 119, ...}}}}

Tarutaru is one viewer race but TWO look races (5 male / 6 female): its "gender" is only the
face, yet the two equipment tables assign *different* model ids to the same armour DAT
(24 body conflicts, 7 head, ...). So it also carries ``lookRaceAlt`` + ``slotsAlt`` (the
female table); the composer picks the set matching the chosen face.

Run (needs the xi-tools checkout and its venv — same requirement as battle-table.json):

    cd D:\\xi-tools && uv run python D:\\xi-model-viewer\\dev\\gear-models.py

Verified against the server DB (`item_equipment.MId`): hume_vest 8, kingdom_aketon 111,
weavers_apron 119 — all agree with the ids emitted here.
"""

import json
from pathlib import Path

from xi.gear.xi_core import RACE_TABLES, SLOTS, parse_race_table, slot_file_ids
from xi.ftable.xi_core import load_all_tables, scan_file_ids

OUT = Path(__file__).with_name("gear-models.json")

# Viewer race id -> (xi race table, look race byte) and, for Tarutaru, the alternate
# (female) table it also spans. Look race bytes are look_t's: 1 HumeM .. 8 Galka.
RACE_MAP = {
    "HumeM": ("HumeMale", 1),
    "HumeF": ("HumeFemale", 2),
    "ElvaanM": ("ElvaanMale", 3),
    "ElvaanF": ("ElvaanFemale", 4),
    "Tarutaru": ("TaruMale", 5),
    "Mithra": ("Mithra", 7),
    "Galka": ("Galka", 8),
}
RACE_ALT = {"Tarutaru": ("TaruFemale", 6)}

# Viewer slot key -> xi slot name (the viewer calls the ranged slot "range"). Keyed by
# the VIEWER's slot names, so the emitted map lines up 1:1 with characters.json's slots.
SLOT_MAP = {
    "face": "face", "head": "head", "body": "body", "hands": "hands", "legs": "legs",
    "feet": "feet", "main": "main", "sub": "sub", "range": "ranged",
}


def main() -> None:
    tables = load_all_tables()

    # Every (race, slot, model_id, file_id) the equipment tables define, resolved to a DAT.
    per_race: dict[str, dict[str, list]] = {}
    all_fids: set[int] = set()
    for race, raw in RACE_TABLES.items():
        parsed = parse_race_table(raw)
        per_race[race] = {}
        for slot in SLOTS:
            rows = slot_file_ids(parsed[slot])
            per_race[race][slot] = rows
            all_fids.update(fid for _, fid in rows)

    dat_by_fid = {e["file_id"]: e["dat"] for e in scan_file_ids(sorted(all_fids), tables)}

    def slots_for(xi_race: str) -> dict[str, dict[str, int]]:
        """{viewer slot: {DAT: model_id}} for one xi race table."""
        out: dict[str, dict[str, int]] = {}
        for view_slot, xi_slot in SLOT_MAP.items():
            mapping: dict[str, int] = {}
            for model_id, file_id in per_race[xi_race][xi_slot]:
                dat = dat_by_fid.get(file_id)
                if not dat:
                    continue
                key = dat.replace("\\", "/").upper()
                # FFXI aliases several model ids onto one DAT (e.g. faces 0-15 repeat at
                # 16-31); keep the lowest, which is the canonical item model id.
                if key not in mapping or model_id < mapping[key]:
                    mapping[key] = model_id
            if mapping:
                out[view_slot] = dict(sorted(mapping.items()))
        return out

    out: dict[str, dict] = {}
    for race_id, (xi_race, look_race) in RACE_MAP.items():
        entry: dict = {"lookRace": look_race, "slots": slots_for(xi_race)}
        alt = RACE_ALT.get(race_id)
        if alt:
            alt_race, alt_look = alt
            entry["lookRaceAlt"] = alt_look
            entry["slotsAlt"] = slots_for(alt_race)
        out[race_id] = entry

    OUT.write_text(json.dumps(out, indent=1), encoding="utf-8")
    total = sum(len(s) for r in out.values() for s in r["slots"].values())
    print(f"wrote {OUT}  ({total:,} DAT->model_id entries across {len(out)} races)")
    for race_id, entry in out.items():
        alt = f"  +alt look {entry['lookRaceAlt']}" if "slotsAlt" in entry else ""
        print(f"  {race_id:9} look {entry['lookRace']}  "
              + "  ".join(f"{k}:{len(v)}" for k, v in entry["slots"].items()) + alt)


if __name__ == "__main__":
    main()
