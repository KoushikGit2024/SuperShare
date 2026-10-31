"""
config.py — Central configuration for SuperShare.
"""
from pathlib import Path
import os
import json
import threading
import time
import sqlite3
import secrets

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

STATE_FILE = BASE_DIR / "supershare_state.json"  # legacy state import source
DATABASE_FILE = BASE_DIR / "supershare_state.sqlite3"
PAIRING_CODE = secrets.token_urlsafe(9)


def _connect_database():
    connection = sqlite3.connect(DATABASE_FILE, timeout=10)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=NORMAL")
    connection.execute("CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    connection.execute("CREATE TABLE IF NOT EXISTS transfers (id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, data TEXT NOT NULL)")
    connection.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    return connection


def load_persistent_state():
    with _connect_database() as connection:
        row = connection.execute("SELECT value FROM settings WHERE key='share_dir'").fetchone()
        if row and os.path.isdir(row[0]):
            STATE["share_dir"] = os.path.abspath(row[0])
        rows = connection.execute("SELECT id, data FROM devices").fetchall()
        STATE["devices"].update({device_id: json.loads(data) for device_id, data in rows})
        rows = connection.execute("SELECT data FROM transfers ORDER BY timestamp DESC LIMIT 200").fetchall()
        STATE["transfers"].extend(json.loads(row[0]) for row in reversed(rows))
        if rows or STATE["devices"]:
            return
        try:
            legacy = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        STATE["devices"].update(legacy.get("devices", {}))
        STATE["transfers"].extend(legacy.get("transfers", [])[-200:])
    save_persistent_state()


def save_persistent_state():
    with STATE["lock"]:
        devices = list(STATE["devices"].items())
        transfers = STATE["transfers"][-200:]
        with _connect_database() as connection:
            connection.executemany(
                "INSERT INTO devices(id, data) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                [(device_id, json.dumps(data, ensure_ascii=False)) for device_id, data in devices],
            )
            ids = [device_id for device_id, _ in devices]
            if ids:
                placeholders = ",".join("?" for _ in ids)
                connection.execute(f"DELETE FROM devices WHERE id NOT IN ({placeholders})", ids)
            else:
                connection.execute("DELETE FROM devices")
            connection.executemany(
                "INSERT INTO transfers(id, timestamp, data) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp=excluded.timestamp, data=excluded.data",
                [(entry["id"], entry["timestamp"], json.dumps(entry, ensure_ascii=False)) for entry in transfers],
            )
            connection.execute("DELETE FROM transfers WHERE id NOT IN (SELECT id FROM transfers ORDER BY timestamp DESC LIMIT 200)")
            connection.execute(
                "INSERT INTO settings(key, value) VALUES('share_dir', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (STATE["share_dir"],),
            )


load_persistent_state()


def record_transfer(device_id, filename, size, status="completed", detail="", destination=None):
    entry = {
        "id": f"{int(time.time() * 1000)}-{os.urandom(3).hex()}",
        "device_id": device_id,
        "filename": filename,
        "size": size,
        "status": status,
        "detail": detail,
        "timestamp": int(time.time()),
        "destination": destination or os.path.join(STATE["share_dir"], filename),
    }
    with STATE["lock"]:
        STATE["transfers"].append(entry)
        STATE["transfers"] = STATE["transfers"][-200:]
    save_persistent_state()
    return entry
