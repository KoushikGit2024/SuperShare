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
import sys
import shutil
from contextlib import closing

BACKEND_DIR = Path(__file__).resolve().parent
BASE_DIR = BACKEND_DIR.parent
FROZEN_DIR = Path(getattr(sys, "_MEIPASS", BASE_DIR))
STATIC_DIR = FROZEN_DIR / "static"
TEMPLATE_DIR = STATIC_DIR / "templates"
DATA_DIR = (
    (Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "SuperShare")
    if getattr(sys, "frozen", False)
    else BASE_DIR
)
SHARE_DIR = DATA_DIR / "shared_files"

os.makedirs(SHARE_DIR, exist_ok=True)

HOST = "0.0.0.0"
PORT = int(os.environ.get("SUPERSHARE_PORT", "8765"))
CHUNK_SIZE = 4 * 1024 * 1024  # 4 MB streaming chunks for balanced network/retry resilience
MAX_CONCURRENT_TRANSFERS = 6
MAX_TRANSFERS_PER_DEVICE = 3
TRANSFER_RETENTION_SECONDS = 7 * 24 * 60 * 60
ACTIVE_SLOT_STATES = {"queued", "transferring", "verifying"}
STALE_TRANSFER_SECONDS = 45

# Mutable runtime state so the active shared directory can be changed on the fly
STATE = {
    "share_dir": str(SHARE_DIR.resolve()),
    "devices": {},
    "transfers": [],
    "lock": threading.RLock(),
}

DATA_DIR.mkdir(parents=True, exist_ok=True)
STATE_FILE = DATA_DIR / "supershare_state.json"  # legacy state import source
DATABASE_FILE = DATA_DIR / "supershare_state.sqlite3"
if getattr(sys, "frozen", False):
    legacy_dir = Path(sys.executable).resolve().parent
    legacy_database = legacy_dir / "supershare_state.sqlite3"
    if legacy_database.exists() and not DATABASE_FILE.exists():
        shutil.copy2(legacy_database, DATABASE_FILE)
        for suffix in ("-wal", "-shm"):
            sidecar = Path(str(legacy_database) + suffix)
            if sidecar.exists():
                shutil.copy2(sidecar, Path(str(DATABASE_FILE) + suffix))
    legacy_json = legacy_dir / "supershare_state.json"
    if legacy_json.exists() and not STATE_FILE.exists():
        shutil.copy2(legacy_json, STATE_FILE)
PAIRING_CODE = secrets.token_urlsafe(9)


def _connect_database():
    connection = sqlite3.connect(DATABASE_FILE, timeout=10)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=NORMAL")
    connection.execute(
        "CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, data TEXT NOT NULL)"
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS transfers (id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, data TEXT NOT NULL)"
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS transfer_jobs (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, data TEXT NOT NULL)"
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    )
    return connection


def _state_json(value):
    # Escaping non-ASCII keeps lone UTF-16 surrogates in legacy/browser text
    # representable as valid ASCII JSON instead of failing SQLite's UTF-8 bind.
    return json.dumps(value, ensure_ascii=True)


def _remove_managed_partial(job):
    part_path = job.get("part_path", "")
    share_root = job.get("share_root") or STATE.get("share_dir", "")
    if not part_path or not share_root:
        return False
    filename = os.path.basename(part_path)
    if not (filename.startswith(".supershare-") and filename.endswith(".partial")):
        return False
    base_real = os.path.realpath(share_root)
    part_real = os.path.realpath(part_path)
    try:
        if os.path.normcase(os.path.commonpath([base_real, part_real])) != os.path.normcase(
            base_real
        ):
            return False
    except ValueError:
        return False
    try:
        os.remove(part_real)
    except FileNotFoundError:
        pass
    except OSError:
        return False
    return True


def load_persistent_state():
    with _db_write_lock, closing(_connect_database()) as connection, connection:
        row = connection.execute("SELECT value FROM settings WHERE key='share_dir'").fetchone()
        if row and os.path.isdir(row[0]):
            STATE["share_dir"] = os.path.abspath(row[0])
        rows = connection.execute("SELECT id, data FROM devices").fetchall()
        STATE["devices"].update({device_id: json.loads(data) for device_id, data in rows})
        rows = connection.execute(
            "SELECT data FROM transfers ORDER BY timestamp DESC LIMIT 200"
        ).fetchall()
        STATE["transfers"].extend(json.loads(row[0]) for row in reversed(rows))
        jobs = connection.execute("SELECT id, data FROM transfer_jobs").fetchall()
        STATE["transfer_jobs"] = {job_id: json.loads(data) for job_id, data in jobs}
        # A process restart interrupts active work; retain its checkpoint for resume.
        for job in STATE["transfer_jobs"].values():
            if job.get("status") in {"queued", "transferring", "verifying"}:
                job["status"] = "interrupted"
        expired = []
        cutoff = int(time.time()) - TRANSFER_RETENTION_SECONDS
        for job_id, job in STATE["transfer_jobs"].items():
            if job.get("updated_at", 0) < cutoff:
                if job.get("status") != "completed" and not _remove_managed_partial(job):
                    continue
                expired.append(job_id)
        for job_id in expired:
            STATE["transfer_jobs"].pop(job_id, None)
        connection.executemany(
            "INSERT INTO transfer_jobs(id, updated_at, data) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, data=excluded.data",
            [
                (job_id, int(job.get("updated_at", time.time())), _state_json(job))
                for job_id, job in STATE["transfer_jobs"].items()
            ],
        )
        if expired:
            connection.executemany(
                "DELETE FROM transfer_jobs WHERE id=?", [(job_id,) for job_id in expired]
            )
        if rows or STATE["devices"] or STATE["transfer_jobs"]:
            return
        try:
            legacy = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        STATE["devices"].update(legacy.get("devices", {}))
        STATE["transfers"].extend(legacy.get("transfers", [])[-200:])
    save_persistent_state()


