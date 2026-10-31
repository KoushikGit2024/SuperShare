"""
config.py — Central configuration for SuperShare.
"""
from pathlib import Path
import os
import json
import threading
import time

BACKEND_DIR = Path(__file__).resolve().parent
BASE_DIR = BACKEND_DIR.parent
STATIC_DIR = BASE_DIR / "static"
TEMPLATE_DIR = STATIC_DIR / "templates"
SHARE_DIR = BASE_DIR / "shared_files"

os.makedirs(SHARE_DIR, exist_ok=True)

HOST = "0.0.0.0"
PORT = 8765
CHUNK_SIZE = 4 * 1024 * 1024  # 4 MB streaming chunks for huge files

# Mutable runtime state so the active shared directory can be changed on the fly
STATE = {
    "share_dir": str(SHARE_DIR.resolve()),
    "devices": {},
    "transfers": [],
    "lock": threading.RLock(),
}

STATE_FILE = BASE_DIR / "supershare_state.json"


def load_persistent_state():
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        STATE["devices"].update(data.get("devices", {}))
        STATE["transfers"].extend(data.get("transfers", [])[-200:])
    except (OSError, ValueError):
        pass


def save_persistent_state():
    with STATE["lock"]:
        data = {"devices": STATE["devices"], "transfers": STATE["transfers"][-200:]}
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(STATE_FILE)


load_persistent_state()


def record_transfer(device_id, filename, size, status="completed", detail=""):
    entry = {
        "id": f"{int(time.time() * 1000)}-{os.urandom(3).hex()}",
        "device_id": device_id,
        "filename": filename,
        "size": size,
        "status": status,
        "detail": detail,
        "timestamp": int(time.time()),
    }
    with STATE["lock"]:
        STATE["transfers"].append(entry)
        STATE["transfers"] = STATE["transfers"][-200:]
    save_persistent_state()
    return entry