_db_write_lock = threading.Lock()
_dirty = threading.Event()


def save_persistent_state():
    with STATE["lock"]:
        devices = [(k, _state_json(v)) for k, v in STATE["devices"].items()]
        transfers = [(e["id"], e["timestamp"], _state_json(e)) for e in STATE["transfers"][-200:]]
        jobs = [
            (k, int(j.get("updated_at", time.time())), _state_json(j))
            for k, j in STATE.get("transfer_jobs", {}).items()
        ]
        share_dir = STATE["share_dir"]

    with _db_write_lock, closing(_connect_database()) as connection, connection:
        connection.executemany(
            "INSERT INTO devices(id, data) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            devices,
        )
        if devices:
            placeholders = ",".join("?" for _ in devices)
            connection.execute(
                f"DELETE FROM devices WHERE id NOT IN ({placeholders})", [d[0] for d in devices]
            )
        else:
            connection.execute("DELETE FROM devices")

        connection.executemany(
            "INSERT INTO transfers(id, timestamp, data) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp=excluded.timestamp, data=excluded.data",
            transfers,
        )
        connection.execute(
            "DELETE FROM transfers WHERE id NOT IN (SELECT id FROM transfers ORDER BY timestamp DESC LIMIT 200)"
        )

        connection.executemany(
            "INSERT INTO transfer_jobs(id, updated_at, data) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, data=excluded.data",
            jobs,
        )
        if jobs:
            placeholders = ",".join("?" for _ in jobs)
            connection.execute(
                f"DELETE FROM transfer_jobs WHERE id NOT IN ({placeholders})", [j[0] for j in jobs]
            )
        else:
            connection.execute("DELETE FROM transfer_jobs")

        connection.execute(
            "INSERT INTO settings(key, value) VALUES('share_dir', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (share_dir,),
        )


def request_save():
    _dirty.set()


def _saver():
    while True:
        _dirty.wait()
        time.sleep(0.5)
        _dirty.clear()
        try:
            save_persistent_state()
        except Exception as exc:
            print(f"[WARN] state save failed: {exc}")


threading.Thread(target=_saver, daemon=True, name="state-saver").start()


def cleanup_expired_transfer_jobs(now=None):
    cutoff = int(now or time.time()) - TRANSFER_RETENTION_SECONDS
    expired = []
    with STATE["lock"]:
        for job_id, job in STATE.get("transfer_jobs", {}).items():
            if int(job.get("updated_at", 0)) >= cutoff:
                continue
            if job.get("status") != "completed" and not _remove_managed_partial(job):
                continue
            expired.append(job_id)
        for job_id in expired:
            STATE["transfer_jobs"].pop(job_id, None)
        if expired:
            with _db_write_lock, closing(_connect_database()) as connection, connection:
                connection.executemany(
                    "DELETE FROM transfer_jobs WHERE id=?", [(job_id,) for job_id in expired]
                )
    return len(expired)


load_persistent_state()


def record_transfer(
    device_id, filename, size, status="completed", detail="", destination=None, direction="receive"
):
    entry = {
        "id": f"{int(time.time() * 1000)}-{os.urandom(3).hex()}",
        "device_id": device_id,
        "filename": filename,
        "size": size,
        "status": status,
        "detail": detail,
        "timestamp": int(time.time()),
        "destination": destination or os.path.join(STATE["share_dir"], filename),
        "direction": direction,
    }
    with STATE["lock"]:
        STATE["transfers"].append(entry)
        STATE["transfers"] = STATE["transfers"][-200:]
    request_save()
    return entry


def clear_transfers_history():
    with STATE["lock"]:
        STATE["transfers"].clear()
    with _db_write_lock, closing(_connect_database()) as connection, connection:
        connection.execute("DELETE FROM transfers")
    request_save()
    return True


def clear_temp_partials(min_age_seconds=0):
    now = time.time()
    with STATE["lock"]:
        share_dir = STATE["share_dir"]
        jobs = list(STATE.get("transfer_jobs", {}).values())
        live = {
            os.path.realpath(j.get("part_path", ""))
            for j in jobs
            if j.get("status") in ACTIVE_SLOT_STATES
        }
        by_part = {os.path.realpath(j["part_path"]): j for j in jobs if j.get("part_path")}
    removed = reclaimed = 0
    for root, _, files in os.walk(share_dir):
        for name in files:
            if not (name.startswith(".supershare-") and name.endswith(".partial")):
                continue
            path = os.path.join(root, name)
            real = os.path.realpath(path)
            if real in live:
                continue
            try:
                st = os.stat(path)
                if now - st.st_mtime < min_age_seconds:
                    continue
                os.remove(path)
            except OSError:
                continue
            removed += 1
            reclaimed += st.st_size
            job = by_part.get(real)
            if job:
                with STATE["lock"]:
                    job["status"] = "cancelled"
                    job["error"] = "Unfinished upload was cleaned up by the host"
                    job["updated_at"] = int(now)
    request_save()
    return {"removed": removed, "reclaimed_bytes": reclaimed}


def reset_all_stored_state():
    with STATE["lock"]:
        active = [
            j
            for j in STATE.get("transfer_jobs", {}).values()
            if j.get("status") in ACTIVE_SLOT_STATES
        ]
        if active:
            raise RuntimeError("Cannot reset state while transfers are actively in progress")
        STATE["devices"].clear()
        STATE["transfers"].clear()
        STATE["transfer_jobs"].clear()
    clear_temp_partials()
    request_save()
    return True
